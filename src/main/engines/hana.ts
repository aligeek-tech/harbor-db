import { randomUUID } from 'node:crypto'
import type { Cell, ConnectionProfile, ConnectionStatus, ObjectInfo, QueryInput, QueryResult, ResultColumn, Secrets, TableInput, TableStructure } from '../../shared/contracts'
import { quoteIdentifier, requiredSqlConfirmation, sqlSafety } from '../../shared/sql'
import { openTransport, type Transport } from './transport'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import { HanaInputError, hanaOptions, hanaColumns, hanaCell, hanaCommand, nativeHanaFactory, type HanaClient, type HanaFactory, type HanaCursor } from './hana-driver'
interface Session { client: HanaClient; busy?: string; closed:boolean; cancelled:boolean; stop?:()=>void }
interface Live { profile:ConnectionProfile; secrets:Secrets; transport:Transport; sessions:Map<string,Session>; opening:Map<string,Promise<Session>>; status:ConnectionStatus; closed:boolean }
const safeError=(error:unknown)=>error instanceof HanaInputError ? error.message : 'HANA rejected or lost the operation. Check permissions, SQL and connectivity; provider details are omitted.'
const literal=(value:string)=> {if(/[\r\n\0]/.test(value))throw new HanaInputError('Invalid HANA catalog filter.');return "'"+value.replaceAll("'","''")+"'"}
export class HanaService {
  private connections=new Map<string,Live>()
  private states=new Map<string,ConnectionStatus>()
  constructor(private readonly factory:HanaFactory=nativeHanaFactory) {}
  status(id:string):ConnectionStatus {return structuredClone(this.connections.get(id)?.status||this.states.get(id)||{state:'disconnected'})}
  private live(id:string) {const live=this.connections.get(id);if(!live||live.closed)throw new HanaInputError('Connect explicitly to HANA.');return live}
  private target(live:Live,database?:string) {if(database&&database!==live.profile.database)throw new HanaInputError('The HANA tab tenant differs from its physical connection. Reconnect another profile explicitly.')}
  private async session(live:Live,id:string):Promise<Session> {
    const old=live.sessions.get(id);if(old){if(old.closed)throw new HanaInputError('This HANA tab connection closed. Open a new tab explicitly.');return old}
    if(live.opening.has(id))return live.opening.get(id)!
    if(live.sessions.size+live.opening.size>=8)throw new HanaInputError('Eight HANA tab connections are already open.')
    const opening=(async()=>{
      const client=await this.factory(hanaOptions(live.profile,live.transport,live.secrets.password||'')), session:Session={client,closed:false,cancelled:false}
      client.on('error',()=>{session.closed=true;session.stop?.();live.status={...live.status,state:'degraded'}})
      let timer:ReturnType<typeof setTimeout>|undefined
      try {
        await Promise.race([new Promise<void>((resolve,reject)=>client.connect(error=>error?reject(error):resolve())),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{client.destroy();reject(new HanaInputError('HANA connection deadline exceeded.'))},live.profile.connectTimeout)})])
        if(live.closed)throw new HanaInputError('HANA profile closed while opening a tab.')
        live.sessions.set(id,session)
        // Each physical tab independently verifies the tenant before user SQL.
        const identity=await this.run(live,session,'SELECT DATABASE_NAME, VERSION FROM SYS.M_DATABASE',randomUUID(),undefined,2)
        if(identity.rows.length!==1||identity.rows[0][0]!==live.profile.database)throw new HanaInputError('The HANA server tenant does not match the explicitly selected database.')
        if(live.profile.schema) {
          client.setAutoCommit(true)
          await this.deadline(live,session,()=>hanaCommand(client,'SET SCHEMA '+quoteIdentifier(live.profile.schema,'hana')))
        }
        return session
      }catch(error){client.destroy();session.closed=true;live.sessions.delete(id);throw error}
      finally {if(timer)clearTimeout(timer)}
    })()
    live.opening.set(id,opening)
    try{return await opening}finally{live.opening.delete(id)}
  }
  private async deadline<T>(live:Live,session:Session,operation:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(signal?.aborted) {
      session.cancelled=true;session.closed=true;session.client.destroy()
      throw new HanaInputError('HANA operation cancelled before submission.')
    }
    let rejectStop!:(error:Error)=>void
    const stopped=new Promise<never>((_,reject)=>{rejectStop=reject})
    const stop=()=>{session.cancelled=true;session.closed=true;session.client.destroy();rejectStop(new HanaInputError('HANA operation cancelled, timed out or disconnected. Server completion is not confirmed.'))}
    session.stop=stop
    const timer=setTimeout(stop,live.profile.queryTimeout)
    signal?.addEventListener('abort',stop,{once:true})
    try{return await Promise.race([stopped,operation()])}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);session.stop=undefined}
  }
  private async run(live:Live,session:Session,sql:string,requestId:string,sink?:QueryStreamSink,maximum=5000) {
    if(session.busy||session.closed||sink?.signal.aborted)throw new HanaInputError('This HANA tab is busy, closed or cancelled.')
    const safety=sqlSafety(sql,'hana')
    if(safety.statementCount!==1||safety.controlsTransaction||/^\s*(?:CALL|DO)\b/i.test(sql))throw new HanaInputError('Run one HANA statement. Session controls, anonymous blocks and procedure result sets are not supported.')
    if(live.profile.readOnly&&!safety.readOnly)throw new HanaInputError('This HANA profile is read-only; no statement was submitted.')
    session.busy=requestId;session.cancelled=false
    let dispatched=false,cursor:HanaCursor|undefined
    const columns:ResultColumn[]=[],rows:Cell[][]=[];let bytes=0,count=0,truncated=false,affectedRows=0
    try {
      await this.deadline(live,session,async()=>{
        // Native read-only transaction protects against side-effectful SELECTs.
        session.client.setAutoCommit(!safety.readOnly)
        if(safety.readOnly)await hanaCommand(session.client,'SET TRANSACTION READ ONLY')
        dispatched=true
        const result=await hanaCommand(session.client,sql)
        if(typeof result==='number') {if(!Number.isSafeInteger(result)||result<0)throw new HanaInputError('HANA affected-row count is not an exact nonnegative integer.');affectedRows=result}
        else if(result) {
          cursor=result;columns.push(...hanaColumns(result.metadata));await sink?.onColumns(columns)
          const stream=result.createObjectStream({rowsAsArray:true,highWaterMark:1})
          try {
            for await(const raw of stream) {
              if(session.cancelled)throw new HanaInputError('HANA operation cancelled.')
              if(!Array.isArray(raw)||raw.length!==columns.length)throw new HanaInputError('HANA returned an unexpected result shape.')
              const row:Cell[]=[]
              for(let i=0;i<raw.length;i++)row.push(await hanaCell(raw[i],result.metadata[i]))
              const size=Buffer.byteLength(JSON.stringify(row))
              if(size>8*1024*1024)throw new HanaInputError('HANA row exceeds 8 MiB; use a bounded native projection.')
              if(!sink&&(count>=maximum||bytes+size>8*1024*1024)){truncated=true;break}
              if(sink)await sink.onRow(row);else rows.push(row)
              count++;bytes+=size
            }
          }finally {stream.destroy()}
          await new Promise<void>((resolve,reject)=>result.close(error=>error?reject(error):resolve()));cursor=undefined
        }else await sink?.onColumns([])
        if(safety.readOnly)await new Promise<void>((resolve,reject)=>session.client.rollback(error=>error?reject(error):resolve()))
      },sink?.signal)
      return {columns,rows,truncated,affectedRows}
    }catch(error){
      session.closed=true;session.client.destroy()
      throw new HanaInputError(safeError(error)+(dispatched&&!safety.readOnly?' Autocommit write outcome is uncertain; inspect the database before retrying.':'')+' No statement was replayed.')
    }finally{if(cursor)session.client.destroy();session.busy=undefined}
  }
  async connect(profile:ConnectionProfile,secrets:Secrets={}):Promise<ConnectionStatus> {
    await this.disconnect(profile.id);let transport:Transport|undefined
    try {
      // Validate before opening SSH or database sockets.
      hanaOptions(profile,{host:profile.host,port:profile.port,close:async()=>{}},secrets.password||'')
      transport=await openTransport(profile,secrets)
      const live:Live={profile:structuredClone(profile),secrets:{...secrets},transport,sessions:new Map(),opening:new Map(),status:{state:'connecting'},closed:false}
      this.connections.set(profile.id,live)
      const id='connect-'+randomUUID(),session=await this.session(live,id)
      const identity=await this.run(live,session,'SELECT DATABASE_NAME, VERSION FROM SYS.M_DATABASE',randomUUID(),undefined,2)
      live.status={state:'connected',version:'SAP HANA '+String(identity.rows[0][1]),transport:profile.tls.enabled?'Verified TLS · direct tenant SQL endpoint':profile.ssh.enabled?'Verified SSH · direct tenant SQL endpoint':'Loopback · direct tenant SQL endpoint',checkedAt:new Date().toISOString()}
      await this.closeSession({connectionId:profile.id,sessionId:id});return structuredClone(live.status)
    }catch(error){await this.disconnect(profile.id);await transport?.close();const status:ConnectionStatus={state:'failed',error:safeError(error)};this.states.set(profile.id,status);return status}
  }
  async listDatabases(id:string) {return [this.live(id).profile.database]}
  private async read(live:Live,sql:string) {
    const id='metadata-'+randomUUID()
    try {const result=await this.run(live,await this.session(live,id),sql,randomUUID());if(result.truncated)throw new HanaInputError('HANA metadata exceeded its 5,000-row/8 MiB view; select a narrower schema.');return result.rows}
    finally {await this.closeSession({connectionId:live.profile.id,sessionId:id})}
  }
  async listObjects(input:{connectionId:string;database?:string;schema?:string}):Promise<ObjectInfo[]> {
    const live=this.live(input.connectionId);this.target(live,input.database)
    const schema=input.schema||live.profile.schema,where=schema?' WHERE SCHEMA_NAME='+literal(schema):''
    const rows=await this.read(live,`SELECT SCHEMA_NAME, TABLE_NAME, 'table' FROM SYS.TABLES${where} UNION ALL SELECT SCHEMA_NAME, VIEW_NAME, 'view' FROM SYS.VIEWS${where} ORDER BY 1,2`)
    return rows.map(row=>({database:live.profile.database,schema:String(row[0]),name:String(row[1]),kind:row[2]==='view'?'view':'table'}))
  }
  async structure(input:{connectionId:string;database?:string;schema:string;table:string}):Promise<TableStructure> {
    const live=this.live(input.connectionId);this.target(live,input.database)
    const where=` WHERE SCHEMA_NAME=${literal(input.schema)} AND TABLE_NAME=${literal(input.table)}`
    let rows=await this.read(live,`SELECT COLUMN_NAME,DATA_TYPE_NAME,LENGTH,SCALE,IS_NULLABLE,DEFAULT_VALUE FROM SYS.TABLE_COLUMNS${where} ORDER BY POSITION`)
    if(!rows.length)rows=await this.read(live,`SELECT COLUMN_NAME,DATA_TYPE_NAME,LENGTH,SCALE,IS_NULLABLE,NULL FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME=${literal(input.schema)} AND VIEW_NAME=${literal(input.table)} ORDER BY POSITION`)
    if(!rows.length)throw new HanaInputError('HANA object metadata is unavailable or not authorized.')
    return {columns:rows.map(row=>({name:String(row[0]),type:String(row[1]) + (row[2]!==null?'('+String(row[2])+(row[3]!==null?','+String(row[3]):'')+')':''),nullable:String(row[4])==='TRUE',primaryKey:false,defaultValue:row[5]===null?null:String(row[5])})),indexes:[],constraints:[],foreignKeys:[],ddl:'-- HANA native column metadata. Executable DDL, indexes and constraints are not inferred.'}
  }
  async execute(input:QueryInput):Promise<QueryResult> {
    const live=this.live(input.connectionId);this.target(live,input.database)
    if(input.parameters?.length)throw new HanaInputError('HANA bound parameters are not enabled; values were not interpolated.')
    const confirmation=requiredSqlConfirmation(input.sql,'hana',live.profile)
    if(confirmation&&input.confirm!==confirmation)throw new HanaInputError('This HANA statement requires the exact target confirmation.')
    const start=performance.now(),result=await this.run(live,await this.session(live,input.sessionId),input.sql,input.requestId,undefined,input.maxRows)
    return {requestId:input.requestId,sets:[{...result,command:'HANA STATEMENT'}],durationMs:Math.round(performance.now()-start),transaction:'idle',messages:['HANA single-statement autocommit for reviewed writes; read queries use native read-only transactions and rollback. Cancelling closes this tab connection and does not prove a server rollback. No automatic replay. Spatial and vector binary values retain native bytes and type labels.']}
  }
  async table(input:TableInput):Promise<QueryResult> {
    if(input.filters?.conditions.length||input.filter)throw new HanaInputError('Use an explicit HANA query for filtering.')
    const structure=await this.structure(input),sorts=input.sorts||(input.sort?[{column:input.sort,direction:input.direction}]:[])
    if(sorts.some(sort=>!structure.columns.some(column=>column.name===sort.column)))throw new HanaInputError('Unknown HANA sort column.')
    const sql=`SELECT * FROM ${quoteIdentifier(input.schema,'hana')}.${quoteIdentifier(input.table,'hana')}${sorts.length?' ORDER BY '+sorts.map(sort=>quoteIdentifier(sort.column,'hana')+(sort.direction==='desc'?' DESC':' ASC')).join(', '):''} LIMIT ${input.limit} OFFSET ${input.offset}`
    return this.execute({...input,sql,maxRows:input.limit,requestId:randomUUID(),privateSession:true})
  }
  async streamQuery(input:StreamQueryInput,sink:QueryStreamSink):Promise<void> {
    const live=this.live(input.connectionId);this.target(live,input.database)
    if(input.parameters?.length||!sqlSafety(input.sql,'hana').readOnly)throw new HanaInputError('HANA full export requires a single read-only query without parameters.')
    const id='export-'+randomUUID()
    try {await this.run(live,await this.session(live,id),input.sql,randomUUID(),sink)}finally{await this.closeSession({connectionId:input.connectionId,sessionId:id})}
  }
  async cancel(input:{connectionId:string;sessionId:string;requestId:string}) {const session=this.live(input.connectionId).sessions.get(input.sessionId);if(!session||session.busy!==input.requestId)return {requested:false,message:'This exact HANA operation is no longer active.'};session.stop?.();return {requested:true,message:'The tab socket was closed. Server termination and autocommit write outcome are not confirmed; inspect before retrying.'}}
  getSessionState(input:{connectionId:string;sessionId:string}) {const live=this.connections.get(input.connectionId),session=live?.sessions.get(input.sessionId);return {state:'idle' as const,connected:!!live&&!live.closed&&!session?.closed,running:!!session?.busy}}
  async closeSession(input:{connectionId:string;sessionId:string}) {const live=this.connections.get(input.connectionId);if(!live)return;await live.opening.get(input.sessionId)?.catch(()=>{});const session=live.sessions.get(input.sessionId);if(session){session.closed=true;session.stop?.();session.client.destroy();live.sessions.delete(input.sessionId)}}
  async disconnect(id:string) {const live=this.connections.get(id);if(live){live.closed=true;for(const session of live.sessions.values()){session.closed=true;session.stop?.();session.client.destroy()}await Promise.allSettled(live.opening.values());await live.transport.close();live.secrets={};live.sessions.clear();this.connections.delete(id)}this.states.set(id,{state:'disconnected'})}
  async closeAll(){await Promise.allSettled([...this.connections.keys()].map(id=>this.disconnect(id)))}
}
