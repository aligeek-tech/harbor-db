import { createRequire } from 'node:module'
import { assertDb2Query } from '../../shared/db2'
import { db2Columns, db2Row, DB2_MAX_BYTES, type Db2ColumnMetadata } from './db2-values'
import type { Db2Request, Db2Response } from './db2-protocol'

export interface Db2NativeResult {
  getColumnMetadataSync(): Db2ColumnMetadata[]
  fetchSync(options: { fetchMode: number }): unknown[] | null
  getSQLErrorSync(): { state?: string; sqlstate?: string; message?: string } | null
  closeSync(): void
}
export interface Db2NativeStatement {
  setAttrSync(attribute: number, value: number): unknown
  executeSync(parameters?: unknown[]): Db2NativeResult
  closeSync(): void
}
export interface Db2NativeConnection {
  getInfoSync(code: number): string | number
  prepareSync(sql: string): Db2NativeStatement
  closeSync(): void
}
export interface Db2NativeDriver {
  openSync(connectionString: string, options: { connectTimeout: number }): Db2NativeConnection
}

export function loadDb2Driver(): Db2NativeDriver {
  const require = createRequire(import.meta.url)
  try {
    if (require('ibm_db/package.json').version !== '4.0.1') throw new Error('version')
    return require('ibm_db') as Db2NativeDriver
  } catch {
    throw new Error(
      'Db2 native runtime unavailable. Provision the approved ibm_db 4.0.1 addon and matching IBM CLI for this OS/architecture, including required license terms. Harbor does not download, accept licenses or load arbitrary driver paths.',
    )
  }
}

function native<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    const value = error as { state?: string; sqlstate?: string }
    const state = value?.state ?? value?.sqlstate
    const code = typeof state === 'string' && /^[A-Z0-9]{5}$/.test(state) ? state : undefined
    throw Object.assign(
      new Error(
        `Db2 native operation failed${code ? ` (SQLSTATE ${code})` : ''}. Check permissions, parameter types and server status.`,
      ),
      { state: code, nativeFailure: true },
    )
  }
}

/** All synchronous native APIs run only in the disposable child process. */
export class Db2WorkerRuntime {
  private connection?: Db2NativeConnection
  private busy?: number
  private ack?: { id: number; resolve: () => void }
  constructor(
    private readonly send: (response: Db2Response) => Promise<void>,
    private readonly load: () => Db2NativeDriver = loadDb2Driver,
  ) {}

  async handle(request: Db2Request): Promise<void> {
    if (request.action === 'ack') {
      if (this.ack?.id === request.target) {
        const ack = this.ack
        this.ack = undefined
        ack.resolve()
      }
      return
    }
    if (this.busy !== undefined) {
      await this.send({ id: request.id, error: 'The Db2 session is busy.' })
      return
    }
    this.busy = request.id
    try {
      if (request.action === 'open') {
        if (this.connection) throw new Error('Db2 session is already open.')
        const driver = this.load()
        this.connection = native(() =>
          driver.openSync(request.connectionString, { connectTimeout: Math.ceil(request.timeout / 1000) }),
        )
        const product = String(native(() => this.connection!.getInfoSync(17))) // SQL_DBMS_NAME
        const version = String(native(() => this.connection!.getInfoSync(18))) // SQL_DBMS_VER
        if (
          !/^DB2\/(?:LINUX|NT|AIX|SUN|DARWIN)[A-Z0-9_. -]*$/i.test(product) ||
          !/^(?:11\.0?5|12\.0?1)\./.test(version)
        )
          throw new Error(
            'This adapter requires Db2 LUW 11.5 or 12.1; IBM i, z/OS, Informix and unknown products are unsupported.',
          )
        if (Number(native(() => this.connection!.getInfoSync(2519))) !== 1208)
          throw new Error('This Db2 slice requires a UTF-8 (1208) database to decode exact HEX projections.')
        await this.send({ id: request.id, version: `${product} ${version}` })
      } else if (request.action === 'close') {
        native(() => this.connection?.closeSync())
        this.connection = undefined
        await this.send({ id: request.id })
      } else {
        if (!this.connection) throw new Error('Db2 session is not open.')
        assertDb2Query(request.sql)
        const statement = native(() => this.connection!.prepareSync(request.sql))
        let result: Db2NativeResult | undefined
        let response: Db2Response | undefined
        try {
          if (native(() => statement.setAttrSync(0, Math.max(1, Math.ceil(request.timeout / 1000)))) !== true)
            throw new Error('The Db2 driver could not set its native query deadline.') // SQL_ATTR_QUERY_TIMEOUT
          result = native(() =>
            statement.executeSync(
              request.parameters.map((value) =>
                typeof value === 'object' && value !== null && 'binary' in value
                  ? Buffer.from(value.binary, 'base64')
                  : value,
              ),
            ),
          )
          const metadata = native(() => result!.getColumnMetadataSync())
          const columns = db2Columns(metadata, request.encodings)
          const rows: ReturnType<typeof db2Row>[] = []
          let bytes = 0,
            truncated = false
          if (request.stream) await this.emit(request.id, { columns })
          while (true) {
            const fetched = native(() => result!.fetchSync({ fetchMode: 3 }))
            const diagnostic = native(() => result!.getSQLErrorSync())
            const state = diagnostic?.state ?? diagnostic?.sqlstate
            if (state && state !== '00000' && state !== '02000')
              throw new Error(
                'Db2 reported a fetch diagnostic; refusing a potentially truncated or changed result.',
              )
            if (fetched === null) break
            const row = db2Row(fetched, metadata, request.encodings)
            if (request.stream) await this.emit(request.id, { row })
            else {
              const size = Buffer.byteLength(JSON.stringify(row))
              if (rows.length >= request.maxRows || bytes + size > DB2_MAX_BYTES) {
                truncated = true
                break
              }
              rows.push(row)
              bytes += size
            }
          }
          response = { id: request.id, set: { columns, rows, affectedRows: 0, command: 'SELECT', truncated } }
        } finally {
          try {
            native(() => result?.closeSync())
          } finally {
            native(() => statement.closeSync())
          }
        }
        await this.send(response)
      }
    } catch (error) {
      // Native errors can echo transformed SQL/credentials. Retain SQLSTATE only.
      const value = error as { state?: string; sqlstate?: string; message?: string; nativeFailure?: boolean }
      const state = value?.state ?? value?.sqlstate
      const native = !!state || !(error instanceof Error)
      const message = native
        ? `Db2 operation failed${state && /^[A-Z0-9]{5}$/.test(state) ? ` (SQLSTATE ${state})` : ''}. Inspect database permissions, parameter types and the server status.`
        : error.message
      await this.send({
        id: request.id,
        error: message,
        fatal: request.action === 'open' || !!state?.startsWith('08') || (!!value.nativeFailure && !state),
      })
    } finally {
      this.busy = undefined
    }
  }
  private async emit(id: number, stream: NonNullable<Db2Response['stream']>): Promise<void> {
    const ack = new Promise<void>((resolve) => {
      this.ack = { id, resolve }
    })
    await this.send({ id, stream })
    await ack
  }
}
