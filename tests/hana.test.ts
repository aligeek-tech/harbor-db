import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { profileSchema, type QueryInput } from '../src/shared/contracts'
import { HanaService } from '../src/main/engines/hana'
import { hanaColumns, hanaCell, hanaOptions, nativeHanaFactory, type HanaClient, type HanaColumn, type HanaCursor } from '../src/main/engines/hana-driver'
const profile=profileSchema.parse({id:'hana',name:'HANA fixture',engine:'hana',host:'127.0.0.1',port:30015,username:'fixture',database:'TEST',schema:'FIXTURE',readOnly:false,queryTimeout:1000})
const input=(sql:string,extra:Partial<QueryInput>={}):QueryInput=>({connectionId:profile.id,database:'TEST',sessionId:'tab',requestId:'request',sql,maxRows:2,privateSession:true,...extra})
class Client implements HanaClient {
  commands:string[]=[];destroyed=false;rollbacks=0;writes=0;mode=true;onError?:(error:Error)=>void
  constructor(private readonly response?:(sql:string)=>unknown,private readonly database='TEST'){}
  on(_name:'error',listener:(error:Error)=>void){this.onError=listener}
  connect(callback:(error?:Error)=>void){queueMicrotask(()=>callback())}
  setAutoCommit(value:boolean){this.mode=value}
  rollback(callback:(error?:Error)=>void){this.rollbacks++;callback()}
  destroy(){this.destroyed=true}
  execute(sql:string,_options:unknown,callback:(error:Error|undefined,result?:HanaCursor|number)=>void){
    this.commands.push(sql)
    if(sql==='SET TRANSACTION READ ONLY'||sql.startsWith('SET SCHEMA')){callback(undefined);return}
    if(sql.includes('SYS.M_DATABASE')){callback(undefined,cursor([[this.database,'2.00.080']], [{columnDisplayName:'DATABASE_NAME',dataType:11},{columnDisplayName:'VERSION',dataType:11}]));return}
    const response=this.response?.(sql)
    if(response==='pending')return
    if(response instanceof Error){if(sql.startsWith('UPDATE'))this.writes++;callback(response);return}
    if(sql.startsWith('UPDATE')){this.writes++;callback(undefined,1);return}
    callback(undefined,response as HanaCursor||cursor([['9007199254740993','123.4500',null],['1','',''],['2','0.0000','third']]))
  }
}
const metadata:HanaColumn[]=[{columnDisplayName:'same',dataType:4},{columnDisplayName:'same',dataType:5,fraction:4},{columnDisplayName:'empty',dataType:11}]
function cursor(rows:unknown[][],columns=metadata):HanaCursor{return {metadata:columns,createObjectStream:()=>Readable.from(rows),close:callback=>callback()}}
function fixture(response?:(sql:string)=>unknown,database='TEST') {const clients:Client[]=[];return {clients,service:new HanaService(async()=>{const client=new Client(response,database);clients.push(client);return client})}}
describe('HANA local driver contracts; no live server compatibility claim',()=>{
  it('retains exact values and duplicate columns while limiting loaded rows',async()=>{
    const {service,clients}=fixture();try{
      expect((await service.connect(profile,{password:'synthetic'})).state).toBe('connected')
      const result=await service.execute(input('SELECT * FROM FIXTURE.T'))
      expect(result.sets[0].columns.map(c=>c.name)).toEqual(['same','same','empty'])
      expect(result.sets[0].rows).toEqual([['9007199254740993','123.4500',null],['1','','']])
      expect(result.sets[0].truncated).toBe(true)
      expect(clients.at(-1)!.rollbacks).toBe(2)
      expect(clients.at(-1)!.commands).toContain('SET TRANSACTION READ ONLY')
    }finally{await service.closeAll()}
  })
  it('binds the actual tenant on every physical tab and rejects mismatches before user SQL',async()=>{
    const {service,clients}=fixture(undefined,'OTHER');try{
      expect((await service.connect(profile,{password:'synthetic'})).state).toBe('failed')
      expect(clients.every(c=>c.destroyed)).toBe(true)
      expect(clients.flatMap(c=>c.commands).some(s=>s.includes('UPDATE'))).toBe(false)
    }finally{await service.closeAll()}
  })
  it('fails closed for unreviewed writes, read-only profiles and raw session controls',async()=>{
    const {service,clients}=fixture();try{
      await service.connect(profile,{password:'synthetic'})
      await expect(service.execute(input('UPDATE T SET X=1 WHERE ID=2'))).rejects.toThrow('confirmation')
      await expect(service.execute(input('COMMIT',{confirm:profile.name}))).rejects.toThrow('Session controls')
      await service.connect({...profile,readOnly:true},{password:'synthetic'})
      await expect(service.execute(input('UPDATE T SET X=1 WHERE ID=2',{confirm:profile.name}))).rejects.toThrow('read-only')
      expect(clients.reduce((sum,c)=>sum+c.writes,0)).toBe(0)
    }finally{await service.closeAll()}
  })
  it('does not replay a submitted autocommit write after its acknowledgement is lost',async()=>{
    const {service,clients}=fixture(sql=>sql.startsWith('UPDATE')?new Error('sensitive server contents'):undefined);try{
      await service.connect(profile,{password:'synthetic'})
      await expect(service.execute(input('UPDATE T SET X=1 WHERE ID=2',{confirm:profile.name}))).rejects.toThrow('outcome is uncertain')
      expect(clients.reduce((sum,c)=>sum+c.writes,0)).toBe(1)
      await expect(service.execute(input('SELECT 1 FROM DUMMY'))).rejects.toThrow('closed')
    }finally{await service.closeAll()}
  })
  it('matches cancellation identity, closes the tab socket and preserves another tab',async()=>{
    const {service}=fixture(sql=>sql.includes('LONG_QUERY')?'pending':undefined);try{
      await service.connect(profile,{password:'synthetic'})
      const running=service.execute(input('SELECT LONG_QUERY FROM DUMMY')).then(()=>'',(error:Error)=>error.message)
      await expect.poll(()=>service.getSessionState({connectionId:profile.id,sessionId:'tab'}).running).toBe(true)
      expect((await service.cancel({connectionId:profile.id,sessionId:'tab',requestId:'other'})).requested).toBe(false)
      expect((await service.cancel({connectionId:profile.id,sessionId:'tab',requestId:'request'})).requested).toBe(true)
      expect(await running).toContain('cancelled')
      expect(service.getSessionState({connectionId:profile.id,sessionId:'tab'}).connected).toBe(false)
      expect((await service.execute(input('SELECT 1 FROM DUMMY',{sessionId:'another'}))).sets[0].rows.length).toBe(2)
    }finally{await service.closeAll()}
  })
  it('bounds execution deadlines without an implicit reconnect',async()=>{
    const {service,clients}=fixture(sql=>sql.includes('LONG_QUERY')?'pending':undefined);try{
      await service.connect({...profile,queryTimeout:50},{password:'synthetic'})
      await expect(service.execute(input('SELECT LONG_QUERY FROM DUMMY'))).rejects.toThrow('timed out')
      expect(clients).toHaveLength(2)
    }finally{await service.closeAll()}
  })
  it('honors export backpressure and abort without materializing the whole cursor',async()=>{
    const {service}=fixture();try{
      await service.connect(profile,{password:'synthetic'});let count=0,active=0,peak=0
      await service.streamQuery({connectionId:profile.id,sql:'SELECT * FROM T'},{signal:new AbortController().signal,onColumns:async()=>{},onRow:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;count++}})
      expect([count,peak]).toEqual([3,1])
      const controller=new AbortController()
      await expect(service.streamQuery({connectionId:profile.id,sql:'SELECT * FROM T'},{signal:controller.signal,onColumns:async()=>{},onRow:async()=>controller.abort()})).rejects.toThrow('cancelled')
    }finally{await service.closeAll()}
  })
  it('does not submit export SQL when its signal is already cancelled',async()=>{
    const controller=new AbortController()
    const {service,clients}=fixture()
    try {
      await service.connect(profile,{password:'synthetic'})
      controller.abort()
      await expect(service.streamQuery({connectionId:profile.id,sql:'SELECT PRIVATE_DATA FROM T'},{signal:controller.signal,onColumns:async()=>{},onRow:async()=>{}})).rejects.toThrow(/cancelled/)
      expect(clients.flatMap(client=>client.commands).some(sql=>sql.includes('PRIVATE_DATA'))).toBe(false)
    }finally{await service.closeAll()}
  })
  it('requires verified remote transport, explicit credentials and disables redirects/retries',()=>{
    const transport={host:'127.0.0.1',port:54321,close:async()=>{}}
    expect(()=>hanaOptions({...profile,host:'remote.example'},transport,'secret')).toThrow('verified TLS')
    expect(()=>hanaOptions(profile,transport,'')).toThrow('username/password')
    const options=hanaOptions({...profile,tls:{...profile.tls,enabled:true}},transport,'secret')
    expect(options).toMatchObject({disableCloudRedirect:true,ignoreTopology:true,fetchSize:1,rowsAsArray:true,useTLS:true,rejectUnauthorized:true})
    expect(options).not.toHaveProperty('databaseName')
  })
  it('preserves binary/geometry/vector bytes and rejects inexact or unsupported representations',async()=>{
    expect(await hanaCell(Buffer.from([0,255]),{columnDisplayName:'vector',dataType:96})).toEqual({type:'binary',base64:'AP8='})
    await expect(hanaCell(9007199254740992,{columnDisplayName:'bad',dataType:4})).rejects.toThrow('inexact')
    expect(()=>hanaColumns([{columnDisplayName:'unsupported',dataType:999}])).toThrow('Unsupported')
    await expect(hanaCell(new Date(),{columnDisplayName:'date',dataType:61})).rejects.toThrow('Unsupported')
  })
  it('loads the real pure-JavaScript driver without opening a socket',async()=>{const client=await nativeHanaFactory({host:'127.0.0.1',port:1});client.destroy()})
  it('checks the pinned real protocol decoder for BIGINT, decimal, timestamp precision and binary',async()=>{
    const load=createRequire(import.meta.url),Reader=load('hdb/lib/protocol/Reader.js')
    const big=Buffer.alloc(9);big[0]=1;big.writeBigInt64LE(9223372036854775807n,1)
    expect(new Reader(big).readBigInt()).toBe('9223372036854775807')
    // HANA uses the Julian/Gregorian transition calendar, two days before the proleptic Gregorian Unix offset.
    const stamp=Buffer.alloc(8),ticks=BigInt(Date.UTC(2026,8,18,12,34,56)/1000+62135769600)*10000000n+1234568n;stamp.writeBigInt64LE(ticks)
    expect(new Reader(stamp).readLongDate()).toBe('2026-09-18 12:34:56.123456700')
    expect(new Reader(Buffer.from([2,0,255])).readBinary()).toEqual(Buffer.from([0,255]))
    const fixed=Buffer.alloc(9);fixed[0]=1;fixed.writeBigInt64LE(1234500n,1)
    expect(new Reader(fixed).readFixed8(4)).toBe('123.4500')
  })
})
