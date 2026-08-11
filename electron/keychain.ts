import { safeStorage, app } from 'electron'
import { join } from 'path'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

interface StoredCredential {
  service: string
  account: string
  /** Ciphertext from Electron's OS-backed safeStorage, base64 encoded. */
  ciphertext: string
  updatedAt: string
}

/**
 * Secret storage backed by Electron `safeStorage`, which delegates to DPAPI on
 * Windows, the Keychain on macOS, and libsecret/kwallet on Linux. The vault
 * file only ever holds ciphertext; the key never leaves the OS keystore.
 */
export class KeychainManager {
  private vaultPath: string
  private credentials = new Map<string, StoredCredential>()
  private loaded = false

  constructor() {
    const userDataPath = app.getPath('userData')
    mkdirSync(userDataPath, { recursive: true })
    this.vaultPath = join(userDataPath, 'credentials.json')
    // Loaded eagerly and synchronously: an async load in the constructor let
    // reads race ahead of it and silently return "no such credential".
    this.load()
  }

  /**
   * Throws when no OS keystore is reachable (common on a headless Linux box
   * with no keyring daemon). Failing loudly beats silently writing plaintext.
   */
  private assertEncryptionAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'OS credential encryption is unavailable. On Linux install/unlock a keyring ' +
          '(gnome-keyring or kwallet), then restart Smartcom Revisited. Secrets are never stored unencrypted.'
      )
    }
  }

  private keyOf(service: string, account: string): string {
    return `${service}:${account}`
  }

  private load(): void {
    this.loaded = true
    try {
      if (!existsSync(this.vaultPath)) return
      const parsed: StoredCredential[] = JSON.parse(readFileSync(this.vaultPath, 'utf8'))
      for (const cred of parsed) {
        if (cred?.service && cred?.account && cred?.ciphertext) {
          this.credentials.set(this.keyOf(cred.service, cred.account), cred)
        }
      }
    } catch {
      // Corrupt or unreadable vault: start empty rather than crash the app.
      this.credentials.clear()
    }
  }

  private persist(): void {
    const payload = JSON.stringify(Array.from(this.credentials.values()), null, 2)
    const tempPath = `${this.vaultPath}.tmp`

    // Write-then-rename so a crash mid-write cannot truncate the vault.
    writeFileSync(tempPath, payload, { mode: 0o600 })
    renameSync(tempPath, this.vaultPath)
    try {
      chmodSync(this.vaultPath, 0o600)
    } catch {
      // chmod is a no-op on some Windows filesystems; DPAPI still protects it.
    }
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    if (!this.loaded) this.load()

    const stored = this.credentials.get(this.keyOf(service, account))
    if (!stored) return null

    try {
      this.assertEncryptionAvailable()
      return safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'))
    } catch (error) {
      console.error(`Failed to decrypt secret for ${service}:${account}`, error)
      return null
    }
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.assertEncryptionAvailable()

    this.credentials.set(this.keyOf(service, account), {
      service,
      account,
      ciphertext: safeStorage.encryptString(password).toString('base64'),
      updatedAt: new Date().toISOString(),
    })
    this.persist()
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const deleted = this.credentials.delete(this.keyOf(service, account))
    if (deleted) this.persist()
    return deleted
  }

  async findCredentials(service: string): Promise<Array<{ account: string }>> {
    return Array.from(this.credentials.values())
      .filter((cred) => cred.service === service)
      .map((cred) => ({ account: cred.account }))
  }

  async findPassword(service: string): Promise<string | null> {
    const first = Array.from(this.credentials.values()).find((cred) => cred.service === service)
    return first ? this.getPassword(service, first.account) : null
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Which keyring is doing the encrypting, in words.
   *
   * Only Linux has a choice to report: Electron picks GNOME Keyring or KWallet
   * by desktop environment, and falls back to `basic` — a hardcoded key, which
   * is barely encryption at all — when libsecret is missing. That distinction
   * matters enough to show the user rather than leave it as a silent downgrade.
   */
  describeBackend(): string {
    if (process.platform === 'win32') return 'Windows DPAPI'
    if (process.platform === 'darwin') return 'macOS Keychain'

    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
      .getSelectedStorageBackend?.()

    switch (backend) {
      case 'gnome_libsecret':
        return 'GNOME Keyring (libsecret)'
      case 'kwallet':
      case 'kwallet5':
      case 'kwallet6':
        return 'KWallet'
      case 'basic_text':
        return 'none — install libsecret-1-0 (Debian/Ubuntu) or libsecret (Fedora)'
      case 'unknown':
      case undefined:
        return 'unknown'
      default:
        return backend
    }
  }

  /** Drops every secret belonging to a profile (password, passphrase, key). */
  async deleteAllForAccount(prefix: string): Promise<number> {
    let removed = 0
    for (const [key, cred] of Array.from(this.credentials.entries())) {
      if (cred.account.startsWith(prefix)) {
        this.credentials.delete(key)
        removed++
      }
    }
    if (removed > 0) this.persist()
    return removed
  }
}

let keychainManager: KeychainManager | null = null

export const getKeychainManager = (): KeychainManager => {
  if (!keychainManager) {
    keychainManager = new KeychainManager()
  }
  return keychainManager
}

/** keytar-compatible surface, so call sites read like the familiar API. */
export const keytar = {
  getPassword: (service: string, account: string) =>
    getKeychainManager().getPassword(service, account),
  setPassword: (service: string, account: string, password: string) =>
    getKeychainManager().setPassword(service, account, password),
  deletePassword: (service: string, account: string) =>
    getKeychainManager().deletePassword(service, account),
  findCredentials: (service: string) => getKeychainManager().findCredentials(service),
  findPassword: (service: string) => getKeychainManager().findPassword(service),
}
