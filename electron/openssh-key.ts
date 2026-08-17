import { createCipheriv, randomBytes } from 'crypto'

/**
 * Writer for OpenSSH's own private-key container (`openssh-key-v1`).
 *
 * This module exists because Node cannot emit one. `crypto` exports ed25519
 * private keys as PKCS#8 only, and OpenSSH rejects that outright — `ssh-keygen
 * -y` on such a file answers "invalid format". That limitation is what
 * previously kept key generation RSA-only; it is a limitation of the *export
 * format*, not of ed25519, so the fix is to encode the container ourselves.
 *
 * The format is documented in OpenSSH's PROTOCOL.key:
 *
 *   "openssh-key-v1\0"
 *   string  ciphername            "none" | "aes256-ctr"
 *   string  kdfname               "none" | "bcrypt"
 *   string  kdfoptions            "" | (string salt, uint32 rounds)
 *   uint32  number of keys        always 1 here
 *   string  publickey             the same blob that goes in authorized_keys
 *   string  encrypted private section:
 *             uint32 checkint
 *             uint32 checkint     repeated; a mismatch means a wrong passphrase
 *             <algorithm-specific private fields>
 *             string comment
 *             padding 1,2,3,...   up to the cipher block size
 *
 * The doubled checkint is the whole reason a wrong passphrase is detectable:
 * decryption always "succeeds" with AES-CTR, so the two halves failing to match
 * is what tells you the key was garbage rather than the file.
 */

/** OpenSSH's default; also what `ssh-keygen` writes unless told otherwise. */
export const DEFAULT_KDF_ROUNDS = 16

const MAGIC = Buffer.from('openssh-key-v1\0', 'binary')

export const encodeUint32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/** SSH `string`: 4-byte big-endian length followed by the bytes. */
export const encodeString = (data: Buffer | string): Buffer => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  return Buffer.concat([encodeUint32(buf.length), buf])
}

/**
 * SSH `mpint`: two's-complement big-endian. A leading zero byte is prepended
 * when the high bit is set, otherwise the value would read as negative.
 */
export const encodeMpint = (value: Buffer): Buffer => {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start++
  let bytes = value.subarray(start)
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes])
  }
  return encodeString(bytes)
}

const fromBase64Url = (value: string): Buffer => Buffer.from(value, 'base64url')

/**
 * ed25519 private section. The "private key" field is the 64-byte
 * `seed || publicKey` concatenation OpenSSH expects, not the bare 32-byte seed
 * — a file carrying only the seed parses but fails every signature.
 */
export function ed25519PrivateFields(seed: Buffer, publicKey: Buffer): Buffer {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`)
  if (publicKey.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`)
  }

  return Buffer.concat([
    encodeString('ssh-ed25519'),
    encodeString(publicKey),
    encodeString(Buffer.concat([seed, publicKey])),
  ])
}

/** RSA private section. Field order is fixed by the format: n, e, d, iqmp, p, q. */
export function rsaPrivateFields(jwk: Record<string, string>): Buffer {
  for (const field of ['n', 'e', 'd', 'p', 'q', 'qi']) {
    if (!jwk[field]) throw new Error(`RSA key is missing the ${field} parameter`)
  }

  return Buffer.concat([
    encodeString('ssh-rsa'),
    encodeMpint(fromBase64Url(jwk.n)),
    encodeMpint(fromBase64Url(jwk.e)),
    encodeMpint(fromBase64Url(jwk.d)),
    // OpenSSH calls it iqmp; JWK calls the same value qi.
    encodeMpint(fromBase64Url(jwk.qi)),
    encodeMpint(fromBase64Url(jwk.p)),
    encodeMpint(fromBase64Url(jwk.q)),
  ])
}

/** Wraps DER in the PEM armour OpenSSH uses, at its 70-character line width. */
function armour(body: Buffer): string {
  const base64 = body.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 70) lines.push(base64.slice(i, i + 70))

  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...lines,
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n')
}

/**
 * Derives the AES key and IV the way OpenSSH does: one bcrypt_pbkdf pass
 * producing 48 bytes, split 32/16.
 *
 * bcrypt-pbkdf arrives as a transitive dependency of ssh2, which uses it to
 * *read* these files; it is declared directly in package.json because we now
 * depend on it to write them too.
 */
function deriveCipherMaterial(
  passphrase: string,
  salt: Buffer,
  rounds: number
): { key: Buffer; iv: Buffer } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bcryptPbkdf = require('bcrypt-pbkdf') as {
    pbkdf: (
      pass: Uint8Array,
      passLen: number,
      salt: Uint8Array,
      saltLen: number,
      key: Uint8Array,
      keyLen: number,
      rounds: number
    ) => number
  }

  const pass = Buffer.from(passphrase, 'utf8')
  const out = Buffer.alloc(48)
  bcryptPbkdf.pbkdf(pass, pass.length, salt, salt.length, out, out.length, rounds)

  return { key: out.subarray(0, 32), iv: out.subarray(32, 48) }
}

export interface EncodeOptions {
  /** The public blob, exactly as it appears base64-encoded in authorized_keys. */
  publicBlob: Buffer
  /** Algorithm-specific private fields from `ed25519PrivateFields` / `rsaPrivateFields`. */
  privateFields: Buffer
  comment?: string
  /** Omit or leave blank for an unencrypted key. */
  passphrase?: string
  rounds?: number
}

/** Builds a complete `-----BEGIN OPENSSH PRIVATE KEY-----` file. */
export function encodeOpenSshPrivateKey({
  publicBlob,
  privateFields,
  comment = '',
  passphrase,
  rounds = DEFAULT_KDF_ROUNDS,
}: EncodeOptions): string {
  const encrypted = Boolean(passphrase)

  // Both copies must match on decrypt; the value itself is arbitrary.
  const checkint = randomBytes(4)

  let plaintext = Buffer.concat([checkint, checkint, privateFields, encodeString(comment)])

  // Padding runs 1,2,3,… to the cipher's block size — 8 is used for the
  // unencrypted case, which has no cipher but still pads.
  const blockSize = encrypted ? 16 : 8
  const padding: number[] = []
  for (let i = plaintext.length % blockSize, n = 1; i !== 0; i = (i + 1) % blockSize, n++) {
    padding.push(n)
  }
  plaintext = Buffer.concat([plaintext, Buffer.from(padding)])

  let cipherName = 'none'
  let kdfName = 'none'
  let kdfOptions = Buffer.alloc(0)
  let privateSection = plaintext

  if (passphrase) {
    const salt = randomBytes(16)
    const { key, iv } = deriveCipherMaterial(passphrase, salt, rounds)
    const cipher = createCipheriv('aes-256-ctr', key, iv)
    privateSection = Buffer.concat([cipher.update(plaintext), cipher.final()])

    cipherName = 'aes256-ctr'
    kdfName = 'bcrypt'
    kdfOptions = Buffer.concat([encodeString(salt), encodeUint32(rounds)])
  }

  return armour(
    Buffer.concat([
      MAGIC,
      encodeString(cipherName),
      encodeString(kdfName),
      encodeString(kdfOptions),
      encodeUint32(1),
      encodeString(publicBlob),
      encodeString(privateSection),
    ])
  )
}

/** True when the text looks like an OpenSSH container rather than a PEM key. */
export const isOpenSshPrivateKey = (text: string): boolean =>
  text.includes('BEGIN OPENSSH PRIVATE KEY')
