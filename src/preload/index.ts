import { contextBridge, ipcRenderer } from 'electron'
import type { HarborAPI } from '../shared/contracts'

// Explicit methods keep the renderer from selecting channels or privileged file paths.
const api: HarborAPI = {
  bootstrap: () => ipcRenderer.invoke('harbor:bootstrap'),
  saveProfile: (input) => ipcRenderer.invoke('harbor:saveProfile', input),
  deleteProfile: (id) => ipcRenderer.invoke('harbor:deleteProfile', id),
  forgetPassword: (id) => ipcRenderer.invoke('harbor:forgetPassword', id),
  testConnection: (input) => ipcRenderer.invoke('harbor:testConnection', input),
  connect: (input) => ipcRenderer.invoke('harbor:connect', input),
  disconnect: (id) => ipcRenderer.invoke('harbor:disconnect', id),
  status: (id) => ipcRenderer.invoke('harbor:status', id),
  saveWorkspace: (input) => ipcRenderer.invoke('harbor:saveWorkspace', input),
  listObjects: (input) => ipcRenderer.invoke('harbor:listObjects', input),
  listDatabases: (id) => ipcRenderer.invoke('harbor:listDatabases', id),
  structure: (input) => ipcRenderer.invoke('harbor:structure', input),
  query: (input) => ipcRenderer.invoke('harbor:query', input),
  cancel: (input) => ipcRenderer.invoke('harbor:cancel', input),
  transaction: (input) => ipcRenderer.invoke('harbor:transaction', input),
  closeSession: (input) => ipcRenderer.invoke('harbor:closeSession', input),
  getSessionState: (input) => ipcRenderer.invoke('harbor:getSessionState', input),
  table: (input) => ipcRenderer.invoke('harbor:table', input),
  applyEdits: (input) => ipcRenderer.invoke('harbor:applyEdits', input),
  redisScan: (input) => ipcRenderer.invoke('harbor:redisScan', input),
  redisInspect: (input) => ipcRenderer.invoke('harbor:redisInspect', input),
  redisMutate: (input) => ipcRenderer.invoke('harbor:redisMutate', input),
  saveQuery: (input) => ipcRenderer.invoke('harbor:saveQuery', input),
  deleteQuery: (id) => ipcRenderer.invoke('harbor:deleteQuery', id),
  clearHistory: () => ipcRenderer.invoke('harbor:clearHistory'),
  clearDrafts: () => ipcRenderer.invoke('harbor:clearDrafts'),
  exportProfiles: () => ipcRenderer.invoke('harbor:exportProfiles'),
  previewImport: () => ipcRenderer.invoke('harbor:previewImport'),
  importProfiles: (input) => ipcRenderer.invoke('harbor:importProfiles', input),
  exportResults: (input) => ipcRenderer.invoke('harbor:exportResults', input),
  importSql: () => ipcRenderer.invoke('harbor:importSql'),
  exportSql: (input) => ipcRenderer.invoke('harbor:exportSql', input),
  setZoom: (value) => ipcRenderer.invoke('harbor:setZoom', value),
  readyToClose: () => ipcRenderer.invoke('harbor:readyToClose'),
  onMenu: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action === 'string') callback(action)
    }
    ipcRenderer.on('harbor:menu', listener)
    return () => ipcRenderer.removeListener('harbor:menu', listener)
  },
}
contextBridge.exposeInMainWorld('harbor', Object.freeze(api))
