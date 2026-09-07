import { describe, it, expect, beforeEach } from 'vitest'
import { SyncService, type SyncServiceOptions } from './sync-service'
import type { SyncChange } from '../../src/shared/cloud'

/**
 * The sync client.
 *
 * The database half is proven under Electron by `npm run test:db`, which is
 * where the real SQLite lives. What is tested here is the *protocol* behaviour
 * that database cannot show: what the client does with each outcome the server
 * can return, and the order it does things in.
 *
 * The cases that matter are the ones where getting it wrong loses data or
 * spins forever, and both are represented.
 */

interface Recorded {
  path: string
  body: any
}

/** The workspace the server reports back when none was named. */
const PERSONAL = 'ws-personal'

const change = (overrides: Partial<SyncChange> = {}): SyncChange => ({
  type: 'profile',
  objectId: 'obj-1',
  revision: 1,
  deletedAt: null,
  updatedAt: '2026-09-04T10:00:00Z',
  payload: { id: 'obj-1', name: 'Core Router' },
  ...overrides,
})

describe('SyncService', () => {
  let calls: Recorded[]
  let responses: Map<string, any[]>
  let dirty: SyncChange[]
  let applied: SyncChange[]
  let marked: Array<{ objectId: string; revision: number }>
  let cursors: Map<string, number>
  let enabled: boolean
  let reachable: boolean
  let workspaceId: string | null
  let forgotten: boolean

  const respond = (path: string, ...bodies: any[]) => {
    responses.set(path, bodies)
  }

  const build = (overrides: Partial<SyncServiceOptions> = {}) =>
    new SyncService({
      post: async (path, body) => {
        calls.push({ path, body })
        const queue = responses.get(path)
        if (!queue || queue.length === 0) return null

        const next = (queue.length === 1 ? queue[0] : queue.shift()) as any

        // The transport reports a status alongside the body. A bare object in
        // a test's queue means 200; `{ __status: n }` means a refusal.
        if (typeof next?.__status === 'number') {
          return { status: next.__status, body: null }
        }

        // The real server always names the workspace it acted on, including
        // when the client named none — that is how a client learns which
        // personal workspace it is syncing with.
        return {
          status: 200,
          body: { workspace: { id: PERSONAL, name: 'Personal' }, ...next },
        }
      },
      canReach: () => reachable,
      isEnabled: () => enabled,
      getWorkspaceId: () => workspaceId,
      setWorkspace: () => {},
      forgetWorkspace: () => {
        workspaceId = null
        forgotten = true
      },
      listLocalChanges: () => dirty.slice(),
      countLocalChanges: () => dirty.length,
      markSynced: (entries) => {
        for (const entry of entries) {
          marked.push({ objectId: entry.objectId, revision: entry.revision })
          dirty = dirty.filter((d) => d.objectId !== entry.objectId)
        }
      },
      applyRemoteChange: (c) => applied.push(c),
      getCursor: (id) => cursors.get(id) ?? 0,
      setCursor: (id, cursor) => cursors.set(id, cursor),
      getLastSyncAt: () => null,
      ...overrides,
    })

  beforeEach(() => {
    calls = []
    responses = new Map()
    dirty = []
    applied = []
    marked = []
    cursors = new Map()
    enabled = true
    reachable = true
    workspaceId = null
    forgotten = false
  })

  // ------------------------------------------------------------------ basics

  it('does nothing at all when sync is switched off', async () => {
    enabled = false
    dirty = [change()]

    await build().syncNow()

    expect(calls).toHaveLength(0)
  })

  it('does nothing when there is no way to reach the server', async () => {
    reachable = false
    dirty = [change()]

    await build().syncNow()

    expect(calls).toHaveLength(0)
  })

  it('pushes before it pulls', async () => {
    // Order is load-bearing: pulling first lets the server's older copy
    // briefly overwrite a local edit, and an unlucky crash makes that stick.
    dirty = [change()]
    respond('/api/v1/sync/push', { results: [{ type: 'profile', objectId: 'obj-1', revision: 1, outcome: 'applied' }], cursor: 3 })
    respond('/api/v1/sync/pull', { changes: [], cursor: 3, more: false })

    await build().syncNow()

    expect(calls.map((c) => c.path)).toEqual(['/api/v1/sync/push', '/api/v1/sync/pull'])
  })

  it('applies what came back and moves the cursor', async () => {
    respond('/api/v1/sync/pull', {
      changes: [change({ objectId: 'remote-1' })],
      cursor: 42,
      more: false,
    })

    await build().syncNow()

    expect(applied.map((c) => c.objectId)).toEqual(['remote-1'])
    expect(cursors.get(PERSONAL)).toBe(42)
  })

  // ---------------------------------------------------------------- outcomes

  it('treats a stale push as settled rather than retrying it forever', async () => {
    // The server had something newer. The winner arrives on the pull; leaving
    // the object dirty would push the same losing write on every run.
    dirty = [change()]
    respond('/api/v1/sync/push', {
      results: [{ type: 'profile', objectId: 'obj-1', revision: 1, outcome: 'stale' }],
      cursor: 1,
    })
    respond('/api/v1/sync/pull', { changes: [], cursor: 1, more: false })

    await build().syncNow()

    expect(marked.map((m) => m.objectId)).toEqual(['obj-1'])
    expect(dirty).toHaveLength(0)
  })

  it('does NOT forget an object the plan limit refused', async () => {
    // It was not stored. Marking it synced would silently drop it.
    dirty = [change()]
    respond('/api/v1/sync/push', {
      results: [{ type: 'profile', objectId: 'obj-1', revision: 1, outcome: 'limit_reached' }],
      cursor: 1,
    })

    const status = await build().syncNow()

    expect(marked).toHaveLength(0)
    expect(dirty).toHaveLength(1)
    expect(status.lastError).toContain('object limit')
  })

  it('records the pushed revision, not whatever the object is now', async () => {
    // An edit made while the request was in flight must stay dirty.
    dirty = [change({ revision: 4 })]
    respond('/api/v1/sync/push', {
      results: [{ type: 'profile', objectId: 'obj-1', revision: 4, outcome: 'applied' }],
      cursor: 1,
    })
    respond('/api/v1/sync/pull', { changes: [], cursor: 1, more: false })

    await build().syncNow()

    expect(marked).toEqual([{ objectId: 'obj-1', revision: 4 }])
  })

  // ----------------------------------------------------------------- paging

  it('keeps pulling while the server says there is more', async () => {
    respond(
      '/api/v1/sync/pull',
      { changes: [change({ objectId: 'a' })], cursor: 1, more: true },
      { changes: [change({ objectId: 'b' })], cursor: 2, more: false }
    )

    await build().syncNow()

    expect(applied.map((c) => c.objectId)).toEqual(['a', 'b'])
    expect(cursors.get(PERSONAL)).toBe(2)
  })

  it('stops instead of spinning when nothing can settle', async () => {
    // A server that accepts a push and reports nothing would otherwise loop.
    dirty = [change()]
    respond('/api/v1/sync/push', { results: [], cursor: 1 })
    respond('/api/v1/sync/pull', { changes: [], cursor: 1, more: false })

    await build().syncNow()

    expect(calls.filter((c) => c.path === '/api/v1/sync/push')).toHaveLength(1)
  })

  // ---------------------------------------------------------------- failure

  it('turns a failed request into a status, never an exception', async () => {
    dirty = [change()]
    // No response registered — the transport returns null.

    const status = await build().syncNow()

    expect(status.lastError).toBeTruthy()
    expect(dirty).toHaveLength(1)
    expect(marked).toHaveLength(0)
  })

  it('steps over one unapplicable object rather than stalling behind it', async () => {
    // A single malformed row must not freeze the cursor forever.
    respond('/api/v1/sync/pull', {
      changes: [change({ objectId: 'bad' }), change({ objectId: 'good' })],
      cursor: 9,
      more: false,
    })

    const service = build({
      applyRemoteChange: (c) => {
        if (c.objectId === 'bad') throw new Error('cannot apply')
        applied.push(c)
      },
    })

    const status = await service.syncNow()

    expect(applied.map((c) => c.objectId)).toEqual(['good'])
    expect(cursors.get(PERSONAL)).toBe(9)
    expect(status.lastError).toBeNull()
  })

  it('does not move the cursor when the pull itself failed', async () => {
    cursors.set(PERSONAL, 5)
    // No response registered for pull.

    await build().syncNow()

    expect(cursors.get(PERSONAL)).toBe(5)
  })

  // ----------------------------------------------------- a vanished workspace

  it('forgets a workspace the server no longer knows, and syncs anyway', async () => {
    // Found by running the desktop against a real server whose database had
    // been rebuilt. The client was holding a workspace id from the old one, and
    // every sync failed with "could not upload changes" — forever, with no way
    // back except clearing settings by hand. The same thing happens to somebody
    // removed from a team.
    workspaceId = 'ws-that-is-gone'
    dirty = [change()]

    respond('/api/v1/sync/pull', { __status: 404 }, { changes: [], cursor: 0, more: false })
    respond('/api/v1/sync/push', {
      results: [{ type: 'profile', objectId: 'obj-1', revision: 1, outcome: 'applied' }],
      cursor: 1,
    })

    const status = await build().syncNow()

    expect(forgotten).toBe(true)
    expect(status.lastError).toBeNull()
    expect(marked.map((m) => m.objectId)).toEqual(['obj-1'])

    // And it fell back to the personal workspace rather than asking for the
    // dead one again.
    const pushed = calls.find((c) => c.path === '/api/v1/sync/push')
    expect(pushed?.body.workspace_id).toBeNull()
  })

  it('does not forget a workspace over an ordinary failure', async () => {
    // A 500 or an outage must not detach somebody from their team workspace.
    workspaceId = 'ws-1'
    respond('/api/v1/sync/pull', { __status: 500 })

    await build().syncNow()

    expect(forgotten).toBe(false)
  })

  it('does not probe at all when syncing the personal workspace', async () => {
    // Nothing is remembered, so there is nothing that can be stale.
    respond('/api/v1/sync/pull', { changes: [], cursor: 0, more: false })

    await build().syncNow()

    expect(calls.filter((c) => c.path === '/api/v1/sync/pull')).toHaveLength(1)
  })

  // ------------------------------------------------------------ concurrency

  it('runs one sync at a time', async () => {
    dirty = [change()]
    respond('/api/v1/sync/push', {
      results: [{ type: 'profile', objectId: 'obj-1', revision: 1, outcome: 'applied' }],
      cursor: 1,
    })
    respond('/api/v1/sync/pull', { changes: [], cursor: 1, more: false })

    const service = build()
    await Promise.all([service.syncNow(), service.syncNow(), service.syncNow()])

    expect(calls.filter((c) => c.path === '/api/v1/sync/push')).toHaveLength(1)
  })
})
