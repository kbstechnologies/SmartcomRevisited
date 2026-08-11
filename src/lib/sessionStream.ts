/**
 * Buffers terminal output per session.
 *
 * A session starts producing output in the main process the moment it connects,
 * which can be before its React pane has mounted — especially when opening many
 * hosts at once. Without this, the login banner and first prompt were lost. The
 * global listener starts at app start-up and each pane replays what it missed.
 */

type Listener = (chunk: string) => void

/** Roughly a screenful of scrollback per session while it waits for a pane. */
const MAX_BUFFER_CHARS = 200_000

const buffers = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()

let started = false

export function startSessionStream(): void {
  if (started) return
  started = true

  window.electronAPI.on('session-data', ({ sessionId, data }: { sessionId: string; data: string }) => {
    // Always retained, never drained on read. A pane that mounts, unmounts and
    // remounts — which React StrictMode does on every mount in development —
    // otherwise threw away the output the discarded instance had consumed,
    // losing the login banner and first prompt.
    const combined = (buffers.get(sessionId) ?? '') + data
    buffers.set(
      sessionId,
      combined.length > MAX_BUFFER_CHARS ? combined.slice(-MAX_BUFFER_CHARS) : combined
    )

    listeners.get(sessionId)?.forEach((listener) => listener(data))
  })
}

/**
 * In-flight or completed history requests, by session.
 *
 * Kept as promises rather than a "done" flag: React mounts an effect twice in
 * development, and a second mount that merely saw "already requested" would
 * subscribe against a buffer the first request had not yet filled, replaying
 * nothing.
 */
const primed = new Map<string, Promise<void>>()

/**
 * Fills in output that happened before this window existed.
 *
 * Buffers are per renderer, so a window that opens later — a popped-out
 * terminal, or a window that reloaded — starts with no history and shows an
 * empty pane until the next byte arrives. The main process keeps the raw
 * scrollback, so ask it once per session.
 *
 * The history is *prepended*: anything buffered while the request was in flight
 * is strictly newer than what the main process had when it answered.
 */
export function primeSessionHistory(sessionId: string): Promise<void> {
  const existing = primed.get(sessionId)
  if (existing) return existing

  // Output seen live in this window already covers the whole session.
  if (buffers.has(sessionId)) {
    const done = Promise.resolve()
    primed.set(sessionId, done)
    return done
  }

  const request = (async () => {
    try {
      const response = await window.electronAPI.invoke<{ data: string }>('sessions:scrollback', {
        sessionId,
      })
      const history = response.success ? response.data?.data : ''
      if (!history) return
      buffers.set(sessionId, history + (buffers.get(sessionId) ?? ''))
    } catch {
      /* history is a nicety; a live pane still works without it */
    }
  })()

  primed.set(sessionId, request)
  return request
}

/**
 * Replays the session's output so far, then streams live output until
 * unsubscribed. Safe to call again after a remount: the subscriber is always a
 * freshly created terminal, so a full replay is what it needs.
 */
export function subscribeToSession(sessionId: string, listener: Listener): () => void {
  const history = buffers.get(sessionId)
  if (history) listener(history)

  let subscribers = listeners.get(sessionId)
  if (!subscribers) {
    subscribers = new Set()
    listeners.set(sessionId, subscribers)
  }
  subscribers.add(listener)

  return () => {
    subscribers!.delete(listener)
    if (subscribers!.size === 0) listeners.delete(sessionId)
  }
}

export function clearSessionBuffer(sessionId: string): void {
  buffers.delete(sessionId)
  listeners.delete(sessionId)
  primed.delete(sessionId)
}
