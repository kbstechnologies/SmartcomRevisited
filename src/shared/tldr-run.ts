/**
 * The gate every tldr command passes through before it reaches a session.
 *
 * A pure function, in `shared/`, for one reason: this is the part where being
 * wrong sends a command to the wrong box or sends a destructive one without
 * asking, and that has to be testable without an Electron process, an SSH
 * connection or a UI. The main process is the only caller — the panel asks, the
 * main process decides — so the renderer cannot route around it.
 *
 * The decisions it makes, in order:
 *
 *  1. **There must be a session.** A request naming a session that has gone is
 *     refused, never redirected to whichever terminal is now in front. That
 *     redirect is the single most plausible way a command meant for a lab box
 *     ends up on a production one.
 *  2. **It must be connected.** Writing into a dead shell silently loses the
 *     command, which is worse than saying so.
 *  3. **Destructive commands need an explicit yes**, and the classification is
 *     re-run here rather than trusted from the caller.
 */

import { classifyCommand } from './tldr-detect'

export interface TldrRunTarget {
  /** How the operator names this box. */
  name: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
}

export type TldrRunDecision =
  | { allow: true; destructive: boolean; reasons: string[] }
  | { allow: false; kind: 'no-session'; message: string }
  | { allow: false; kind: 'not-connected'; message: string }
  | { allow: false; kind: 'needs-confirmation'; reasons: string[] }

export function decideTldrRun(input: {
  /** Null when the id names nothing — closed, or never existed. */
  target: TldrRunTarget | null
  command: string
  /** True only when the operator was shown the command and agreed. */
  confirmedDestructive: boolean
}): TldrRunDecision {
  if (!input.target) {
    return { allow: false, kind: 'no-session', message: 'That session no longer exists.' }
  }

  if (input.target.status !== 'connected') {
    return {
      allow: false,
      kind: 'not-connected',
      message: `${input.target.name} is not connected.`,
    }
  }

  const risk = classifyCommand(input.command)

  if (risk.destructive && !input.confirmedDestructive) {
    return { allow: false, kind: 'needs-confirmation', reasons: risk.reasons }
  }

  return { allow: true, destructive: risk.destructive, reasons: risk.reasons }
}
