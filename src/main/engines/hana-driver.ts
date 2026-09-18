import type { Readable } from 'node:stream'
import type { ConnectionProfile, Cell, ResultColumn } from '../../shared/contracts'
import type { Transport } from './transport'

export class HanaInputError extends Error {}
export interface HanaColumn { columnDisplayName: string; dataType: number; fraction?: number; length?: number; mode?: number }
export interface HanaCursor { metadata: HanaColumn[]; createObjectStream(options: { rowsAsArray: true; highWaterMark: number }): Readable; close(callback: (error?: Error) => void): void }
export interface HanaClient {
  on(name: 'error', listener: (error: Error) => void): unknown
  connect(callback: (error?: Error) => void): void
  execute(sql: string, options: { rowsAsArray: true; fetchSize: number; readSize: number }, callback: (error: Error | undefined, result?: HanaCursor | number, ...extra: unknown[]) => void): void
  setAutoCommit(value: boolean): void
  rollback(callback: (error?: Error) => void): void
  destroy(): void
}
export type HanaFactory = (options: Record<string, unknown>) => Promise<HanaClient>
export const nativeHanaFactory: HanaFactory = async options => {
  // The pinned driver's debug/trace modes can log wire payloads. Do not import it
  // while inherited tracing is enabled; never mutate the host process environment.
  if (process.env.HDB_TRACE || /(?:^|[,\s])(?:hdb[^,\s]*|\*)(?:$|[,\s])/i.test(process.env.NODE_DEBUG || ''))
    throw new HanaInputError('Disable HDB_TRACE and HDB NODE_DEBUG tracing before connecting; wire contents must remain private.')
  const module = await import('hdb')
  return module.default.createClient(options) as HanaClient
}
export function hanaOptions(profile: ConnectionProfile, transport: Transport, password: string): Record<string, unknown> {
  if (profile.engine !== 'hana' || !profile.username || !password || !profile.database)
    throw new HanaInputError('Enter an explicit HANA tenant database, SQL endpoint and username/password.')
  if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
    throw new HanaInputError('HANA TLS requires certificate and hostname verification.')
  if (!profile.tls.enabled && !profile.ssh.enabled && !['localhost', '127.0.0.1', '::1'].includes(profile.host))
    throw new HanaInputError('Remote HANA endpoints require verified TLS or SSH.')
  return {
    host: transport.host, port: transport.port, user: profile.username, password,
    // Connect directly to the tenant SQL port. Never follow a server-selected target.
    disableCloudRedirect: true, ignoreTopology: true, compress: false,
    connectTimeout: profile.connectTimeout, fetchSize: 1, readSize: 65536,
    rowsAsArray: true, useCesu8: false, vectorOutputType: 'Buffer',
    packetSize: 131072, packetSizeLimit: 1048576,
    ...(profile.tls.enabled ? { ...transport.tls, useTLS: true, rejectUnauthorized: true } : {}),
  }
}
const names: Record<number,string> = { 0:'NULL',1:'TINYINT',2:'SMALLINT',3:'INTEGER',4:'BIGINT',5:'DECIMAL',6:'REAL',7:'DOUBLE',8:'CHAR',9:'VARCHAR',10:'NCHAR',11:'NVARCHAR',12:'BINARY',13:'VARBINARY',14:'DATE',15:'TIME',16:'TIMESTAMP',25:'CLOB',26:'NCLOB',27:'BLOB',28:'BOOLEAN',29:'STRING',30:'NSTRING',31:'BLOB LOCATOR',32:'NCLOB LOCATOR',33:'BSTRING',35:'VARCHAR',51:'TEXT',52:'SHORTTEXT',53:'BINTEXT',55:'ALPHANUM',61:'LONGDATE',62:'SECONDDATE',63:'DAYDATE',64:'SECONDTIME',74:'ST_GEOMETRY',75:'ST_POINT',76:'FIXED16',81:'FIXED8',82:'FIXED12',96:'REAL_VECTOR' }
export function hanaColumns(metadata: HanaColumn[]): ResultColumn[] {
  if (!Array.isArray(metadata) || metadata.length > 2000 || metadata.some(item => !names[item.dataType] || typeof item.columnDisplayName !== 'string'))
    throw new HanaInputError('Unsupported HANA result type or more than 2,000 columns. Use an explicit native scalar projection.')
  return metadata.map(item => ({name:item.columnDisplayName,type:names[item.dataType] + ([5,76,81,82].includes(item.dataType) ? `(scale=${item.fraction ?? 0})` : '')}))
}
export async function hanaCell(value: unknown, column: HanaColumn): Promise<Cell> {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (![6,7].includes(column.dataType) && !Number.isSafeInteger(value))
      throw new HanaInputError('HANA driver returned an inexact numeric value; no rounded value was displayed.')
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return {type:'binary',base64:value.toString('base64')}
  if (value && typeof value === 'object' && 'createReadStream' in value && typeof value.createReadStream === 'function') {
    const stream = value.createReadStream() as Readable, chunks:Buffer[]=[]
    let size=0
    try {
      for await (const part of stream) { const chunk=Buffer.from(part);size+=chunk.length;if(size>8*1024*1024) throw new HanaInputError('HANA LOB exceeds the 8 MiB cell limit. Use an explicit bounded native projection.');chunks.push(chunk) }
    } finally { stream.destroy() }
    const bytes=Buffer.concat(chunks)
    return [25,26,32,51,53].includes(column.dataType) ? new TextDecoder('utf-8',{fatal:true}).decode(bytes) : {type:'binary',base64:bytes.toString('base64')}
  }
  throw new HanaInputError('Unsupported HANA cell representation; use an explicit native scalar projection.')
}
export function hanaCommand(client: HanaClient, sql:string): Promise<HanaCursor|number|undefined> {
  return new Promise((resolve,reject)=>client.execute(sql,{rowsAsArray:true,fetchSize:1,readSize:65536},(error,result,...extra)=> {
    if(error) reject(error)
    else if(extra.length) reject(new HanaInputError('Multiple HANA procedure results are not supported. Use a single SELECT statement.'))
    else resolve(result)
  }))
}
