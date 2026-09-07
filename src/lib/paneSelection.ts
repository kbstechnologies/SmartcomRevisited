import { sessionIdFromPane } from '@shared/sftp'

/**
 * Chooses which of a window's own panes is on screen.
 *
 * Two different ideas were previously conflated:
 *
 *  - the **active session** is global, shared across every window, and decides
 *    which terminal the button panel targets — that is what lets buttons in the
 *    main window act on a pane popped out to another monitor;
 *  - the **visible pane** is per window.
 *
 * Using the global value for visibility meant focusing anything in the main
 * window marked a detached window's only pane inactive, and in tabs or
 * fullscreen mode an inactive pane is hidden — so the popped-out window went
 * blank whenever a new connection was opened in the main one.
 *
 * The global value is therefore only adopted when it belongs to this window.
 *
 * The two values also work at different granularities. The global one names a
 * **session**; a window may hold more than one pane for that session — a
 * terminal and a file browser. When they agree about the session, the local
 * click is the finer-grained answer and decides which of that session's panes
 * is shown; when they disagree, focus genuinely moved elsewhere and the global
 * value wins.
 */
export function selectVisibleSession(
  /** Panes this window renders, in display order. */
  ownPaneIds: string[],
  /** Globally focused session — may belong to a different window. */
  activeSessionId: string | null,
  /** Last pane the user clicked in *this* window. */
  lastFocusedHere: string | null
): string | null {
  if (ownPaneIds.length === 0) return null

  const owns = (id: string | null): id is string => !!id && ownPaneIds.includes(id)

  // Same session, so the global focus cannot say which pane: the click does.
  // Without this, clicking a file browser is undone on the next render, because
  // its session's terminal pane is also owned by this window and matches first.
  if (owns(lastFocusedHere) && sessionIdFromPane(lastFocusedHere) === activeSessionId) {
    return lastFocusedHere
  }

  // The global focus wins only when this window actually shows that session.
  if (owns(activeSessionId)) return activeSessionId

  // Otherwise keep showing whatever the user last looked at here.
  if (owns(lastFocusedHere)) return lastFocusedHere

  // A window that has never been focused still shows something.
  return ownPaneIds[0]
}

