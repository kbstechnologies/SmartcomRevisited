import { useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useStore } from './store/useStore'
import Layout from './components/Layout'
import CommandPalette from './components/CommandPalette'
import TldrCommandCenter from './components/TldrCommandCenter'
import VariableForm from './components/VariableForm'
import ConfirmStep from './components/ConfirmStep'
import { startSessionStream } from './lib/sessionStream'
import { startAssistantStream } from './lib/assistantStream'

function App() {
  const isCommandPaletteOpen = useStore((state) => state.isCommandPaletteOpen)
  const setCommandPaletteOpen = useStore((state) => state.setCommandPaletteOpen)
  const pendingForm = useStore((state) => state.pendingForm)
  const submitMacroForm = useStore((state) => state.submitMacroForm)
  const pendingConfirm = useStore((state) => state.pendingConfirm)
  const submitMacroConfirm = useStore((state) => state.submitMacroConfirm)
  const tldrSearchOpen = useStore((state) => state.tldrSearchOpen)
  const setTldrSearchOpen = useStore((state) => state.setTldrSearchOpen)
  // A detached window shows terminals only. Its results would open a panel
  // that window does not render, so the search does not open there either.
  const isDetached = useStore((state) => state.isDetachedWindow)

  useHotkeys('cmd+k,ctrl+k', (event) => {
    event.preventDefault()
    setCommandPaletteOpen(!isCommandPaletteOpen)
  })

  /**
   * The tldr Command Center. Ctrl+Shift+T was free: Ctrl+K is the command
   * palette, and the terminal's own bindings are Ctrl+Shift+C / Ctrl+Shift+V.
   *
   * `enableOnFormTags` because xterm puts a hidden textarea under the cursor,
   * so without it the shortcut would be dead in the one place it is for. The
   * terminal also handles this key itself — see `attachCustomKeyEventHandler`
   * in Terminal.tsx — since a focused terminal never lets the key reach here.
   */
  useHotkeys(
    'cmd+shift+t,ctrl+shift+t',
    (event) => {
      event.preventDefault()
      if (isDetached) return
      setTldrSearchOpen(!tldrSearchOpen)
    },
    { enableOnFormTags: true }
  )

  // A detached window is opened with ?mode=detached and the sessions it owns.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('mode') === 'detached') {
      useStore.getState().setDetachedWindow(true)
    }
  }, [])

  // Terminal output is buffered from the very first paint so nothing that
  // arrives before a pane mounts is dropped.
  useEffect(() => {
    startSessionStream()
    // Same reasoning: an answer must keep streaming into the store while the
    // assistant panel is unmounted on the buttons tab.
    startAssistantStream()
  }, [])

  useEffect(() => {
    const {
      loadProfiles,
      loadMacroSets,
      loadMacros,
      loadSettings,
      loadSshKeys,
      loadSessions,
      refreshLogStatus,
      loadSessionPlacement,
      loadGlobalVars,
      loadTldrStatus,
    } = useStore.getState()

    void Promise.allSettled([
      loadProfiles(),
      loadMacroSets(),
      loadMacros(),
      loadSettings(),
      loadSshKeys(),
      loadSessions(),
      refreshLogStatus(),
      // The button panel resolves form defaults through the globals before it
      // prompts, so they have to be here before the first button is pressed.
      loadGlobalVars(),
      // Placement is otherwise only learned from the broadcast sent when a
      // window is detached, so a window that loads later — or reloads — would
      // render a duplicate pane for a session already shown elsewhere.
      loadSessionPlacement(),
      // A window that opens or reloads while a macro is running would otherwise
      // show no busy indicator until the run happened to end.
      useStore.getState().loadRunningMacros(),
      // Whether tldr has a usable cache. `allSettled`, so a main process
      // without the service — an older build, a service that failed to
      // construct — leaves the chip inert rather than breaking start-up.
      loadTldrStatus(),
    ])
  }, [])

  // Main-process pushes: logging state, macro progress, and inline form asks.
  useEffect(() => {
    const { setSessionLog, setMacroProgress, setPendingForm, setPendingConfirm, loadSessions } =
      useStore.getState()

    const onLogChanged = ({
      sessionId,
      logPath,
    }: {
      sessionId: string
      logPath: string | null
    }) => setSessionLog(sessionId, logPath)

    const onProgress = ({ sessionId, progress }: { sessionId: string; progress: any }) =>
      setMacroProgress(sessionId, progress)

    // Kept in the store rather than derived per component: the busy state has
    // to be right in the session tabs, the button panel and the close handler,
    // and a window that opened late gets the full set on mount.
    const onRunningChanged = ({ running }: { running: any[] }) =>
      useStore.getState().setRunningMacros(running)

    const onFormRequest = (payload: any) => setPendingForm(payload)

    const onConfirmRequest = (payload: any) => setPendingConfirm(payload)

    const onStatus = () => {
      void loadSessions()
    }

    // The focused pane may live in another window; the main process owns the
    // truth so the button panel can target a terminal on a second monitor.
    const onActiveSession = ({ sessionId }: { sessionId: string | null }) =>
      useStore.setState({ activeSessionId: sessionId })

    const onPlacement = ({ placement }: { placement: Record<string, number> }) =>
      useStore.getState().setSessionPlacement(placement)

    // The tldr cache downloads and indexes long after start-up, so the chip has
    // to learn it went from "unavailable" to "ready" without being asked.
    const onTldrStatus = ({ status }: { status: any }) =>
      useStore.getState().setTldrStatus({
        ...status,
        // The push does not carry a disk measurement; keep the last one rather
        // than blanking the size in an open settings screen.
        cacheBytes: useStore.getState().tldrStatus?.cacheBytes ?? 0,
      })

    window.electronAPI.on('session-log-changed', onLogChanged)
    window.electronAPI.on('macro-progress', onProgress)
    window.electronAPI.on('macro-running-changed', onRunningChanged)
    window.electronAPI.on('macro-form-request', onFormRequest)
    window.electronAPI.on('macro-confirm-request', onConfirmRequest)
    window.electronAPI.on('session-status-changed', onStatus)
    window.electronAPI.on('active-session-changed', onActiveSession)
    window.electronAPI.on('session-placement-changed', onPlacement)
    window.electronAPI.on('tldr-status', onTldrStatus)

    return () => {
      window.electronAPI.off('session-log-changed', onLogChanged)
      window.electronAPI.off('macro-progress', onProgress)
      window.electronAPI.off('macro-running-changed', onRunningChanged)
      window.electronAPI.off('macro-form-request', onFormRequest)
      window.electronAPI.off('macro-confirm-request', onConfirmRequest)
      window.electronAPI.off('session-status-changed', onStatus)
      window.electronAPI.off('active-session-changed', onActiveSession)
      window.electronAPI.off('session-placement-changed', onPlacement)
      window.electronAPI.off('tldr-status', onTldrStatus)
    }
  }, [])

  return (
    <div className="h-screen bg-gray-900 text-gray-100">
      <Layout />

      {isCommandPaletteOpen && (
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      {/* Searchable tldr, opened from the chip, the panel header or
          Ctrl+Shift+T. A result opens in the side panel, not here. */}
      {tldrSearchOpen && !isDetached && (
        <TldrCommandCenter onClose={() => setTldrSearchOpen(false)} />
      )}

      {/* An `Ask for input` block reached mid-script */}
      {pendingForm && (
        <VariableForm
          title={pendingForm.title}
          fields={pendingForm.fields}
          submitLabel="Continue"
          onSubmit={(values) => void submitMacroForm(pendingForm.requestId, values)}
          onCancel={() => void submitMacroForm(pendingForm.requestId, null)}
        />
      )}

      {/* A `Confirm` block reached mid-script: no stops the flow */}
      {pendingConfirm && (
        <ConfirmStep
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          cancelLabel={pendingConfirm.cancelLabel}
          destructive={pendingConfirm.destructive}
          onAnswer={(confirmed) => void submitMacroConfirm(pendingConfirm.requestId, confirmed)}
        />
      )}
    </div>
  )
}

export default App
