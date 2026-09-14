import type { HarborAPI } from '@shared/contracts'
import { previewBootstrap } from './demo'
export const isDesktop = !!window.harbor
const unavailable = async () => {
  throw new Error(
    'This is the browser preview. Run Harbor DB in Electron to connect to your databases and save your workspace.',
  )
}
export const api: HarborAPI =
  window.harbor ||
  new Proxy(
    {
      bootstrap: async () => previewBootstrap,
      onMenu: () => () => {},
      saveWorkspace: async () => {},
      setZoom: async () => {},
    } as unknown as HarborAPI,
    { get: (target, key) => (key in target ? target[key as keyof HarborAPI] : unavailable) },
  )
