/**
 * Chooses which of a window's own sessions is on screen.
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
 */
export function selectVisibleSession(
  /** Sessions this window renders, in display order. */
  ownSessionIds: string[],
  /** Globally focused session — may belong to a different window. */
  activeSessionId: string | null,
  /** Last pane the user clicked in *this* window. */
  lastFocusedHere: string | null
): string | null {
  if (ownSessionIds.length === 0) return null

  const owns = (id: string | null): id is string => !!id && ownSessionIds.includes(id)

  // The global focus wins only when this window actually shows that session.
  if (owns(activeSessionId)) return activeSessionId

  // Otherwise keep showing whatever the user last looked at here.
  if (owns(lastFocusedHere)) return lastFocusedHere

  // A window that has never been focused still shows something.
  return ownSessionIds[0]
}
