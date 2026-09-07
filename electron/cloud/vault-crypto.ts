import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

/**
 * The secure vault's cryptography — phase 6.
 *
 * **The server never holds a key that decrypts anything.** Everything in this
 * file runs on the user's machine; what leaves it is ciphertext and the
 * parameters needed to derive a key from a passphrase the server has never
 * seen. That is what `config/cloud.php` means by `vault.model: client_side`,
 * and until this file existed the honest thing to say — and what
 * `docs/SECURE_VAULT.md` did say — was that nothing was implemented.
 *
 * ## The shape
 *
 * ```
 *   passphrase ──scrypt(salt)──► key-encryption key ──AES-GCM──► master key
 *                                                                    │
 *   secret ─────────────────────────────AES-GCM(master key)──────────┘
 * ```
 *
 * Two layers rather than one, for a reason that matters in practice:
 * **changing the passphrase re-wraps the master key and nothing else.** With a
 * single layer, every secret would have to be decrypted and re-encrypted on a
 * passphrase change — thousands of round trips, and a window during which a
 * crash leaves half the vault readable with the old passphrase and half with
 * the new.
 *
 * ## The choices, and why
 *
 * - **scrypt**, not PBKDF2 or a bare hash. It is memory-hard, so an attacker
 *   with a GPU farm gains far less than they would against PBKDF2, and unlike
 *   Argon2 it is in Node's standard library — a dependency for a KDF is a
 *   dependency that has to stay trustworthy for as long as the vault exists.
 *
 * - **AES-256-GCM**, which is authenticated. A vault that used CBC would
 *   decrypt tampered ciphertext into plausible-looking garbage; GCM refuses.
 *   That is not a nicety here: the ciphertext is stored on a server, and the
 *   threat model explicitly includes that server being compromised.
 *
 * - **The item id is authenticated as additional data.** Without it, somebody
 *   who can rewrite the server's storage could move the ciphertext for "lab
 *   router password" onto "core router password" — every block would verify,
 *   and the user would send the wrong credential to production equipment. This
 *   is the single least obvious control in the file and the one most worth
 *   keeping.
 *
 * - **Parameters travel with the ciphertext.** A vault written today must
 *   still open in five years when the cost parameters have been raised twice.
 *
 * ## What this deliberately does not do
 *
 * There is **no recovery path**. Forgetting the passphrase means the vault is
 * gone, and that is the direct consequence of the server holding no key: a
 * reset would require somebody other than the user to be able to decrypt it,
 * which is exactly the property being sold. The UI has to say so before the
 * first secret goes in, not afterwards.
 */

/** Bumped only when the envelope itself changes shape. */
export const VAULT_FORMAT_VERSION = 1

/**
 * scrypt cost. N=65536, r=8, p=1 needs ~64 MB and about a tenth of a second on
 * a current laptop — heavy enough to be worth an attacker's while to avoid,
 * light enough that unlocking does not feel broken.
 *
 * `maxmem` has to be raised explicitly: Node's default is 32 MB and would
 * refuse these parameters outright.
 */
export const VAULT_KDF = { N: 65536, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 256 * 1024 * 1024

const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16

/** A wrapped master key, as stored on the server and on disk. */
export interface WrappedVaultKey {
  version: number
  kdf: 'scrypt'
  /** Base64. Unique per vault, and not a secret. */
  salt: string
  N: number
  r: number
  p: number
  /** Base64 IV and ciphertext of the master key. */
  iv: string
  ciphertext: string
  tag: string
}

/** One encrypted secret. */
export interface VaultEnvelope {
  version: number
  iv: string
  ciphertext: string
  tag: string
}

const b64 = (buffer: Buffer): string => buffer.toString('base64')
const unb64 = (value: string): Buffer => Buffer.from(value, 'base64')

/**
 * Derives the key-encryption key from a passphrase.
 *
 * Exported because the tests need to prove that the same passphrase and salt
 * always give the same key, and that a different salt does not.
 */
export async function deriveKek(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number } = VAULT_KDF
): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFKC'), salt, KEY_BYTES, {
    ...params,
    maxmem: SCRYPT_MAXMEM,
  })
}

/**
 * Creates a new vault: a random master key, wrapped under the passphrase.
 *
 * The master key is returned so the caller can hold it in memory for the
 * session. It is never written anywhere in the clear.
 */
export async function createVault(
  passphrase: string
): Promise<{ wrapped: WrappedVaultKey; masterKey: Buffer }> {
  assertUsablePassphrase(passphrase)

  const masterKey = randomBytes(KEY_BYTES)
  const salt = randomBytes(SALT_BYTES)
  const kek = await deriveKek(passphrase, salt)

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()])

  return {
    masterKey,
    wrapped: {
      version: VAULT_FORMAT_VERSION,
      kdf: 'scrypt',
      salt: b64(salt),
      N: VAULT_KDF.N,
      r: VAULT_KDF.r,
      p: VAULT_KDF.p,
      iv: b64(iv),
      ciphertext: b64(ciphertext),
      tag: b64(cipher.getAuthTag()),
    },
  }
}

/**
 * Unwraps the master key.
 *
 * Returns null for a wrong passphrase rather than throwing, because "wrong
 * passphrase" is an ordinary thing a person does and not an exceptional
 * condition. Tampering also lands here — GCM cannot tell the two apart, and
 * neither should the caller's message.
 */
export async function unlockVault(
  passphrase: string,
  wrapped: WrappedVaultKey
): Promise<Buffer | null> {
  if (wrapped.version > VAULT_FORMAT_VERSION) {
    throw new Error(
      'This vault was written by a newer version of Smartcom Revisited. Update to open it.'
    )
  }

  // The parameters stored with the vault, not today's — otherwise raising the
  // cost in a future release would lock everybody out of their own secrets.
  const kek = await deriveKek(passphrase, unb64(wrapped.salt), {
    N: wrapped.N,
    r: wrapped.r,
    p: wrapped.p,
  })

  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, unb64(wrapped.iv))
    decipher.setAuthTag(unb64(wrapped.tag))

    return Buffer.concat([decipher.update(unb64(wrapped.ciphertext)), decipher.final()])
  } catch {
    return null
  }
}

/**
 * Re-wraps the master key under a new passphrase.
 *
 * The secrets are untouched, which is the point of the two-layer design: this
 * is one small write, not a re-encryption of the whole vault with a window in
 * the middle where half of it opens with the old passphrase.
 */
export async function changePassphrase(
  masterKey: Buffer,
  newPassphrase: string
): Promise<WrappedVaultKey> {
  assertUsablePassphrase(newPassphrase)

  const salt = randomBytes(SALT_BYTES)
  const kek = await deriveKek(newPassphrase, salt)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()])

  return {
    version: VAULT_FORMAT_VERSION,
    kdf: 'scrypt',
    salt: b64(salt),
    N: VAULT_KDF.N,
    r: VAULT_KDF.r,
    p: VAULT_KDF.p,
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  }
}

/**
 * Encrypts one secret.
 *
 * `itemId` is authenticated but not encrypted: it is bound into the ciphertext
 * so that a blob cannot be moved from one item to another by anybody who can
 * write to the server. See the class comment — this is what stops a lab
 * password being served up as the production one.
 */
export function sealSecret(masterKey: Buffer, itemId: string, plaintext: string): VaultEnvelope {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  cipher.setAAD(Buffer.from(itemId, 'utf8'))

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ])

  return {
    version: VAULT_FORMAT_VERSION,
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  }
}

/**
 * Decrypts one secret, or returns null.
 *
 * Null covers every failure — wrong key, altered ciphertext, an envelope moved
 * to a different item — and they are deliberately not distinguished. A caller
 * that could tell "wrong key" from "tampered" would be an oracle.
 */
export function openSecret(
  masterKey: Buffer,
  itemId: string,
  envelope: VaultEnvelope
): string | null {
  if (envelope.version > VAULT_FORMAT_VERSION) return null

  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, unb64(envelope.iv))
    decipher.setAAD(Buffer.from(itemId, 'utf8'))
    decipher.setAuthTag(unb64(envelope.tag))

    const plaintext = Buffer.concat([
      decipher.update(unb64(envelope.ciphertext)),
      decipher.final(),
    ])

    return plaintext.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Whether two master keys are the same, in constant time.
 *
 * Used when a second device unlocks: it proves the passphrase produced the
 * same vault rather than a different one, without an early return that leaks
 * how much of the key matched.
 */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The one rule enforced on passphrases, and it is a length floor rather than a
 * character-class rule.
 *
 * Composition rules ("one capital, one symbol") measurably push people towards
 * `Password1!` and are worth nothing against an offline attack on a vault. A
 * length floor is the only cheap control that helps, and the UI's job is to
 * suggest a passphrase rather than to nag about punctuation.
 */
export const MIN_PASSPHRASE_LENGTH = 12

function assertUsablePassphrase(passphrase: string): void {
  if (passphrase.normalize('NFKC').length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `A vault passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. ` +
        'Three or four unrelated words are easier to remember and much harder to guess than a short one.'
    )
  }
}
