import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  statfs,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionProfile, QueryInput, QueryResult, Secrets } from '../../shared/contracts'
import { quoteIdentifier } from '../../shared/sql'
import { SqlService } from '../engines/sql'
import {
  previewNativeBackupSchema,
  startNativeBackupSchema,
  type NativeBackupArchive,
  type NativeBackupJob,
  type NativeBackupPreview,
  type NativeBackupTool,
  type NativeBackupToolKind,
  type PreviewNativeBackupInput,
  type StartNativeBackupInput,
} from '../../shared/native-backup'
import {
  inspectNativeTool,
  nativeFileIdentity,
  redactNativeText,
  runNative,
  verifyOpenNativeFile,
  writeNativeChunk,
  type NativeFileIdentity,
} from './native-backup-tools'

interface Context {
  profile(id: string): ConnectionProfile
  secrets(id: string): Secrets
  execute(input: QueryInput): Promise<QueryResult>
  closeSession(input: { connectionId: string; sessionId: string }): Promise<void>
  cancel?(input: { connectionId: string; sessionId: string; requestId: string }): Promise<unknown>
  temporaryDirectory?: string
}
interface SelectedTool {
  tool: NativeBackupTool
  identity: NativeFileIdentity
}
interface SelectedArchive {
  archive: NativeBackupArchive
  identity: NativeFileIdentity
}
interface Sealed {
  input: PreviewNativeBackupInput
  preview: NativeBackupPreview
  profile: string
  expires: number
  server: string
}
interface Job {
  snapshot: NativeBackupJob
  controller: AbortController
  started: number
  done: Promise<void>
  finalizing: boolean
  key: string
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Native backup operation failed.'
const maxArchive = 100 * 1024 ** 3
const versionMajor = (version: string) => Number(/^(\d+)/.exec(version)?.[1])
const connValue = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
const passValue = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:')

/** PostgreSQL logical custom archives. Native tools are user-selected and pinned; no existing database is overwritten. */
export class NativeBackupService {
  private tools = new Map<string, SelectedTool>()
  private archives = new Map<string, SelectedArchive>()
  private previews = new Map<string, Sealed>()
  private jobs = new Map<string, Job>()
  private closed = false
  private starting = 0
  private generations = new Map<string, number>()
  constructor(
    private context: Context,
    private now: () => number = Date.now,
  ) {}
  async chooseTool(path: string, kind: NativeBackupToolKind): Promise<NativeBackupTool> {
    const selected = await inspectNativeTool(path, kind)
    while (this.tools.size >= 16) this.tools.delete(this.tools.keys().next().value!)
    this.tools.set(selected.tool.id, selected)
    return structuredClone(selected.tool)
  }
  async chooseArchive(path: string): Promise<NativeBackupArchive> {
    const identity = await nativeFileIdentity(path, maxArchive),
      file = await open(identity.path, 'r')
    try {
      const magic = Buffer.alloc(5)
      await file.read(magic, 0, 5, 0)
      if (magic.toString() !== 'PGDMP')
        throw new Error(
          'Select a PostgreSQL custom-format archive (PGDMP). SQL scripts, tar and directory formats are not accepted.',
        )
    } finally {
      await file.close()
    }
    const archive = {
      id: randomUUID(),
      name: basename(identity.path),
      path: identity.path,
      bytes: identity.size,
      sha256: identity.sha256,
    }
    while (this.archives.size >= 8) this.archives.delete(this.archives.keys().next().value!)
    this.archives.set(archive.id, { archive, identity })
    return structuredClone(archive)
  }
  private profile(id: string, restore: boolean) {
    const profile = this.context.profile(id)
    if (profile.engine !== 'postgres')
      throw new Error('Native backup/restore currently supports PostgreSQL custom-format archives only.')
    if (profile.ssh.enabled)
      throw new Error(
        'Native backup through Harbor SSH tunnels is not supported. Choose a separately configured direct PostgreSQL endpoint.',
      )
    if (profile.tls.cert || profile.tls.keyPath)
      throw new Error(
        'Native client-certificate profiles require an additional validated key-handling workflow and are not supported in this slice.',
      )
    if (
      !profile.database ||
      !profile.username ||
      /[\r\n\0]/.test(`${profile.host}${profile.database}${profile.username}`)
    )
      throw new Error('Choose an explicit database, username and valid endpoint.')
    if (restore && profile.readOnly)
      throw new Error('Creating a restore database requires an explicitly writable profile.')
    if (restore && profile.environment.toLowerCase() === 'production')
      throw new Error('Restore drills are restricted to a non-production profile and a new database.')
    return profile
  }
  private async query(
    profile: ConnectionProfile,
    sessionId: string,
    sql: string,
    values: string[] = [],
    database = profile.database,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error('Operation cancelled before database request.')
    const requestId = randomUUID(),
      cancel = () =>
        void this.context.cancel?.({ connectionId: profile.id, sessionId, requestId }).catch(() => undefined)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await this.context.execute({
        connectionId: profile.id,
        database,
        sessionId,
        requestId,
        sql,
        maxRows: 201,
        privateSession: true,
        confirm: profile.name,
        parameters: values.map((value, i) => ({ name: `p${i + 1}`, type: 'text', value, secret: false })),
      })
      if (result.cancelled || signal?.aborted)
        throw new Error(
          'Database request cancelled. Inspect any newly created restore database before continuing.',
        )
      if (result.sets.some((set) => set.truncated || set.rows.length > 200))
        throw new Error('Backup metadata exceeds its bound.')
      return result.sets.flatMap((set) =>
        set.rows.map((row) =>
          Object.fromEntries(
            set.columns.map((column, i) => [column.name, row[i] === null ? '' : String(row[i])]),
          ),
        ),
      )
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  private async server(
    profile: ConnectionProfile,
    sessionId: string,
    database = profile.database,
    signal?: AbortSignal,
  ) {
    const records = await this.query(
      profile,
      sessionId,
      "SELECT current_database() AS database,current_user AS username,current_setting('server_version') AS version,current_setting('server_version_num') AS version_number,inet_server_addr()::text AS address,inet_server_port()::text AS port,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid",
      [],
      database,
      signal,
    )
    if (records.length !== 1 || records[0].database !== database || records[0].username !== profile.username)
      throw new Error('The native target database/user does not match the selected profile.')
    if (Number(records[0].version_number) < 140000)
      throw new Error('This workflow supports PostgreSQL server 14 or later.')
    return records[0]
  }
  private async archiveSummary(selected: SelectedArchive, tool: SelectedTool) {
    await nativeFileIdentity(selected.identity.path, maxArchive, selected.identity)
    const file = await open(selected.identity.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      await verifyOpenNativeFile(file, selected.identity)
      const result = await runNative(tool.identity.path, ['--list', '--format=custom'], {
        input: file.createReadStream({ autoClose: false, start: 0 }),
        timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024,
      })
      await verifyOpenNativeFile(file, selected.identity)
      const sourceVersion =
          /^;\s*Dumped from database version:\s*(.+)$/m.exec(result.stdout)?.[1].trim() || '',
        writerVersion = /^;\s*Dumped by pg_dump version:\s*(.+)$/m.exec(result.stdout)?.[1].trim() || ''
      if (!versionMajor(sourceVersion) || !versionMajor(writerVersion))
        throw new Error('The archive did not expose identifiable source and writer versions.')
      const entries = result.stdout.split(/\r?\n/).filter((line) => line && !line.startsWith(';'))
      return {
        sourceVersion,
        writerVersion,
        entries: entries.length,
        preview: entries.slice(0, 100).map((line) => line.slice(0, 500)),
        truncated: entries.length > 100,
      }
    } finally {
      await file.close()
    }
  }
  async preview(raw: PreviewNativeBackupInput): Promise<NativeBackupPreview> {
    if (this.closed) throw new Error('The backup service is closing.')
    const input = previewNativeBackupSchema.parse(raw),
      profile = this.profile(input.connectionId, input.mode === 'restore'),
      selected = this.tools.get(input.toolId)
    const reviewedProfile = hash(profile),
      generation = this.generations.get(profile.id) || 0
    if (!selected || selected.tool.kind !== (input.mode === 'backup' ? 'pg_dump' : 'pg_restore'))
      throw new Error('Choose the matching native PostgreSQL executable first.')
    const token = randomUUID(),
      expires = this.now() + 300000,
      sessionId = `backup-preview-${token}`,
      database = input.mode === 'backup' ? profile.database : input.newDatabase
    const preview: NativeBackupPreview = {
      token,
      mode: input.mode,
      expiresAt: new Date(expires).toISOString(),
      confirmation: `${input.mode === 'backup' ? 'back up' : 'create and restore'} ${database} on ${profile.name}`,
      target: {
        connectionId: profile.id,
        profile: profile.name,
        host: profile.host,
        port: profile.port,
        database,
        user: profile.username,
        serverVersion: '',
      },
      tool: structuredClone(selected.tool),
      commands: [],
      warnings: [
        'A PostgreSQL logical archive covers one database. Cluster roles, server configuration, physical/PITR recovery and disaster recovery are separate scopes.',
        'Archive contents may contain sensitive data and SQL. Keep files in trusted storage; a checksum detects changes, not whether the source is trustworthy.',
      ],
      blockedReasons: [],
    }
    try {
      await nativeFileIdentity(selected.identity.path, 100 * 1024 * 1024, selected.identity)
      const identity = await this.server(profile, sessionId),
        serverMajor = Math.floor(Number(identity.version_number) / 10000)
      preview.target.serverVersion = identity.version
      if (
        profile.tls.enabled &&
        profile.tls.rejectUnauthorized &&
        !profile.tls.ca &&
        selected.tool.major < 16
      )
        throw new Error(
          'Verified TLS without an explicit CA requires a native tool supporting system trust. Select a newer native tool or configure the CA.',
        )
      if (input.mode === 'backup') {
        if (selected.tool.major < serverMajor)
          throw new Error('pg_dump must be at least as new as the source server major version.')
        preview.commands = [
          'pg_dump --format=custom --verbose --no-password --lock-wait-timeout=10000 --quote-all-identifiers [reviewed direct connection] > [new private partial archive]',
        ]
        preview.warnings.push(
          'A fresh native snapshot includes committed database data only; it does not reuse tab transactions or include their uncommitted work. Writers may continue; conflicting DDL can cause the dump to fail.',
          `Archive cap ${input.maxBytes} bytes; deadline ${input.maxDurationSeconds} seconds. No existing output file is overwritten. Foreign table contents are not fetched.`,
          'Restoring with a server older than this pg_dump major is unsupported by this workflow, even if the source server is older.',
        )
      } else {
        if (input.newDatabase === profile.database)
          throw new Error('Restore must use a new database, distinct from the profile database.')
        const exists = await this.query(
          profile,
          sessionId,
          'SELECT oid::text FROM pg_catalog.pg_database WHERE datname=$1',
          [input.newDatabase],
        )
        if (exists.length)
          throw new Error(
            'That database already exists. Existing databases are never overwritten or reused, even if they appear empty.',
          )
        const archive = this.archives.get(input.archiveId)
        if (!archive) throw new Error('Select a custom archive again.')
        preview.archive = structuredClone(archive.archive)
        preview.archiveSummary = await this.archiveSummary(archive, selected)
        const writer = versionMajor(preview.archiveSummary.writerVersion),
          source = versionMajor(preview.archiveSummary.sourceVersion)
        if (selected.tool.major < writer || serverMajor < writer || serverMajor < source)
          throw new Error(
            'Restore tool and target server majors must be at least the archive writer/source major. Restoring newer-tool output into an older server is not guaranteed by PostgreSQL.',
          )
        preview.commands = [
          `CREATE DATABASE ${quoteIdentifier(input.newDatabase, 'postgres')} TEMPLATE template0;`,
          'pg_restore --format=custom --single-transaction --exit-on-error --no-owner --no-privileges --no-tablespaces --no-password --verbose --dbname=[reviewed NEW database] < [verified archive]',
        ]
        preview.warnings.push(
          'Restoring a trusted archive executes SQL chosen by the source database owners. A fresh database and single transaction do not sandbox SQL or restrict every possible server side effect. Do not restore an untrusted archive.',
          'An explicit new database will be created. Failure or cancellation retains it for inspection; Harbor never drops it automatically. Existing databases, active tabs and their transactions are not reused.',
          'Object ownership becomes the restore user. Global roles and original ownership/ACLs/tablespaces are not restored. Required extensions or roles must already be appropriately available; this tool does not provision them.',
          'Server free disk space cannot be established reliably by this client. Native storage/permission errors are reported. Review server capacity before execution.',
          `Deadline ${input.maxDurationSeconds} seconds; one native restore connection, one transaction. Large object counts can exceed server lock capacity.`,
        )
      }
      if (
        this.closed ||
        generation !== (this.generations.get(profile.id) || 0) ||
        reviewedProfile !== hash(this.context.profile(profile.id))
      )
        throw new Error('The profile or connection changed during review. Preview again.')
      for (const [id, value] of this.previews) if (value.expires < this.now()) this.previews.delete(id)
      while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(token, {
        input: structuredClone(input),
        preview: structuredClone(preview),
        profile: reviewedProfile,
        expires,
        server: hash(identity),
      })
    } catch (error) {
      preview.blockedReasons.push(
        redactNativeText(message(error), Object.values(this.context.secrets(profile.id))),
      )
    } finally {
      await this.context.closeSession({ connectionId: profile.id, sessionId }).catch(() => undefined)
    }
    return preview
  }
  async start(raw: StartNativeBackupInput, outputPath?: string): Promise<NativeBackupJob> {
    const input = startNativeBackupSchema.parse(raw),
      sealed = this.previews.get(input.token)
    if (!sealed || sealed.expires < this.now())
      throw new Error('Backup review expired. Preview the exact target again.')
    if (input.confirm !== sealed.preview.confirmation)
      throw new Error('Type the exact target confirmation shown in the review.')
    if (
      this.closed ||
      this.starting + [...this.jobs.values()].filter((job) => job.snapshot.state === 'running').length >= 2
    )
      throw new Error('The backup service is closing or two native jobs are already running.')
    const profile = this.profile(sealed.input.connectionId, sealed.input.mode === 'restore')
    if (hash(profile) !== sealed.profile)
      throw new Error('The profile changed after preview. Review the target again.')
    if (sealed.input.mode === 'backup' && !outputPath)
      throw new Error('Choose a new backup destination with the native Save dialog.')
    const key = `${profile.host}:${profile.port}/${sealed.preview.target.database}`
    if ([...this.jobs.values()].some((job) => job.key === key && job.snapshot.state === 'running'))
      throw new Error('A native backup/restore job already owns this exact target.')
    this.previews.delete(input.token)
    this.starting++
    try {
      const id = randomUUID(),
        controller = new AbortController()
      const job: Job = {
        key,
        controller,
        started: performance.now(),
        done: Promise.resolve(),
        finalizing: false,
        snapshot: {
          id,
          connectionId: profile.id,
          mode: sealed.input.mode,
          state: 'running',
          phase: 'preparing',
          bytes: 0,
          durationMs: 0,
          message: 'Rechecking tools, target and credentials.',
          warnings: [],
          details: [],
          ...(sealed.input.mode === 'restore' ? { database: sealed.input.newDatabase } : {}),
        },
      }
      while (this.jobs.size >= 50) {
        const completed = [...this.jobs].find(([, value]) => value.snapshot.state !== 'running')
        if (!completed) break
        this.jobs.delete(completed[0])
      }
      this.jobs.set(id, job)
      const generation = this.generations.get(profile.id) || 0
      job.done = this.run(job, sealed, profile, outputPath, generation)
      return this.getJob(id)
    } finally {
      this.starting--
    }
  }
  previewMode(token: string): 'backup' | 'restore' {
    const sealed = this.previews.get(token)
    if (!sealed || sealed.expires < this.now())
      throw new Error('Backup review expired. Preview the exact target again.')
    return sealed.input.mode
  }
  getJob(id: string): NativeBackupJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This native backup job is no longer available.')
    return structuredClone({
      ...job.snapshot,
      durationMs:
        job.snapshot.state === 'running'
          ? Math.round(performance.now() - job.started)
          : job.snapshot.durationMs,
    })
  }
  cancelJob(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This native backup job is no longer available.')
    if (job.snapshot.state === 'running' && !job.finalizing) job.controller.abort()
    return this.getJob(id)
  }
  async cancelForConnection(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    for (const [token, preview] of this.previews)
      if (preview.input.connectionId === id) this.previews.delete(token)
    const jobs = [...this.jobs.values()].filter((job) => job.snapshot.connectionId === id)
    jobs.forEach((job) => {
      if (!job.finalizing) job.controller.abort()
    })
    await Promise.allSettled(jobs.map((job) => job.done))
  }
  async closeAll() {
    this.closed = true
    this.jobs.forEach((job) => {
      if (!job.finalizing) job.controller.abort()
    })
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
    this.tools.clear()
    this.archives.clear()
    this.previews.clear()
  }
  private async connectionEnvironment(
    profile: ConnectionProfile,
    database: string,
    secret: Secrets,
    directory: string,
    jobId: string,
  ) {
    if (/\r|\n|\0/.test(secret.password || ''))
      throw new Error(
        'Multiline/NUL passwords are not supported by the protected native password-file format.',
      )
    const passwordFile = join(directory, 'pgpass')
    await writeFile(
      passwordFile,
      `${[profile.host, String(profile.port), database, profile.username, secret.password || ''].map(passValue).join(':')}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    let sslrootcert = ''
    if (profile.tls.ca) {
      sslrootcert = join(directory, 'root.crt')
      await writeFile(sslrootcert, profile.tls.ca, { flag: 'wx', mode: 0o600 })
    }
    const parameters = {
      host: profile.host,
      port: String(profile.port),
      dbname: database,
      user: profile.username,
      connect_timeout: String(Math.ceil(profile.connectTimeout / 1000)),
      sslmode: !profile.tls.enabled ? 'disable' : profile.tls.rejectUnauthorized ? 'verify-full' : 'require',
      ...(profile.tls.enabled && profile.tls.rejectUnauthorized
        ? { sslrootcert: sslrootcert || 'system' }
        : {}),
    }
    return {
      connection: Object.entries(parameters)
        .map(([key, value]) => `${key}=${connValue(value)}`)
        .join(' '),
      env: {
        PGPASSFILE: passwordFile,
        PGAPPNAME: `harbor-native-${jobId}`,
        HOME: directory,
        USERPROFILE: directory,
        PGSYSCONFDIR: directory,
      },
    }
  }
  private async verifyDatabase(
    profile: ConnectionProfile,
    database: string,
    secrets: Secrets,
    signal: AbortSignal,
  ) {
    // A restored database must never reuse or retarget the user's original tab/session.
    const verification = new SqlService()
    const isolated = { ...profile, id: `restore-verify-${randomUUID()}`, database, readOnly: true }
    const sessionId = 'restore-catalog',
      requestId = randomUUID()
    const cancel = () => {
      void verification.cancel({ connectionId: isolated.id, sessionId, requestId }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('Restore verification was cancelled.')
      const connected = await verification.connect(isolated, secrets)
      if (connected.state !== 'connected')
        throw new Error('The isolated restore verification connection could not be opened.')
      if (signal.aborted) throw new Error('Restore verification was cancelled.')
      const result = await verification.execute({
        connectionId: isolated.id,
        database,
        sessionId,
        requestId,
        privateSession: true,
        maxRows: 1,
        sql: "SELECT (SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p')) AS tables,(SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('v','m')) AS views,(SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind='i') AS indexes,(SELECT count(*)::text FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS constraints,(SELECT count(*)::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS routines",
      })
      if (signal.aborted || result.cancelled || result.sets.length !== 1 || result.sets[0].rows.length !== 1)
        throw new Error('Restore catalog verification did not complete.')
      const set = result.sets[0]
      return Object.fromEntries(
        set.columns.map((column, index) => [column.name, Number(set.rows[0][index])]),
      ) as NonNullable<NativeBackupJob['verification']>
    } finally {
      signal.removeEventListener('abort', cancel)
      await verification.closeAll()
    }
  }
  private async run(
    job: Job,
    sealed: Sealed,
    profile: ConnectionProfile,
    outputPath: string | undefined,
    generation: number,
  ) {
    const input = sealed.input,
      selected = this.tools.get(input.toolId),
      sessionId = `backup-${job.snapshot.id}`,
      signal = job.controller.signal
    let temporary = '',
      file: FileHandle | undefined,
      archiveFile: FileHandle | undefined,
      creating = false,
      created = false,
      restoring = false,
      partial = '',
      finalized = false
    let finalState: NativeBackupJob['state'] = 'failed'
    let redactions: string[] = []
    const check = () => {
      if (
        signal.aborted ||
        this.closed ||
        (this.generations.get(profile.id) || 0) !== generation ||
        hash(this.context.profile(profile.id)) !== sealed.profile
      )
        throw new Error('Native operation cancelled or the profile changed. No retry was attempted.')
    }
    const details = (line: string) => {
      if (!line) return
      job.snapshot.details.push(redactNativeText(line, redactions).slice(0, 2000))
      while (job.snapshot.details.length > 40) job.snapshot.details.shift()
    }
    const deadline = setTimeout(() => job.controller.abort(), input.maxDurationSeconds * 1000)
    deadline.unref()
    try {
      check()
      const secrets = this.context.secrets(profile.id)
      redactions = Object.values(secrets)
      if (!selected) throw new Error('The selected native tool is no longer available.')
      await nativeFileIdentity(selected.identity.path, 100 * 1024 * 1024, selected.identity)
      const identity = await this.server(profile, sessionId, profile.database, signal)
      if (hash(identity) !== sealed.server)
        throw new Error('The database/server identity changed after preview.')
      const parent = this.context.temporaryDirectory || tmpdir()
      await mkdir(parent, { recursive: true, mode: 0o700 })
      temporary = await mkdtemp(join(parent, 'harbor-native-backup-'))
      await chmod(temporary, 0o700)
      const native = await this.connectionEnvironment(
        profile,
        sealed.preview.target.database,
        secrets,
        temporary,
        job.snapshot.id,
      )
      const options = {
        env: native.env,
        signal,
        timeoutMs: input.maxDurationSeconds * 1000,
        onMessage: details,
        secrets: redactions,
        cwd: temporary,
      }
      if (input.mode === 'backup') {
        const destination = resolve(outputPath!),
          parent = await realpath(dirname(destination))
        if (parent !== dirname(destination))
          throw new Error(
            'Choose a destination in a real directory; symbolic-link directory destinations are not supported.',
          )
        try {
          await lstat(destination)
          throw new Error(
            'The destination already exists. Choose a new filename; no existing file is replaced.',
          )
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        }
        const storage = await statfs(parent, { bigint: true })
        if (storage.bavail * storage.bsize < BigInt(input.maxBytes))
          throw new Error(
            'Available destination storage is below the reviewed archive byte cap. Choose a smaller cap or another volume.',
          )
        partial = join(parent, `.${basename(destination)}.harbor-${job.snapshot.id}.partial`)
        file = await open(partial, 'wx+', 0o600)
        job.snapshot.partialPath = partial
        job.snapshot.phase = 'dumping'
        job.snapshot.message =
          'Native pg_dump is streaming a fresh consistent snapshot; bytes are archive bytes, not rows.'
        const digest = createHash('sha256')
        await nativeFileIdentity(selected.identity.path, 100 * 1024 * 1024, selected.identity)
        await runNative(
          selected.identity.path,
          [
            '--format=custom',
            '--verbose',
            '--no-password',
            '--lock-wait-timeout=10000',
            '--quote-all-identifiers',
            `--dbname=${native.connection}`,
          ],
          {
            ...options,
            onOutput: async (chunk) => {
              check()
              if (job.snapshot.bytes + chunk.length > input.maxBytes)
                throw new Error('Archive exceeded its reviewed byte cap. The partial file was not published.')
              await writeNativeChunk(file!, chunk)
              digest.update(chunk)
              job.snapshot.bytes += chunk.length
            },
          },
        )
        check()
        job.snapshot.phase = 'verifying'
        const magic = Buffer.alloc(5)
        await file.read(magic, 0, 5, 0)
        if (magic.toString() !== 'PGDMP' || job.snapshot.bytes < 20)
          throw new Error('The native output is not a valid custom archive header.')
        await file.sync()
        await file.close()
        file = undefined
        check()
        job.finalizing = true
        job.snapshot.phase = 'finalizing'
        await link(partial, destination)
        finalized = true
        job.snapshot.outputPath = destination
        await unlink(partial)
        partial = ''
        delete job.snapshot.partialPath
        job.snapshot.outputPath = destination
        job.snapshot.sha256 = digest.digest('hex')
        finalState = 'completed'
        job.snapshot.message =
          'Native dump completed and the new archive was finalized without replacing any file. A restore drill is still required to establish recoverability.'
      } else {
        const archive = this.archives.get(input.archiveId)
        if (!archive) throw new Error('The selected archive is no longer available.')
        await nativeFileIdentity(archive.identity.path, maxArchive, archive.identity)
        archiveFile = await open(archive.identity.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        await verifyOpenNativeFile(archiveFile, archive.identity)
        if (
          (
            await this.query(
              profile,
              sessionId,
              'SELECT oid::text FROM pg_catalog.pg_database WHERE datname=$1',
              [input.newDatabase],
              profile.database,
              signal,
            )
          ).length
        )
          throw new Error('The reviewed database name now exists. No restore was attempted.')
        check()
        job.snapshot.phase = 'creating-database'
        job.snapshot.message =
          'Creating the exact explicitly reviewed new database; existing databases are never reused.'
        creating = true
        await this.query(
          profile,
          sessionId,
          `CREATE DATABASE ${quoteIdentifier(input.newDatabase, 'postgres')} TEMPLATE template0`,
          [],
          profile.database,
          signal,
        )
        created = true
        check()
        const others = await this.query(
          profile,
          sessionId,
          'SELECT pid::text FROM pg_catalog.pg_stat_activity WHERE datname=$1',
          [input.newDatabase],
          profile.database,
          signal,
        )
        if (others.length)
          throw new Error(
            'Another connection appeared in the newly created restore target. It is retained without restoring.',
          )
        job.snapshot.phase = 'restoring'
        job.snapshot.message =
          'Native restore is executing trusted archive SQL in one transaction; input bytes do not measure committed rows.'
        restoring = true
        await nativeFileIdentity(selected.identity.path, 100 * 1024 * 1024, selected.identity)
        const stream = archiveFile.createReadStream({ autoClose: false, start: 0 })
        stream.on('data', (chunk) => {
          job.snapshot.bytes += Buffer.byteLength(chunk)
        })
        await runNative(
          selected.identity.path,
          [
            '--format=custom',
            '--single-transaction',
            '--exit-on-error',
            '--no-owner',
            '--no-privileges',
            '--no-tablespaces',
            '--no-password',
            '--verbose',
            `--dbname=${native.connection}`,
          ],
          { ...options, input: stream },
        )
        await verifyOpenNativeFile(archiveFile, archive.identity)
        check()
        job.snapshot.phase = 'verifying'
        job.snapshot.message =
          'Native restore finished; inspecting the resulting catalog without running restored functions.'
        job.snapshot.verification = await this.verifyDatabase(profile, input.newDatabase, secrets, signal)
        job.finalizing = true
        finalState = 'completed'
        job.snapshot.message =
          'Native restore completed and catalog counts were read. Verify representative application data before using this database; it remains separate from all existing databases.'
      }
    } catch (error) {
      job.snapshot.warnings.push(redactNativeText(message(error), redactions))
      finalState =
        finalized || restoring || (creating && !created) ? 'unknown' : signal.aborted ? 'cancelled' : 'failed'
      job.snapshot.message = finalized
        ? 'The output file was finalized but subsequent cleanup could not be confirmed. Inspect the reported destination before retrying.'
        : restoring
          ? 'Restore completion could not be confirmed. The new database is retained for inspection; no automatic retry or DROP was attempted.'
          : creating && !created
            ? 'Database creation acknowledgement was not confirmed. Inspect the exact reviewed database name before retrying; no DROP was attempted.'
            : created
              ? 'The new database was created but restore did not complete. It is retained for inspection.'
              : signal.aborted
                ? 'The native job was cancelled before completion. No completed backup was published.'
                : 'The native workflow failed before completion; no automatic retry was attempted.'
      if (created && !restoring)
        job.snapshot.warnings.push(`Retained new database: ${sealed.preview.target.database}`)
    } finally {
      clearTimeout(deadline)
      await file?.close().catch(() => undefined)
      await archiveFile?.close().catch(() => undefined)
      if (partial && !finalized) {
        await unlink(partial).then(
          () => {
            delete job.snapshot.partialPath
          },
          () =>
            job.snapshot.warnings.push(
              'A private partial archive could not be removed; its exact path is shown. It is not a completed backup.',
            ),
        )
      }
      if (temporary)
        await rm(temporary, { recursive: true, force: true }).catch(() =>
          job.snapshot.warnings.push(
            'Temporary protected credential files could not be removed. Close the app and inspect its private temporary directory.',
          ),
        )
      await Promise.allSettled(
        [sessionId, `${sessionId}-verify`].map((id) =>
          this.context.closeSession({ connectionId: profile.id, sessionId: id }),
        ),
      )
      job.snapshot.phase = 'finished'
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
      job.snapshot.state = finalState
    }
  }
}
