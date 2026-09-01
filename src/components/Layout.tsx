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
  BookOpenIcon,
  BoltIcon,
  SparklesIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType, SVGProps } from 'react'
import { useStore, type SidePanel } from '../store/useStore'
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
import TldrPanel from './TldrPanel'
import ScratchPad from './ScratchPad'

/** Side panel width limits, in pixels. 384 matches the previous fixed w-96. */
const MIN_PANEL_WIDTH = 240
const MAX_PANEL_WIDTH = 900
const DEFAULT_PANEL_WIDTH = 384
const PANEL_WIDTH_KEY = 'smartcom.panelWidth'

/**
 * The panel tabs.
 *
 * Icons rather than labels: three text tabs plus seven utility buttons in one
 * narrow row left nothing legible, and the panel is routinely dragged down to
 * 240px. The names survive as tooltips, and each icon is the one that already
 * means that thing elsewhere in the app — the bolt is a button/macro, the
 * sparkle is the assistant (the same one on the AI chip above the terminal),
 * the book is tldr.
 */
const PANEL_TABS: Array<{
  panel: SidePanel
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
}> = [
  { panel: 'buttons', label: 'Buttons', Icon: BoltIcon },
  { panel: 'assistant', label: 'Assistant', Icon: SparklesIcon },
  // Lower-case on purpose: it is the project's name, not a word.
  { panel: 'tldr', label: 'tldr', Icon: BookOpenIcon },
  { panel: 'scratch', label: 'Scratch pad — not saved', Icon: PencilSquareIcon },
]

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
  /**
   * Which tab is showing. In the store rather than in local state because three
   * things outside this component now raise it: the TLDR chip above the
   * terminal, a Command Center result, and Ask AI inside the tldr panel.
   */
  const sidePanel = useStore((state) => state.sidePanel)
  const setSidePanel = useStore((state) => state.setSidePanel)
  const [showAssistantSettings, setShowAssistantSettings] = useState(false)

  // Dialog state lives in the store so the command palette can open these too.
  const activeDialog = useStore((state) => state.activeDialog)
  const setActiveDialog = useStore((state) => state.setActiveDialog)
  const isDetached = useStore((state) => state.isDetachedWindow)
  const theme = useStore((state) => state.theme)

  const tldrRequest = useStore((state) => state.tldrRequest)
  const assistantPrefill = useStore((state) => state.assistantPrefill)
  const setTldrSearchOpen = useStore((state) => state.setTldrSearchOpen)

  /**
   * Something outside the panel asked for a tab. Opening it while the panel is
   * collapsed would look like the button did nothing, so reopen it — the
   * operator asked to see a page, not to change a preference.
   */
  useEffect(() => {
    if (tldrRequest || assistantPrefill) setPanelCollapsed(false)
  }, [tldrRequest, assistantPrefill])

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
                <div className="flex rounded overflow-hidden border border-gray-600 shrink-0">
                  {PANEL_TABS.map(({ panel, label, Icon }) => (
                    <button
                      key={panel}
                      onClick={() => setSidePanel(panel)}
                      title={label}
                      aria-label={label}
                      aria-pressed={sidePanel === panel}
                      className={clsx(
                        'px-2.5 py-1 transition-colors',
                        sidePanel === panel
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      )}
                    >
                      <Icon className="w-4 h-4" />
                    </button>
                  ))}
                </div>

                {/* Pushes the dialogs to the right, so the tabs stay a group
                    rather than blurring into the row of utility buttons. */}
                <div className="flex-1" />

                {/* The permanent way into tldr for when nothing has been typed
                    yet: search the whole page set and build a command from it.
                    A magnifier, not a book — the book is the tab beside it, and
                    two identical icons a centimetre apart mean neither. */}
                <button
                  onClick={() => setTldrSearchOpen(true)}
                  title="Search tldr commands (Ctrl+Shift+T)"
                  className="p-1 rounded hover:bg-gray-700 text-gray-400"
                >
                  <MagnifyingGlassIcon className="w-4 h-4" />
                </button>
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
              {sidePanel === 'buttons' && <MacroPanel />}
              {sidePanel === 'assistant' && (
                <AssistantPanel
                  onOpenSettings={() => setShowAssistantSettings(true)}
                  settingsOpen={showAssistantSettings}
                />
              )}
              {sidePanel === 'tldr' && <TldrPanel />}
              {sidePanel === 'scratch' && <ScratchPad />}
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
