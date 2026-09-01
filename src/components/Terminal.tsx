import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ArrowDownIcon } from '@heroicons/react/24/solid'
// Required: without it the rows are not positioned and the viewport cannot
// scroll, which renders as a blank terminal that never advances.
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store/useStore'
import { primeSessionHistory, subscribeToSession } from '../lib/sessionStream'
import { noteKeystrokes, noteOutput } from '../lib/commandLine'

interface TerminalProps {
  sessionId: string
  /** Refit when the pane becomes the active one, in case geometry changed. */
  isActive?: boolean
}

const THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#ffffff',
  black: '#000000',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#feca57',
  blue: '#339af0',
  magenta: '#f783ac',
  cyan: '#22b8cf',
  white: '#ffffff',
  brightBlack: '#495057',
  brightRed: '#ff8787',
  brightGreen: '#69db7c',
  brightYellow: '#ffd43b',
  brightBlue: '#4dabf7',
  brightMagenta: '#f06292',
  brightCyan: '#3bc9db',
  brightWhite: '#ffffff',
}

export default function Terminal({ sessionId, isActive = true }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const fitRef = useRef<(() => void) | null>(null)

  const settings = useStore((state) => state.settings)
  const broadcastInput = useStore((state) => state.broadcastInput)

  // Handlers live behind refs because xterm's onData callback is registered
  // once per session; reading state directly would capture the first render's
  // values forever (the original bug that stopped typing from being sent).
  const broadcastRef = useRef(broadcastInput)
  broadcastRef.current = broadcastInput

  // Same reasoning: the mouseup listener is registered once per session, so it
  // has to read the current setting rather than the one at first render.
  const copyOnSelectRef = useRef(settings.copyOnSelect !== false)
  copyOnSelectRef.current = settings.copyOnSelect !== false

  /**
   * Whether the viewport is parked above the live end of the buffer. Output
   * arriving while you read back deliberately does *not* yank the view to the
   * bottom, so there has to be a way back — this drives the "jump to present"
   * button. The ref mirrors the state so the xterm listeners, which are
   * registered once per session, can compare without re-rendering on every
   * scroll event.
   */
  const [scrolledBack, setScrolledBack] = useState(false)
  const scrolledBackRef = useRef(false)

  /**
   * Measured off xterm's scrollable viewport element rather than the buffer's
   * viewportY: xterm only emits onScroll when the *buffer* scrolls, so moving
   * the viewport by wheel or scrollbar does not report through its API, and
   * the button stayed hidden until the next write landed — precisely the case
   * where you scrolled up to read something and nothing more was coming.
   */
  const syncScrollPosition = () => {
    const xterm = xtermRef.current
    if (!xterm) return
    const viewport = containerRef.current?.querySelector('.xterm-viewport')
    let away: boolean
    if (viewport) {
      away = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2
    } else {
      const buffer = xterm.buffer.active
      away = buffer.viewportY < buffer.baseY
    }
    if (away === scrolledBackRef.current) return
    scrolledBackRef.current = away
    setScrolledBack(away)
  }

  const jumpToPresent = () => {
    const xterm = xtermRef.current
    if (!xterm) return
    xterm.scrollToBottom()
    // Typing should go straight back to the shell after jumping.
    xterm.focus()
    syncScrollPosition()
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const xterm = new XTerm({
      theme: THEME,
      fontSize: settings.fontSize || 14,
      fontFamily:
        settings.fontFamily || 'JetBrains Mono, Monaco, Menlo, Ubuntu Mono, monospace',
      scrollback: settings.scrollback || 5000,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      macOptionIsMeta: true,
    })

    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.loadAddon(new WebLinksAddon())

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    /**
     * xterm measures a character to build its renderer, which only works on an
     * element that is laid out. Opening into a still-collapsed pane leaves the
     * render service uninitialised, and the viewport then throws
     * "Cannot read properties of undefined (reading 'dimensions')" — after
     * which the terminal never paints, however much output arrives.
     *
     * So open on the first frame where the pane has real dimensions, and hold
     * incoming output until then.
     */
    let opened = false
    const pending: string[] = []
    // The viewport element only exists once xterm has opened, so the scroll
    // listener that drives the jump-to-present button is attached there.
    let detachViewportScroll = () => {}

    const openWhenMeasurable = (): boolean => {
      if (opened) return true
      const el = containerRef.current
      if (!el || !el.clientWidth || !el.clientHeight) return false
      xterm.open(el)
      opened = true
      const viewport = el.querySelector('.xterm-viewport')
      if (viewport) {
        viewport.addEventListener('scroll', syncScrollPosition, { passive: true })
        detachViewportScroll = () => viewport.removeEventListener('scroll', syncScrollPosition)
      }
      for (const chunk of pending) xterm.write(chunk)
      pending.length = 0
      return true
    }

    const write = (chunk: string) => {
      // Before the write, not after: the tldr indicator only needs to know
      // whether the far end is currently asking for a password, and holding
      // that answer back behind xterm's parser would be a frame late.
      noteOutput(sessionId, chunk)
      if (opened) xterm.write(chunk)
      else pending.push(chunk)
    }

    // Read actions off the store directly so this effect never restarts.
    const { sendToSession, broadcast, resizeSession } = useStore.getState()

    const dataSub = xterm.onData((data) => {
      // Recorded before the send so nothing is ever delayed by it. The tracker
      // is a few string operations and cannot throw; if that ever stops being
      // true it belongs behind the send, not in front of it.
      noteKeystrokes(sessionId, data)

      if (broadcastRef.current) {
        void broadcast(data)
      } else {
        void sendToSession(sessionId, data)
      }
    })

    const resizeSub = xterm.onResize(({ cols, rows }) => {
      void resizeSession(sessionId, cols, rows)
    })

    // onScroll covers moving the viewport; onWriteParsed covers the buffer
    // growing underneath a parked viewport, which pushes the live end further
    // away without the viewport itself moving.
    const scrollSub = xterm.onScroll(syncScrollPosition)
    const writeSub = xterm.onWriteParsed(syncScrollPosition)

    /**
     * PuTTY's mouse convention, which is what people coming from it expect:
     * right-click copies the selection, and right-click with nothing selected
     * pastes instead. Ctrl+Shift+C / Ctrl+Shift+V do the same from the
     * keyboard — plain Ctrl+C has to stay as interrupt.
     *
     * The clipboard is reached through the main process: the async clipboard
     * API needs permissions the sandboxed renderer does not reliably get.
     */
    const copySelection = async (): Promise<boolean> => {
      const selection = xterm.getSelection()
      if (!selection) return false
      await window.electronAPI.invoke('clipboard:write', { text: selection })
      xterm.clearSelection()
      return true
    }

    const pasteClipboard = async () => {
      const response = await window.electronAPI.invoke<{ text: string }>('clipboard:read')
      const text = response.success ? response.data?.text : ''
      if (!text) return

      // Not `sendToSession`: the clipboard cannot go to the pty as-is. CRLF
      // reads as two Enters, and without the paste markers the remote treats a
      // paste as typing. The main process owns that conversion because it is
      // what tracks the remote's bracketed-paste mode.
      await useStore.getState().pasteToSession(sessionId, text)
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      void copySelection().then((copied) => {
        if (!copied) void pasteClipboard()
      })
    }
    container.addEventListener('contextmenu', handleContextMenu)

    /**
     * PuTTY's copy-on-select: releasing the mouse over a highlight puts it on
     * the clipboard, with no copy step in between.
     *
     * On mouseup rather than xterm's `onSelectionChange`, which fires on every
     * frame of a drag — that would write to the clipboard dozens of times per
     * selection. The selection is deliberately *not* cleared afterwards: the
     * highlight is how you can see what you just took.
     *
     * An empty selection is ignored, so an ordinary click to focus a pane
     * never clobbers what is already on the clipboard.
     */
    const handleMouseUp = () => {
      if (!copyOnSelectRef.current) return
      const selection = xterm.getSelection()
      if (!selection) return
      void window.electronAPI.invoke('clipboard:write', { text: selection })
    }
    container.addEventListener('mouseup', handleMouseUp)

    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true

      if (event.key === 'C' || event.key === 'c') {
        void copySelection()
        return false
      }
      if (event.key === 'V' || event.key === 'v') {
        void pasteClipboard()
        return false
      }
      // The tldr Command Center. Handled here as well as through the global
      // hotkey because a focused terminal swallows keys before they reach the
      // document — and a focused terminal is exactly when you want it.
      if (event.key === 'T' || event.key === 't') {
        // A detached window has nowhere to show a result, so the key is left
        // alone there rather than swallowed to no effect.
        if (useStore.getState().isDetachedWindow) return true
        useStore.getState().setTldrSearchOpen(true)
        return false
      }
      return true
    })

    // Ask for any history this window missed before replaying the buffer, so a
    // pane that mounts mid-session opens on the scrollback rather than blank.
    let disposed = false
    let unsubscribe = () => {}
    void primeSessionHistory(sessionId).then(() => {
      if (disposed) return
      unsubscribe = subscribeToSession(sessionId, write)
    })

    const handleStatus = ({
      sessionId: id,
      status,
      error,
    }: {
      sessionId: string
      status: string
      error?: string
    }) => {
      if (id !== sessionId) return
      if (status === 'connected') {
        write('\r\n\x1b[32mConnected.\x1b[0m\r\n')
        // xterm only reports a size when it *changes*, so a pane that was
        // already at its final size never tells the new shell how big it is.
        void resizeSession(sessionId, xterm.cols, xterm.rows)
      }
      if (status === 'disconnected') write('\r\n\x1b[33mDisconnected.\x1b[0m\r\n')
      if (status === 'error') write(`\r\n\x1b[31mConnection error: ${error}\x1b[0m\r\n`)
    }
    window.electronAPI.on('session-status-changed', handleStatus)

    // Open (if still waiting for dimensions) and fit. Both dimensions must be
    // non-zero: fitting a collapsed element makes xterm's render service throw
    // and leaves the terminal in a broken state.
    const fit = () => {
      if (!openWhenMeasurable()) return
      try {
        fitAddon.fit()
      } catch {
        /* renderer not ready yet; the next resize will retry */
      }
    }
    fitRef.current = fit

    // A pane can mount before layout has given it a size, and a ResizeObserver
    // does not fire for an element that is already at its final size, so poll
    // frames until the open succeeds rather than relying on either alone.
    let raf = 0
    const openLoop = () => {
      if (openWhenMeasurable()) {
        fit()
        return
      }
      raf = requestAnimationFrame(openLoop)
    }
    raf = requestAnimationFrame(openLoop)

    const observer = new ResizeObserver(fit)
    observer.observe(container)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      container.removeEventListener('contextmenu', handleContextMenu)
      container.removeEventListener('mouseup', handleMouseUp)
      window.electronAPI.off('session-status-changed', handleStatus)
      unsubscribe()
      detachViewportScroll()
      dataSub.dispose()
      resizeSub.dispose()
      scrollSub.dispose()
      writeSub.dispose()
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
    // Rebuilding on settings changes would wipe scrollback, so the terminal is
    // tied to the session alone; appearance changes apply to new panes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Becoming active can coincide with a geometry change (layout switch, window
  // resize while hidden), so refit on the next frame once it is on screen.
  useEffect(() => {
    if (!isActive) return
    const raf = requestAnimationFrame(() => fitRef.current?.())
    return () => cancelAnimationFrame(raf)
  }, [isActive])

  // Live-apply appearance tweaks without tearing the terminal down.
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    if (settings.fontSize) xterm.options.fontSize = settings.fontSize
    if (settings.fontFamily) xterm.options.fontFamily = settings.fontFamily
    if (settings.scrollback) xterm.options.scrollback = settings.scrollback
    try {
      fitAddonRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [settings.fontSize, settings.fontFamily, settings.scrollback])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="terminal-pane h-full w-full" />
      {scrolledBack && (
        <button
          type="button"
          onClick={jumpToPresent}
          title="Scroll to the live end of the output"
          className="absolute bottom-3 right-5 z-10 flex items-center gap-1.5 rounded-full bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur transition hover:bg-blue-500"
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
          Jump to present
        </button>
      )}
    </div>
  )
}
