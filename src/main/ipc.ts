import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  cellSchema,
  editsSchema,
  profileSchema,
  querySchema,
  redisInspectSchema,
  redisMutateSchema,
  redisScanSchema,
  mongoReadSchema,
  mongoWriteSchema,
  savedQuerySchema,
  saveProfileSchema,
  secretsSchema,
  settingsSchema,
  tableInputSchema,
  workspaceSchema,
  type ConnectionProfile,
  type SaveProfileInput,
  type Secrets,
} from '../shared/contracts'
import { MetadataStore } from './persistence/store'
import { CredentialService, redactHistory } from './persistence/credentials'
import { exportLoadedData } from './persistence/export'
import type { SqlService } from './engines/sql'
import type { RedisService } from './engines/redis'
import type { MongoService } from './engines/mongo'

const id = z.string().min(1).max(100)
const context = { connectionId: id, sessionId: id }
const database = z.string().min(1).max(255).optional()
const sessionSchema = z.object(context).strict()
const objectSchema = z
  .object({ connectionId: id, database, schema: z.string().max(255), table: z.string().min(1).max(255) })
  .strict()
const exportSchema = z
  .object({
    format: z.enum(['csv', 'json']),
    columns: z
      .array(
        z
          .object({
            name: z.string().max(10000),
            type: z.string().max(1000),
            key: z.boolean().optional(),
            nullable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2000),
    rows: z.array(z.array(cellSchema).max(2000)).max(10000),
    spreadsheetSafe: z.boolean(),
    scope: z.enum(['loaded results', 'selected rows', 'loaded table page']),
  })
  .strict()
const executionContext = (profile: ConnectionProfile) =>
  JSON.stringify({
    name: profile.name,
    environment: profile.environment,
    engine: profile.engine,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.database,
    schema: profile.schema,
    redisDb: profile.redisDb,
    mongo: profile.mongo,
    readOnly: profile.readOnly,
    connectTimeout: profile.connectTimeout,
    queryTimeout: profile.queryTimeout,
    tls: profile.tls,
    ssh: profile.ssh,
  })
export const ipcSchemas = {
  mongoDatabases: id,
  mongoCollections: z.object({ connectionId: id, database: z.string().min(1).max(255) }).strict(),
  mongoRead: mongoReadSchema,
  mongoWrite: mongoWriteSchema,
  bootstrap: z.undefined(),
  saveProfile: saveProfileSchema,
  deleteProfile: id,
  forgetPassword: id,
  testConnection: saveProfileSchema,
  connect: z.object({ id, secrets: secretsSchema.optional() }).strict(),
  disconnect: id,
  status: id,
  saveWorkspace: workspaceSchema.extend({ settings: settingsSchema.strict() }),
  listObjects: z.object({ connectionId: id, database, schema: z.string().max(255).optional() }).strict(),
  listDatabases: id,
  structure: objectSchema,
  query: querySchema.extend({ connectionId: id, sessionId: id, requestId: id }),
  cancel: z.object({ ...context, requestId: id }).strict(),
  transaction: z.object({ ...context, database, action: z.enum(['begin', 'commit', 'rollback']) }).strict(),
  closeSession: sessionSchema,
  getSessionState: sessionSchema,
  table: tableInputSchema.extend(context),
  applyEdits: editsSchema.extend(context),
  redisScan: redisScanSchema.extend({ connectionId: id }),
  redisInspect: redisInspectSchema.extend({ connectionId: id }),
  redisMutate: redisMutateSchema.extend({ connectionId: id }),
  saveQuery: savedQuerySchema.extend({
    id,
    connectionId: id.optional(),
    tags: z.array(z.string().max(60)).max(30),
    updatedAt: z.iso.datetime(),
  }),
  deleteQuery: id,
  clearHistory: z.undefined(),
  clearDrafts: z.undefined(),
  exportProfiles: z.undefined(),
  previewImport: z.undefined(),
  importProfiles: z.array(profileSchema).max(1000),
  exportResults: exportSchema,
  importSql: z.undefined(),
  exportSql: z.object({ name: z.string().min(1).max(255), sql: z.string().max(1000000) }).strict(),
  setZoom: z.number().min(0.75).max(1.5),
  readyToClose: z.undefined(),
} as const

export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: Pick<BrowserWindow, 'webContents'>,
  expectedUrl: string,
): boolean {
  if (
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false
  try {
    const received = new URL(event.senderFrame.url)
    const expected = new URL(expectedUrl)
    received.hash = ''
    expected.hash = ''
    return received.href === expected.href
  } catch {
    return false
  }
}

export function registerIpc(
  window: BrowserWindow,
  expectedUrl: string,
  store: MetadataStore,
  credentials: CredentialService,
  sql: SqlService,
  redis: RedisService,
  mongo: MongoService,
  finishShutdown: () => Promise<void>,
): () => void {
  const locks = new Map<string, Promise<unknown>>()
  const serial = async <T>(connectionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(connectionId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    locks.set(connectionId, current)
    try {
      return await current
    } finally {
      if (locks.get(connectionId) === current) locks.delete(connectionId)
    }
  }
  const service = (profile: ConnectionProfile): SqlService | RedisService | MongoService =>
    profile.engine === 'mongodb' ? mongo : profile.engine === 'redis' ? redis : sql
  const requireSql = (connectionId: string): void => {
    if (!['postgres', 'mariadb'].includes(store.profile(connectionId).engine))
      throw new Error('This action requires a PostgreSQL or MariaDB connection.')
  }
  const requireRedis = (connectionId: string): void => {
    if (store.profile(connectionId).engine !== 'redis')
      throw new Error('This action requires a Redis connection.')
  }
  const requireMongo = (connectionId: string): void => {
    if (store.profile(connectionId).engine !== 'mongodb')
      throw new Error('This action requires a MongoDB connection.')
  }
  const checkedFile = async (path: string, limit: number): Promise<string> => {
    const info = await stat(path)
    if (!info.isFile() || info.size > limit)
      throw new Error(`Choose a regular file smaller than ${Math.floor(limit / 1000000)} MB.`)
    return readFile(path, 'utf8')
  }
  const test = async (input: SaveProfileInput) => {
    const start = performance.now()
    const temporary = { ...input.profile, id: `test-${randomUUID()}` }
    let secret: Secrets | undefined
    try {
      secret = store.hasProfile(input.profile.id)
        ? credentials.resolve(input.profile.id, input.secrets)
        : input.secrets || {}
      return await service(temporary).connect(temporary, secret)
    } catch (error) {
      return {
        state: 'failed' as const,
        durationMs: Math.round(performance.now() - start),
        error: credentials.sanitize(error, secret || input.secrets),
      }
    } finally {
      await service(temporary)
        .disconnect(temporary.id)
        .catch(() => undefined)
      secret = undefined
    }
  }
  const handlers: {
    [K in keyof typeof ipcSchemas]: (input: z.infer<(typeof ipcSchemas)[K]>) => unknown | Promise<unknown>
  } = {
    mongoDatabases: (id) => {
      requireMongo(id)
      return mongo.databases(id)
    },
    mongoCollections: (input) => {
      requireMongo(input.connectionId)
      return mongo.collections(input)
    },
    mongoRead: (input) => {
      requireMongo(input.connectionId)
      return mongo.read(input)
    },
    mongoWrite: (input) => {
      requireMongo(input.connectionId)
      return mongo.write(input)
    },
    bootstrap: () => ({
      profiles: store.profiles(),
      workspace: store.workspace(),
      savedQueries: store.queries(),
      history: store.history(),
      secureStorage: credentials.status(),
      version: app.getVersion(),
      platform: process.platform,
    }),
    saveProfile: (input) =>
      serial(input.profile.id, async () => {
        const existing = store.hasProfile(input.profile.id) ? store.profile(input.profile.id) : undefined
        const profile = { ...input.profile }
        if (
          profile.environment.toLowerCase() === 'production' &&
          existing?.environment.toLowerCase() !== 'production'
        )
          profile.readOnly = true
        const prepared = credentials.prepare(profile.id, input.secrets, input.rememberPassword)
        // Organization changes preserve live transactions; execution/credential changes never reuse sessions.
        const credentialsChanged =
          !!Object.keys(input.secrets || {}).length ||
          (!!existing &&
            !input.rememberPassword &&
            (existing.hasPassword || existing.hasSshPassword || existing.hasPassphrase))
        const contextChanged =
          existing && (executionContext(existing) !== executionContext(profile) || credentialsChanged)
        if (contextChanged) await service(existing).disconnect(existing.id)
        store.transaction(() => {
          store.saveProfile(profile)
          if (prepared.remove) store.deleteCredential(profile.id)
          if (prepared.credential) store.writeCredential(profile.id, prepared.credential)
        })
        if (contextChanged) credentials.clearSession(profile.id)
        credentials.rememberSession(profile.id, prepared.session)
        return store.profile(profile.id)
      }),
    deleteProfile: (connectionId) =>
      serial(connectionId, async () => {
        const profile = store.profile(connectionId)
        await service(profile).disconnect(connectionId)
        store.deleteProfile(connectionId)
        credentials.clearSession(connectionId)
      }),
    forgetPassword: (connectionId) => {
      store.profile(connectionId)
      credentials.forget(connectionId)
    },
    testConnection: test,
    connect: (input) =>
      serial(input.id, async () => {
        const profile = store.profile(input.id)
        let secret: Secrets | undefined
        try {
          secret = credentials.resolve(input.id, input.secrets)
          return await service(profile).connect(profile, secret)
        } catch (error) {
          return { state: 'failed' as const, error: credentials.sanitize(error, secret || input.secrets) }
        } finally {
          secret = undefined
        }
      }),
    disconnect: (connectionId) =>
      serial(connectionId, async () => {
        await service(store.profile(connectionId)).disconnect(connectionId)
        credentials.clearSession(connectionId)
      }),
    status: (connectionId) => service(store.profile(connectionId)).status(connectionId),
    saveWorkspace: (input) => {
      store.saveWorkspace(input)
      store.pruneHistory()
    },
    listObjects: (input) => {
      requireSql(input.connectionId)
      return sql.listObjects(input)
    },
    listDatabases: (connectionId) => {
      requireSql(connectionId)
      return sql.listDatabases(connectionId)
    },
    structure: (input) => {
      requireSql(input.connectionId)
      return sql.structure(input)
    },
    query: async (input) => {
      const profile = store.profile(input.connectionId)
      if (profile.engine === 'mongodb') throw new Error('Use the MongoDB document browser for JSON queries.')
      const start = performance.now()
      try {
        const result = await (profile.engine === 'redis' ? redis : sql).execute(input)
        store.addHistory(
          {
            connectionId: input.connectionId,
            ...(input.database ? { database: input.database } : {}),
            sql: input.sql,
            executedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            rowCount: result.sets.reduce((sum, set) => sum + set.rows.length, 0),
            success: !result.cancelled,
            ...(result.cancelled
              ? {
                  error:
                    'Cancelled: the server confirmed cancellation. Earlier script statements may already have committed.',
                }
              : {}),
          },
          input.privateSession,
        )
        return result
      } catch (error) {
        const message =
          redactHistory(input.sql) === input.sql
            ? credentials.sanitize(error)
            : 'Credential-bearing command failed. Check authentication and connection settings.'
        store.addHistory(
          {
            connectionId: input.connectionId,
            ...(input.database ? { database: input.database } : {}),
            sql: input.sql,
            executedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - start),
            rowCount: 0,
            success: false,
            error: message,
          },
          input.privateSession,
        )
        throw new Error(message)
      }
    },
    cancel: (input) => {
      if (store.profile(input.connectionId).engine === 'mongodb')
        return { requested: false, message: 'MongoDB queries are bounded by the connection timeout.' }
      if (store.profile(input.connectionId).engine === 'redis')
        return {
          requested: false,
          message:
            'Redis commands cannot be cancelled safely after dispatch. Stop loading to cancel continued scanning.',
        }
      return sql.cancel(input)
    },
    transaction: (input) => {
      requireSql(input.connectionId)
      return sql.transaction(input)
    },
    closeSession: (input) => {
      if (['postgres', 'mariadb'].includes(store.profile(input.connectionId).engine))
        return sql.closeSession(input)
    },
    getSessionState: (input) => {
      if (['redis', 'mongodb'].includes(store.profile(input.connectionId).engine))
        return {
          state: 'idle',
          connected:
            service(store.profile(input.connectionId)).status(input.connectionId).state === 'connected',
          running: false,
        }
      return sql.getSessionState(input)
    },
    table: (input) => {
      requireSql(input.connectionId)
      return sql.table(input)
    },
    applyEdits: (input) => {
      requireSql(input.connectionId)
      if (store.profile(input.connectionId).readOnly)
        throw new Error(
          'This connection is in guarded browsing mode. Edit the connection to deliberately enable writes.',
        )
      return sql.applyEdits(input)
    },
    redisScan: (input) => {
      requireRedis(input.connectionId)
      return redis.scan(input)
    },
    redisInspect: (input) => {
      requireRedis(input.connectionId)
      return redis.inspect(input)
    },
    redisMutate: (input) => {
      requireRedis(input.connectionId)
      if (store.profile(input.connectionId).readOnly)
        throw new Error(
          'This connection is in guarded browsing mode. Edit the connection to deliberately enable writes.',
        )
      return redis.mutate(input)
    },
    saveQuery: (input) => store.saveQuery({ ...input, updatedAt: new Date().toISOString() }),
    deleteQuery: (queryId) => store.deleteQuery(queryId),
    clearHistory: () => store.clearHistory(),
    clearDrafts: () => store.clearDrafts(),
    exportProfiles: async () => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export connection metadata — passwords excluded',
        defaultPath: 'harbor-connections.json',
        filters: [{ name: 'Harbor connection metadata', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await writeFile(result.filePath, store.exportProfiles(), { encoding: 'utf8', mode: 0o600 })
      return { cancelled: false, path: result.filePath }
    },
    previewImport: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Preview connection metadata import',
        properties: ['openFile'],
        filters: [{ name: 'Harbor connection metadata', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return store.previewImport(JSON.parse(await checkedFile(result.filePaths[0], 16000000)))
    },
    importProfiles: (input) => store.importProfiles(input),
    exportResults: async (input) => {
      if (input.rows.some((row) => row.length !== input.columns.length))
        throw new Error('Result rows must match the ordered column metadata.')
      let size = 0
      for (const row of input.rows)
        for (const value of row) {
          size +=
            typeof value === 'string'
              ? value.length * 2
              : value && typeof value === 'object'
                ? value.base64.length * 2
                : 16
          if (size > 32000000)
            throw new Error(
              'Loaded export exceeds 32 MB. Export a smaller selection or lower the result limit.',
            )
        }
      const result = await dialog.showSaveDialog(window, {
        title: `Export ${input.scope} — ${input.rows.length} rows`,
        defaultPath: `harbor-results.${input.format}`,
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await exportLoadedData(result.filePath, input)
      return { cancelled: false, path: result.filePath }
    },
    importSql: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Open SQL without executing',
        properties: ['openFile'],
        filters: [{ name: 'SQL query', extensions: ['sql'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return { name: basename(result.filePaths[0]), sql: await checkedFile(result.filePaths[0], 1000000) }
    },
    exportSql: async (input) => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export saved query',
        defaultPath: `${input.name.replace(/[\\/:*?"<>|]/g, '-').replace(/\.sql$/i, '')}.sql`,
        filters: [{ name: 'SQL query', extensions: ['sql'] }],
      })
      if (!result.canceled && result.filePath)
        await writeFile(result.filePath, input.sql, { encoding: 'utf8', mode: 0o600 })
    },
    setZoom: (value) => window.webContents.setZoomFactor(value),
    readyToClose: () => {
      setImmediate(() => {
        void finishShutdown()
      })
    },
  }
  for (const [name, schema] of Object.entries(ipcSchemas)) {
    ipcMain.handle(`harbor:${name}`, async (event, input: unknown) => {
      if (!isTrustedSender(event, window, expectedUrl))
        throw new Error('This request did not originate from the trusted Harbor DB application frame.')
      const parsed = schema.safeParse(input)
      if (!parsed.success)
        throw new Error(
          `Invalid ${name} request: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'payload'} ${issue.message}`)
            .join('; ')
            .slice(0, 1200)}`,
        )
      try {
        return await (handlers[name as keyof typeof handlers] as (input: unknown) => unknown)(parsed.data)
      } catch (error) {
        throw new Error(credentials.sanitize(error))
      }
    })
  }
  return () => {
    for (const name of Object.keys(ipcSchemas)) ipcMain.removeHandler(`harbor:${name}`)
  }
}
