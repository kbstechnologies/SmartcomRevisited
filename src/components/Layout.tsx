import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import {
  ChevronDoubleRightIcon,
  ChevronDoubleLeftIcon,
  KeyIcon,
  FolderIcon,
  Cog6ToothIcon,
  DocumentMagnifyingGlassIcon,
  InformationCircleIcon,
  VariableIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import SessionWorkspace from './SessionWorkspace'
import MacroPanel from './MacroPanel'
import StatusBar from './StatusBar'
import KeyManager from './KeyManager'
import ScriptLibrary from './ScriptLibrary'
import GlobalVariables from './GlobalVariables'
import SettingsPanel from './SettingsPanel'
import LogsViewer from './LogsViewer'
import AboutDialog from './AboutDialog'
import AssistantPanel from './AssistantPanel'
import AssistantSettings from './AssistantSettings'

/** Side panel width limits, in pixels. 384 matches the previous fixed w-96. */
const MIN_PANEL_WIDTH = 240
const MAX_PANEL_WIDTH = 900
const DEFAULT_PANEL_WIDTH = 384
const PANEL_WIDTH_KEY = 'smartcom.panelWidth'

type SidePanel = 'buttons' | 'assistant'

export default function Layout() {
  const [panelCollapsed, setPanelCollapsed] = useState(false)

  /**
   * Side panel width, dragged by the handle and remembered between runs.
   *
   * Button labels and the assistant's replies both want more room than a fixed
   * 24rem allowed, and how much depends on the screen — so it is the user's to
   * decide.
   */
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    return stored >= MIN_PANEL_WIDTH && stored <= MAX_PANEL_WIDTH ? stored : DEFAULT_PANEL_WIDTH
  })
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth))
  }, [panelWidth])

  /**
   * Drag tracking lives on the window, not the handle: the pointer routinely
   * outruns a 4px target, and releasing outside it must still end the drag.
   */
  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    setResizing(true)

    const onMove = (move: MouseEvent) => {
      // The panel is on the right, so its width grows as the pointer moves left.
      const width = window.innerWidth - move.clientX
      setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width)))
    }

    const onUp = () => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Terminals re-fit to the space that just changed.
      window.dispatchEvent(new Event('resize'))
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const [sidePanel, setSidePanel] = useState<SidePanel>('buttons')
  const [showAssistantSettings, setShowAssistantSettings] = useState(false)

  // Dialog state lives in the store so the command palette can open these too.
  const activeDialog = useStore((state) => state.activeDialog)
  const setActiveDialog = useStore((state) => state.setActiveDialog)
  const isDetached = useStore((state) => state.isDetachedWindow)
  const theme = useStore((state) => state.theme)

  // A detached window shows terminals only — buttons and dialogs stay in the
  // main window so there is exactly one place that owns them.
  if (isDetached) {
    return (
      <div className={clsx('h-screen flex flex-col bg-gray-900', theme)}>
        <div className="flex-1 min-h-0">
          <SessionWorkspace />
        </div>
        <StatusBar />
      </div>
    )
  }

  return (
    <div className={clsx('h-screen flex flex-col bg-gray-900', theme)}>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <SessionWorkspace />
        </div>

        {/* Drag handle. Sits between the terminals and the panel, and is wider
            than it looks so it is not a pixel hunt. */}
        {!panelCollapsed && (
          <div
            onMouseDown={startResize}
            onDoubleClick={() => setPanelWidth(DEFAULT_PANEL_WIDTH)}
            title="Drag to resize, double-click to reset"
            className={clsx(
              'w-1 shrink-0 cursor-col-resize hover:bg-blue-500/60 transition-colors',
              resizing ? 'bg-blue-500' : 'bg-gray-700'
            )}
          />
        )}

        <div
          style={panelCollapsed ? undefined : { width: panelWidth }}
          className={clsx(
            'flex flex-col border-l border-gray-700 bg-gray-800 shrink-0',
            // Animating width fights the drag, so transition only when the
            // panel is being collapsed or reopened.
            panelCollapsed ? 'w-10 transition-all duration-150' : ''
          )}
        >
          <div className="flex items-center gap-1 p-2 border-b border-gray-700">
            <button
              onClick={() => setPanelCollapsed(!panelCollapsed)}
              title={panelCollapsed ? 'Show panel' : 'Hide panel'}
              className="p-1 rounded hover:bg-gray-700 text-gray-400"
            >
              {panelCollapsed ? (
                <ChevronDoubleLeftIcon className="w-4 h-4" />
              ) : (
                <ChevronDoubleRightIcon className="w-4 h-4" />
              )}
            </button>

            {!panelCollapsed && (
              <>
                <div className="flex flex-1 rounded overflow-hidden border border-gray-600">
                  {(['buttons', 'assistant'] as SidePanel[]).map((panel) => (
                    <button
                      key={panel}
                      onClick={() => setSidePanel(panel)}
                      className={clsx(
                        'flex-1 px-2 py-1 text-xs capitalize transition-colors',
                        sidePanel === panel
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      )}
                    >
                      {panel}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setActiveDialog('keys')}
                  title="SSH keys"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <KeyIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setActiveDialog('scripts')}
                  title="Script library"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <FolderIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setActiveDialog('globals')}
                  title="Global variables — {{NAME}} in every button"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <VariableIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setActiveDialog('logs')}
                  title="Audit log"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <DocumentMagnifyingGlassIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setActiveDialog('settings')}
                  title="Settings"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <Cog6ToothIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setActiveDialog('about')}
                  title="About Smartcom Revisited"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <InformationCircleIcon className="w-4 h-4" />
                </button>
              </>
            )}
          </div>

          {!panelCollapsed && (
            <div className="flex-1 min-h-0">
              {sidePanel === 'buttons' ? (
                <MacroPanel />
              ) : (
                <AssistantPanel
                  onOpenSettings={() => setShowAssistantSettings(true)}
                  settingsOpen={showAssistantSettings}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <StatusBar />

      {activeDialog === 'keys' && <KeyManager onClose={() => setActiveDialog(null)} />}
      {activeDialog === 'scripts' && <ScriptLibrary onClose={() => setActiveDialog(null)} />}
      {activeDialog === 'globals' && <GlobalVariables onClose={() => setActiveDialog(null)} />}
      {activeDialog === 'about' && <AboutDialog onClose={() => setActiveDialog(null)} />}
      {showAssistantSettings && (
        <AssistantSettings onClose={() => setShowAssistantSettings(false)} />
      )}
      <SettingsPanel isOpen={activeDialog === 'settings'} onClose={() => setActiveDialog(null)} />
      <LogsViewer isOpen={activeDialog === 'logs'} onClose={() => setActiveDialog(null)} />
    </div>
  )
}
