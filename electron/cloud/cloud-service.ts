import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import {
  cloudSignupUrl,
  trimBase,
  type CloudAccount,
  type CloudBilling,
  type CloudDevice,
  type CloudError,
  type CloudSettings,
  type CloudState,
} from '../../src/shared/cloud'
import {
  KeychainCloudTokenStore,
  type CloudTokenStore,
} from './cloud-tokens'

/**
 * CloudService — every byte that goes to or comes from a SmartCom Cloud server.
 *
 * Deliberately not called `CloudSyncService`: it synchronises nothing. Sync is
 * phase 4 and is blocked on desktop schema changes that have not been made, so
 * a class named for it would be a promise this code does not keep. What this
 * owns is *account*: sign in, refresh, devices, entitlements, and the two URLs
 * that open billing in a browser.
 *
 * ## The rules
 *
 * **Nothing here may sit between a person and their terminal.** Every method
 * fails locally and reports it through `getState().error`. There is no path in
 * this file that can prevent a session opening, a button running or the app
 * starting — and the whole subsystem is off until somebody turns it on.
 *
 * **No credential leaves the main process.** The access token is held in the
 * field below and never written anywhere; the refresh token goes to the OS
 * keystore. `getState()` is display data and carries neither.
 *
 * **The server is the authority on entitlement.** Anything cached here exists
 * to draw a panel, never to decide whether an operation is permitted.
 *
 * ## Two hazards that are specific to this server, and are handled here
 *
 * 1. **Refresh tokens rotate and reuse revokes the whole chain.** The server
 *    treats a second presentation of a consumed refresh token as a theft and
 *    signs every device out. Two of our own requests expiring at the same
 *    moment would do exactly that, so refresh is single-flight: concurrent
 *    callers await one rotation rather than each starting their own. This is
 *    the single most important thing in this file.
 *
 * 2. **A rotation that is lost is a sign-out.** The old token is consumed the
 *    instant the server answers, so the new one is written to the keystore
 *    *before* it is used for anything. A crash between the two would otherwise
 *    leave the machine holding a token that no longer works.
 */

export interface CloudServiceOptions {
  /** Read fresh each time: the server URL and the enabled flag can change under us. */
  getSettings: () => CloudSettings
  /** The stable device id, or null the first time. Persisted by the caller. */
  getDeviceId: () => string | null
  setDeviceId: (deviceId: string) => void
  appVersion: string
  /** `process.platform` in the real app. */
  platform: string
  /** Machine name, used when the user has not named this device themselves. */
  defaultDeviceName: string
  tokenStore?: CloudTokenStore
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  log?: (event: string, detail?: Record<string, unknown>) => void
}

const NO_ERROR: CloudError = { kind: 'none', message: '' }

/** Requests fail rather than hang. Fifteen seconds is generous for JSON. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Refresh this long before the access token actually expires.
 *
 * Clocks disagree and requests take time; presenting a token that expires
 * mid-flight costs a round trip and, worse, a needless rotation.
 */
const EXPIRY_SKEW_MS = 60_000

interface IssuedTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires_at?: string
}

export class CloudService extends EventEmitter {
  private readonly options: CloudServiceOptions
  private readonly tokens: CloudTokenStore
  private readonly fetchImpl: typeof fetch
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  /** In memory only, and deliberately so. Never written to disk. */
  private accessToken: string | null = null
  private accessExpiresAt = 0

  /** Mirrors whether a refresh token exists, so `getState()` stays synchronous. */
  private hasRefreshToken = false

  private account: CloudAccount | null = null
  private billing: CloudBilling | null = null
  private fetchedAt: string | null = null
  private error: CloudError = NO_ERROR
  private busy = false

  /** The in-flight rotation. See hazard 1 in the class comment. */
  private rotating: Promise<string | null> | null = null

  /** The base URL the current tokens belong to, so a server change resets state. */
  private boundBaseUrl: string | null = null

  constructor(options: CloudServiceOptions) {
    super()
    this.options = options
    this.tokens = options.tokenStore ?? new KeychainCloudTokenStore()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.log = options.log ?? (() => {})
  }

  // -------------------------------------------------------------------- state

  /**
   * Loads what can be known without the network.
   *
   * Called once at start-up. It reads the keystore so the panel can say
   * "signed in" before any request is made, and it does not go near the server:
   * an install that opens offline must still show the right thing.
   */
  async initialize(): Promise<void> {
    const settings = this.options.getSettings()
    if (!settings.enabled) return

    await this.bindTo(this.baseUrl())
    this.emitState()
  }

  getState(): CloudState {
    const settings = this.options.getSettings()
    const baseUrl = this.baseUrl()

    // Reading the keystore is asynchronous and this is not, so a server that
    // has changed since the last bind is reported as signed *out* until the
    // rebind confirms otherwise. Erring the other way would show one server's
    // sign-in against another's address, which is the single most misleading
    // thing this panel could say.
    const boundToCurrentServer = this.boundBaseUrl === baseUrl

    return {
      enabled: settings.enabled,
      baseUrl,
      deviceId: this.deviceId(),
      deviceName: this.deviceName(),
      signedIn: boundToCurrentServer && this.hasRefreshToken,
      busy: this.busy,
      account: boundToCurrentServer ? this.account : null,
      billing: boundToCurrentServer ? this.billing : null,
      fetchedAt: boundToCurrentServer ? this.fetchedAt : null,
      error: settings.enabled ? this.error : { kind: 'disabled', message: 'SmartCom Cloud is off.' },
    }
  }

  private emitState(): void {
    this.emit('status', this.getState())
  }

  /**
   * The device's identity within an account.
   *
   * Generated locally and once. The server offers an endpoint that hands out a
   * UUID, but it also documents that a client-generated one is fine — the id
   * is not a credential, it only names a row *inside* an already-authenticated
   * account. Generating it here means a first sign-in needs one round trip
   * rather than two, and works before the server is reachable.
   *
   * It must never be regenerated. A rotating id creates a new device row per
   * launch and burns through the plan's device limit in a week.
   */
  private deviceId(): string {
    const existing = this.options.getDeviceId()
    if (existing) return existing

    const created = randomUUID()
    this.options.setDeviceId(created)
    this.log('device-id-created')

    return created
  }

  private deviceName(): string {
    return this.options.getSettings().deviceName.trim() || this.options.defaultDeviceName
  }

  private baseUrl(): string {
    return trimBase(this.options.getSettings().baseUrl) || ''
  }

  signupUrl(): string {
    return cloudSignupUrl(this.baseUrl())
  }

  /**
   * Points the service at a server, reading whatever refresh token belongs to
   * it.
   *
   * Called at start-up and whenever the URL changes. Anything cached from the
   * previous server is dropped rather than shown against the new one — an
   * account panel showing one server's plan while talking to another is worse
   * than an empty one.
   */
  private async bindTo(baseUrl: string): Promise<void> {
    if (this.boundBaseUrl === baseUrl) return

    this.boundBaseUrl = baseUrl
    this.accessToken = null
    this.accessExpiresAt = 0
    this.account = null
    this.billing = null
    this.fetchedAt = null
    this.error = NO_ERROR
    this.hasRefreshToken = Boolean(await this.tokens.read(baseUrl))
  }

  // ------------------------------------------------------------------- auth

  async signIn(email: string, password: string): Promise<CloudState> {
    if (!this.assertEnabled()) return this.getState()

    const baseUrl = this.baseUrl()
    await this.bindTo(baseUrl)

    return this.withBusy(async () => {
      const response = await this.send('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email,
          password,
          device_id: this.deviceId(),
          device_name: this.deviceName(),
          platform: this.options.platform,
          app_version: this.options.appVersion,
        },
      })

      if (!response.ok) {
        this.error = await this.describeFailure(response)
        return
      }

      const body = (await response.json()) as { tokens: IssuedTokens }
      await this.acceptTokens(baseUrl, body.tokens)
      this.error = NO_ERROR

      // Straight into the account read, so one click produces a filled panel
      // rather than a signed-in one that then has to be refreshed by hand.
      await this.loadAccount()
    })
  }

  /**
   * Signs out.
   *
   * The local credential is cleared **whether or not the server was reachable**.
   * "Sign out" that silently does nothing because the machine is on a plane is
   * not a sign-out, and the person pressing it is usually trying to hand the
   * laptop to somebody. The server-side revocation is attempted first and its
   * failure is logged, not surfaced.
   */
  async signOut(everywhere = false): Promise<CloudState> {
    const baseUrl = this.baseUrl()

    return this.withBusy(async () => {
      try {
        if (this.hasRefreshToken && this.options.getSettings().enabled) {
          await this.request(everywhere ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout', {
            method: 'POST',
          })
        }
      } catch (error) {
        this.log('signout-remote-failed', { message: String(error) })
      }

      await this.tokens.clear(baseUrl)
      this.accessToken = null
      this.accessExpiresAt = 0
      this.hasRefreshToken = false
      this.account = null
      this.billing = null
      this.fetchedAt = null
      this.error = NO_ERROR
    })
  }

  /**
   * Stores a freshly issued pair.
   *
   * The refresh token is written before anything else happens with either. See
   * hazard 2 in the class comment: the server consumed the old one the moment
   * it answered, so losing the new one here is a sign-out on next launch.
   */
  private async acceptTokens(baseUrl: string, tokens: IssuedTokens): Promise<void> {
    await this.tokens.write(baseUrl, tokens.refresh_token)
    this.hasRefreshToken = true
    this.accessToken = tokens.access_token
    this.accessExpiresAt = Date.now() + Math.max(0, tokens.expires_in * 1000) - EXPIRY_SKEW_MS
  }

  /**
   * Returns a usable access token, rotating if necessary.
   *
   * Single-flight: every concurrent caller awaits the same rotation. Two
   * parallel rotations would present the same consumed refresh token, which
   * this server reads as a stolen credential and answers by revoking every
   * device on the account.
   */
  private async accessTokenFor(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessExpiresAt) {
      return this.accessToken
    }

    if (this.rotating) return this.rotating

    this.rotating = this.rotate().finally(() => {
      this.rotating = null
    })

    return this.rotating
  }

  private async rotate(): Promise<string | null> {
    const baseUrl = this.baseUrl()
    const refreshToken = await this.tokens.read(baseUrl)

    if (!refreshToken) {
      this.hasRefreshToken = false
      return null
    }

    const response = await this.send('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })

    if (response.status === 401) {
      // Expired, revoked, or the chain was torn down. Only a sign-in fixes it,
      // and pretending otherwise leaves the panel retrying forever.
      await this.tokens.clear(baseUrl)
      this.accessToken = null
      this.accessExpiresAt = 0
      this.hasRefreshToken = false
      this.error = { kind: 'auth', message: 'Signed out. Sign in again on this device.' }
      this.log('refresh-rejected')

      return null
    }

    if (!response.ok) {
      // A 500 or a proxy error is not a reason to throw away a month-long
      // credential that may well still be good.
      this.error = await this.describeFailure(response)
      return null
    }

    const body = (await response.json()) as { tokens: IssuedTokens }
    await this.acceptTokens(baseUrl, body.tokens)

    return this.accessToken
  }

  // ---------------------------------------------------------------- account

  /** Account and billing in one go, because the panel draws them together. */
  async loadAccount(): Promise<CloudState> {
    if (!this.assertEnabled()) return this.getState()
    if (!this.hasRefreshToken) return this.getState()

    return this.withBusy(async () => {
      try {
        const account = await this.getJson<CloudAccount>('/api/v1/account')
        if (account === null) return

        this.account = account
        this.fetchedAt = new Date().toISOString()
        this.error = NO_ERROR

        // Billing is a nicety: a server with no payment provider answers with
        // `available: false`, and an older server may not have the route at
        // all. Neither is a reason to blank the account panel.
        this.billing = await this.getJson<CloudBilling>('/api/v1/billing', { tolerate404: true })
      } catch (error) {
        this.error = this.describeThrown(error)
      }
    })
  }

  async listDevices(): Promise<CloudDevice[]> {
    if (!this.assertEnabled() || !this.hasRefreshToken) return []

    const body = await this.getJson<{ devices: CloudDevice[] }>('/api/v1/devices')
    return body?.devices ?? []
  }

  async renameDevice(deviceId: string, name: string): Promise<CloudDevice | null> {
    const response = await this.request(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: { name },
    })

    if (!response?.ok) return null

    const body = (await response.json()) as { device: CloudDevice }
    return body.device
  }

  /**
   * Ends a device's cloud access.
   *
   * Explicitly not a remote wipe, and the panel says so: the machine keeps
   * every host, button and script it already has and goes on working offline.
   * What it loses is the ability to reach the account.
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const response = await this.request(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    })

    if (response?.ok && deviceId === this.deviceId()) {
      // Revoking yourself is a sign-out, and the server has already torn the
      // tokens down. Leaving the panel claiming to be signed in would be a lie
      // it discovers on the next request.
      await this.signOut()
      return true
    }

    return Boolean(response?.ok)
  }

  // ---------------------------------------------------------------- billing

  /** A hosted checkout URL for the caller to open in the system browser. */
  async checkoutUrl(plan: string): Promise<string | null> {
    const response = await this.request('/api/v1/billing/checkout', {
      method: 'POST',
      body: { plan },
    })

    if (!response) return null

    if (!response.ok) {
      this.error = await this.describeFailure(response)
      this.emitState()
      return null
    }

    const body = (await response.json()) as { url: string }
    return body.url
  }

  /** The provider's own portal: card, invoices, plan changes, cancellation. */
  async portalUrl(): Promise<string | null> {
    const response = await this.request('/api/v1/billing/portal', { method: 'POST' })

    if (!response) return null

    if (!response.ok) {
      this.error = await this.describeFailure(response)
      this.emitState()
      return null
    }

    const body = (await response.json()) as { url: string }
    return body.url
  }

  /**
   * An authenticated POST returning JSON, for callers outside this class.
   *
   * `SyncService` is the only one, and it goes through here rather than owning
   * a second HTTP path so that token rotation, the single-flight guard and the
   * offline diagnosis all keep working for it too. Returns null when the
   * request could not be made or was refused; `getState().error` says why.
   */
  async postJson<T>(path: string, body: unknown): Promise<T | null> {
    return (await this.postWithStatus<T>(path, body))?.body ?? null
  }

  /**
   * The same, but reporting the status.
   *
   * `SyncService` needs it to tell one refusal apart from the rest: a 404 on a
   * named workspace means the client is holding an id the server no longer
   * knows — a workspace deleted, a team left, a server rebuilt — and the answer
   * is to forget it and fall back to the personal one. Every other failure is
   * "not now". Without the distinction a stale id is permanent: every sync
   * fails, forever, with no way back except clearing settings by hand.
   *
   * Returns null when no request could be made at all.
   */
  async postWithStatus<T>(
    path: string,
    body: unknown
  ): Promise<{ status: number; body: T | null } | null> {
    const response = await this.request(path, { method: 'POST', body })

    if (!response) return null

    if (!response.ok) {
      this.error = await this.describeFailure(response)
      return { status: response.status, body: null }
    }

    return { status: response.status, body: (await response.json()) as T }
  }

  /** Whether a request could be attempted at all. */
  canReachServer(): boolean {
    return this.options.getSettings().enabled && this.hasRefreshToken
  }

  // -------------------------------------------------------------------- http

  /**
   * An authenticated request, retried once across a token rotation.
   *
   * Exactly once. A 401 that survives a fresh access token is a real
   * authorization failure — a revoked device, a suspended account — and
   * retrying it in a loop turns one problem into a rate limit.
   */
  private async request(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' }
  ): Promise<Response | null> {
    if (!this.assertEnabled()) return null

    const token = await this.accessTokenFor()
    if (!token) return null

    let response = await this.send(path, { ...init, token })

    if (response.status === 401) {
      this.accessExpiresAt = 0
      const refreshed = await this.accessTokenFor()
      if (!refreshed) return response

      response = await this.send(path, { ...init, token: refreshed })
    }

    return response
  }

  private async getJson<T>(
    path: string,
    options: { tolerate404?: boolean } = {}
  ): Promise<T | null> {
    const response = await this.request(path)

    if (!response) return null

    if (response.status === 404 && options.tolerate404) return null

    if (!response.ok) {
      this.error = await this.describeFailure(response)
      return null
    }

    return (await response.json()) as T
  }

  /** The one place a request is actually made. */
  private async send(
    path: string,
    init: { method: string; body?: unknown; token?: string }
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Identifies the client in the server's logs, and is the only place the
      // app version travels other than the device record.
      'User-Agent': `SmartcomRevisited/${this.options.appVersion}`,
    }

    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (init.token) headers.Authorization = `Bearer ${init.token}`

    return this.fetchImpl(`${this.baseUrl()}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  // -------------------------------------------------------------- diagnosis

  private assertEnabled(): boolean {
    if (this.options.getSettings().enabled) return true

    this.error = { kind: 'disabled', message: 'SmartCom Cloud is off.' }
    return false
  }

  private async withBusy(work: () => Promise<void>): Promise<CloudState> {
    this.busy = true
    this.emitState()

    try {
      await work()
    } catch (error) {
      this.error = this.describeThrown(error)
    } finally {
      this.busy = false
      this.emitState()
    }

    return this.getState()
  }

  /**
   * Turns a failed response into something the panel can act on.
   *
   * The server's own message is used when it sent one — its wording is chosen
   * for exactly these cases ("This plan allows 5 devices. Revoke one to add
   * another.") and duplicating it here is how the two drift apart.
   */
  private async describeFailure(response: Response): Promise<CloudError> {
    let payload: Record<string, unknown> = {}

    try {
      payload = (await response.json()) as Record<string, unknown>
    } catch {
      // Not JSON — a proxy error page, most likely.
    }

    const message =
      typeof payload.message === 'string'
        ? payload.message
        : this.firstValidationMessage(payload) ?? `The server returned ${response.status}.`

    if (response.status === 401) return { kind: 'auth', message }
    if (response.status === 403 && payload.error === 'account_suspended') {
      return { kind: 'suspended', message }
    }
    if (response.status === 422 || response.status === 409 || response.status === 403) {
      return { kind: 'server', message }
    }
    if (response.status === 503) {
      return { kind: 'server', message: message || 'SmartCom Cloud is unavailable.' }
    }

    return { kind: 'server', message }
  }

  /** Laravel validation errors: `{ errors: { email: ['…'] } }`. */
  private firstValidationMessage(payload: Record<string, unknown>): string | null {
    const errors = payload.errors

    if (errors && typeof errors === 'object') {
      for (const value of Object.values(errors as Record<string, unknown>)) {
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
      }
    }

    return null
  }

  private describeThrown(error: unknown): CloudError {
    const message = error instanceof Error ? error.message : String(error)

    // Every one of these is "the network is not there", and none of them means
    // the credential is bad — so none of them may sign anybody out.
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' ||
        error.name === 'AbortError' ||
        /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(message))
    ) {
      return { kind: 'offline', message: 'Could not reach SmartCom Cloud.' }
    }

    this.log('unexpected-error', { message })

    return { kind: 'server', message }
  }
}
