import { TimeSeriesService } from './engines/time-series'
import { VectorService } from './engines/vector'
import { MongoFileService } from './persistence/mongo-files'
import { WarehouseService } from './engines/warehouses'
import { AthenaService } from './engines/athena'
import { HanaService } from './engines/hana'
import { FirebirdService } from './engines/firebird'
import { CqlService } from './engines/cql'
import { DynamoService } from './engines/dynamodb'
import { Neo4jService } from './engines/neo4j'
import { CouchdbService } from './engines/couchdb'
import { BigQueryService } from './engines/bigquery'
import { TrinoService } from './engines/trino'
import { Db2Service } from './engines/db2'
import { CompatibleSqlService } from './engines/compatible-sql'
import { isCompatibleSqlEngine } from '../shared/compatible-sql'
import { DatabaseTransferService } from './persistence/database-transfer'
import { NativeBackupService } from './persistence/native-backup'
import { DuckDBService } from './engines/duckdb'
import { MssqlService } from './engines/mssql'
import { ClickhouseService } from './engines/clickhouse'
import { ElasticsearchService } from './engines/elasticsearch'
import { OpenSearchService } from './engines/opensearch'
import { OracleService } from './engines/oracle'
import { TransferService } from './persistence/transfers'
import { exportConsistency } from '../shared/transfers'
import { ImportService } from './persistence/transfer-imports'
import { openLocalImport } from './persistence/local-import-writer'
import { shortcutAccelerator, shortcutPlatform } from '../shared/shortcuts'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  safeStorage,
  session,
  type MenuItemConstructorOptions,
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MetadataStore } from './persistence/store'
import { CredentialService } from './persistence/credentials'
import { SqlService } from './engines/sql'
import { RedisService } from './engines/redis'
import { MongoService } from './engines/mongo'
import { SqliteService } from './engines/sqlite'
import { registerIpc } from './ipc'

const runtimeDirectory = fileURLToPath(new URL('.', import.meta.url))

// Test instances are isolated; a packaged application cannot redirect its data through env.
if (!app.isPackaged && process.env.HARBOR_USER_DATA) app.setPath('userData', process.env.HARBOR_USER_DATA)
if (process.platform === 'win32') app.setAppUserModelId('dev.harbordb.desktop')
app.setName('Harbor DB')
const isPrimaryInstance = app.requestSingleInstanceLock()

let window: BrowserWindow | undefined
let store: MetadataStore | undefined
let credentials: CredentialService | undefined
const timeSeries = new TimeSeriesService()
const vectors = new VectorService()
const sql = new SqlService()
const mssql = new MssqlService()
const clickhouse = new ClickhouseService()
const elasticsearch = new ElasticsearchService()
const opensearch = new OpenSearchService()
const oracle = new OracleService()
const compatible = new CompatibleSqlService()
const db2 = new Db2Service()
const trino = new TrinoService()
const bigquery = new BigQueryService()
const snowflake = new WarehouseService('snowflake')
const databricks = new WarehouseService('databricks')
const athena = new AthenaService()
const firebird = new FirebirdService()
const hana = new HanaService()
const couchdb = new CouchdbService()
const neo4j = new Neo4jService()
const dynamodb = new DynamoService()
const cassandra = new CqlService()
const imports = new ImportService({
  openImport: (target, signal) => {
    const profile = store?.profile(target.connectionId)
    if (profile?.engine === 'clickhouse') return clickhouse.openImport(target, signal)
    if (profile?.engine === 'oracle') return oracle.openImport(target, signal)
    if (profile?.engine === 'sqlite' && sqlite) return openLocalImport(sqlite, profile, target, signal)
    if (profile?.engine === 'duckdb' && duckdb) return openLocalImport(duckdb, profile, target, signal)
    return sql.openImport(target, signal)
  },
})
const transfers = new TransferService({
  exportConsistency: (input) => {
    if (!store) throw new Error('Application metadata is not ready.')
    return exportConsistency(store.profile(input.connectionId).engine)
  },
  streamQuery: (input, sink) => {
    const engine = store?.profile(input.connectionId).engine
    if (engine === 'clickhouse') return clickhouse.streamQuery(input, sink)
    if (engine === 'oracle') return oracle.streamQuery(input, sink)
    if (engine === 'db2') return db2.streamQuery(input, sink)
    if (engine && isCompatibleSqlEngine(engine)) return compatible.streamQuery(input, sink)
    if (engine === 'snowflake') return snowflake.streamQuery(input, sink)
    if (engine === 'athena') return athena.streamQuery(input, sink)
    if (engine === 'hana') return hana.streamQuery(input, sink)
    if (engine === 'firebird') return firebird.streamQuery(input, sink)
    if (engine === 'bigquery') return bigquery.streamQuery(input, sink)
    if (engine === 'trino') return trino.streamQuery(input, sink)
    if (engine === 'mssql') return mssql.streamQuery(input, sink)
    if (engine === 'sqlite') {
      if (!sqlite) throw new Error('SQLite adapter is unavailable.')
      return sqlite.streamQuery(input, sink)
    }
    if (engine === 'duckdb') {
      if (!duckdb) throw new Error('DuckDB adapter is unavailable.')
      return duckdb.streamQuery(input, sink)
    }
    return sql.streamQuery(input, sink)
  },
})
const databaseTransfers = new DatabaseTransferService({
  profile: (id) => { if (!store) throw new Error('Application metadata is not ready.'); return store.profile(id) },
  structure: (input) => {
    const engine = store?.profile(input.connectionId).engine
    if (engine === 'sqlite' && sqlite) return sqlite.structure(input)
    if (engine === 'duckdb' && duckdb) return duckdb.structure(input)
    if (engine === 'postgres') return sql.structure(input)
    throw new Error('This database is outside the transfer matrix.')
  },
  streamQuery: (input, sink) => {
    const engine = store?.profile(input.connectionId).engine
    if (engine === 'sqlite' && sqlite) return sqlite.streamQuery(input, sink)
    if (engine === 'duckdb' && duckdb) return duckdb.streamQuery(input, sink)
    if (engine === 'postgres') return sql.streamQuery(input, sink)
    throw new Error('This database is outside the transfer matrix.')
  },
  openImport: (input, signal) => {
    const profile = store?.profile(input.connectionId)
    if (profile?.engine === 'sqlite' && sqlite) return openLocalImport(sqlite, profile, input, signal)
    if (profile?.engine === 'duckdb' && duckdb) return openLocalImport(duckdb, profile, input, signal)
    if (profile?.engine === 'postgres') return sql.openImport(input, signal)
    throw new Error('This database is outside the transfer matrix.')
  },
})
const nativeBackups = new NativeBackupService({
  profile: (id) => { if (!store) throw new Error('Application metadata is not ready.'); return store.profile(id) },
  secrets: (id) => { if (!credentials) throw new Error('Credential storage is not ready.'); return credentials.resolve(id) },
  execute: (input) => sql.execute(input),
  closeSession: (input) => sql.closeSession(input),
  cancel: (input) => sql.cancel(input),
  temporaryDirectory: join(app.getPath('userData'), 'native-backup-temporary'),
})
const redis = new RedisService()
const mongo = new MongoService()
const mongoFiles = new MongoFileService(mongo)
let sqlite: SqliteService | undefined
let duckdb: DuckDBService | undefined
let shutdownStarted = false
let shutdownComplete = false
let removeIpc: (() => void) | undefined

export async function finishShutdown(): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  try {
    await mongoFiles.closeAll()
    await nativeBackups.closeAll()
    await databaseTransfers.closeAll()
    await transfers.closeAll()
    await imports.closeAll()
    await Promise.allSettled([
      vectors.closeAll(),
      timeSeries.closeAll(),
      sql.closeAll(),
      mssql.closeAll(),
      clickhouse.closeAll(),
      elasticsearch.closeAll(),
      opensearch.closeAll(),
      oracle.closeAll(),
      compatible.closeAll(),
      db2.closeAll(),
      trino.closeAll(),
      bigquery.closeAll(),
      snowflake.closeAll(),
      databricks.closeAll(),
      athena.closeAll(),
      firebird.closeAll(),
      hana.closeAll(),
      couchdb.closeAll(),
      neo4j.closeAll(),
      dynamodb.closeAll(),
      cassandra.closeAll(),
      redis.closeAll(),
      mongo.closeAll(),
      sqlite?.closeAll(),
      duckdb?.closeAll(),
    ])
    credentials?.clearAll()
    store?.close()
  } catch (error) {
    dialog.showErrorBox(
      'Harbor DB could not finish saving',
      credentials?.sanitize(error) ||
        'Application metadata could not be flushed. Existing files have been preserved.',
    )
  } finally {
    removeIpc?.()
    shutdownComplete = true
    app.quit()
  }
}

const sendMenu = (action: string): void => window?.webContents.send('harbor:menu', action)
function installMenu(): void {
  const platform = shortcutPlatform(process.platform)
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'Harbor DB',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: shortcutAccelerator('settings', platform),
                click: () => sendMenu('settings'),
              },
              { type: 'separator' },
              { role: 'services' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Connection…',
          accelerator: shortcutAccelerator('new-connection', platform),
          click: () => sendMenu('new-connection'),
        },
        {
          label: 'New Query',
          accelerator: shortcutAccelerator('new-query', platform),
          click: () => sendMenu('new-query'),
        },
        {
          label: 'Open SQL…',
          accelerator: shortcutAccelerator('import-sql', platform),
          click: () => sendMenu('import-sql'),
        },
        {
          label: 'Save Query…',
          accelerator: shortcutAccelerator('save-query', platform),
          click: () => sendMenu('save-query'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: shortcutAccelerator('close-tab', platform),
          click: () => sendMenu('close-tab'),
        },
        ...(mac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: mac ? undefined : shortcutAccelerator('settings', platform),
          click: () => sendMenu('settings'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette',
          accelerator: shortcutAccelerator('command-palette', platform),
          click: () => sendMenu('command-palette'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged
          ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Query',
      submenu: [
        {
          label: 'Run Selection or Current Statement',
          accelerator: shortcutAccelerator('run-current', platform),
          click: () => sendMenu('run-current'),
        },
        {
          label: 'Run Complete Script',
          accelerator: shortcutAccelerator('run-script', platform),
          click: () => sendMenu('run-script'),
        },
        {
          label: 'Cancel Query',
          accelerator: shortcutAccelerator('cancel-query', platform),
          click: () => sendMenu('cancel-query'),
        },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Harbor DB',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Harbor DB',
              message: `Harbor DB ${app.getVersion()}`,
              detail:
                'A local workspace for SQL databases, MongoDB, and Redis.\n\nConnection metadata is stored in the operating system application-data directory. Managed database data is never backed up by exporting Harbor connection profiles.',
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Only the lock owner may initialize storage, windows, or shutdown handlers.
// app.quit() alone does not stop JavaScript execution in a secondary process.
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isCrashed()
    ) {
      void finishShutdown()
      return
    }
    sendMenu('prepare-close')
  })
  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      try {
        store = new MetadataStore(app.getPath('userData'))
        sqlite = new SqliteService(store.path)
        duckdb = new DuckDBService(store.path)
        credentials = new CredentialService(safeStorage, store)
        const settings = store.workspace().settings
        nativeTheme.themeSource = settings.theme
        const rendererPath = join(runtimeDirectory, '../renderer/index.html')
        const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
        const expectedUrl = devUrl || pathToFileURL(rendererPath).href
        if (devUrl) {
          const url = new URL(devUrl)
          if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
            throw new Error('The development renderer must use a local HTTP server.')
        }
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        )
        session.defaultSession.setPermissionCheckHandler(() => false)
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          const csp = `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${devUrl ? ` ws://${new URL(devUrl).host}` : ''}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`
          callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
        })
        window = new BrowserWindow({
          width: 1440,
          height: 900,
          minWidth: 1024,
          minHeight: 700,
          show: false,
          title: 'Harbor DB',
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#101318' : '#f4f6fa',
          autoHideMenuBar: process.platform !== 'darwin',
          icon: join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
          webPreferences: {
            preload: join(runtimeDirectory, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
          },
        })
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', (event) => event.preventDefault())
        window.webContents.on('will-attach-webview', (event) => event.preventDefault())
        window.webContents.on('render-process-gone', () => {
          if (!shutdownStarted)
            dialog.showErrorBox(
              'Harbor DB workspace stopped',
              'The last saved workspace is preserved. Restart Harbor DB to recover it. Active server operations may have completed; inspect the database before retrying a write.',
            )
        })
        removeIpc = registerIpc(
          window,
          expectedUrl,
          store,
          credentials,
          sql,
          redis,
          mongo,
          finishShutdown,
          sqlite,
          transfers,
          duckdb,
          imports,
          mssql,
          clickhouse,
          elasticsearch,
          opensearch,
          oracle,
          compatible,
          databaseTransfers,
          nativeBackups,
          trino,
          bigquery,
          { snowflake, databricks },
          mongoFiles,
          athena,
          couchdb,
          firebird,
          neo4j,
          hana,
          vectors,
          dynamodb,
          timeSeries,
          db2,
          cassandra,
        )
        window.webContents.setZoomFactor(settings.zoom)
        window.on('close', (event) => {
          if (!shutdownComplete) {
            event.preventDefault()
            app.quit()
          }
        })
        window.once('ready-to-show', () => window?.show())
        installMenu()
        if (devUrl) await window.loadURL(devUrl)
        else await window.loadFile(rendererPath)
      } catch (error) {
        dialog.showErrorBox(
          'Harbor DB needs attention',
          error instanceof Error
            ? error.message
            : 'Application initialization failed. Your existing files have been preserved.',
        )
        await finishShutdown()
      }
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Harbor DB could not start',
        error instanceof Error ? error.message : 'Unknown initialization error.',
      )
      app.exit(1)
    })
}
