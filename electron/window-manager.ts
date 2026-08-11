import { BrowserWindow, app, screen } from 'electron'
import { join } from 'path'
import { APP_NAME } from '../src/shared/constants'

export interface DetachedWindowInfo {
  windowId: number
  sessionIds: string[]
  title: string
}

interface CreateOptions {
  preloadPath: string
  /** Vite dev server URL when running unpackaged; undefined when packaged. */
  devServerUrl?: string
  /** Built renderer entry, used when packaged. */
  indexPath: string
}

/**
 * Owns the main window plus any number of detached terminal windows.
 *
 * Detached windows exist so terminals can live on a second monitor. They render
 * the same app in a terminals-only mode: the button panel stays in the main
 * window, and buttons act on whichever pane has focus — in any window — because
 * the active session is tracked here rather than per-window.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private detached = new Map<number, { window: BrowserWindow; sessionIds: string[] }>()
  private activeSessionId: string | null = null

  constructor(private readonly options: CreateOptions) {}

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window
    window.on('closed', () => {
      this.mainWindow = null
      // The button panel lives here; detached terminals are useless without it.
      for (const { window: detachedWindow } of this.detached.values()) {
        if (!detachedWindow.isDestroyed()) detachedWindow.close()
      }
      this.detached.clear()
    })
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /** Every live window, so session output reaches whichever one displays it. */
  private allWindows(): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    if (this.mainWindow && !this.mainWindow.isDestroyed()) windows.push(this.mainWindow)
    for (const { window } of this.detached.values()) {
      if (!window.isDestroyed()) windows.push(window)
    }
    return windows
  }

  /**
   * Sends to every window. Session events must be broadcast because a session's
   * pane may be in a detached window while the panel that started it is not.
   */
  broadcast(channel: string, payload: unknown) {
    for (const window of this.allWindows()) {
      window.webContents.send(channel, payload)
    }
  }

  // --- Active session (shared across windows) --------------------------------

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  /**
   * Records which pane has focus, wherever it lives, and tells every window.
   * This is what lets the main window's buttons target a terminal that is
   * displayed on another monitor.
   */
  setActiveSession(sessionId: string | null) {
    if (this.activeSessionId === sessionId) return
    this.activeSessionId = sessionId
    this.broadcast('active-session-changed', { sessionId })
  }

  // --- Detached windows ------------------------------------------------------

  /** Which window currently owns each session, so panes are never duplicated. */
  placement(): Record<string, number> {
    const map: Record<string, number> = {}
    for (const [windowId, entry] of this.detached) {
      for (const sessionId of entry.sessionIds) map[sessionId] = windowId
    }
    return map
  }

  private announcePlacement() {
    this.broadcast('session-placement-changed', { placement: this.placement() })
  }

  list(): DetachedWindowInfo[] {
    return Array.from(this.detached.entries()).map(([windowId, entry]) => ({
      windowId,
      sessionIds: entry.sessionIds,
      title: entry.window.isDestroyed() ? '' : entry.window.getTitle(),
    }))
  }

  async detach(sessionIds: string[]): Promise<DetachedWindowInfo> {
    // A session can only be shown in one place, so take it from any window
    // that already holds it before handing it to the new one.
    for (const entry of this.detached.values()) {
      entry.sessionIds = entry.sessionIds.filter((id) => !sessionIds.includes(id))
    }

    // Open on the display the pointer is on, so it lands where the user is.
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x, y, width, height } = display.workArea

    const window = new BrowserWindow({
      width: Math.min(1100, Math.round(width * 0.7)),
      height: Math.min(760, Math.round(height * 0.8)),
      x: x + Math.round(width * 0.1),
      y: y + Math.round(height * 0.08),
      minWidth: 480,
      minHeight: 320,
      backgroundColor: '#111827',
      title: `${APP_NAME} — Terminals`,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      show: false,
    })

    const windowId = window.id
    this.detached.set(windowId, { window, sessionIds: [...sessionIds] })

    const query = new URLSearchParams({
      mode: 'detached',
      windowId: String(windowId),
      sessions: sessionIds.join(','),
    }).toString()

    if (this.options.devServerUrl) {
      await window.loadURL(`${this.options.devServerUrl}?${query}`)
    } else {
      await window.loadFile(this.options.indexPath, { search: query })
    }

    window.once('ready-to-show', () => window.show())

    window.on('closed', () => {
      this.detached.delete(windowId)
      this.announcePlacement()
    })

    this.announcePlacement()
    return { windowId, sessionIds: [...sessionIds], title: window.getTitle() }
  }

  /** Closes a detached window; its sessions return to the main window's layout. */
  reattach(windowId: number): boolean {
    const entry = this.detached.get(windowId)
    if (!entry) return false

    if (!entry.window.isDestroyed()) entry.window.close()
    this.detached.delete(windowId)
    this.announcePlacement()
    return true
  }

  /** Drops a closed session from whichever window was showing it. */
  forgetSession(sessionId: string) {
    let changed = false
    for (const entry of this.detached.values()) {
      const next = entry.sessionIds.filter((id) => id !== sessionId)
      if (next.length !== entry.sessionIds.length) {
        entry.sessionIds = next
        changed = true
      }
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
    if (changed) this.announcePlacement()
  }

  closeAll() {
    for (const { window } of this.detached.values()) {
      if (!window.isDestroyed()) window.close()
    }
    this.detached.clear()
  }
}

/** Resolves the built renderer entry for packaged builds. */
export const rendererIndexPath = (dirname: string): string =>
  app.isPackaged ? join(dirname, '../dist/index.html') : join(dirname, '../dist/index.html')
