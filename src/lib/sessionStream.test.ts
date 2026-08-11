import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The module keeps per-session state, so each test imports a fresh copy after
 * installing its own `window.electronAPI` stub.
 */
async function loadStream(options: {
  scrollback?: string
  /** Resolve the scrollback request manually to model a slow main process. */
  deferred?: boolean
} = {}) {
  vi.resetModules()

  let releaseRequest: (() => void) | undefined
  const gate = options.deferred
    ? new Promise<void>((resolve) => {
        releaseRequest = resolve
      })
    : Promise.resolve()

  const emitters = new Map<string, Set<(payload: any) => void>>()

  const electronAPI = {
    invoke: vi.fn(async (channel: string) => {
      if (channel !== 'sessions:scrollback') return { success: false, error: 'unexpected channel' }
      await gate
      return { success: true, data: { data: options.scrollback ?? '' } }
    }),
    on: (channel: string, listener: (payload: any) => void) => {
      if (!emitters.has(channel)) emitters.set(channel, new Set())
      emitters.get(channel)!.add(listener)
    },
    off: (channel: string, listener: (payload: any) => void) => {
      emitters.get(channel)?.delete(listener)
    },
  }

  ;(globalThis as any).window = { electronAPI }

  const stream = await import('./sessionStream')
  return {
    ...stream,
    electronAPI,
    /** Pushes a chunk the way the main process would. */
    emit: (sessionId: string, data: string) =>
      emitters.get('session-data')?.forEach((listener) => listener({ sessionId, data })),
    releaseRequest: () => releaseRequest?.(),
  }
}

describe('sessionStream', () => {
  beforeEach(() => {
    delete (globalThis as any).window
  })

  it('replays live output to a pane that mounts later', async () => {
    const s = await loadStream()
    s.startSessionStream()
    s.emit('a', 'hello ')
    s.emit('a', 'world')

    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    expect(seen.join('')).toBe('hello world')
  })

  it('fills a window that never saw the session from the main process', async () => {
    const s = await loadStream({ scrollback: 'login banner\r\n$ ' })
    s.startSessionStream()

    await s.primeSessionHistory('a')

    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    expect(seen.join('')).toBe('login banner\r\n$ ')
  })

  it('keeps history ahead of output that arrives while the request is in flight', async () => {
    const s = await loadStream({ scrollback: 'OLD', deferred: true })
    s.startSessionStream()

    const priming = s.primeSessionHistory('a')
    s.emit('a', 'NEW') // lands before the main process answers
    s.releaseRequest()
    await priming

    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    expect(seen.join('')).toBe('OLDNEW')
  })

  it('makes a second mount wait for the first mount\'s request', async () => {
    // React mounts effects twice in development. The remount must not subscribe
    // against a buffer the first request has not filled yet — that replayed
    // nothing and left the pane blank.
    const s = await loadStream({ scrollback: 'HISTORY', deferred: true })
    s.startSessionStream()

    const first = s.primeSessionHistory('a')
    const second = s.primeSessionHistory('a')
    s.releaseRequest()
    await Promise.all([first, second])

    expect(s.electronAPI.invoke).toHaveBeenCalledTimes(1)

    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    expect(seen.join('')).toBe('HISTORY')
  })

  it('does not ask for history it already has live', async () => {
    const s = await loadStream({ scrollback: 'SHOULD NOT BE USED' })
    s.startSessionStream()
    s.emit('a', 'live output')

    await s.primeSessionHistory('a')

    expect(s.electronAPI.invoke).not.toHaveBeenCalled()
    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    expect(seen.join('')).toBe('live output')
  })

  it('re-primes after a session is closed and its buffer dropped', async () => {
    const s = await loadStream({ scrollback: 'HISTORY' })
    s.startSessionStream()

    await s.primeSessionHistory('a')
    s.clearSessionBuffer('a')
    await s.primeSessionHistory('a')

    expect(s.electronAPI.invoke).toHaveBeenCalledTimes(2)
  })

  it('leaves the pane usable when the main process cannot answer', async () => {
    const s = await loadStream()
    s.startSessionStream()
    s.electronAPI.invoke.mockRejectedValueOnce(new Error('gone'))

    await expect(s.primeSessionHistory('a')).resolves.toBeUndefined()

    const seen: string[] = []
    s.subscribeToSession('a', (chunk) => seen.push(chunk))
    s.emit('a', 'still works')
    expect(seen.join('')).toBe('still works')
  })
})
