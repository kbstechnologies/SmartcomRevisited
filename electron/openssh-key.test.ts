import { execFileSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ed25519PrivateFields,
  encodeOpenSshPrivateKey,
  encodeString,
  isOpenSshPrivateKey,
  rsaPrivateFields,
} from './openssh-key'

/**
 * These tests exist because of one specific past failure: key generation was
 * restricted to RSA on the belief that ed25519 private keys could not be
 * written in a form OpenSSH accepts. The belief came from Node exporting them
 * as PKCS#8, which `ssh-keygen -y` rejects as "invalid format".
 *
 * So the assertion that matters is not "our parser round-trips our own output"
 * — it is that the real `ssh-keygen` binary reads the file and derives the same
 * public key. Anything less would have passed under the old code too.
 */

/** `ssh-keygen -y` is the arbiter; without it these tests prove much less. */
const sshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' })
    return true
  } catch (error) {
    // `-?` is not a real flag, so it exits non-zero with usage text. That still
    // proves the binary is there; anything else means it is not.
    return error instanceof Error && 'stderr' in error
  }
})()

const dir = mkdtempSync(join(tmpdir(), 'smartcom-keys-'))

function writeKey(name: string, pem: string): string {
  const path = join(dir, name)
  writeFileSync(path, pem, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows may refuse chmod; ssh-keygen there does not enforce it either */
  }
  return path
}

/** Derives the public key with the real binary. Throws on a malformed file. */
function publicKeyViaSshKeygen(path: string, passphrase = ''): string {
  return execFileSync('ssh-keygen', ['-y', '-P', passphrase, '-f', path], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function newEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, string>
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, string>
  const seed = Buffer.from(priv.d, 'base64url')
  const point = Buffer.from(pub.x, 'base64url')
  const blob = Buffer.concat([encodeString('ssh-ed25519'), encodeString(point)])
  return { seed, point, blob }
}

describe('ed25519 private keys', () => {
  it('produces a file that announces itself as an OpenSSH container', () => {
    const { seed, point, blob } = newEd25519()
    const pem = encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: ed25519PrivateFields(seed, point),
      comment: 'test@smartcom',
    })

    expect(pem.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true)
    expect(pem.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(isOpenSshPrivateKey(pem)).toBe(true)
    // PKCS#8 is exactly what OpenSSH rejects, so it must not appear.
    expect(pem).not.toContain('BEGIN PRIVATE KEY')
  })

  it.skipIf(!sshKeygen)('is accepted by the real ssh-keygen, unencrypted', () => {
    const { seed, point, blob } = newEd25519()
    const pem = encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: ed25519PrivateFields(seed, point),
      comment: 'unencrypted@smartcom',
    })

    const path = writeKey('ed25519-plain', pem)
    const derived = publicKeyViaSshKeygen(path)

    expect(derived.split(' ')[0]).toBe('ssh-ed25519')
    expect(derived.split(' ')[1]).toBe(blob.toString('base64'))
  })

  it.skipIf(!sshKeygen)('is accepted by the real ssh-keygen when passphrase-protected', () => {
    const { seed, point, blob } = newEd25519()
    const pem = encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: ed25519PrivateFields(seed, point),
      comment: 'encrypted@smartcom',
      passphrase: 'correct horse battery staple',
    })

    const path = writeKey('ed25519-encrypted', pem)
    const derived = publicKeyViaSshKeygen(path, 'correct horse battery staple')

    expect(derived.split(' ')[1]).toBe(blob.toString('base64'))
  })

  it.skipIf(!sshKeygen)('is rejected by ssh-keygen when the passphrase is wrong', () => {
    const { seed, point, blob } = newEd25519()
    const pem = encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: ed25519PrivateFields(seed, point),
      passphrase: 'the right one',
    })

    const path = writeKey('ed25519-wrongpass', pem)
    expect(() => publicKeyViaSshKeygen(path, 'the wrong one')).toThrow()
  })

  it('refuses a seed or public key of the wrong length', () => {
    expect(() => ed25519PrivateFields(Buffer.alloc(16), Buffer.alloc(32))).toThrow(/32 bytes/)
    expect(() => ed25519PrivateFields(Buffer.alloc(32), Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('RSA private keys', () => {
  it.skipIf(!sshKeygen)('writes an OpenSSH container ssh-keygen accepts', () => {
    // 2048 keeps the test quick; the size is not what is under test.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>
    const pubJwk = publicKey.export({ format: 'jwk' }) as Record<string, string>

    const blob = Buffer.concat([
      encodeString('ssh-rsa'),
      // e and n as mpints, in that order for the public blob.
      (() => {
        const e = Buffer.from(pubJwk.e, 'base64url')
        return Buffer.concat([Buffer.alloc(0), encodeString(e)])
      })(),
      encodeString(Buffer.concat([Buffer.from([0]), Buffer.from(pubJwk.n, 'base64url')])),
    ])

    const pem = encodeOpenSshPrivateKey({
      publicBlob: blob,
      privateFields: rsaPrivateFields(jwk),
      comment: 'rsa@smartcom',
    })

    const path = writeKey('rsa-plain', pem)
    const derived = publicKeyViaSshKeygen(path)
    expect(derived.split(' ')[0]).toBe('ssh-rsa')
  })

  it('names the missing parameter when the JWK is incomplete', () => {
    expect(() => rsaPrivateFields({ n: 'AA', e: 'AQAB' })).toThrow(/missing the d parameter/)
  })
})

describe('why import does not go through Node crypto', () => {
  it.skipIf(!sshKeygen)('Node cannot read an OpenSSH container at all', () => {
    const path = join(dir, 'from-keygen')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'made@keygen', '-f', path], {
      stdio: 'pipe',
    })

    // This is the bug from issue #1, pinned so nobody "simplifies" the import
    // path back onto crypto.createPrivateKey. Node reports either
    // DECODER routines::unsupported or PEM routines: NO_START_LINE depending on
    // the OpenSSL build; both mean the same thing.
    expect(() => createPrivateKey({ key: readFileSync(path), format: 'pem' })).toThrow()

    // The same bytes are fine for ssh2, which is why the import path uses it.
    // This is a container problem, not an algorithm one.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { utils } = require('ssh2') as typeof import('ssh2')
    const parsed = utils.parseKey(readFileSync(path))
    expect(parsed).not.toBeInstanceOf(Error)
  })
})
