import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils as sshUtils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { generateKeyPair, publicKeyFromPrivate, sanitizeComment } from './key-manager'

const dir = mkdtempSync(join(tmpdir(), 'smartcom-km-'))

const haveSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' })
    return true
  } catch (error) {
    return error instanceof Error && 'stderr' in error
  }
})()

/** Makes a key with the real binary, so imports are tested against real input. */
function keygen(args: string[], name: string): string {
  const path = join(dir, name)
  execFileSync('ssh-keygen', [...args, '-f', path], { stdio: 'pipe' })
  return path
}

describe('generateKeyPair — ed25519', () => {
  it('writes an OpenSSH container, not the PKCS#8 OpenSSH rejects', async () => {
    const key = await generateKeyPair({ type: 'ed25519', comment: 'me@box' })

    expect(key.privateKeyPem).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(key.privateKeyPem).not.toContain('BEGIN PRIVATE KEY')
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(key.publicKey.endsWith(' me@box')).toBe(true)
    expect(key.fingerprint.startsWith('SHA256:')).toBe(true)
    // OpenSSH strips base64 padding from fingerprints.
    expect(key.fingerprint).not.toContain('=')
  })

  it('produces a key ssh2 can authenticate with', async () => {
    const key = await generateKeyPair({ type: 'ed25519' })
    const parsed = sshUtils.parseKey(key.privateKeyPem)

    expect(parsed).not.toBeInstanceOf(Error)
    const parsedKey = Array.isArray(parsed) ? parsed[0] : parsed
    expect(parsedKey.type).toBe('ssh-ed25519')
    expect(parsedKey.isPrivateKey()).toBe(true)
    // The public half ssh2 derives must match what we advertise.
    expect(parsedKey.getPublicSSH().toString('base64')).toBe(key.publicKey.split(' ')[1])
  })

  it('encrypts the file when given a passphrase', async () => {
    const key = await generateKeyPair({ type: 'ed25519', passphrase: 'hunter2' })

    expect(sshUtils.parseKey(key.privateKeyPem, 'hunter2')).not.toBeInstanceOf(Error)
    expect(sshUtils.parseKey(key.privateKeyPem, 'wrong')).toBeInstanceOf(Error)
    expect(sshUtils.parseKey(key.privateKeyPem)).toBeInstanceOf(Error)
  })

  it.skipIf(!haveSshKeygen)('round-trips through the real ssh-keygen', async () => {
    const key = await generateKeyPair({ type: 'ed25519', comment: 'roundtrip@box' })
    const path = join(dir, 'generated-ed25519')
    writeFileSync(path, key.privateKeyPem, { mode: 0o600 })

    const derived = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', path], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()

    expect(derived.split(' ').slice(0, 2).join(' ')).toBe(
      key.publicKey.split(' ').slice(0, 2).join(' ')
    )
  })

  it.skipIf(!haveSshKeygen)('agrees with ssh-keygen on the fingerprint', async () => {
    const key = await generateKeyPair({ type: 'ed25519' })
    const path = join(dir, 'fingerprint-ed25519')
    writeFileSync(path, key.privateKeyPem, { mode: 0o600 })

    const printed = execFileSync('ssh-keygen', ['-l', '-f', path], {
      encoding: 'utf8',
      stdio: 'pipe',
    })

    // `ssh-keygen -l` prints "256 SHA256:… comment (ED25519)".
    expect(printed).toContain(key.fingerprint)
  })
})

describe('generateKeyPair — RSA', () => {
  it('still produces a PKCS#1 PEM for legacy compatibility', async () => {
    const key = await generateKeyPair({ type: 'rsa', bits: 2048, comment: 'legacy@box' })

    expect(key.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY')
    expect(key.publicKey.startsWith('ssh-rsa ')).toBe(true)
    expect(sshUtils.parseKey(key.privateKeyPem)).not.toBeInstanceOf(Error)
  })

  it('refuses a modulus too small to be worth generating', async () => {
    await expect(generateKeyPair({ type: 'rsa', bits: 1024 })).rejects.toThrow(/2048/)
  })
})

describe('publicKeyFromPrivate — import', () => {
  it.skipIf(!haveSshKeygen)('imports an unencrypted ed25519 key from ssh-keygen', async () => {
    // This is the exact case reported in issue #1: Node's crypto cannot read it.
    const path = keygen(['-t', 'ed25519', '-N', '', '-C', 'from@keygen'], 'import-ed25519')
    const result = await publicKeyFromPrivate(readFileSync(path, 'utf8'), undefined, 'mine@here')

    expect(result.type).toBe('ed25519')
    expect(result.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(result.publicKey.endsWith(' mine@here')).toBe(true)

    // The blob must match what ssh-keygen itself derives.
    const expected = readFileSync(`${path}.pub`, 'utf8').split(' ')[1]
    expect(result.publicKey.split(' ')[1]).toBe(expected)
  })

  it.skipIf(!haveSshKeygen)('imports a passphrase-protected ed25519 key', async () => {
    const path = keygen(['-t', 'ed25519', '-N', 's3cret', '-C', 'enc@keygen'], 'import-ed25519-enc')
    const result = await publicKeyFromPrivate(readFileSync(path, 'utf8'), 's3cret', 'enc@here')

    expect(result.type).toBe('ed25519')
    expect(result.publicKey.split(' ')[1]).toBe(readFileSync(`${path}.pub`, 'utf8').split(' ')[1])
  })

  it.skipIf(!haveSshKeygen)('imports an RSA key, unchanged behaviour', async () => {
    const path = keygen(['-t', 'rsa', '-b', '2048', '-N', '', '-m', 'PEM'], 'import-rsa')
    const result = await publicKeyFromPrivate(readFileSync(path, 'utf8'), undefined, 'rsa@here')

    expect(result.type).toBe('rsa')
    expect(result.publicKey.startsWith('ssh-rsa ')).toBe(true)
  })

  it.skipIf(!haveSshKeygen)('imports an RSA key in the newer OpenSSH container too', async () => {
    const path = keygen(['-t', 'rsa', '-b', '2048', '-N', ''], 'import-rsa-openssh')
    expect(readFileSync(path, 'utf8')).toContain('BEGIN OPENSSH PRIVATE KEY')

    const result = await publicKeyFromPrivate(readFileSync(path, 'utf8'), undefined, '')
    expect(result.type).toBe('rsa')
  })

  it.skipIf(!haveSshKeygen)('says the passphrase is wrong rather than leaking parser text', async () => {
    const path = keygen(['-t', 'ed25519', '-N', 'right'], 'import-wrongpass')

    await expect(
      publicKeyFromPrivate(readFileSync(path, 'utf8'), 'wrong', '')
    ).rejects.toThrow(/passphrase does not unlock this key/i)
  })

  it.skipIf(!haveSshKeygen)('asks for the passphrase when none was given', async () => {
    const path = keygen(['-t', 'ed25519', '-N', 'needed'], 'import-nopass')

    await expect(
      publicKeyFromPrivate(readFileSync(path, 'utf8'), undefined, '')
    ).rejects.toThrow(/passphrase-protected/i)
  })

  it.skipIf(!haveSshKeygen)('rejects a public key with an instruction, not a stack trace', async () => {
    const path = keygen(['-t', 'ed25519', '-N', ''], 'import-pubonly')

    await expect(
      publicKeyFromPrivate(readFileSync(`${path}.pub`, 'utf8'), undefined, '')
    ).rejects.toThrow(/public key, not a private one/i)
  })

  it('rejects a file that was never a key', async () => {
    await expect(publicKeyFromPrivate('hello, world', undefined, '')).rejects.toThrow(
      /does not look like a private key/i
    )
  })

  it('rejects an empty file', async () => {
    await expect(publicKeyFromPrivate('   ', undefined, '')).rejects.toThrow(/empty/i)
  })

  it.skipIf(!haveSshKeygen)('rejects a truncated key as unreadable', async () => {
    const path = keygen(['-t', 'ed25519', '-N', ''], 'import-corrupt')
    const text = readFileSync(path, 'utf8')
    const lines = text.trim().split('\n')
    // Drop a body line, keeping the armour, so it looks like a key and is not.
    const corrupted = [lines[0], ...lines.slice(2)].join('\n')

    await expect(publicKeyFromPrivate(corrupted, undefined, '')).rejects.toThrow()
  })

  it.skipIf(!haveSshKeygen)('rejects an ECDSA key by name', async () => {
    const path = keygen(['-t', 'ecdsa', '-b', '256', '-N', ''], 'import-ecdsa')

    await expect(publicKeyFromPrivate(readFileSync(path, 'utf8'), undefined, '')).rejects.toThrow(
      /Unsupported key type/i
    )
  })
})

describe('sanitizeComment', () => {
  it('keeps what a comment normally holds', () => {
    expect(sanitizeComment('nathan@workstation-1')).toBe('nathan@workstation-1')
  })

  it('strips quotes that would break the remote install command', () => {
    expect(sanitizeComment("bad'; rm -rf /")).toBe('bad rm -rf')
  })
})
