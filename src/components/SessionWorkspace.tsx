import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  XMarkIcon,
  PlayIcon,
  PlusIcon,
  Squares2X2Icon,
  WindowIcon,
  ArrowsPointingOutIcon,
  DocumentTextIcon,
  SignalIcon,
  ArrowTopRightOnSquareIcon,
  FolderIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import Terminal from './Terminal'
import ProfileSelector from './ProfileSelector'
import TldrIndicator from './TldrIndicator'
import SessionTabMenu from './SessionTabMenu'
import DownloadFileDialog from './DownloadFileDialog'
import SftpExplorer from './SftpExplorer'
import { selectVisibleSession } from '../lib/paneSelection'
import { isSftpPaneId, sessionIdFromPane, sftpPaneId } from '@shared/sftp'
import type { LayoutMode, Session } from '@shared/types'

const MODE_BUTTONS: Array<{ mode: LayoutMode; label: string; Icon: typeof WindowIcon }> = [
  { mode: 'tabs', label: 'Tabs', Icon: WindowIcon },
  { mode: 'grid', label: 'Grid', Icon: Squares2X2Icon },
  { mode: 'fullscreen', label: 'Full screen', Icon: ArrowsPointingOutIcon },
]

/**
 * One thing the workspace lays out: a terminal, or a file browser for the same
 * session.
 *
 * `id` is what focus, placement and pop-out use. For a terminal it *is* the
 * session id, so nothing about the existing behaviour changes; for a browser it
 * is `sftp:<sessionId>`, which a detached window can be handed and render from
 * with no other information.
 */
type Pane =
  | { kind: 'terminal'; id: string; session: Session }
  | { kind: 'sftp'; id: string; session: Session }

const statusColor = (status: Session['status']) =>
  ({
    connected: 'bg-green-500',
    connecting: 'bg-yellow-500',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
  })[status] ?? 'bg-gray-500'

/** Square-ish grid unless the user pinned a column count. */
function gridColumnCount(sessionCount: number, configured: number): number {
  if (configured > 0) return configured
  if (sessionCount <= 1) return 1
  return Math.ceil(Math.sqrt(sessionCount))
}

export default function SessionWorkspace() {
  const allSessions = useStore((state) => state.sessions)
  const sessionPlacement = useStore((state) => state.sessionPlacement)
  const isDetached = useStore((state) => state.isDetachedWindow)
  const detachSessions = useStore((state) => state.detachSessions)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const layoutMode = useStore((state) => state.layoutMode)
  const gridColumns = useStore((state) => state.gridColumns)
  const broadcastInput = useStore((state) => state.broadcastInput)
  const sessionLogs = useStore((state) => state.sessionLogs)

  const setActiveSession = useStore((state) => state.setActiveSession)
  const setLayoutMode = useStore((state) => state.setLayoutMode)
  const setBroadcastInput = useStore((state) => state.setBroadcastInput)
  const closeSession = useStore((state) => state.closeSession)
  const toggleSessionLog = useStore((state) => state.toggleSessionLog)
  const loadSessions = useStore((state) => state.loadSessions)

  const openSession = useStore((state) => state.openSession)
  const sftpPanes = useStore((state) => state.sftpPanes)
  const loadSftpState = useStore((state) => state.loadSftpState)
  const closeSftpPane = useStore((state) => state.closeSftpPane)
  const openSftpPane = useStore((state) => state.openSftpPane)

  const [showProfileSelector, setShowProfileSelector] = useState(false)
  /** Last pane clicked in THIS window; global focus may belong to another. */
  const [lastFocusedHere, setLastFocusedHere] = useState<string | null>(null)
  /** Which tab was right-clicked, and where, so the menu can be pinned to it. */
  const [tabMenu, setTabMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  /** Session whose download dialog is open, or null. */
  const [downloadFor, setDownloadFor] = useState<string | null>(null)
  /** Why a duplicate failed. There is no toast here, so it gets its own line. */
  const [duplicateError, setDuplicateError] = useState<string | null>(null)

  /**
   * A session is shown in exactly one window. A detached window renders only
   * the sessions it was handed; the main window renders everything that has
   * not been detached, so a pane is never duplicated across monitors.
   */
  const ownedSessionIds = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const ids = (params.get('sessions') ?? '').split(',').filter(Boolean)
    return new Set(ids)
  }, [])

  const sessions = useMemo(
    () =>
      isDetached
        ? allSessions.filter((session) => ownedSessionIds.has(session.id))
        : allSessions.filter((session) => sessionPlacement[session.id] === undefined),
    [allSessions, isDetached, ownedSessionIds, sessionPlacement]
  )

  /**
   * Everything this window shows, terminals and file browsers alike.
   *
   * A pane is the unit the tab strip, the grid, focus and pop-out all work on.
   * Making the explorer one of these rather than a special case is what lets it
   * behave exactly like a terminal — the window manager already carries opaque
   * ids, so `sftp:<sessionId>` detaches with no changes there at all.
   *
   * A browser is listed straight after the terminal it belongs to, because
   * they are two views of one host and separating them in the tab strip would
   * be the sort of ordering nobody can predict.
   */
  const panes = useMemo<Pane[]>(() => {
    const result: Pane[] = []

    for (const session of sessions) {
      const terminalId = session.id
      const explorerId = sftpPaneId(session.id)

      const owns = (id: string) =>
        isDetached ? ownedSessionIds.has(id) : sessionPlacement[id] === undefined

      if (owns(terminalId)) result.push({ kind: 'terminal', id: terminalId, session })
      if (sftpPanes.includes(session.id) && owns(explorerId)) {
        result.push({ kind: 'sftp', id: explorerId, session })
      }
    }

    // A detached window can hold an explorer whose terminal stayed behind, so
    // the loop above would miss it: `sessions` there is filtered to the ids the
    // window was handed, and the terminal is not one of them.
    if (isDetached) {
      for (const id of ownedSessionIds) {
        if (!isSftpPaneId(id) || result.some((pane) => pane.id === id)) continue

        const session = allSessions.find((item) => item.id === sessionIdFromPane(id))
        if (session) result.push({ kind: 'sftp', id, session })
      }
    }

    return result
  }, [sessions, allSessions, sftpPanes, isDetached, ownedSessionIds, sessionPlacement])

  /** Distinct hosts on screen here, however many panes each one has open. */
  const hostCount = useMemo(
    () => new Set(panes.map((pane) => sessionIdFromPane(pane.id))).size,
    [panes]
  )

  useEffect(() => {
    void loadSessions()
    void loadSftpState()
  }, [loadSessions, loadSftpState])

  /**
   * Which pane this window shows. Deliberately not the global active session:
   * that is shared across windows so buttons can target a terminal on another
   * monitor, and using it for visibility blanked detached windows whenever the
   * main window opened a connection.
   */
  const visiblePaneId = useMemo(
    () =>
      selectVisibleSession(
        panes.map((pane) => pane.id),
        // A terminal pane's id *is* its session id, so the global focus still
        // resolves here unchanged. It never names an explorer, which is right:
        // buttons target terminals.
        activeSessionId,
        lastFocusedHere
      ),
    [panes, activeSessionId, lastFocusedHere]
  )

  const columns = useMemo(
    () => gridColumnCount(panes.length, gridColumns),
    [panes.length, gridColumns]
  )

  const runningMacros = useStore((state) => state.runningMacros)
  /** The macro running on a session, if any — drives the tab indicator. */
  const busyOn = (sessionId: string) =>
    runningMacros.find((item) => item.sessionId === sessionId)

  /**
   * Focus is owned by the main process so every window agrees on the target.
   *
   * A pane id is what this window shows; the *session* it reports globally is
   * the underlying one either way. Clicking a file browser therefore points
   * the button panel at that host, which is what somebody looking at its
   * filesystem would expect — and means the global value never names a pane
   * that has no terminal to act on.
   */
  const focusPane = (paneId: string) => {
    setLastFocusedHere(paneId)

    const sessionId = sessionIdFromPane(paneId)
    setActiveSession(sessionId)
    void window.electronAPI.invoke('windows:set-active-session', { sessionId })
  }

  /**
   * Closing kills the shell a macro is writing into, so the run dies with it.
   * The main process refuses and says what is in flight; the question is asked
   * here, where it can name the button and be honest that stopping the script
   * does not stop whatever it already started on the far end.
   */
  const handleClose = async (sessionId: string, event: React.MouseEvent) => {
    event.stopPropagation()

    const result = await closeSession(sessionId)
    if (!result.blockedBy) return

    const { macroName, profileName } = result.blockedBy
    const proceed = window.confirm(
      `"${macroName}" is still running on ${profileName}.\n\n` +
        'Closing this session stops the remaining steps. Anything already started on ' +
        'the host keeps running there, but the steps that were going to wait for it, ' +
        'collect files or clean up will not happen.\n\nClose anyway?'
    )
    if (proceed) await closeSession(sessionId, true)
  }

  /**
   * "Duplicate" means another session to the same saved connection: an SSH
   * channel cannot be forked, so there is nothing to clone but the profile.
   * Connecting can fail for all the usual reasons, and the failure has to land
   * somewhere the operator will see it — hence the line under the tab strip.
   */
  const handleDuplicate = async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) return

    setDuplicatingId(sessionId)
    setDuplicateError(null)
    try {
      const newSessionId = await openSession(session.profileId)
      // openSession already claims global focus; this window has to agree, or
      // the new pane stays hidden behind the one that was in front.
      setLastFocusedHere(newSessionId)
      setTabMenu(null)
    } catch (error) {
      setDuplicateError(
        `Could not duplicate ${session.profileName}: ` +
          (error instanceof Error ? error.message : 'failed to open the session')
      )
      setTabMenu(null)
    } finally {
      setDuplicatingId(null)
    }
  }

  const handleToggleLog = async (sessionId: string, event: React.MouseEvent) => {
    event.stopPropagation()
    await toggleSessionLog(sessionId)
  }

  /**
   * Closes a file browser without touching the session it belongs to.
   *
   * Downloads already queued keep running: they live in the main process
   * precisely so that closing the pane that started them is not a way to lose
   * work halfway through a large transfer.
   */
  const handleCloseExplorer = async (sessionId: string, event: React.MouseEvent) => {
    event.stopPropagation()
    await closeSftpPane(sessionId)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar: layout modes, broadcast, new session */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-800 border-b border-gray-700">
        <div className="flex rounded overflow-hidden border border-gray-600">
          {MODE_BUTTONS.map(({ mode, label, Icon }) => (
            <button
              key={mode}
              onClick={() => setLayoutMode(mode)}
              title={label}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 text-xs transition-colors',
                layoutMode === mode
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <button
          onClick={() => setBroadcastInput(!broadcastInput)}
          title="Type into every connected session at once"
          className={clsx(
            'flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors',
            broadcastInput
              ? 'bg-amber-600 border-amber-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'
          )}
        >
          <SignalIcon className="w-3.5 h-3.5" />
          Broadcast
        </button>

        <div className="flex-1" />

        {/* Contextual help for whatever is being typed into the visible pane.
            This toolbar is the closest thing Smartcom has to "beside the
            command input": a session is a raw pty, so there is no input box to
            attach to — see TldrIndicator.

            Not in a detached window: it shows terminals only, and the panel
            these chips open lives in the main window. A chip that visibly did
            nothing would be worse than no chip. */}
        {/* The tldr chip is about what is being typed, so it follows the
            terminal — an explorer pane has no command line to help with. */}
        {!isDetached && (
          <TldrIndicator
            sessionId={
              visiblePaneId && !isSftpPaneId(visiblePaneId) ? visiblePaneId : null
            }
          />
        )}

        {/* Hosts, not panes: a terminal and its file browser are two views of
            one connection, and counting them twice would overstate what is
            open. A window holding only a browser still has a host in it. */}
        <span className="text-xs text-gray-500">
          {hostCount} session{hostCount === 1 ? '' : 's'}
        </span>

        {/* Detaching moves the focused terminal to its own window — useful for
            watching a session on a second monitor. The buttons stay here. */}
        {!isDetached && (
          <button
            // The *pane* this window is showing, not the globally active
            // session: otherwise popping out a file browser would silently
            // pop out its terminal instead, which is the one thing it must not
            // do when both are on screen.
            onClick={() => visiblePaneId && void detachSessions([visiblePaneId])}
            disabled={!visiblePaneId}
            title="Open the focused pane in its own window"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-600 disabled:opacity-40"
          >
            <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Pop out</span>
          </button>
        )}

        {!isDetached && (
          <button
            onClick={() => setShowProfileSelector(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-600"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New
          </button>
        )}
      </div>

      {/* Tab strip (tabs mode only) */}
      {layoutMode === 'tabs' && panes.length > 0 && (
        <div className="flex items-center bg-gray-800 border-b border-gray-700 overflow-x-auto">
          {panes.map((pane) => {
            const { session } = pane
            const isExplorer = pane.kind === 'sftp'

            return (
            <div
              key={pane.id}
              onClick={() => focusPane(pane.id)}
              // Not in a detached window: it renders only the panes it was
              // handed, so a duplicate opened from here would appear in the
              // main window instead — the same reason "New" is hidden there.
              onContextMenu={
                isDetached || isExplorer
                  ? undefined
                  : (event) => {
                      event.preventDefault()
                      setTabMenu({ sessionId: session.id, x: event.clientX, y: event.clientY })
                    }
              }
              title={
                isExplorer
                  ? `Files on ${session.profileName}`
                  : isDetached
                    ? undefined
                    : 'Right-click for more'
              }
              className={clsx(
                'flex items-center gap-2 px-3 py-2 text-sm border-r border-gray-700 cursor-pointer max-w-48',
                visiblePaneId === pane.id
                  ? 'bg-gray-700 text-blue-400'
                  : 'text-gray-300 hover:bg-gray-700'
              )}
            >
              {isExplorer ? (
                <FolderIcon className="w-3.5 h-3.5 shrink-0 text-blue-400" />
              ) : (
                <div
                  className={clsx('w-2 h-2 rounded-full shrink-0', statusColor(session.status))}
                />
              )}
              <span className="truncate">
                {isExplorer ? `${session.profileName} — files` : session.profileName}
              </span>
              {/*
                On the tab rather than only in the button panel: the whole point
                of a long-running button is that you walk away to another host,
                and the panel you left is no longer the one on screen.
              */}
              {!isExplorer && busyOn(session.id) && (
                <PlayIcon
                  className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-pulse"
                  title={`${busyOn(session.id)?.macroName} is running`}
                />
              )}
              {!isExplorer && sessionLogs[session.id] && (
                <DocumentTextIcon className="w-3.5 h-3.5 text-green-400 shrink-0" title="Logging" />
              )}
              <button
                onClick={(event) =>
                  isExplorer ? handleCloseExplorer(session.id, event) : handleClose(session.id, event)
                }
                className="p-0.5 rounded hover:bg-gray-600 shrink-0"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
            </div>
            )
          })}
        </div>
      )}

      {duplicateError && (
        <div className="flex items-start gap-2 px-3 py-1.5 text-xs bg-red-950 border-b border-red-800 text-red-200">
          <span className="flex-1">{duplicateError}</span>
          <button
            onClick={() => setDuplicateError(null)}
            className="p-0.5 rounded hover:bg-red-900 shrink-0"
            title="Dismiss"
          >
            <XMarkIcon className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Panes */}
      <div className="flex-1 overflow-hidden bg-gray-900">
        {panes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <div className="text-6xl mb-4">🔗</div>
              <h2 className="text-xl font-medium mb-2">No active session</h2>
              <p className="text-gray-400 mb-4">Connect to one or more servers to get started</p>
              <button
                onClick={() => setShowProfileSelector(true)}
                className="inline-flex items-center px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-500"
              >
                <PlusIcon className="w-4 h-4 mr-2" />
                New connection
              </button>
            </div>
          </div>
        ) : (
          <div
            className={clsx('h-full w-full', layoutMode === 'grid' ? 'grid gap-1 p-1' : 'relative')}
            style={
              layoutMode === 'grid'
                ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                : undefined
            }
          >
            {panes.map((pane) => {
              const { session } = pane
              const isExplorer = pane.kind === 'sftp'
              const isActive = pane.id === visiblePaneId
              // Every pane stays mounted so scrollback and the PTY-side size
              // survive switching modes.
              //
              // Inactive panes are hidden with `invisible` (visibility:hidden),
              // never `hidden` (display:none): a display:none pane collapses to
              // 0x0, which leaves xterm with degenerate dimensions — it renders
              // blank and stops advancing when you switch back to it.
              // visibility:hidden keeps the box laid out at full size.
              const inactive = layoutMode !== 'grid' && !isActive

              return (
                <div
                  key={pane.id}
                  onMouseDown={() => focusPane(pane.id)}
                  className={clsx(
                    'flex flex-col overflow-hidden',
                    layoutMode === 'grid'
                      ? clsx(
                          'rounded border min-h-0',
                          isActive ? 'border-blue-500' : 'border-gray-700'
                        )
                      : 'absolute inset-0',
                    inactive && 'invisible pointer-events-none'
                  )}
                >
                  {layoutMode === 'grid' && (
                    <div
                      className={clsx(
                        'flex items-center gap-2 px-2 py-1 text-xs border-b',
                        isActive
                          ? 'bg-blue-950 border-blue-500 text-blue-200'
                          : 'bg-gray-800 border-gray-700 text-gray-400'
                      )}
                    >
                      {isExplorer ? (
                        <FolderIcon className="w-3.5 h-3.5 text-blue-400" />
                      ) : (
                        <div
                          className={clsx('w-2 h-2 rounded-full', statusColor(session.status))}
                        />
                      )}
                      <span className="truncate flex-1">
                        {isExplorer ? `${session.profileName} — files` : session.profileName}
                      </span>
                      {!isExplorer && busyOn(session.id) && (
                        <PlayIcon
                          className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-pulse"
                          title={`${busyOn(session.id)?.macroName} is running`}
                        />
                      )}
                      {!isExplorer && (
                        <button
                          onClick={(event) => handleToggleLog(session.id, event)}
                          title={sessionLogs[session.id] ? 'Stop logging' : 'Start logging'}
                          className="p-0.5 rounded hover:bg-gray-700"
                        >
                          <DocumentTextIcon
                            className={clsx(
                              'w-3.5 h-3.5',
                              sessionLogs[session.id] ? 'text-green-400' : 'text-gray-500'
                            )}
                          />
                        </button>
                      )}
                      <button
                        onClick={(event) =>
                          isExplorer
                            ? handleCloseExplorer(session.id, event)
                            : handleClose(session.id, event)
                        }
                        className="p-0.5 rounded hover:bg-gray-700"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  <div className="flex-1 min-h-0">
                    {isExplorer ? (
                      <SftpExplorer session={session} isActive={isActive} />
                    ) : (
                      <Terminal sessionId={session.id} isActive={isActive} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {tabMenu &&
        (() => {
          // The tab can be closed from another window while its menu is open.
          const session = sessions.find((item) => item.id === tabMenu.sessionId)
          if (!session) return null
          return (
            <SessionTabMenu
              session={session}
              x={tabMenu.x}
              y={tabMenu.y}
              duplicating={duplicatingId === session.id}
              onDuplicate={() => void handleDuplicate(session.id)}
              onDownloadFile={() => {
                // The menu closes first: the dialog owns the screen from here,
                // and leaving a context menu floating over a modal is the kind
                // of thing that survives to a release.
                setTabMenu(null)
                setDownloadFor(session.id)
              }}
              onBrowseFiles={() => {
                setTabMenu(null)
                void openSftpPane(session.id).then(() => focusPane(sftpPaneId(session.id)))
              }}
              browsing={panes.some((pane) => pane.id === sftpPaneId(session.id))}
              onClose={() => setTabMenu(null)}
            />
          )
        })()}

      {downloadFor &&
        (() => {
          const session = sessions.find((item) => item.id === downloadFor)
          if (!session) return null
          return (
            <DownloadFileDialog session={session} onClose={() => setDownloadFor(null)} />
          )
        })()}

      {showProfileSelector && (
        <ProfileSelector
          onClose={() => setShowProfileSelector(false)}
          onConnected={() => setShowProfileSelector(false)}
        />
      )}
    </div>
  )
}
