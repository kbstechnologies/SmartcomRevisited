import { z } from 'zod'

/**
 * SmartCom Cloud — the client half of the contract.
 *
 * These types mirror what `/api/v1/*` returns and nothing more. They are
 * deliberately *not* a model of the account: the server re-derives every
 * entitlement on every request, so what arrives here is only ever good enough
 * to draw the right panel with. Nothing in this file may be used to decide
 * whether an operation is allowed — the server decides that, and it decides it
 * again each time.
 *
 * ## The rule the whole subsystem serves
 *
 * SmartCom works with no account. Nothing here may sit between a person and
 * their terminal. Every call is optional, every failure is local, and a cloud
 * that is switched off, unreachable, unpaid or never signed into is a
 * *supported* state rather than a broken one.
 *
 * ## What the renderer is never given
 *
 * A token. Access tokens live in the main process's memory and nowhere else;
 * refresh tokens live in the OS keystore via `safeStorage`. `CloudState` is
 * display data — names, dates, plan labels — and carries no credential of any
 * kind, so a compromised renderer gains nothing it could replay.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The hosted service. A self-hosted deployment overrides it in Settings. */
export const CLOUD_DEFAULT_BASE_URL = 'https://smartcomrevisited.com'

export const CloudSettingsSchema = z.object({
  /**
   * Off, and it stays off until somebody turns it on.
   *
   * With this false the app makes no request to any SmartCom server, shows no
   * account UI, and behaves exactly as it did before the cloud existed. That
   * is not caution for its own sake: cross-device sync is what a subscription
   * is *for*, and it is not built yet, so an install that has never been asked
   * should not be talking to an account service.
   */
  enabled: z.boolean().default(false),

  /**
   * Server root, no trailing slash. Changing it is changing accounts: the
   * stored refresh token is filed per host, so pointing at a different server
   * never reuses another server's credential.
   */
  baseUrl: z.string().default(CLOUD_DEFAULT_BASE_URL),

  /**
   * How this machine is named in the account's device list. Blank uses the
   * hostname, which is what somebody scanning a list of devices expects to
   * recognise.
   */
  deviceName: z.string().default(''),
})

export type CloudSettings = z.infer<typeof CloudSettingsSchema>

// ---------------------------------------------------------------------------
// What the server sends back
// ---------------------------------------------------------------------------

export interface CloudUser {
  name: string
  email: string
  email_verified: boolean
}

export interface CloudDevice {
  id: string
  name: string
  platform: string
  app_version: string
  first_seen_at: string | null
  last_seen_at: string | null
  last_sync_at: string | null
  revoked: boolean
}

export interface CloudSubscription {
  plan: string
  status: string
  entitled: boolean
  current_period_end?: string | null
  cancel_at_period_end?: boolean
}

export interface CloudEntitlements {
  plan: string
  plan_label: string
  features: Record<string, boolean>
  limits: Record<string, number | null>
  vault_model: string
}

export interface CloudWorkspace {
  id: string
  type: string
  name: string
  slug?: string
  company?: string
  role?: string
  member_count?: number
  created_at?: string
}

/** `GET /api/v1/account` — one round trip, by the server's design. */
export interface CloudAccount {
  user: CloudUser
  subscription: CloudSubscription
  entitlements: CloudEntitlements
  workspaces: CloudWorkspace[]
  device: CloudDevice | null
  device_count: number
}

export interface CloudPlanOffer {
  plan: string
  label: string
  display_price: string
  display_period: string
  blurb: string
}

/** `GET /api/v1/billing`. Never carries a provider price id. */
export interface CloudBilling {
  available: boolean
  plans: CloudPlanOffer[]
  portal_available: boolean
  subscription: CloudSubscription
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * The four object types that synchronise, parents first.
 *
 * The order is the apply order and is load-bearing: a macro whose set has not
 * arrived yet has nowhere to go, and a profile that arrives before its folder
 * loses its grouping.
 *
 * **Scripts and global variables are deliberately absent.** Both are files on
 * disk that the app indexes rather than owns, so "which copy wins" is a
 * different question with a different answer — see docs/CLOUD_SYNC.md.
 */
export const SYNC_TYPES = ['group', 'macro_set', 'profile', 'macro'] as const
export type SyncObjectType = (typeof SYNC_TYPES)[number]

/**
 * One object's state, as it travels in either direction.
 *
 * `deletedAt` set makes this a **tombstone**: the object is gone and the
 * payload is null. Tombstones are the reason a delete on an offline laptop is
 * not undone by the next pull, and they are why deletion cannot simply be
 * "absence from the list".
 */
export interface SyncChange {
  type: SyncObjectType
  objectId: string
  /** The originating device's local revision. Ordering, not identity. */
  revision: number
  deletedAt: string | null
  updatedAt: string
  payload: Record<string, unknown> | null
}

/** What a push is answered with, per object. */
export interface SyncPushResult {
  type: SyncObjectType
  objectId: string
  revision: number
  /** `applied` | `stale` — stale means the server had something newer. */
  outcome: string
}

export interface SyncPullResponse {
  changes: SyncChange[]
  cursor: number
  /** True when there is more to fetch — pull again with the new cursor. */
  more: boolean
}

export interface SyncPushResponse {
  results: SyncPushResult[]
  cursor: number
}

/** What the panel shows about synchronisation. */
export interface SyncStatus {
  /** Never null once signed in: sync always has a workspace, personal by default. */
  workspaceId: string | null
  workspaceName: string | null
  enabled: boolean
  running: boolean
  pending: number
  lastSyncAt: string | null
  lastError: string | null
}

// ---------------------------------------------------------------------------
// What the renderer sees
// ---------------------------------------------------------------------------

/**
 * Why the last attempt to reach the cloud failed, in a form the panel can act
 * on rather than only print.
 *
 * `offline` and `server` are transient and worth a retry button; `auth` means
 * the stored refresh token is gone or revoked and only a sign-in fixes it;
 * `disabled` is not a failure at all.
 */
export type CloudErrorKind = 'none' | 'disabled' | 'offline' | 'server' | 'auth' | 'suspended'

export interface CloudError {
  kind: CloudErrorKind
  message: string
}

/**
 * Everything the Account panel draws, and the only cloud data that crosses the
 * IPC boundary.
 *
 * `signedIn` says a refresh token exists, not that the network is reachable —
 * an offline laptop is still signed in, and telling somebody they have been
 * signed out because their train went into a tunnel is how trust in a sync
 * product is lost.
 */
export interface CloudState {
  enabled: boolean
  baseUrl: string
  /** This machine's stable identifier within the account. */
  deviceId: string
  deviceName: string
  signedIn: boolean
  /** True while a request is in flight, so the panel can show it rather than freeze. */
  busy: boolean
  account: CloudAccount | null
  billing: CloudBilling | null
  /** When `account` was last refreshed from the server. */
  fetchedAt: string | null
  error: CloudError
}

/**
 * Where somebody is sent to create an account.
 *
 * Registration is not proxied through the API on purpose — the terms, the
 * price and the email verification all live on the website, and a second copy
 * of a consent flow is a second copy to keep correct.
 */
export const cloudSignupUrl = (baseUrl: string): string => `${trimBase(baseUrl)}/register`

export const cloudForgotPasswordUrl = (baseUrl: string): string =>
  `${trimBase(baseUrl)}/forgot-password`

export const trimBase = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '')

/**
 * A plan's human label, falling back to the raw key.
 *
 * The server sends `plan_label` precisely so this does not become a lookup
 * table here that drifts from `config/cloud.php`.
 */
export const cloudPlanLabel = (state: CloudState): string =>
  state.account?.entitlements.plan_label ?? 'Local'
