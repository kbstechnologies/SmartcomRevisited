import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CloudService } from './cloud-service'
import { MemoryCloudTokenStore, cloudRefreshAccount } from './cloud-tokens'
import { CloudSettingsSchema, type CloudSettings } from '../../src/shared/cloud'

/**
 * The cloud account client.
 *
 * There is no server to test against — the site cannot run on this machine —
 * so every request is answered by a scripted `fetch`. That makes these tests
 * about the client's *behaviour*, which is where the expensive mistakes live:
 * what it does with a rotating credential, what it refuses to do when it is
 * switched off, and what it must never do when the network is simply absent.
 *
 * The shapes below are copied from the real controllers rather than invented.
 */

const BASE = 'https://cloud.example.test'

interface Call {
  url: string
  method: string
  body: any
  authorization: string | null
}

/**
 * A fetch stand-in that answers from a queue of handlers, records every call,
 * and fails loudly on anything unexpected — a request this test did not plan
 * for is the thing worth catching.
 */
class FakeServer {
  calls: Call[] = []
  private routes = new Map<string, (call: Call) => { status: number; body?: any }>()

  on(path: string, handler: (call: Call) => { status: number; body?: any }): this {
    this.routes.set(path, handler)
    return this
  }

  /** How many times a path was hit. The single-flight tests turn on this. */
  countOf(path: string): number {
    return this.calls.filter((call) => call.url.endsWith(path)).length
  }

  readonly fetch: typeof fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const path = url.slice(BASE.length)

    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
      authorization: (init.headers?.Authorization as string) ?? null,
    }
    this.calls.push(call)

    const handler = this.routes.get(path)
    if (!handler) throw new Error(`FakeServer: no handler for ${call.method} ${path}`)

    const { status, body } = handler(call)

    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const tokensBody = (suffix: string) => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 900,
  refresh_expires_at: '2027-01-01T00:00:00+00:00',
})

const accountBody = {
  user: { name: 'Nathan', email: 'nathan@example.test', email_verified: true },
  subscription: { plan: 'individual', status: 'active', entitled: true },
  entitlements: {
    plan: 'individual',
    plan_label: 'Individual Cloud',
    features: { cloud_sync: true, team_features: false, secret_sync: true, version_history: true },
    limits: { max_devices: 5, max_teams: 0, max_team_members: 0, max_objects: 10000, version_history_days: 30 },
    vault_model: 'client_side',
  },
  workspaces: [],
  device: null,
  device_count: 1,
}

describe('CloudService', () => {
  let server: FakeServer
  let tokens: MemoryCloudTokenStore
  let settings: CloudSettings
  let deviceId: string | null

  const build = () =>
    new CloudService({
      getSettings: () => settings,
      getDeviceId: () => deviceId,
      setDeviceId: (id) => {
        deviceId = id
      },
      appVersion: '1.7.0',
      platform: 'win32',
      defaultDeviceName: 'test-machine',
      tokenStore: tokens,
      fetchImpl: server.fetch,
    })

  beforeEach(() => {
    server = new FakeServer()
    tokens = new MemoryCloudTokenStore()
    deviceId = null
    settings = CloudSettingsSchema.parse({ enabled: true, baseUrl: BASE })
  })

  // ------------------------------------------------------------------- off

  describe('when it is switched off', () => {
    beforeEach(() => {
      settings = CloudSettingsSchema.parse({ enabled: false, baseUrl: BASE })
    })

    it('contacts no server at all', async () => {
      const cloud = build()

      await cloud.initialize()
      await cloud.signIn('nathan@example.test', 'hunter2')
      await cloud.loadAccount()
      await cloud.listDevices()

      expect(server.calls).toHaveLength(0)
    })

    it('reports itself as off rather than as broken', async () => {
      const cloud = build()
      await cloud.initialize()

      expect(cloud.getState().error.kind).toBe('disabled')
      expect(cloud.getState().signedIn).toBe(false)
    })
  })

  // ---------------------------------------------------------------- signing in

  it('signs in, stores only the refresh token, and loads the account', async () => {
    server
      .on('/api/v1/auth/login', () => ({ status: 200, body: { tokens: tokensBody('1') } }))
      .on('/api/v1/account', () => ({ status: 200, body: accountBody }))
      .on('/api/v1/billing', () => ({ status: 404 }))

    const cloud = build()
    const state = await cloud.signIn('nathan@example.test', 'hunter2')

    expect(state.signedIn).toBe(true)
    expect(state.account?.entitlements.plan_label).toBe('Individual Cloud')
    expect(state.error.kind).toBe('none')

    // The refresh token is in the store; the access token is nowhere but memory.
    expect(await tokens.read(BASE)).toBe('refresh-1')
    expect(JSON.stringify(state)).not.toContain('access-1')
    expect(JSON.stringify(state)).not.toContain('refresh-1')
  })

  it('sends a stable device id that it generates once', async () => {
    server
      .on('/api/v1/auth/login', () => ({ status: 200, body: { tokens: tokensBody('1') } }))
      .on('/api/v1/account', () => ({ status: 200, body: accountBody }))
      .on('/api/v1/billing', () => ({ status: 404 }))

    const cloud = build()
    await cloud.signIn('nathan@example.test', 'hunter2')
    const first = server.calls[0].body.device_id

    expect(first).toMatch(/^[0-9a-f-]{36}$/)

    // A second sign-in — a new service instance, as after a restart — must
    // reuse it. A rotating id creates a device row per launch and burns
    // through the plan's device limit in a week.
    await build().signIn('nathan@example.test', 'hunter2')

    expect(server.calls.filter((c) => c.url.endsWith('/auth/login'))[1].body.device_id).toBe(first)
  })

  it('reports the server’s own message when credentials are wrong', async () => {
    server.on('/api/v1/auth/login', () => ({
      status: 422,
      body: {
        message: 'Those credentials do not match our records.',
        errors: { email: ['Those credentials do not match our records.'] },
      },
    }))

    const cloud = build()
    const state = await cloud.signIn('nathan@example.test', 'wrong')

    expect(state.signedIn).toBe(false)
    expect(state.error.kind).toBe('server')
    expect(state.error.message).toBe('Those credentials do not match our records.')
  })

  it('surfaces a suspended account distinctly', async () => {
    server.on('/api/v1/auth/login', () => ({
      status: 403,
      body: { error: 'account_suspended', message: 'This account is suspended.' },
    }))

    const state = await build().signIn('nathan@example.test', 'hunter2')

    expect(state.error.kind).toBe('suspended')
  })

  it('passes the device limit message through instead of inventing one', async () => {
    server.on('/api/v1/auth/login', () => ({
      status: 409,
      body: {
        error: 'device_limit_reached',
        message: 'This plan allows 5 devices. Revoke one to add another.',
        limit: 5,
      },
    }))

    const state = await build().signIn('nathan@example.test', 'hunter2')

    expect(state.error.message).toContain('Revoke one to add another')
  })

  // ------------------------------------------------------------- rotation

  it('rotates once for concurrent requests, never twice', async () => {
    // The hazard this whole design turns on: presenting a consumed refresh
    // token is read by the server as a stolen credential and revokes every
    // device on the account. Two of our own expired requests must not do it.
    let refreshes = 0

    server
      .on('/api/v1/auth/refresh', () => {
        refreshes += 1
        return refreshes === 1
          ? { status: 200, body: { tokens: tokensBody('2') } }
          : { status: 401, body: { error: 'invalid_refresh_token' } }
      })
      .on('/api/v1/account', () => ({ status: 200, body: accountBody }))
      .on('/api/v1/devices', () => ({ status: 200, body: { devices: [] } }))
      .on('/api/v1/billing', () => ({ status: 404 }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()

    // Three calls at once, all needing an access token this service does not
    // yet have.
    await Promise.all([cloud.loadAccount(), cloud.listDevices(), cloud.listDevices()])

    expect(refreshes).toBe(1)
    expect(cloud.getState().signedIn).toBe(true)
  })

  it('stores the new refresh token before using the new access token', async () => {
    // The server consumes the old token the instant it answers. If the new one
    // is lost between the response and the keystore, the next launch is a
    // silent sign-out.
    const order: string[] = []

    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on('/api/v1/account', () => {
        order.push('account')
        return { status: 200, body: accountBody }
      })
      .on('/api/v1/billing', () => ({ status: 404 }))

    await tokens.write(BASE, 'refresh-1')

    const write = vi.spyOn(tokens, 'write').mockImplementation(async (base, token) => {
      order.push('write')
      MemoryCloudTokenStore.prototype.write.call(tokens, base, token)
    })

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(order).toEqual(['write', 'account'])
    expect(await tokens.read(BASE)).toBe('refresh-2')

    write.mockRestore()
  })

  it('signs out when the refresh token is rejected', async () => {
    server.on('/api/v1/auth/refresh', () => ({
      status: 401,
      body: { error: 'invalid_refresh_token', message: 'Sign in again on this device.' },
    }))

    await tokens.write(BASE, 'stale')

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(cloud.getState().signedIn).toBe(false)
    expect(cloud.getState().error.kind).toBe('auth')
    expect(await tokens.read(BASE)).toBeNull()
  })

  it('retries a 401 exactly once, then gives up', async () => {
    // A 401 that survives a fresh access token is a real authorization
    // failure — a revoked device. Retrying in a loop turns it into a rate
    // limit.
    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on('/api/v1/account', () => ({ status: 401, body: { error: 'unauthenticated' } }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(server.countOf('/api/v1/account')).toBe(2)
  })

  // -------------------------------------------------------------- offline

  it('does not sign anybody out because the network is missing', async () => {
    // The failure that must never be mistaken for a bad credential. A laptop
    // in a tunnel is still signed in.
    server.on('/api/v1/account', () => {
      throw new TypeError('fetch failed')
    })
    server.on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(cloud.getState().error.kind).toBe('offline')
    expect(cloud.getState().signedIn).toBe(true)
    expect(await tokens.read(BASE)).toBe('refresh-2')
  })

  it('keeps a refresh token when the refresh endpoint itself is broken', async () => {
    // A 500 or a proxy error is not a reason to throw away a month-long
    // credential that is probably still good.
    server.on('/api/v1/auth/refresh', () => ({ status: 502, body: { message: 'Bad gateway' } }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(cloud.getState().signedIn).toBe(true)
    expect(await tokens.read(BASE)).toBe('refresh-1')
  })

  it('reports "signed in" before it has spoken to anything', async () => {
    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()

    expect(cloud.getState().signedIn).toBe(true)
    expect(server.calls).toHaveLength(0)
  })

  // ------------------------------------------------------------ sign-out

  it('clears the local credential even when the server cannot be told', async () => {
    // Somebody pressing Sign out is usually about to hand the laptop over.
    server.on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
    server.on('/api/v1/auth/logout', () => {
      throw new TypeError('fetch failed')
    })

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()
    await cloud.signOut()

    expect(cloud.getState().signedIn).toBe(false)
    expect(await tokens.read(BASE)).toBeNull()
  })

  it('treats revoking this very device as a sign-out', async () => {
    deviceId = '11111111-2222-3333-4444-555555555555'

    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on(`/api/v1/devices/${deviceId}`, () => ({
        status: 200,
        body: { device: { id: deviceId, revoked: true }, note: 'Cloud access ended.' },
      }))
      .on('/api/v1/auth/logout', () => ({ status: 200, body: { signed_out: true } }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()

    expect(await cloud.revokeDevice(deviceId!)).toBe(true)
    expect(cloud.getState().signedIn).toBe(false)
  })

  // -------------------------------------------------------- server change

  it('files credentials per server, so switching never leaks one to the other', async () => {
    const other = 'https://selfhosted.example.test'

    await tokens.write(BASE, 'refresh-hosted')

    expect(cloudRefreshAccount(BASE)).not.toBe(cloudRefreshAccount(other))
    expect(await tokens.read(other)).toBeNull()

    const cloud = build()
    await cloud.initialize()
    expect(cloud.getState().signedIn).toBe(true)

    // Point at a different deployment: signed out there, and nothing cached
    // from the first one is shown against it.
    settings = CloudSettingsSchema.parse({ enabled: true, baseUrl: other })
    await cloud.initialize()

    expect(cloud.getState().signedIn).toBe(false)
    expect(cloud.getState().account).toBeNull()
  })

  it('does not claim a sign-in against a server it has not bound to yet', async () => {
    // Found in the running app: the Settings dialog writes the server through
    // the generic settings channel, so the service can be asked for its state
    // between the URL changing and the rebind completing. Answering "signed
    // in" there would show one server's account against another's address.
    await tokens.write(BASE, 'refresh-hosted')

    const cloud = build()
    await cloud.initialize()
    expect(cloud.getState().signedIn).toBe(true)

    settings = CloudSettingsSchema.parse({ enabled: true, baseUrl: 'https://other.example.test' })

    expect(cloud.getState().signedIn).toBe(false)
    expect(cloud.getState().account).toBeNull()
  })

  // -------------------------------------------------------------- billing

  it('asks for a checkout URL and hands it back without opening anything itself', async () => {
    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on('/api/v1/billing/checkout', () => ({
        status: 200,
        body: { url: 'https://checkout.stripe.test/pay/cs_1' },
      }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()

    expect(await cloud.checkoutUrl('individual')).toBe('https://checkout.stripe.test/pay/cs_1')
  })

  it('reports a server with no payment provider rather than failing silently', async () => {
    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on('/api/v1/billing/portal', () => ({
        status: 503,
        body: { error: 'billing_unavailable' },
      }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()

    expect(await cloud.portalUrl()).toBeNull()
    expect(cloud.getState().error.kind).toBe('server')
  })

  it('survives a server that has never heard of the billing route', async () => {
    // An older deployment: the account must still draw.
    server
      .on('/api/v1/auth/refresh', () => ({ status: 200, body: { tokens: tokensBody('2') } }))
      .on('/api/v1/account', () => ({ status: 200, body: accountBody }))
      .on('/api/v1/billing', () => ({ status: 404, body: {} }))

    await tokens.write(BASE, 'refresh-1')

    const cloud = build()
    await cloud.initialize()
    await cloud.loadAccount()

    expect(cloud.getState().account).not.toBeNull()
    expect(cloud.getState().billing).toBeNull()
    expect(cloud.getState().error.kind).toBe('none')
  })
})
