import type { TLSSocket } from 'node:tls'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VectorService } from '../src/main/engines/vector'
import { profileSchema } from '../src/shared/contracts'

describe('native vector TLS transport', () => {
  it('verifies custom CA, original hostname and mutual TLS without leaking provider bodies', async () => {
    const directory=await mkdtemp(join(tmpdir(),'harbor-vector-tls-'))
    const keyPath=join(directory,'key.pem'), certPath=join(directory,'cert.pem')
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',keyPath,'-out',certPath],{stdio:'ignore'})
    const key=await readFile(keyPath),ca=await readFile(certPath,'utf8')
    let authorized=false
    const server=createServer({key,cert:ca,ca,requestCert:true,rejectUnauthorized:true},(request,response)=>{
      authorized=(request.socket as TLSSocket).authorized
      if(request.url==='/')response.end('{"version":"tls-fixture"}')
      else {response.statusCode=403;response.end('PRIVATE_CUSTOMER_DATA')}
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address || typeof address==='string')throw new Error('TLS fixture did not bind')
    const service=new VectorService()
    const profile=profileSchema.parse({id:'tls',name:'tls',engine:'qdrant',host:'localhost',port:address.port,tls:{enabled:true,rejectUnauthorized:true,ca,cert:ca,keyPath}})
    try {
      expect((await service.connect(profile)).state).toBe('connected');expect(authorized).toBe(true)
      await expect(service.collections(profile.id)).rejects.toThrow('HTTP 403. Provider details omitted')
      await service.disconnect(profile.id)
      await expect(service.connect({...profile,host:'127.0.0.1'})).rejects.toThrow('Vector transport interrupted')
      await expect(service.connect({...profile,tls:{...profile.tls,ca:''}})).rejects.toThrow('Vector transport interrupted')
      await expect(service.connect({...profile,tls:{...profile.tls,cert:'',keyPath:''}})).rejects.toThrow('Vector transport interrupted')
    } finally {await service.closeAll();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true})}
  })
})
