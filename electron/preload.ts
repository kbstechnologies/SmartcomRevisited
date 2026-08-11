import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, type ElectronAPI, type EventChannel, type IpcChannel, type IpcResponse } from '../src/shared/ipc'

/**
 * Renderer listeners take the payload only, but `ipcRenderer` prepends the
 * event object. Wrappers are tracked per (channel, listener) so `off` can
 * remove the same function instance that was registered.
 */
type PayloadListener = (payload: any) => void
type WrappedListener = (event: IpcRendererEvent, payload: any) => void

const wrappers = new Map<string, Map<PayloadListener, WrappedListener>>()

const isAllowed = (channel: string): channel is EventChannel =>
  (EVENT_CHANNELS as readonly string[]).includes(channel)

const electronAPI: ElectronAPI = {
  invoke: async <T = any>(channel: IpcChannel, data?: any): Promise<IpcResponse<T>> => {
    return await ipcRenderer.invoke('ipc-request', { channel, data })
  },

  on: (channel, listener) => {
    if (!isAllowed(channel)) return

    let perChannel = wrappers.get(channel)
    if (!perChannel) {
      perChannel = new Map()
      wrappers.set(channel, perChannel)
    }
    if (perChannel.has(listener)) return

    const wrapped = (_event: IpcRendererEvent, payload: any) => listener(payload)
    perChannel.set(listener, wrapped)
    ipcRenderer.on(channel, wrapped)
  },

  off: (channel, listener) => {
    if (!isAllowed(channel)) return

    const perChannel = wrappers.get(channel)
    const wrapped = perChannel?.get(listener)
    if (!perChannel || !wrapped) return

    ipcRenderer.removeListener(channel, wrapped)
    perChannel.delete(listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
