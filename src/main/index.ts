import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  safeStorage,
  session,
  type MenuItemConstructorOptions,
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MetadataStore } from './persistence/store'
import { CredentialService } from './persistence/credentials'
import { SqlService } from './engines/sql'
import { RedisService } from './engines/redis'
import { MongoService } from './engines/mongo'
import { registerIpc } from './ipc'

const runtimeDirectory = fileURLToPath(new URL('.', import.meta.url))

// Test instances are isolated; a packaged application cannot redirect its data through env.
if (!app.isPackaged && process.env.HARBOR_USER_DATA) app.setPath('userData', process.env.HARBOR_USER_DATA)
if (process.platform === 'win32') app.setAppUserModelId('dev.harbordb.desktop')
app.setName('Harbor DB')
const isPrimaryInstance = app.requestSingleInstanceLock()

let window: BrowserWindow | undefined
let store: MetadataStore | undefined
let credentials: CredentialService | undefined
const sql = new SqlService()
const redis = new RedisService()
const mongo = new MongoService()
let shutdownStarted = false
let shutdownComplete = false
let removeIpc: (() => void) | undefined

export async function finishShutdown(): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  try {
    await Promise.allSettled([sql.closeAll(), redis.closeAll(), mongo.closeAll()])
    credentials?.clearAll()
    store?.close()
  } catch (error) {
    dialog.showErrorBox(
      'Harbor DB could not finish saving',
      credentials?.sanitize(error) ||
        'Application metadata could not be flushed. Existing files have been preserved.',
    )
  } finally {
    removeIpc?.()
    shutdownComplete = true
    app.quit()
  }
}

const sendMenu = (action: string): void => window?.webContents.send('harbor:menu', action)
function installMenu(): void {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'Harbor DB',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
              { type: 'separator' },
              { role: 'services' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Connection…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendMenu('new-connection'),
        },
        { label: 'New Query', accelerator: 'CmdOrCtrl+T', click: () => sendMenu('new-query') },
        { label: 'Open SQL…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('import-sql') },
        { label: 'Save Query…', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save-query') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        ...(mac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: mac ? undefined : 'CmdOrCtrl+,',
          click: () => sendMenu('settings'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('command-palette') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged
          ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Query',
      submenu: [
        {
          label: 'Run Selection or Current Statement',
          accelerator: 'CmdOrCtrl+Enter',
          click: () => sendMenu('run-current'),
        },
        {
          label: 'Run Complete Script',
          accelerator: 'CmdOrCtrl+Shift+Enter',
          click: () => sendMenu('run-script'),
        },
        { label: 'Cancel Query', accelerator: 'CmdOrCtrl+.', click: () => sendMenu('cancel-query') },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Harbor DB',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Harbor DB',
              message: `Harbor DB ${app.getVersion()}`,
              detail:
                'A local workspace for PostgreSQL, MariaDB, and Redis.\n\nConnection metadata is stored in the operating system application-data directory. Managed database data is never backed up by exporting Harbor connection profiles.',
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Only the lock owner may initialize storage, windows, or shutdown handlers.
// app.quit() alone does not stop JavaScript execution in a secondary process.
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownStarted) return
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isCrashed()
    ) {
      void finishShutdown()
      return
    }
    sendMenu('prepare-close')
  })
  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      try {
        store = new MetadataStore(app.getPath('userData'))
        credentials = new CredentialService(safeStorage, store)
        const settings = store.workspace().settings
        nativeTheme.themeSource = settings.theme
        const rendererPath = join(runtimeDirectory, '../renderer/index.html')
        const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
        const expectedUrl = devUrl || pathToFileURL(rendererPath).href
        if (devUrl) {
          const url = new URL(devUrl)
          if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
            throw new Error('The development renderer must use a local HTTP server.')
        }
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        )
        session.defaultSession.setPermissionCheckHandler(() => false)
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          const csp = `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${devUrl ? ` ws://${new URL(devUrl).host}` : ''}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`
          callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
        })
        window = new BrowserWindow({
          width: 1440,
          height: 900,
          minWidth: 1024,
          minHeight: 700,
          show: false,
          title: 'Harbor DB',
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#101318' : '#f4f6fa',
          autoHideMenuBar: process.platform !== 'darwin',
          icon: join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
          webPreferences: {
            preload: join(runtimeDirectory, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
          },
        })
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', (event) => event.preventDefault())
        window.webContents.on('will-attach-webview', (event) => event.preventDefault())
        window.webContents.on('render-process-gone', () => {
          if (!shutdownStarted)
            dialog.showErrorBox(
              'Harbor DB workspace stopped',
              'The last saved workspace is preserved. Restart Harbor DB to recover it. Active server operations may have completed; inspect the database before retrying a write.',
            )
        })
        removeIpc = registerIpc(window, expectedUrl, store, credentials, sql, redis, mongo, finishShutdown)
        window.webContents.setZoomFactor(settings.zoom)
        window.on('close', (event) => {
          if (!shutdownComplete) {
            event.preventDefault()
            app.quit()
          }
        })
        window.once('ready-to-show', () => window?.show())
        installMenu()
        if (devUrl) await window.loadURL(devUrl)
        else await window.loadFile(rendererPath)
      } catch (error) {
        dialog.showErrorBox(
          'Harbor DB needs attention',
          error instanceof Error
            ? error.message
            : 'Application initialization failed. Your existing files have been preserved.',
        )
        await finishShutdown()
      }
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Harbor DB could not start',
        error instanceof Error ? error.message : 'Unknown initialization error.',
      )
      app.exit(1)
    })
}
