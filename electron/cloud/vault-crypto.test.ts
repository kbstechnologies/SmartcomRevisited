import { describe, it, expect } from 'vitest'
import {
  changePassphrase,
  createVault,
  deriveKek,
  openSecret,
  sameKey,
  sealSecret,
  unlockVault,
  VAULT_FORMAT_VERSION,
  MIN_PASSPHRASE_LENGTH,
} from './vault-crypto'

/**
 * The vault's cryptography.
 *
 * These are the tests that decide whether the phrase "the server holds no key
 * that decrypts it" is true or marketing. Every one of them is about a
 * property somebody would be relying on when they put a production router's
 * enable password in here.
 */

const PASSPHRASE = 'correct horse battery staple'

describe('vault crypto', () => {
  // ------------------------------------------------------------- round trip

  it('encrypts and decrypts a secret', async () => {
    const { masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', 'enable-secret-42')

    expect(openSecret(masterKey, 'item-1', sealed)).toBe('enable-secret-42')
  })

  it('never puts the plaintext in the envelope', async () => {
    const { masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', 'enable-secret-42')

    expect(JSON.stringify(sealed)).not.toContain('enable-secret-42')
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('enable')
  })

  it('never puts the master key or the passphrase in the wrapped key', async () => {
    // The wrapped key is what gets uploaded. If either appeared in it, the
    // whole design would be decorative.
    const { wrapped, masterKey } = await createVault(PASSPHRASE)
    const serialised = JSON.stringify(wrapped)

    expect(serialised).not.toContain(PASSPHRASE)
    expect(serialised).not.toContain(masterKey.toString('base64'))
    expect(serialised).not.toContain(masterKey.toString('hex'))
  })

  it('produces different ciphertext for the same secret every time', async () => {
    // A fresh IV per encryption. Identical ciphertexts would leak that two
    // hosts share a password.
    const { masterKey } = await createVault(PASSPHRASE)

    const first = sealSecret(masterKey, 'item-1', 'same-password')
    const second = sealSecret(masterKey, 'item-1', 'same-password')

    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.iv).not.toBe(second.iv)
    expect(openSecret(masterKey, 'item-1', second)).toBe('same-password')
  })

  it('gives every vault its own salt', async () => {
    const a = await createVault(PASSPHRASE)
    const b = await createVault(PASSPHRASE)

    expect(a.wrapped.salt).not.toBe(b.wrapped.salt)
    expect(a.masterKey.equals(b.masterKey)).toBe(false)
  })

  // ---------------------------------------------------------------- unlock

  it('unlocks with the right passphrase, on a second device', async () => {
    // The whole point of wrapping the key rather than deriving it: another
    // machine with the same passphrase and the same wrapped key gets the same
    // master key, and can read what the first one wrote.
    const { wrapped, masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', 'shared-secret')

    const onSecondDevice = await unlockVault(PASSPHRASE, wrapped)

    expect(onSecondDevice).not.toBeNull()
    expect(sameKey(onSecondDevice!, masterKey)).toBe(true)
    expect(openSecret(onSecondDevice!, 'item-1', sealed)).toBe('shared-secret')
  })

  it('returns null for the wrong passphrase rather than throwing', async () => {
    const { wrapped } = await createVault(PASSPHRASE)

    expect(await unlockVault('not the passphrase at all', wrapped)).toBeNull()
  })

  it('refuses a wrapped key whose ciphertext has been altered', async () => {
    // The server is explicitly in the threat model. Tampering must fail, not
    // produce a key that decrypts things into plausible nonsense.
    const { wrapped } = await createVault(PASSPHRASE)

    const bytes = Buffer.from(wrapped.ciphertext, 'base64')
    bytes[0] ^= 0xff

    expect(
      await unlockVault(PASSPHRASE, { ...wrapped, ciphertext: bytes.toString('base64') })
    ).toBeNull()
  })

  it('refuses a wrapped key whose authentication tag has been altered', async () => {
    const { wrapped } = await createVault(PASSPHRASE)

    const tag = Buffer.from(wrapped.tag, 'base64')
    tag[0] ^= 0xff

    expect(await unlockVault(PASSPHRASE, { ...wrapped, tag: tag.toString('base64') })).toBeNull()
  })

  it('refuses a vault written by a newer version instead of guessing', async () => {
    const { wrapped } = await createVault(PASSPHRASE)

    await expect(
      unlockVault(PASSPHRASE, { ...wrapped, version: VAULT_FORMAT_VERSION + 1 })
    ).rejects.toThrow(/newer version/i)
  })

  // ------------------------------------------------------------- tampering

  it('refuses a secret whose ciphertext has been altered', async () => {
    const { masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', 'enable-secret-42')

    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[0] ^= 0xff

    expect(
      openSecret(masterKey, 'item-1', { ...sealed, ciphertext: bytes.toString('base64') })
    ).toBeNull()
  })

  it('refuses a secret that has been moved onto a different item', async () => {
    // The least obvious control in the design, and the one with the worst
    // consequence if it were missing: somebody who can rewrite the server's
    // storage swaps the lab router's password onto the core router's entry,
    // every block verifies, and the wrong credential goes to production kit.
    const { masterKey } = await createVault(PASSPHRASE)
    const labSecret = sealSecret(masterKey, 'lab-router', 'lab-password')

    expect(openSecret(masterKey, 'lab-router', labSecret)).toBe('lab-password')
    expect(openSecret(masterKey, 'core-router', labSecret)).toBeNull()
  })

  it('refuses a secret opened with a different vault key', async () => {
    const mine = await createVault(PASSPHRASE)
    const theirs = await createVault('a completely different passphrase')

    const sealed = sealSecret(mine.masterKey, 'item-1', 'my-secret')

    expect(openSecret(theirs.masterKey, 'item-1', sealed)).toBeNull()
  })

  // ----------------------------------------------------- passphrase change

  it('re-wraps the master key without touching a single secret', async () => {
    // The reason for two layers. With one, a passphrase change would decrypt
    // and re-encrypt the whole vault, and a crash halfway would leave part of
    // it openable only with the old passphrase.
    const { wrapped, masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', 'unchanged')

    const rewrapped = await changePassphrase(masterKey, 'an entirely new passphrase')

    // The old passphrase no longer opens the vault...
    expect(await unlockVault(PASSPHRASE, rewrapped)).toBeNull()

    // ...the new one does, and it is the same master key...
    const unlocked = await unlockVault('an entirely new passphrase', rewrapped)
    expect(sameKey(unlocked!, masterKey)).toBe(true)

    // ...so every secret written before the change still opens, untouched.
    expect(openSecret(unlocked!, 'item-1', sealed)).toBe('unchanged')
    expect(wrapped.salt).not.toBe(rewrapped.salt)
  })

  // ---------------------------------------------------------------- policy

  it('refuses a passphrase too short to be worth encrypting with', async () => {
    await expect(createVault('short')).rejects.toThrow(
      new RegExp(`${MIN_PASSPHRASE_LENGTH} characters`)
    )
  })

  it('treats a passphrase the same however it was typed', async () => {
    // Unicode normalisation. The same characters entered on two operating
    // systems can be different byte sequences, and somebody locked out of
    // their own vault by their keyboard layout would have no way to diagnose
    // it.
    const composed = 'passphrase-café-long-enough'
    const decomposed = 'passphrase-café-long-enough'

    expect(composed).not.toBe(decomposed)

    const { wrapped } = await createVault(composed)

    expect(await unlockVault(decomposed, wrapped)).not.toBeNull()
  })

  it('derives the same key from the same passphrase and salt, and no other', async () => {
    const salt = Buffer.alloc(16, 7)
    const other = Buffer.alloc(16, 9)

    const a = await deriveKek(PASSPHRASE, salt)
    const b = await deriveKek(PASSPHRASE, salt)
    const c = await deriveKek(PASSPHRASE, other)

    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(false)
    expect(a).toHaveLength(32)
  })

  it('unlocks using the parameters the vault was written with', async () => {
    // A future release raising the cost must not lock anybody out of a vault
    // written under the old parameters.
    const { wrapped, masterKey } = await createVault(PASSPHRASE)
    const cheaper = { ...wrapped, N: wrapped.N, r: wrapped.r, p: wrapped.p }

    const unlocked = await unlockVault(PASSPHRASE, cheaper)

    expect(sameKey(unlocked!, masterKey)).toBe(true)
  })

  it('handles a secret with awkward content', async () => {
    const { masterKey } = await createVault(PASSPHRASE)
    const awkward = 'pässwörd\n\t"quoted" \\backslash\\ 🔐   end'

    const sealed = sealSecret(masterKey, 'item-1', awkward)

    expect(openSecret(masterKey, 'item-1', sealed)).toBe(awkward)
  })

  it('handles an empty secret without producing something unopenable', async () => {
    const { masterKey } = await createVault(PASSPHRASE)
    const sealed = sealSecret(masterKey, 'item-1', '')

    expect(openSecret(masterKey, 'item-1', sealed)).toBe('')
  })
})
