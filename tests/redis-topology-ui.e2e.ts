import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createClient } from 'redis'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'
test.use({trace:'off'})
test('Redis topology connection form, all-node scan, stream groups and explicit bounded capture',async()=>{
  test.skip(!process.env.HARBOR_REDIS_TOPOLOGY_ENV_FILE,'Requires disposable Cluster and Sentinel topology.')
  const credentials=JSON.parse(await readFile(process.env.HARBOR_REDIS_TOPOLOGY_ENV_FILE!,'utf8')) as {data:string;sentinel:string}
  const directory=await mkdtemp(join(tmpdir(),'harbor-redis-topology-ui-')),root=resolve(import.meta.dirname,'..'),channel=`harbor-ui:${randomUUID()}`
  let desktop:ElectronApplication|undefined
  const publish=createClient({socket:{host:'127.0.0.1',port:26371,reconnectStrategy:false},password:credentials.data});publish.on('error',()=>{})
  try{
    await publish.connect()
    const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&entry[0]!=='ELECTRON_RUN_AS_NODE'))
    desktop=await _electron.launch({chromiumSandbox:true,args:[root],cwd:root,env:{...env,HARBOR_USER_DATA:directory}})
    const page=await desktop.firstWindow();await waitForElectronWorkspace(page)
    await page.getByRole('button',{name:'New connection',exact:true}).first().click()
    await selectDatabaseEngine(page, 'Redis')
    const dialog=page.getByRole('dialog')
    await dialog.getByLabel('Connection name',{exact:true}).fill('Cluster UI fixture')
    await dialog.getByLabel('Host',{exact:true}).fill('127.0.0.1')
    await dialog.getByLabel('Port',{exact:true}).fill('26371')
    await dialog.getByLabel('Password',{exact:true}).fill(credentials.data)
    await dialog.getByLabel('Deployment',{exact:true}).selectOption('cluster')
    await expect(dialog.getByLabel('Logical database',{exact:true})).toBeDisabled()
    await expect(dialog.getByLabel('Logical database',{exact:true})).toHaveValue('0')
    await dialog.getByRole('button',{name:'Save and connect',exact:true}).click()
    await expect(page.getByLabel('Cluster UI fixture: connected',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Cluster UI fixture',exact:true}).click()
    await page.getByRole('button',{name:'Browse keys',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:/primary nodes scanned/})).toBeVisible()
    for(let i=0;i<3;i++){const next=page.getByRole('button',{name:'Scan next batch',exact:true});if(await next.isEnabled())await next.click()}
    await expect(page.getByRole('status').filter({hasText:/3\/3 primary nodes scanned/})).toBeVisible()
    await page.getByRole('button',{name:'Topology',exact:true}).click()
    const topology=page.getByRole('dialog',{name:/Redis topology/})
    await topology.getByRole('button',{name:'Refresh topology',exact:true}).click()
    await expect(topology.getByRole('cell',{name:'primary',exact:true})).toHaveCount(3)
    await expect(topology.getByRole('cell',{name:'replica',exact:true})).toHaveCount(3)
    await topology.getByRole('button',{name:'Close',exact:true}).click()
    await page.getByRole('button',{name:'Stream / live tools',exact:true}).click()
    const tools=page.getByRole('dialog',{name:'Redis stream and live tools',exact:true})
    await expect(tools.getByRole('button',{name:'Stop capture',exact:true})).toBeDisabled()
    await tools.getByLabel('Channel to capture',{exact:true}).fill(channel)
    await tools.getByLabel('Capture seconds',{exact:true}).fill('10')
    await tools.getByRole('button',{name:'Start capture',exact:true}).click()
    await expect(tools.getByRole('status')).toContainText('running')
    await publish.publish(channel,'synthetic desktop message')
    await expect(tools.getByText(/synthetic desktop message/)).toBeVisible()
    await tools.getByRole('button',{name:'Stop capture',exact:true}).click()
    await expect(tools.getByRole('status')).toContainText('stopped')
    await page.screenshot({path:join(directory,'redis-capture.png')})
    await tools.getByRole('button',{name:'Close',exact:true}).click()
    const state=await page.evaluate(()=>window.harbor.bootstrap())
    expect(JSON.stringify(state)).not.toContain('synthetic desktop message')
    expect(JSON.stringify(state)).not.toContain(credentials.data)
  }finally{publish.destroy();await desktop?.evaluate(({app})=>app.exit(0)).catch(()=>{});await desktop?.close();await rm(directory,{recursive:true,force:true})}
})
