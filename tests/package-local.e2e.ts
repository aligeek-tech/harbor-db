import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { diagnosticBundleSchema } from '../src/shared/diagnostic-bundle'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

test('native release package preserves sandbox, exact local values and diagnostics', async () => {
  test.skip(process.env.HARBOR_PACKAGE_LOCAL !== '1', 'Requires an actual native packaged application.')
  const data = await mkdtemp(join(tmpdir(), 'harbor-release-package-'))
  const executablePath = resolve(process.platform === 'darwin'
    ? `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Harbor DB.app/Contents/MacOS/Harbor DB`
    : process.platform === 'win32' ? 'release/win-unpacked/Harbor DB.exe'
      : `release/linux${process.arch === 'arm64' ? '-arm64' : ''}-unpacked/harbor-db`)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] =>
    entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','HARBOR_USER_DATA'].includes(entry[0])))
  // This gate verifies packaged engines and sandbox, not OS credential persistence.
  const desktop = await _electron.launch({executablePath, chromiumSandbox:true,args:[`--user-data-dir=${data}`,'--use-mock-keychain','--password-store=basic'],env:{...env,XDG_CONFIG_HOME:data}})
  try {
    const page = await desktop.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await waitForElectronWorkspace(page)
    expect(page.url()).toMatch(/app\.asar/)
    await inspectElectronSandbox(desktop, page)
    expect(await desktop.evaluate(({app,BrowserWindow}) => {
      const contents=BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences():{sandbox:boolean;contextIsolation:boolean;nodeIntegration:boolean}}
      const p=contents.getLastWebPreferences()
      return {packaged:app.isPackaged,disabled:app.commandLine.hasSwitch('no-sandbox'),sandbox:p.sandbox,isolated:p.contextIsolation,node:p.nodeIntegration,arch:process.arch}
    })).toEqual({packaged:true,disabled:false,sandbox:true,isolated:true,node:false,arch:process.arch})
    for(const engine of ['sqlite','duckdb'] as const) {
      const profile=profileSchema.parse({id:`release-${engine}`,name:`Release ${engine}`,engine,host:'localhost',port:1,readOnly:false,
        sqlite:{path:join(data,'local.sqlite3'),mode:'create'},duckdb:{path:'',mode:'memory'}})
      const value=await page.evaluate(async profile=>{
        await window.harbor.saveProfile({profile,rememberPassword:false})
        await window.harbor.connect({id:profile.id})
        const result=await window.harbor.query({connectionId:profile.id,sessionId:'release',requestId:crypto.randomUUID(),sql:'SELECT 9007199254740993 AS exact_value',maxRows:5,privateSession:true})
        await window.harbor.disconnect(profile.id)
        return result.sets[0].rows[0][0]
      },profile)
      expect(value).toBe('9007199254740993')
    }
    const bundle=await page.evaluate(()=>window.harbor.previewDiagnosticBundle())
    expect(diagnosticBundleSchema.safeParse(bundle).success).toBe(true)
    await page.reload();await waitForElectronWorkspace(page)
    expect(errors).toEqual([])
  } finally {await desktop.close();await rm(data,{recursive:true,force:true})}
})
