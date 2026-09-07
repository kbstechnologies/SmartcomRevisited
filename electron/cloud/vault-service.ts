import { EventEmitter } from 'events'
import {
  changePassphrase,
  createVault,
  openSecret,
  sealSecret,
  unlockVault,
  type VaultEnvelope,
  type WrappedVaultKey,
} from './vault-crypto'

/**
 * VaultService — phase 6, the desktop half.
 *
 * Holds the master key **in memory and nowhere else**, for as long as the vault
 * is unlocked. Not in the OS keystore, not in a file, not in the database: an
 * unlocked vault is a decision the person made this session, and it should not
 * outlive the process without them saying so again.
 *
 * Every secret is encrypted here before it goes anywhere near
 * `CloudService.postJson`. There is no code path in this class that sends a
 * plaintext secret, and the server would refuse it anyway — its validation
 * accepts an AES-GCM envelope and nothing else.
 *
 * ## What the person has to be told, and when
 *
 * **There is no recovery.** Forgetting the passphrase means the vault is gone,
 * because the server holds nothing that could open it — which is the property
 * being paid for. `createVault` is where that has to be said, before the first
 * secret goes in and not afterwards.
 */

export interface VaultServiceOptions {
  /** Authenticated GET/PUT/DELETE, owned by CloudService. */
  request: <T>(method: string, path: string, body?: unknown) => Promise<T | null>
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export interface VaultStatus {
  /** Whether this account has a vault at all. Null until it has been checked. */
  exists: boolean | null
  unlocked: boolean
  itemCount: number
  lastError: string | null
}

interface RemoteItem {
  id: string
  label: string | null
  envelope: VaultEnvelope | null
  deletedAt: string | null
}

export class VaultService extends EventEmitter {
  private readonly options: VaultServiceOptions
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  /** The only copy, and it dies with the process. */
  private masterKey: Buffer | null = null

  private exists: boolean | null = null
  private items: RemoteItem[] = []
  private lastError: string | null = null

  constructor(options: VaultServiceOptions) {
    super()
    this.options = options
    this.log = options.log ?? (() => {})
  }

  getStatus(): VaultStatus {
    return {
      exists: this.exists,
      unlocked: this.masterKey !== null,
      itemCount: this.items.filter((item) => item.deletedAt === null).length,
      lastError: this.lastError,
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /**
   * Locks the vault.
   *
   * Overwrites the key material before dropping the reference. Node will not
   * promise the bytes are gone from every copy the allocator made, but leaving
   * a 32-byte key sitting in a live buffer for the rest of the session when it
   * costs one line not to would be careless.
   */
  lock(): void {
    this.masterKey?.fill(0)
    this.masterKey = null
    this.emitStatus()
  }

  /** Whether the account already has a vault, without unlocking it. */
  async check(): Promise<VaultStatus> {
    const key = await this.options.request<{ key: WrappedVaultKey }>('GET', '/api/v1/vault/key')

    // Null covers "no vault" (404) and "could not ask". They are different, and
    // the second must not be reported as the first — offering to create a vault
    // that already exists is how somebody replaces one and loses everything in
    // it.
    this.exists = key === null ? null : true
    this.emitStatus()

    return this.getStatus()
  }

  /**
   * Creates a vault. Refuses if one already exists.
   *
   * That refusal is load-bearing: replacing a wrapped key orphans every secret
   * encrypted under the old master key, irreversibly, and the person doing it
   * would have no idea until the next time they needed a password.
   */
  async create(passphrase: string): Promise<VaultStatus> {
    await this.check()

    if (this.exists) {
      throw new Error(
        'This account already has a vault. Unlock it with its passphrase — creating a new one ' +
          'would make every secret already in it permanently unreadable.'
      )
    }

    const { wrapped, masterKey } = await createVault(passphrase)

    const stored = await this.options.request('PUT', '/api/v1/vault/key', { key: wrapped })

    if (stored === null) {
      throw new Error('Could not save the vault. Nothing was created.')
    }

    this.masterKey = masterKey
    this.exists = true
    this.lastError = null
    this.emitStatus()

    return this.getStatus()
  }

  /** Unlocks with a passphrase, and loads the encrypted items. */
  async unlock(passphrase: string): Promise<VaultStatus> {
    const response = await this.options.request<{ key: WrappedVaultKey }>('GET', '/api/v1/vault/key')

    if (response === null) {
      throw new Error('Could not reach the vault.')
    }

    const masterKey = await unlockVault(passphrase, response.key)

    if (masterKey === null) {
      // One message for a wrong passphrase and for tampering. GCM cannot tell
      // them apart and neither should this.
      throw new Error('That passphrase does not open this vault.')
    }

    this.masterKey = masterKey
    this.exists = true
    this.lastError = null

    await this.refreshItems()
    this.emitStatus()

    return this.getStatus()
  }

  /**
   * Changes the passphrase.
   *
   * Re-wraps the master key and nothing else, so every secret stays readable
   * and no secret is decrypted in the process.
   */
  async changePassphrase(current: string, next: string): Promise<VaultStatus> {
    // Deliberately re-derives from the current passphrase rather than trusting
    // an already-unlocked session: somebody who walked up to an unlocked laptop
    // must not be able to lock the owner out of their own vault.
    const response = await this.options.request<{ key: WrappedVaultKey }>('GET', '/api/v1/vault/key')

    if (response === null) throw new Error('Could not reach the vault.')

    const masterKey = await unlockVault(current, response.key)

    if (masterKey === null) throw new Error('That passphrase does not open this vault.')

    const rewrapped = await changePassphrase(masterKey, next)
    const stored = await this.options.request('PUT', '/api/v1/vault/key', { key: rewrapped })

    if (stored === null) {
      throw new Error('Could not save the new passphrase. The old one still works.')
    }

    this.masterKey = masterKey
    this.emitStatus()

    return this.getStatus()
  }

  // ----------------------------------------------------------------- items

  /** Labels only. Reading a secret is a separate, deliberate call. */
  listItems(): Array<{ id: string; label: string | null }> {
    return this.items
      .filter((item) => item.deletedAt === null)
      .map((item) => ({ id: item.id, label: item.label }))
  }

  async put(itemId: string, label: string, secret: string): Promise<void> {
    const key = this.requireUnlocked()

    // Encrypted here, before anything is sent. The item id is bound into the
    // ciphertext, so this envelope cannot later be served up as a different
    // item's secret.
    const envelope = sealSecret(key, itemId, secret)

    const stored = await this.options.request(
      'PUT',
      `/api/v1/vault/items/${encodeURIComponent(itemId)}`,
      { label, envelope }
    )

    if (stored === null) throw new Error('Could not save that secret.')

    await this.refreshItems()
    this.emitStatus()
  }

  /**
   * Reads one secret.
   *
   * Returns null when the item is unknown or will not decrypt. A failure here
   * with an unlocked vault means the stored ciphertext has been altered, which
   * is worth logging as the security event it is.
   */
  read(itemId: string): string | null {
    const key = this.requireUnlocked()
    const item = this.items.find((candidate) => candidate.id === itemId)

    if (!item?.envelope) return null

    const plaintext = openSecret(key, itemId, item.envelope)

    if (plaintext === null) {
      this.log('vault-item-failed-authentication', { itemId })
    }

    return plaintext
  }

  async remove(itemId: string): Promise<void> {
    this.requireUnlocked()

    await this.options.request('DELETE', `/api/v1/vault/items/${encodeURIComponent(itemId)}`)

    await this.refreshItems()
    this.emitStatus()
  }

  private async refreshItems(): Promise<void> {
    const response = await this.options.request<{ items: RemoteItem[] }>('GET', '/api/v1/vault/items')

    // A failed refresh keeps what is already loaded rather than emptying the
    // list — an empty vault and an unreachable one look identical otherwise.
    if (response !== null) this.items = response.items
  }

  private requireUnlocked(): Buffer {
    if (this.masterKey === null) {
      throw new Error('The vault is locked.')
    }

    return this.masterKey
  }
}
