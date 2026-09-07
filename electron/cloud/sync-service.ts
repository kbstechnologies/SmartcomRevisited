import { EventEmitter } from 'events'
import type {
  SyncChange,
  SyncPullResponse,
  SyncPushResponse,
  SyncStatus,
} from '../../src/shared/cloud'

/**
 * SyncService — phase 4.
 *
 * Push what changed here, pull what changed elsewhere, apply it. That is the
 * whole of it, and the restraint is deliberate: every additional cleverness in
 * a sync engine is another way to lose somebody's data.
 *
 * ## The rule this exists under
 *
 * **The local database is the source of truth and the cloud is a peer.** No
 * terminal, session, button or script ever waits on this class. It runs on a
 * timer and after local edits, it fails silently into `getStatus().lastError`,
 * and switching it off changes nothing about how the application works.
 *
 * ## Order, and why it is push-then-pull
 *
 * Push first. If the two orders differ, pulling first means a local edit made
 * since the last sync is briefly overwritten by the server's older copy before
 * being pushed back — the value flickers, and on an unlucky crash the flicker
 * is what survives. Pushing first means the server has our newest before we ask
 * what it has, and last-write-wins then resolves it once, on the server, where
 * both versions are actually present.
 *
 * ## What it deliberately does not do
 *
 * - **No field-level merge.** Two edits of a shell command merged into a third
 *   command nobody wrote, then run on production network gear, is a worse
 *   outcome than losing one edit. Last write wins, whole object.
 * - **No sync of scripts or global variables.** Both are files on disk that the
 *   app indexes rather than owns; "which copy wins" is a different question
 *   with a different answer, and answering it badly would overwrite a file the
 *   user edits in their own editor.
 * - **No sync of secrets.** Passwords and key passphrases stay in the OS
 *   keystore and never enter a payload. That is phase 6, and it needs real
 *   client-side encryption rather than a pipe.
 */

export interface SyncServiceOptions {
  /**
   * Authenticated POST reporting the status, owned by CloudService so token
   * rotation and the offline diagnosis are shared. Null means no request could
   * be made at all.
   */
  post: <T>(
    path: string,
    body: unknown
  ) => Promise<{ status: number; body: T | null } | null>
  /** Whether a request could be attempted at all. */
  canReach: () => boolean
  /** Whether the account is entitled and the user has sync switched on. */
  isEnabled: () => boolean
  /** The workspace to sync with, or null for the account's personal one. */
  getWorkspaceId: () => string | null
  setWorkspace: (id: string, name: string) => void
  /**
   * Forgets the remembered workspace, so the next sync uses the personal one.
   *
   * Called when the server says the workspace does not exist — see the 404
   * handling below.
   */
  forgetWorkspace: () => void

  listLocalChanges: (limit?: number) => SyncChange[]
  countLocalChanges: () => number
  markSynced: (
    entries: Array<{ type: SyncChange['type']; objectId: string; revision: number }>
  ) => void
  applyRemoteChange: (change: SyncChange) => void
  getCursor: (workspaceId: string) => number
  setCursor: (workspaceId: string, cursor: number) => void
  getLastSyncAt: (workspaceId: string) => string | null

  log?: (event: string, detail?: Record<string, unknown>) => void
}

/** One page. Matches the server's own ceiling. */
const BATCH = 500

export class SyncService extends EventEmitter {
  private readonly options: SyncServiceOptions
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  /** The run in flight. Two syncs at once would push the same changes twice. */
  private running: Promise<SyncStatus> | null = null

  private workspaceId: string | null = null
  private workspaceName: string | null = null
  private lastError: string | null = null

  constructor(options: SyncServiceOptions) {
    super()
    this.options = options
    this.log = options.log ?? (() => {})
  }

  getStatus(): SyncStatus {
    const workspaceId = this.workspaceId ?? this.options.getWorkspaceId()

    return {
      workspaceId,
      workspaceName: this.workspaceName,
      enabled: this.options.isEnabled(),
      running: this.running !== null,
      pending: this.options.countLocalChanges(),
      lastSyncAt: workspaceId ? this.options.getLastSyncAt(workspaceId) : null,
      lastError: this.lastError,
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /**
   * Runs a sync, or joins the one already running.
   *
   * Single-flight for the same reason token rotation is: two concurrent runs
   * would each read the same dirty set and push it twice, and the second push
   * would then lose to the first as `stale` — harmless but pointless traffic,
   * and confusing in a log.
   */
  async syncNow(): Promise<SyncStatus> {
    if (this.running) return this.running

    this.running = this.run().finally(() => {
      this.running = null
      this.emitStatus()
    })

    this.emitStatus()

    return this.running
  }

  private async run(): Promise<SyncStatus> {
    if (!this.options.isEnabled() || !this.options.canReach()) {
      return this.getStatus()
    }

    try {
      this.lastError = null

      // A workspace the server does not know is not a transient failure and
      // will not fix itself: every sync from here on would fail the same way.
      // Forget it, fall back to the personal workspace, and go again — once.
      if (await this.workspaceIsGone()) {
        this.log('sync-workspace-gone', { workspaceId: this.options.getWorkspaceId() })
        this.options.forgetWorkspace()
        this.workspaceId = null
        this.workspaceName = null
      }

      await this.pushLocalChanges()
      await this.pullRemoteChanges()

      this.log('sync-complete', { pending: this.options.countLocalChanges() })
    } catch (error) {
      // Never thrown onward. A failed sync is a state, not an exception: the
      // local data is untouched and the next run tries again.
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log('sync-failed', { message: this.lastError })
    }

    return this.getStatus()
  }

  /**
   * Whether the remembered workspace has stopped existing for this account.
   *
   * A cheap zero-length pull, and only when a workspace is actually
   * remembered — an install syncing its personal workspace has nothing to
   * check. The server answers 404 both for "no such workspace" and for "not
   * yours", deliberately, and either is a reason to stop asking for it.
   */
  private async workspaceIsGone(): Promise<boolean> {
    const workspaceId = this.options.getWorkspaceId()
    if (!workspaceId) return false

    const probe = await this.options.post('/api/v1/sync/pull', {
      workspace_id: workspaceId,
      since: 0,
      limit: 1,
    })

    return probe?.status === 404
  }

  // ------------------------------------------------------------------- push

  private async pushLocalChanges(): Promise<void> {
    // Loops because a first sync of an established install can be thousands of
    // objects, and one enormous request is a request that times out halfway and
    // has to start again.
    for (;;) {
      const changes = this.options.listLocalChanges(BATCH)
      if (changes.length === 0) return

      const result = await this.options.post<
        SyncPushResponse & { workspace?: { id: string; name: string } }
      >('/api/v1/sync/push', { workspace_id: this.options.getWorkspaceId(), changes })

      const response = result?.body

      if (!response) {
        // Offline, unentitled, or refused. `CloudService` has recorded why.
        throw new Error('Could not upload changes.')
      }

      this.rememberWorkspace(response.workspace)

      // `stale` counts as done. The server has something newer, we will receive
      // it on the pull below, and leaving the object dirty would mean pushing
      // the same losing write on every run for ever.
      //
      // `limit_reached` deliberately does *not* — the object has not been
      // stored, and forgetting about it would silently drop it.
      const settled = response.results
        .filter((result) => result.outcome === 'applied' || result.outcome === 'stale')
        .map((result) => ({
          type: result.type,
          objectId: result.objectId,
          revision: result.revision,
        }))

      this.options.markSynced(settled)

      const blocked = response.results.filter((result) => result.outcome === 'limit_reached')
      if (blocked.length > 0) {
        this.log('sync-limit-reached', { blocked: blocked.length })
        throw new Error(
          `This plan's object limit has been reached, so ${blocked.length} item(s) were not uploaded.`
        )
      }

      // Nothing settled means nothing can settle; stop rather than spin.
      if (settled.length === 0) return
      if (changes.length < BATCH) return
    }
  }

  // ------------------------------------------------------------------- pull

  private async pullRemoteChanges(): Promise<void> {
    const workspaceId = this.options.getWorkspaceId() ?? this.workspaceId

    for (;;) {
      const since = workspaceId ? this.options.getCursor(workspaceId) : 0

      const result = await this.options.post<
        SyncPullResponse & { workspace?: { id: string; name: string } }
      >('/api/v1/sync/pull', { workspace_id: workspaceId, since, limit: BATCH })

      const response = result?.body

      if (!response) throw new Error('Could not download changes.')

      const resolvedId = this.rememberWorkspace(response.workspace) ?? workspaceId

      for (const change of response.changes) {
        try {
          this.options.applyRemoteChange(change)
        } catch (error) {
          // One malformed object must not stop the rest of the batch, and must
          // not stall the cursor for ever behind it. Logged and stepped over;
          // the object stays on the server and can be re-applied once the
          // reason is fixed.
          this.log('sync-apply-failed', {
            type: change.type,
            objectId: change.objectId,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // The cursor moves only after the batch has been applied. A crash between
      // the two costs a redundant re-apply, which is idempotent; moving it
      // first would cost the changes themselves.
      if (resolvedId) this.options.setCursor(resolvedId, response.cursor)

      if (!response.more) return
    }
  }

  private rememberWorkspace(workspace?: { id: string; name: string }): string | null {
    if (!workspace?.id) return null

    this.workspaceId = workspace.id
    this.workspaceName = workspace.name
    this.options.setWorkspace(workspace.id, workspace.name)

    return workspace.id
  }
}
