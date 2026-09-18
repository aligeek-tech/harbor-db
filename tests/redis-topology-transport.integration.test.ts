import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { RedisService } from '../src/main/engines/redis'

const file = process.env.HARBOR_REDIS_TOPOLOGY_ENV_FILE
const secrets = file ? JSON.parse(readFileSync(file, 'utf8')) as { data: string; sentinel: string } : { data: '', sentinel: '' }
describe.skipIf(!file)('Real topology transport and lost acknowledgement', () => {
  const service = new RedisService(), servers: tls.Server[] = [], sockets = new Set<net.Socket>(), upstreams = new Set<net.Socket>()
  const mappings: { discovered: string; host: string; port: number }[] = []
  let directory = '', ca = '', mute = false
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'harbor-redis-tls-'))
    const config = join(directory, 'cert.conf'), key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
    writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Harbor disposable Redis fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1\n')
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-config',config], { stdio: 'ignore' })
    ca = readFileSync(cert,'utf8')
    for (const port of [26371,26372,26373,26374,26375,26376,26381,26382,26391,26392,26393]) {
      const server = tls.createServer({ cert: ca, key: readFileSync(key), minVersion: 'TLSv1.2' }, (socket) => {
        const remote = net.connect({host:'127.0.0.1',port});sockets.add(socket);sockets.add(remote);upstreams.add(remote)
        socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy())
        socket.on('close',()=>{sockets.delete(socket);remote.destroy()});remote.on('close',()=>{sockets.delete(remote);upstreams.delete(remote);socket.destroy()})
        socket.pipe(remote);remote.on('data',(chunk)=>{if(!mute)socket.write(chunk)})
      })
      server.on('tlsClientError',()=>{}); await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));servers.push(server)
      mappings.push({discovered:`127.0.0.1:${port}`,host:'127.0.0.1',port:(server.address() as net.AddressInfo).port})
    }
  },20000)
  afterAll(async()=>{await service.closeAll();for(const socket of sockets)socket.destroy();await Promise.all(servers.map((server)=>new Promise<void>((resolve)=>server.close(()=>resolve()))));if(directory)rmSync(directory,{recursive:true,force:true})})
  const profile = (mode:'cluster'|'sentinel') => profileSchema.parse({id:`tls-${mode}`,name:`TLS ${mode}`,engine:'redis',host:'127.0.0.1',port:mappings.find((row)=>row.discovered===`127.0.0.1:${mode==='cluster'?26371:26391}`)!.port,readOnly:false,queryTimeout:1000,tls:{enabled:true,rejectUnauthorized:true,ca},redis:{mode,serviceName:'harbor-fixture',addressMap:mappings}})
  it('verifies TLS identity on mapped Cluster and Sentinel data/discovery connections',async()=>{
    for(const mode of ['cluster','sentinel'] as const){const target=profile(mode);const status=await service.connect(target,{password:secrets.data,sentinelPassword:secrets.sentinel});expect(status.state,status.error).toBe('connected');expect((await service.topology(target.id)).mode).toBe(mode)}
    const wrong={...profile('cluster'),id:'wrong-name',host:'localhost'}
    expect((await service.connect(wrong,{password:secrets.data})).state).toBe('failed')
  },15000)
  it('does not replay a Cluster write whose reply is lost',async()=>{
    const target=profile('cluster'),key=`harbor-no-replay:${randomUUID()}`
    mute=true
    try{await expect(service.execute({connectionId:target.id,sessionId:'s',requestId:'r',sql:`INCR ${key}`,maxRows:10,privateSession:true})).rejects.toThrow('write may have reached the server')}finally{mute=false}
    expect(service.status(target.id).state).toBe('failed')
    let value: string|null=null
    for(const port of [26371,26372,26373,26374,26375,26376]){
      const c=createClient({socket:{host:'127.0.0.1',port,reconnectStrategy:false},password:secrets.data});c.on('error',()=>{});await c.connect()
      try{const info=await c.info('replication');if(!info.includes('role:master'))continue;try{value=await c.get(key);if(value!==null){await c.del(key);break}}catch(error){if(!(error instanceof Error)||!error.message.startsWith('MOVED'))throw error}}finally{c.destroy()}
    }
    expect(value).toBe('1')
  },10000)
})
