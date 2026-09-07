import { keytar } from '../keychain'
import { VAULT_SERVICE } from '../../src/shared/constants'
import { trimBase } from '../../src/shared/cloud'

/**
 * Where SmartCom Cloud credentials live.
 *
 * Two rules, and both are the reason this is a file of its own rather than
 * four lines inside CloudService:
 *
 * 1. **The refresh token goes in the OS keystore, never in settings.**
 *    `settings.json` and the SQLite database are both plain files that get
 *    copied into backups, synced by corporate tooling and pasted into support
 *    tickets. A refresh token is a month-long credential for somebody's whole
 *    account. It goes through `safeStorage` — DPAPI, Keychain, libsecret —
 *    exactly like an SSH key passphrase does.
 *
 * 2. **The access token is never persisted at all.** It lives for fifteen
 *    minutes and is cheap to replace, so writing it anywhere buys nothing and
 *    puts a bearer credential on disk. It stays in the service's memory and
 *    dies with the process.
 *
 * Tokens are filed **per server host**. Pointing the app at a different
 * deployment must not hand that deployment a credential issued by another one,
 * and someone switching between a self-hosted server and the hosted service
 * should not have to sign in again each time they switch back.
 */

/** `cloud:refresh:smartcomrevisited.com` — one entry per server. */
export const cloudRefreshAccount = (baseUrl: string): string => {
  let host: string

  try {
    host = new URL(trimBase(baseUrl)).host
  } catch {
    // An unparseable URL still needs a stable, distinct key: falling back to a
    // shared one would let a typo'd server read the real server's token.
    host = trimBase(baseUrl).toLowerCase()
  }

  return `cloud:refresh:${host}`
}

export interface CloudTokenStore {
  read(baseUrl: string): Promise<string | null>
  write(baseUrl: string, refreshToken: string): Promise<void>
  clear(baseUrl: string): Promise<void>
}

/** The real one. Everything goes through `safeStorage`. */
export class KeychainCloudTokenStore implements CloudTokenStore {
  async read(baseUrl: string): Promise<string | null> {
    return keytar.getPassword(VAULT_SERVICE, cloudRefreshAccount(baseUrl))
  }

  async write(baseUrl: string, refreshToken: string): Promise<void> {
    await keytar.setPassword(VAULT_SERVICE, cloudRefreshAccount(baseUrl), refreshToken)
  }

  async clear(baseUrl: string): Promise<void> {
    await keytar.deletePassword(VAULT_SERVICE, cloudRefreshAccount(baseUrl))
  }
}

/** In-memory stand-in for tests, which have no OS keystore to talk to. */
export class MemoryCloudTokenStore implements CloudTokenStore {
  private tokens = new Map<string, string>()

  async read(baseUrl: string): Promise<string | null> {
    return this.tokens.get(cloudRefreshAccount(baseUrl)) ?? null
  }

  async write(baseUrl: string, refreshToken: string): Promise<void> {
    this.tokens.set(cloudRefreshAccount(baseUrl), refreshToken)
  }

  async clear(baseUrl: string): Promise<void> {
    this.tokens.delete(cloudRefreshAccount(baseUrl))
  }
}
