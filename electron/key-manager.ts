import { Client, utils as sshUtils } from 'ssh2'
import { createHash, generateKeyPair as generateKeyPairCb, type KeyObject } from 'crypto'
import { promisify } from 'util'
import { chmodSync, writeFileSync } from 'fs'
import type { Profile, SshKeyType } from '../src/shared/types'
import {
  ed25519PrivateFields,
  encodeMpint,
  encodeOpenSshPrivateKey,
  encodeString,
} from './openssh-key'

const generateKeyPairAsync = promisify(generateKeyPairCb)

export interface GeneratedKeyPair {
  /** PEM private key, passphrase-encrypted when one was supplied. */
  privateKeyPem: string
  /** Single-line OpenSSH public key: `<algo> <base64> <comment>`. */
  publicKey: string
  /** OpenSSH-style `SHA256:...` fingerprint of the public key blob. */
  fingerprint: string
}

// The SSH wire encoders live in openssh-key.ts, which is where the format they
// serve is documented; duplicating them here once meant two mpint routines.

const fromBase64Url = (value: string): Buffer => Buffer.from(value, 'base64url')

/** Builds the binary public-key blob that OpenSSH base64-encodes. */
function buildPublicKeyBlob(publicKey: KeyObject, type: SshKeyType): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>

  if (type === 'rsa') {
    return Buffer.concat([
      encodeString('ssh-rsa'),
      encodeMpint(fromBase64Url(jwk.e)),
      encodeMpint(fromBase64Url(jwk.n)),
    ])
  }

  return Buffer.concat([encodeString('ssh-ed25519'), encodeString(fromBase64Url(jwk.x))])
}

const algorithmName = (type: SshKeyType): string =>
  type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519'

/** OpenSSH prints SHA256 fingerprints base64 with padding stripped. */
export const fingerprintOf = (blob: Buffer): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`

/** Strips characters that would break the single-quoted remote shell command. */
export const sanitizeComment = (comment: string): string =>
  comment.replace(/[^\w@.\-+ ]/g, '').trim()

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export async function generateKeyPair(options: {
  type: SshKeyType
  bits?: number
  comment?: string
  passphrase?: string
}): Promise<GeneratedKeyPair> {
  const { type, bits = 4096, passphrase } = options
  const comment = sanitizeComment(options.comment || '')

  if (type === 'ed25519') return generateEd25519(comment, passphrase)

  if (bits < 2048) {
    throw new Error('RSA keys must be at least 2048 bits')
  }

  // RSA stays on PKCS#1 ("BEGIN RSA PRIVATE KEY"), which ssh2 and every legacy
  // device in scope read happily, and whose output was previously verified
  // byte-identical to ssh-keygen. Only ed25519 needs the OpenSSH container, so
  // only ed25519 gets it — there is nothing to gain from rewriting a path that
  // is known good and is the compatibility option by definition.
  const privateKeyEncoding: Record<string, unknown> = { type: 'pkcs1', format: 'pem' }
  if (passphrase) {
    privateKeyEncoding.cipher = 'aes-256-cbc'
    privateKeyEncoding.passphrase = passphrase
  }

  const { publicKey, privateKey } = (await generateKeyPairAsync('rsa' as never, {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding,
  } as never)) as unknown as { publicKey: Buffer; privateKey: string }

  const { createPublicKey } = await import('crypto')
  const publicKeyObject = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })

  const blob = buildPublicKeyBlob(publicKeyObject, 'rsa')

  return {
    privateKeyPem: privateKey,
    publicKey: [algorithmName('rsa'), blob.toString('base64'), comment].filter(Boolean).join(' '),
    fingerprint: fingerprintOf(blob),
  }
}

/**
 * ed25519 generation.
 *
 * Node exports these as PKCS#8 only, which OpenSSH rejects outright — that is
 * why generation used to be RSA-only. The seed and public point are the whole
 * key, so we take them from the JWK export and write OpenSSH's own container
 * ourselves (see `openssh-key.ts`). The result is verified against the real
 * `ssh-keygen -y` binary in `openssh-key.test.ts`, encrypted and not.
 */
async function generateEd25519(
  comment: string,
  passphrase?: string
): Promise<GeneratedKeyPair> {
  const { publicKey, privateKey } = (await generateKeyPairAsync('ed25519' as never, {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  } as never)) as unknown as { publicKey: Buffer; privateKey: Buffer }

  const { createPrivateKey, createPublicKey } = await import('crypto')

  const privateJwk = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }).export({
    format: 'jwk',
  }) as Record<string, string>
  const publicJwk = createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).export({
    format: 'jwk',
  }) as Record<string, string>

  const seed = Buffer.from(privateJwk.d, 'base64url')
  const point = Buffer.from(publicJwk.x, 'base64url')
  const blob = Buffer.concat([encodeString('ssh-ed25519'), encodeString(point)])

  return {
    privateKeyPem: encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: ed25519PrivateFields(seed, point),
      comment,
      passphrase,
    }),
    publicKey: [algorithmName('ed25519'), blob.toString('base64'), comment]
      .filter(Boolean)
      .join(' '),
    fingerprint: fingerprintOf(blob),
  }
}

/**
 * Turns whatever the user pointed at into a public key line, or explains why it
 * cannot.
 *
 * Parsing goes through ssh2 rather than Node's `crypto`. Node cannot read the
 * `openssh-key-v1` container at all — it answers
 * `error:1E08010C:DECODER routines::unsupported`, or on other builds the
 * `NO_START_LINE` reported in issue #1 — so every ed25519 key written by a
 * modern `ssh-keygen` failed to import while the dialog claimed to accept
 * "PEM or OpenSSH". ssh2 already ships a parser for both containers and is
 * already a dependency, and it is the same parser that will later authenticate
 * with the key, so agreeing with it here is the point.
 */
export async function publicKeyFromPrivate(
  privateKeyPem: string,
  passphrase: string | undefined,
  comment: string
): Promise<{ publicKey: string; fingerprint: string; type: SshKeyType }> {
  const text = privateKeyPem.trim()
  if (!text) throw new Error('The file is empty')

  const parsed = sshUtils.parseKey(text, passphrase || undefined)

  if (parsed instanceof Error) {
    throw new Error(describeParseFailure(parsed, text, passphrase))
  }

  // parseKey returns an array for formats that can hold several keys.
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key) throw new Error('No key was found in that file')

  if (!key.isPrivateKey()) {
    throw new Error(
      'That file holds a public key, not a private one. Import the file without the ' +
        '".pub" extension.'
    )
  }

  const type = SSH_TYPE_BY_ALGORITHM[key.type]
  if (!type) {
    throw new Error(
      `Unsupported key type "${key.type}". Smartcom Revisited supports ed25519 and RSA.`
    )
  }

  const blob = key.getPublicSSH()

  return {
    type,
    publicKey: [key.type, blob.toString('base64'), sanitizeComment(comment)]
      .filter(Boolean)
      .join(' '),
    fingerprint: fingerprintOf(blob),
  }
}

/** Algorithms this app will manage, keyed by the name ssh2 reports. */
const SSH_TYPE_BY_ALGORITHM: Record<string, SshKeyType | undefined> = {
  'ssh-rsa': 'rsa',
  'ssh-ed25519': 'ed25519',
}

/**
 * ssh2's parse errors are accurate but not addressed to a person — "Bad
 * passphrase?" and "Cannot parse privateKey" do not say what to do next. The
 * three cases below are the ones a user actually hits, and each is worth
 * telling apart: the wrong passphrase, a missing one, and a file that was never
 * a key.
 */
function describeParseFailure(error: Error, text: string, passphrase?: string): string {
  const message = error.message || String(error)

  if (/passphrase/i.test(message) || /decrypt/i.test(message)) {
    return passphrase
      ? 'That passphrase does not unlock this key. Check it and try again.'
      : 'This key is passphrase-protected. Enter its passphrase and try again.'
  }

  if (/encrypted/i.test(message) && !passphrase) {
    return 'This key is passphrase-protected. Enter its passphrase and try again.'
  }

  if (text.includes('PUBLIC KEY') || /^(ssh|ecdsa)-/.test(text)) {
    return 'That file holds a public key, not a private one.'
  }

  if (!text.includes('-----BEGIN')) {
    return (
      'That does not look like a private key file. Expected a file beginning with ' +
      '"-----BEGIN OPENSSH PRIVATE KEY-----" or "-----BEGIN RSA PRIVATE KEY-----".'
    )
  }

  return `Could not read that private key: ${message}`
}

/** Writes a private key to disk with owner-only permissions. */
export function writePrivateKeyFile(path: string, pem: string): void {
  writeFileSync(path, pem, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows filesystems may reject chmod; ACLs still apply.
  }
}

// ---------------------------------------------------------------------------
// Deployment (ssh-copy-id equivalent)
// ---------------------------------------------------------------------------

/**
 * Appends `publicKey` to the remote `~/.ssh/authorized_keys`, creating the
 * directory with correct permissions and skipping the write if already present
 * — the same contract as `ssh-copy-id`.
 */
export function buildInstallCommand(publicKey: string): string {
  const line = publicKey.replace(/\r?\n/g, ' ').trim()
  if (line.includes("'")) {
    throw new Error('Public key contains a quote character and cannot be installed safely')
  }

  return [
    'set -e',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `if grep -qxF '${line}' ~/.ssh/authorized_keys; then`,
    '  echo "SMARTCOM_RESULT=already-present"',
    'else',
    `  printf '%s\\n' '${line}' >> ~/.ssh/authorized_keys`,
    '  echo "SMARTCOM_RESULT=installed"',
    'fi',
  ].join('\n')
}

export interface DeployResult {
  success: boolean
  status: 'installed' | 'already-present' | 'failed'
  output: string
  error?: string
}

/** Runs the install command over an already-authenticated ssh2 client. */
export function installPublicKeyOnClient(
  client: Client,
  publicKey: string
): Promise<DeployResult> {
  const command = buildInstallCommand(publicKey)

  return new Promise((resolve) => {
    client.exec(command, (err, stream) => {
      if (err) {
        resolve({ success: false, status: 'failed', output: '', error: err.message })
        return
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      stream.on('close', (code: number) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim()

        if (code !== 0) {
          resolve({
            success: false,
            status: 'failed',
            output,
            error: stderr.trim() || `Remote command exited with code ${code}`,
          })
          return
        }

        resolve({
          success: true,
          status: stdout.includes('already-present') ? 'already-present' : 'installed',
          output,
        })
      })
    })
  })
}

/**
 * Opens a throwaway connection (typically password-authenticated) purely to
 * install the public key, then disconnects.
 */
export function installPublicKeyViaPassword(
  profile: Profile,
  password: string,
  publicKey: string
): Promise<DeployResult> {
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false

    const finish = (result: DeployResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end()
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ success: false, status: 'failed', output: '', error: 'Connection timeout' }),
      20000
    )

    client.on('ready', async () => {
      const result = await installPublicKeyOnClient(client, publicKey)
      finish(result)
    })

    client.on('error', (err) =>
      finish({ success: false, status: 'failed', output: '', error: err.message })
    )

    client.connect({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password,
      readyTimeout: 15000,
    })
  })
}
