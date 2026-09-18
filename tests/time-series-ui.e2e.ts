import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { waitForElectronWorkspace } from './electron-runtime'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('InfluxDB real form, explicit range, exact values and inert reload', async () => {
  const fixture = process.env.HARBOR_TIME_SERIES_FIXTURE
  test.skip(!fixture, 'Requires prepared disposable native InfluxDB2 fixture')
  const creds = JSON.parse(await readFile(fixture!, 'utf8')),
    directory = await mkdtemp(join(tmpdir(), 'harbor-influx-ui-')),
    root = resolve(import.meta.dirname, '..')
  let desktop: ElectronApplication | undefined
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    )
    desktop = await _electron.launch({
      chromiumSandbox: true,
      args: [root],
      cwd: root,
      env: { ...env, HARBOR_USER_DATA: directory },
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await selectDatabaseEngine(dialog, 'InfluxDB 2 Flux')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Influx native fixture')
    await dialog.getByLabel('Port', { exact: true }).fill('18086')
    await dialog.getByLabel('InfluxDB API token', { exact: true }).fill(creds.influxToken)
    await dialog.getByLabel('InfluxDB 2 organization ID', { exact: true }).fill(creds.influxOrgId)
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · InfluxDB v?2.9.1/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Influx native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Influx native fixture', exact: true }).dblclick()
    await expect(page.getByText('InfluxDB 2 · Flux time-series workspace', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Time-series results')).toHaveCount(0)
    await page.getByLabel('Time-series source', { exact: true }).fill('metrics')
    await page.getByLabel('Time-series start', { exact: true }).fill('2026-01-01T00:00:00Z')
    await page.getByLabel('Time-series stop', { exact: true }).fill('2026-01-02T00:00:00Z')
    await page.getByRole('button', { name: 'Inspect measurements / fields in range', exact: true }).click()
    await expect(page.getByLabel('Time-series metadata')).toContainText('harbor_exact')
    await page.getByLabel('InfluxDB measurement', { exact: true }).fill('harbor_exact')
    await page.getByLabel('Time-series field', { exact: true }).fill('signed')
    await page.getByRole('button', { name: 'Run time-series query', exact: true }).click()
    await expect(page.getByLabel('Time-series results')).toContainText('9223372036854775807')
    await expect(page.getByLabel('Time-series results')).toContainText('2026-01-01T00:00:00.123456789Z')
    await page.screenshot({ path: join(dirname(fixture!), 'influx-workspace.png') })
    await expect
      .poll(() =>
        page
          .evaluate(() => window.harbor.bootstrap())
          .then((b) => b.workspace.tabs.filter((t) => t.kind === 'timeseries').length),
      )
      .toBe(1)
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page.getByText('Restored tab · no query executed', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Time-series results')).toHaveCount(0)
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('QuestDB real form, timestamp browse, reviewed SQL and inert draft reload',async()=>{
 const fixture=process.env.HARBOR_QUESTDB_FIXTURE;test.skip(!fixture,'Requires prepared disposable native QuestDB10 fixture')
 const creds=JSON.parse(await readFile(fixture!,'utf8')),directory=await mkdtemp(join(tmpdir(),'harbor-quest-ui-')),root=resolve(import.meta.dirname,'..');let desktop:ElectronApplication|undefined
 try{
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&entry[0]!=='ELECTRON_RUN_AS_NODE'))
  desktop=await _electron.launch({chromiumSandbox:true,args:[root],cwd:root,env:{...env,HARBOR_USER_DATA:directory}});const page=await desktop.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await waitForElectronWorkspace(page)
  await page.getByRole('button',{name:'New connection',exact:true}).first().click();const dialog=page.getByRole('dialog');await selectDatabaseEngine(dialog, 'QuestDB');await dialog.getByLabel('Connection name',{exact:true}).fill('Quest native fixture');await dialog.getByLabel('Port',{exact:true}).fill('19000');await dialog.getByLabel('Username',{exact:true}).fill('harbor');await dialog.getByLabel('Password',{exact:true}).fill(creds.questPassword)
  await dialog.getByRole('button',{name:'Test connection',exact:true}).click();await expect(dialog.getByText(/Connection successful · Build Information: QuestDB 10.0.1/)).toBeVisible();await dialog.getByLabel('Read-only safeguard',{exact:true}).uncheck();await dialog.getByRole('button',{name:'Save and connect',exact:true}).click();await expect(page.getByLabel('Quest native fixture: connected',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Quest native fixture',exact:true}).dblclick()
  await page.getByLabel('Time-series source',{exact:true}).fill('harbor_series');await page.getByLabel('Time-series start',{exact:true}).fill('2026-01-01T00:00:00Z');await page.getByLabel('Time-series stop',{exact:true}).fill('2026-01-02T00:00:00Z');await page.getByRole('button',{name:'Inspect timestamp and column types',exact:true}).click();await expect(page.getByLabel('Time-series metadata')).toContainText('designated timestamp');await page.getByRole('button',{name:'Run time-series query',exact:true}).click();await expect(page.getByLabel('Time-series results')).toContainText('12345678901234567890.123456789012345678');await expect(page.getByLabel('Time-series results')).toContainText('2026-01-01T00:00:00.123456789Z');await page.screenshot({path:join(dirname(fixture!),'questdb-workspace.png')})
  await page.getByLabel('QuestDB operation',{exact:true}).selectOption('sql');const sql="SELECT ts,host,exact FROM harbor_series WHERE host='a' LATEST ON ts PARTITION BY host";await page.getByLabel('QuestDB SQL',{exact:true}).fill(sql);await expect(page.getByRole('button',{name:'Run time-series query',exact:true})).toBeDisabled();const profile=await page.evaluate(()=>window.harbor.bootstrap()).then(b=>b.profiles.find(p=>p.name==='Quest native fixture')!);await page.getByLabel('Confirm QuestDB SQL',{exact:true}).fill('EXECUTE QUESTDB '+profile.id);await page.getByRole('button',{name:'Run time-series query',exact:true}).click();await expect(page.getByLabel('Time-series results')).toContainText('1 rows');await expect(page.getByLabel('Confirm QuestDB SQL',{exact:true})).toHaveValue('')
  await expect.poll(()=>page.evaluate(()=>window.harbor.bootstrap()).then(b=>b.workspace.tabs.find(t=>t.connectionId===profile.id)?.seriesDraft?.source)).toBe('harbor_series');await page.reload();await waitForElectronWorkspace(page);await expect(page.getByText('Restored tab · no query executed',{exact:true})).toBeVisible();expect(await page.evaluate(()=>window.harbor.bootstrap()).then(b=>b.workspace.tabs.find(t=>t.connectionId===profile.id)?.sql)).toBe(sql);await expect(page.getByLabel('Time-series results')).toHaveCount(0);expect(errors).toEqual([])
 }finally{await desktop?.close();await rm(directory,{recursive:true,force:true})}
})
