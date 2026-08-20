import { useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useStore } from './store/useStore'
import Layout from './components/Layout'
import CommandPalette from './components/CommandPalette'
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

  useHotkeys('cmd+k,ctrl+k', (event) => {
    event.preventDefault()
    setCommandPaletteOpen(!isCommandPaletteOpen)
  })

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

    window.electronAPI.on('session-log-changed', onLogChanged)
    window.electronAPI.on('macro-progress', onProgress)
    window.electronAPI.on('macro-running-changed', onRunningChanged)
    window.electronAPI.on('macro-form-request', onFormRequest)
    window.electronAPI.on('macro-confirm-request', onConfirmRequest)
    window.electronAPI.on('session-status-changed', onStatus)
    window.electronAPI.on('active-session-changed', onActiveSession)
    window.electronAPI.on('session-placement-changed', onPlacement)

    return () => {
      window.electronAPI.off('session-log-changed', onLogChanged)
      window.electronAPI.off('macro-progress', onProgress)
      window.electronAPI.off('macro-running-changed', onRunningChanged)
      window.electronAPI.off('macro-form-request', onFormRequest)
      window.electronAPI.off('macro-confirm-request', onConfirmRequest)
      window.electronAPI.off('session-status-changed', onStatus)
      window.electronAPI.off('active-session-changed', onActiveSession)
      window.electronAPI.off('session-placement-changed', onPlacement)
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
