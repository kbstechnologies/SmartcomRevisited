import { Client } from 'ssh2'
import { createHash, generateKeyPair as generateKeyPairCb, type KeyObject } from 'crypto'
import { promisify } from 'util'
import { chmodSync, writeFileSync } from 'fs'
import type { Profile, SshKeyType } from '../src/shared/types'

const generateKeyPairAsync = promisify(generateKeyPairCb)

export interface GeneratedKeyPair {
  /** PEM private key, passphrase-encrypted when one was supplied. */
  privateKeyPem: string
  /** Single-line OpenSSH public key: `<algo> <base64> <comment>`. */
  publicKey: string
  /** OpenSSH-style `SHA256:...` fingerprint of the public key blob. */
  fingerprint: string
}

// ---------------------------------------------------------------------------
// OpenSSH wire encoding
// ---------------------------------------------------------------------------

const encodeUint32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/** SSH `string`: 4-byte big-endian length followed by the bytes. */
const encodeString = (data: Buffer | string): Buffer => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  return Buffer.concat([encodeUint32(buf.length), buf])
}

/**
 * SSH `mpint`: two's-complement big-endian. A leading zero byte is prepended
 * when the high bit is set, otherwise the value would read as negative.
 */
const encodeMpint = (value: Buffer): Buffer => {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start++
  let bytes = value.subarray(start)
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes])
  }
  return encodeString(bytes)
}

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

  // Node can only emit ed25519 private keys as PKCS#8, which OpenSSH rejects
  // ("invalid format") — it requires its own openssh-key-v1 container for that
  // algorithm. Generating one would hand the user an unusable file, so we
  // generate RSA only. Existing ed25519 keys can still be imported and used.
  if (type !== 'rsa') {
    throw new Error(
      'Smartcom Revisited generates RSA keys only. ed25519 private keys must be created with ' +
        '`ssh-keygen -t ed25519` and imported, so the file stays OpenSSH-compatible.'
    )
  }

  if (bits < 2048) {
    throw new Error('RSA keys must be at least 2048 bits')
  }

  // ssh2 parses PKCS#1 ("BEGIN RSA PRIVATE KEY") most reliably for RSA;
  // ed25519 is only exportable as PKCS#8.
  const privateKeyEncoding: any =
    type === 'rsa'
      ? { type: 'pkcs1', format: 'pem' }
      : { type: 'pkcs8', format: 'pem' }

  if (passphrase) {
    privateKeyEncoding.cipher = 'aes-256-cbc'
    privateKeyEncoding.passphrase = passphrase
  }

  const { publicKey, privateKey } = (await generateKeyPairAsync(
    type === 'rsa' ? ('rsa' as any) : ('ed25519' as any),
    {
      ...(type === 'rsa' ? { modulusLength: bits } : {}),
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding,
    } as any
  )) as unknown as { publicKey: Buffer; privateKey: string }

  const { createPublicKey } = await import('crypto')
  const publicKeyObject = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })

  const blob = buildPublicKeyBlob(publicKeyObject, type)
  const openSshPublicKey = [algorithmName(type), blob.toString('base64'), comment]
    .filter(Boolean)
    .join(' ')

  return {
    privateKeyPem: privateKey,
    publicKey: openSshPublicKey,
    fingerprint: fingerprintOf(blob),
  }
}

/** Derives the OpenSSH public key line from an existing private key PEM. */
export async function publicKeyFromPrivate(
  privateKeyPem: string,
  passphrase: string | undefined,
  comment: string
): Promise<{ publicKey: string; fingerprint: string; type: SshKeyType }> {
  const { createPrivateKey, createPublicKey } = await import('crypto')

  const privateKeyObject = createPrivateKey(
    passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem
  )
  const publicKeyObject = createPublicKey(privateKeyObject)

  const asymmetricType = publicKeyObject.asymmetricKeyType
  if (asymmetricType !== 'rsa' && asymmetricType !== 'ed25519') {
    throw new Error(`Unsupported key type: ${asymmetricType}`)
  }

  const type = asymmetricType as SshKeyType
  const blob = buildPublicKeyBlob(publicKeyObject, type)

  return {
    type,
    publicKey: [algorithmName(type), blob.toString('base64'), sanitizeComment(comment)]
      .filter(Boolean)
      .join(' '),
    fingerprint: fingerprintOf(blob),
  }
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
