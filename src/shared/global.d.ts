import type { ElectronAPI } from './ipc'

// The preload script exposes this bridge; declaring it here makes it visible
// to the renderer's tsconfig, which does not include electron/.
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
