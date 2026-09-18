import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  EditsInput,
  Engine,
  HarborAPI,
  ObjectInfo,
  QueryInput,
  QueryResult,
  ResultColumn,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import type { QueryParameter } from '../../shared/parameters'
import { engineDefinitions, engineSupports, type Capability } from '../../shared/capabilities'

export interface ConnectionAdapter {
  connect(profile: ConnectionProfile, secrets?: Secrets): Promise<ConnectionStatus>
  status(id: string): ConnectionStatus
  disconnect(id: string): Promise<void>
  closeAll(): Promise<void>
}
export interface CatalogAdapter {
  listObjects(input: { connectionId: string; database?: string; schema?: string }): Promise<ObjectInfo[]>
  listDatabases(id: string): Promise<string[]>
  structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure>
}
export interface QueryAdapter {
  execute(input: QueryInput): Promise<QueryResult>
  cancel: HarborAPI['cancel']
  closeSession: HarborAPI['closeSession']
  getSessionState(
    input: Parameters<HarborAPI['getSessionState']>[0],
  ): Awaited<ReturnType<HarborAPI['getSessionState']>> | ReturnType<HarborAPI['getSessionState']>
}
export interface TransactionAdapter {
  transaction: HarborAPI['transaction']
}
export interface EditableAdapter {
  applyEdits(input: EditsInput): Promise<{ affectedRows: number }>
}
export interface StreamQueryInput {
  connectionId: string
  database?: string
  sessionId?: string
  sql: string
  parameters?: QueryParameter[]
}
export interface QueryStreamSink {
  signal: AbortSignal
  onColumns(columns: ResultColumn[]): Promise<void>
  onRow(row: Cell[]): Promise<void>
}
export interface ExportAdapter {
  streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void>
}
export interface RelationalAdapter extends ConnectionAdapter, CatalogAdapter, QueryAdapter {
  table(input: TableInput): Promise<QueryResult>
  transaction?: TransactionAdapter['transaction']
  applyEdits?: EditableAdapter['applyEdits']
  streamQuery?: ExportAdapter['streamQuery']
}

/** First-party registrations only. Unsupported engines never fall through to a different wire protocol. */
export class AdapterRegistry {
  private entries = new Map<Engine, { connection: ConnectionAdapter; relational?: RelationalAdapter }>()
  register(engine: Engine, adapter: ConnectionAdapter, relational?: RelationalAdapter): void {
    if (this.entries.has(engine)) throw new Error(`The ${engine} adapter was already registered.`)
    if (engineSupports(engine, 'sql') !== !!relational)
      throw new Error(`${engine} registration does not match its declared SQL capability.`)
    if (relational) {
      for (const [capability, method] of [
        ['transactions', 'transaction'],
        ['rowEdits', 'applyEdits'],
        ['streamExport', 'streamQuery'],
      ] as const)
        if (engineSupports(engine, capability) && !relational[method])
          throw new Error(`${engine} declares ${capability} without an implementation.`)
    }
    this.entries.set(engine, { connection: adapter, relational })
  }
  connection(engine: Engine): ConnectionAdapter {
    const entry = this.entries.get(engine)
    if (!entry) throw new Error(`${engineDefinitions[engine].name} is not available in this runtime.`)
    return entry.connection
  }
  relational(engine: Engine): RelationalAdapter {
    this.requireCapability(engine, 'sql')
    return this.entries.get(engine)!.relational!
  }
  requireCapability(engine: Engine, capability: Capability): void {
    this.connection(engine)
    if (!engineSupports(engine, capability))
      throw new Error(`${engineDefinitions[engine].name} does not support ${capability} in Harbor.`)
  }
}
