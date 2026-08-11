import type { Session } from '@shared/types'

/**
 * Which sessions a button acts on.
 *
 * Broadcast was originally about typing — keystrokes going to every pane at
 * once. Buttons are the same idea with a script instead of a keystroke, so they
 * follow the same switch: with broadcast on, a button runs everywhere; with it
 * off, it runs on the focused pane only.
 *
 * Disconnected sessions are never targeted: a script sent to a dead session
 * would report failures that have nothing to do with the script.
 */
export function macroTargets(
  sessions: Session[],
  activeSessionId: string | null,
  broadcastInput: boolean
): Session[] {
  const connected = sessions.filter((session) => session.status === 'connected')
  if (broadcastInput) return connected

  const active = connected.find((session) => session.id === activeSessionId)
  return active ? [active] : []
}

/** Human-readable target for confirmations and status lines. */
export function describeTargets(targets: Session[]): string {
  if (targets.length === 0) return 'no connected session'
  if (targets.length === 1) return targets[0].profileName
  return `${targets.length} sessions`
}
