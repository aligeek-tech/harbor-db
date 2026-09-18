import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { HanaService } from '../src/main/engines/hana'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
const fixture=process.env.HARBOR_HANA_FIXTURE
const service=new HanaService()
let profile:ConnectionProfile,password=''
async function query(sql:string){const sessionId=randomUUID();try{return await service.execute({connectionId:profile.id,sessionId,requestId:randomUUID(),sql,maxRows:10,privateSession:true})}finally{await service.closeSession({connectionId:profile.id,sessionId})}}
describe.skipIf(!fixture)('real authorized disposable HANA target (not a mock)',()=>{
  beforeAll(async()=>{const config=JSON.parse(await readFile(fixture!,'utf8'));if(config.disposable!==true)throw new Error('HANA fixture must explicitly designate a disposable synthetic-data target.');password=config.password;profile=profileSchema.parse({...config.profile,id:randomUUID(),engine:'hana',readOnly:true});const status=await service.connect(profile,{password});expect(status.state,status.error).toBe('connected')})
  afterAll(async()=>{await service.closeAll()})
  it('verifies native catalog and exact SQL values with duplicate labels/null/empty',async()=>{
    expect(await service.listDatabases(profile.id)).toEqual([profile.database])
    expect(await service.listObjects({connectionId:profile.id,schema:profile.schema})).toBeInstanceOf(Array)
    const result=await query(`SELECT CAST('9223372036854775807' AS BIGINT) AS "same", CAST('12345678901234567890.123456789012345678' AS DECIMAL(38,18)) AS "same", CAST(NULL AS NVARCHAR(10)) AS "nil", '' AS "empty", TO_TIMESTAMP('2026-09-18 12:34:56.1234567','YYYY-MM-DD HH24:MI:SS.FF7') AS "stamp", HEXTOBIN('00ff') AS "bytes" FROM DUMMY`)
    expect(result.sets[0].columns.slice(0,2).map(c=>c.name)).toEqual(['same','same'])
    expect(result.sets[0].rows[0].slice(0,4)).toEqual(['9223372036854775807','12345678901234567890.123456789012345678',null,''])
    expect(String(result.sets[0].rows[0][4])).toContain('1234567')
    expect(result.sets[0].rows[0][5]).toEqual({type:'binary',base64:'AP8='})
  })
  it('rejects bad credentials, changed tenant and unreviewed writes then reconnects explicitly',async()=>{
    expect((await service.connect({...profile,id:'bad-auth'},{password:'invalid-'+randomUUID()})).state).toBe('failed')
    expect((await service.connect({...profile,id:'bad-tenant',database:'NOT_THIS_TENANT'},{password})).state).toBe('failed')
    await expect(query('UPDATE DUMMY SET DUMMY=1')).rejects.toThrow('confirmation')
    await service.disconnect(profile.id)
    expect((await service.connect(profile,{password})).state).toBe('connected')
    expect((await query('SELECT 1 FROM DUMMY')).sets[0].rows).toEqual([[1]])
  })
  it('streams native rows with backpressure and explicit cancellation',async()=>{
    let count=0,active=0,peak=0;const controller=new AbortController()
    await expect(service.streamQuery({connectionId:profile.id,sql:'SELECT 1 FROM DUMMY UNION ALL SELECT 2 FROM DUMMY'},{signal:controller.signal,onColumns:async()=>{},onRow:async()=>{active++;peak=Math.max(peak,active);count++;await new Promise(r=>setTimeout(r,5));active--;controller.abort()}})).rejects.toThrow('cancelled')
    expect(count).toBe(1);expect(peak).toBe(1)
  })
})
