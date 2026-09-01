/**
 * Hooks that turn "someone is typing in a terminal" into "there is a page for
 * this".
 *
 * The performance contract lives here, and it is the reason this is a hook and
 * not a `useEffect` scattered through the indicator:
 *
 *  - keystrokes are folded into the model synchronously and cheaply, in
 *    `commandLine.ts`, on the same path that sends them to the far end;
 *  - the *lookup* is debounced, so a line typed at speed produces one IPC round
 *    trip, not thirty;
 *  - the lookup itself only touches an in-memory index in the main process, so
 *    it never waits on the network and never waits on disk.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { getCommandLine, subscribeToCommandLine, type CommandLineState } from './commandLine'
import { detectCommand, type DetectedCommand } from '@shared/tldr-detect'
import { platformForConnection, type TldrPlatform } from '@shared/tldr'

/** Long enough that a typed word is one lookup, short enough to feel live. */
const LOOKUP_DEBOUNCE_MS = 300

/** Live view of what is being typed into one session. */
export function useCommandLine(sessionId: string | null): CommandLineState {
  const [state, setState] = useState<CommandLineState>(() =>
    sessionId ? getCommandLine(sessionId) : { line: '', lastSubmitted: '', reliable: true, sensitive: false }
  )

  useEffect(() => {
    if (!sessionId) {
      setState({ line: '', lastSubmitted: '', reliable: true, sensitive: false })
      return
    }
    return subscribeToCommandLine(sessionId, setState)
  }, [sessionId])

  return state
}

/**
 * Which tldr platform a session's far end is.
 *
 * Read off the connection the session was opened from, because that is where
 * the operator has already recorded what the box is — the transport, the shell
 * they chose, and any tags. See `platformForConnection`.
 */
export function useSessionPlatform(sessionId: string | null): TldrPlatform {
  const sessions = useStore((state) => state.sessions)
  const profiles = useStore((state) => state.profiles)
  const hostPlatform = useStore((state) => state.tldrStatus?.hostPlatform)

  return useMemo(() => {
    const session = sessions.find((item) => item.id === sessionId)
    const profile = profiles.find((item) => item.id === session?.profileId)
    if (!profile) return 'common'
    return platformForConnection({
      transport: profile.transport,
      shellKind: profile.shellKind,
      tags: profile.tags,
      hostPlatform,
    })
  }, [sessionId, sessions, profiles, hostPlatform])
}

export type TldrIndicatorState = 'idle' | 'searching' | 'found' | 'missing'

export interface TldrDetection {
  /** What the operator is typing, or the last thing they submitted. */
  detected: DetectedCommand
  /** The command a lookup was performed for. */
  command: string
  platform: TldrPlatform
  /** Platform of the page that was found, which may not be the session's. */
  pagePlatform: TldrPlatform | null
  state: TldrIndicatorState
  /** True while the far end appears to be asking for a secret. */
  sensitive: boolean
}

/**
 * Contextual detection for one session.
 *
 * Falls back to the last submitted line once Enter is pressed: help about the
 * command you just ran is the common case, and an indicator that blanked the
 * instant you committed would be useless exactly when you wanted it.
 */
export function useTldrDetection(sessionId: string | null): TldrDetection {
  const enabled = useStore((state) => state.settings.tldrEnabled !== false)
  const ready = useStore((state) => state.tldrStatus?.ready ?? false)
  const lookup = useStore((state) => state.tldrLookup)

  const commandLine = useCommandLine(sessionId)
  const platform = useSessionPlatform(sessionId)

  const source = commandLine.line.trim() || commandLine.lastSubmitted
  const detected = useMemo(() => detectCommand(source), [source])

  const [state, setState] = useState<TldrIndicatorState>('idle')
  const [pagePlatform, setPagePlatform] = useState<TldrPlatform | null>(null)

  /** Guards against a slow answer for an older command landing last. */
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    const mine = generation.current

    if (!enabled || !ready || !detected.command || commandLine.sensitive) {
      setState('idle')
      setPagePlatform(null)
      return
    }

    setState('searching')
    const timer = window.setTimeout(() => {
      void lookup(detected.command, platform).then((result) => {
        if (generation.current !== mine) return
        setPagePlatform(result.platform)
        setState(result.found ? 'found' : 'missing')
      })
    }, LOOKUP_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [enabled, ready, detected.command, platform, commandLine.sensitive, lookup])

  return {
    detected,
    command: detected.command,
    platform,
    pagePlatform,
    state,
    sensitive: commandLine.sensitive,
  }
}
