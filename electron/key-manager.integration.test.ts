import { Client } from 'ssh2'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildInstallCommand,
  generateKeyPair,
  installPublicKeyViaPassword,
  publicKeyFromPrivate,
  sanitizeComment,
} from './key-manager'
import { ProfileSchema, type Profile } from '../src/shared/types'

/**
 * Exercises key generation and ssh-copy-id-style deployment against the
 * disposable container in ../test-server.
 *
 *   docker build -t smartcom-test-server test-server
 *   docker run -d --name smartcom-test -p 2222:22 smartcom-test-server
 *
 * Skipped automatically when that host is not listening, so the default
 * `npm test` stays hermetic. Force it on with SMARTCOM_SSH_TESTS=1.
 */
const HOST = process.env.SMARTCOM_TEST_HOST ?? '127.0.0.1'
const PORT = Number(process.env.SMARTCOM_TEST_PORT ?? 2222)
const USER = process.env.SMARTCOM_TEST_USER ?? 'testuser'
const PASSWORD = process.env.SMARTCOM_TEST_PASSWORD ?? 'testpass'

// Built through the schema so defaults for the serial fields are filled in.
const profile: Profile = ProfileSchema.parse({
  id: 'test-profile',
  name: 'docker-test',
  transport: 'ssh',
  host: HOST,
  port: PORT,
  username: USER,
  authMethod: 'password',
})

async function canReach(): Promise<boolean> {
  const net = await import('net')
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(2000)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/** Runs a command over ssh2 using the given auth, resolving its stdout. */
function execWith(
  auth: { password?: string; privateKey?: string; passphrase?: string },
  command: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const timer = setTimeout(() => {
      client.end()
      reject(new Error('timeout'))
    }, 15000)

    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer)
            client.end()
            reject(err)
            return
          }
          let out = ''
          stream.on('data', (chunk: Buffer) => (out += chunk.toString()))
          stream.on('close', () => {
            clearTimeout(timer)
            client.end()
            resolve(out.trim())
          })
        })
      })
      .on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      .connect({ host: HOST, port: PORT, username: USER, readyTimeout: 10000, ...auth })
  })
}

describe('buildInstallCommand', () => {
  it('refuses a key containing a quote that would break the remote shell', () => {
    expect(() => buildInstallCommand("ssh-rsa AAAA' rm -rf /")).toThrow(/quote character/)
  })

  it('is idempotent by construction — greps before appending', () => {
    const script = buildInstallCommand('ssh-rsa AAAAB3 test@smartcom')
    expect(script).toContain('grep -qxF')
    expect(script).toContain('chmod 700 ~/.ssh')
    expect(script).toContain('chmod 600 ~/.ssh/authorized_keys')
  })
})

describe('sanitizeComment', () => {
  it('strips shell-significant characters but keeps user@host punctuation', () => {
    // Quote, semicolon and slash go; @ . - + and spaces are legitimate in
    // key comments and are preserved.
    expect(sanitizeComment("me@host'; rm -rf /")).toBe('me@host rm -rf')
    expect(sanitizeComment('me@laptop.local')).toBe('me@laptop.local')
    expect(sanitizeComment('a`b$(c)d')).toBe('abcd')
  })
})

// Probed in beforeAll rather than at module scope: a top-level await would
// require a different `module` setting than tsconfig-electron.json uses.
let reachable = false
const FORCED = process.env.SMARTCOM_SSH_TESTS === '1'

describe('against a live SSH server', () => {
  beforeAll(async () => {
    reachable = await canReach()
    if (!reachable && !FORCED) {
      console.warn(
        `[skip] no SSH server on ${HOST}:${PORT} — run "npm run testserver:up" to include these tests`
      )
    }
  })

  /** Skips unless the container is up (or the env var forces a hard failure). */
  const requireServer = (ctx: { skip: () => void }) => {
    if (!reachable && !FORCED) ctx.skip()
  }

  it('logs in with a password', async (ctx) => {
    requireServer(ctx)
    const out = await execWith({ password: PASSWORD }, 'whoami')
    expect(out).toBe(USER)
  }, 30000)

  it('generates a key, installs it, and then authenticates with it', async (ctx) => {
    requireServer(ctx)
    const generated = await generateKeyPair({
      type: 'rsa',
      bits: 2048,
      comment: 'smartcom-integration',
    })

    expect(generated.publicKey.startsWith('ssh-rsa ')).toBe(true)
    expect(generated.fingerprint.startsWith('SHA256:')).toBe(true)

    // Clean slate so the assertions below mean something.
    await execWith({ password: PASSWORD }, 'rm -f ~/.ssh/authorized_keys')

    const first = await installPublicKeyViaPassword(profile, PASSWORD, generated.publicKey)
    expect(first.success).toBe(true)
    expect(first.status).toBe('installed')

    // The whole point: the generated key must actually authenticate.
    const whoami = await execWith({ privateKey: generated.privateKeyPem }, 'whoami')
    expect(whoami).toBe(USER)

    // Permissions must satisfy sshd's StrictModes.
    const perms = await execWith(
      { privateKey: generated.privateKeyPem },
      'stat -c %a ~/.ssh ~/.ssh/authorized_keys'
    )
    expect(perms.split('\n').map((l) => l.trim())).toEqual(['700', '600'])

    // Re-running must not duplicate the entry.
    const second = await installPublicKeyViaPassword(profile, PASSWORD, generated.publicKey)
    expect(second.success).toBe(true)
    expect(second.status).toBe('already-present')

    const lineCount = await execWith(
      { privateKey: generated.privateKeyPem },
      'wc -l < ~/.ssh/authorized_keys'
    )
    expect(Number(lineCount)).toBe(1)
  }, 120000)

  it('round-trips a passphrase-protected key', async (ctx) => {
    requireServer(ctx)
    const passphrase = 'correct horse battery staple'
    const generated = await generateKeyPair({
      type: 'rsa',
      bits: 2048,
      comment: 'smartcom-passphrase',
      passphrase,
    })

    expect(generated.privateKeyPem).toContain('ENCRYPTED')

    // The public key we derive from the encrypted PEM must match the one we
    // published at generation time.
    const derived = await publicKeyFromPrivate(
      generated.privateKeyPem,
      passphrase,
      'smartcom-passphrase'
    )
    expect(derived.fingerprint).toBe(generated.fingerprint)

    await execWith({ password: PASSWORD }, 'rm -f ~/.ssh/authorized_keys')
    const installed = await installPublicKeyViaPassword(profile, PASSWORD, generated.publicKey)
    expect(installed.success).toBe(true)

    const whoami = await execWith(
      { privateKey: generated.privateKeyPem, passphrase },
      'whoami'
    )
    expect(whoami).toBe(USER)
  }, 120000)
})
