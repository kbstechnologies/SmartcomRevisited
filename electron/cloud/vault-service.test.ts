import { describe, it, expect, beforeEach } from 'vitest'
import { VaultService } from './vault-service'

/**
 * The vault service.
 *
 * The cryptography is proven in `vault-crypto.test.ts`. What is tested here is
 * everything around it: that nothing plaintext is ever sent, that a vault
 * cannot be destroyed by accident, and that a locked vault stays locked.
 */

const PASSPHRASE = 'correct horse battery staple'

interface Sent {
  method: string
  path: string
  body: any
}

describe('VaultService', () => {
  let sent: Sent[]
  let key: any
  let items: any[]
  let reachable: boolean

  const build = () =>
    new VaultService({
      request: async (method, path, rawBody) => {
        // The contract types the body as unknown, deliberately: CloudService
        // does not care what it is posting. The fake has to narrow it to
        // inspect what was sent.
        const body = rawBody as any
        sent.push({ method, path, body })

        if (!reachable) return null

        if (path === '/api/v1/vault/key') {
          if (method === 'PUT') {
            key = body.key
            return { stored: true } as any
          }
          return key ? ({ key } as any) : null
        }

        if (path === '/api/v1/vault/items') {
          return { items } as any
        }

        if (path.startsWith('/api/v1/vault/items/')) {
          const id = decodeURIComponent(path.split('/').pop()!)

          if (method === 'PUT') {
            items = items.filter((item) => item.id !== id)
            items.push({ id, label: body.label, envelope: body.envelope, deletedAt: null })
            return { ok: true } as any
          }

          if (method === 'DELETE') {
            items = items.map((item) =>
              item.id === id ? { ...item, envelope: null, label: null, deletedAt: 'now' } : item
            )
            return { deleted: true } as any
          }
        }

        return null
      },
    })

  beforeEach(() => {
    sent = []
    key = null
    items = []
    reachable = true
  })

  // ----------------------------------------------------------------- create

  it('creates a vault and holds the key only in memory', async () => {
    const vault = build()
    const status = await vault.create(PASSPHRASE)

    expect(status.unlocked).toBe(true)
    expect(status.exists).toBe(true)

    // Nothing resembling the passphrase went to the server.
    expect(JSON.stringify(sent)).not.toContain(PASSPHRASE)
  })

  it('refuses to create a second vault over an existing one', async () => {
    // Replacing the wrapped key orphans every secret under the old master key,
    // irreversibly, and nobody would find out until they next needed a password.
    await build().create(PASSPHRASE)

    await expect(build().create('a different passphrase entirely')).rejects.toThrow(
      /already has a vault/i
    )
  })

  it('does not claim a vault is missing when the server is unreachable', async () => {
    // "No vault" and "cannot ask" must not be conflated, or the app offers to
    // create a vault over one that already exists.
    reachable = false

    const status = await build().check()

    expect(status.exists).toBeNull()
  })

  // ----------------------------------------------------------------- unlock

  it('unlocks on another device with the same passphrase', async () => {
    const first = build()
    await first.create(PASSPHRASE)
    await first.put('core-router', 'Core router enable', 'enable-secret-42')

    const second = build()
    await second.unlock(PASSPHRASE)

    expect(second.read('core-router')).toBe('enable-secret-42')
  })

  it('refuses the wrong passphrase', async () => {
    await build().create(PASSPHRASE)

    await expect(build().unlock('not the passphrase at all')).rejects.toThrow(
      /does not open this vault/i
    )
  })

  // ------------------------------------------------------------------ items

  it('never sends a secret in the clear', async () => {
    // The property the whole feature rests on.
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('router', 'Router', 'hunter2-the-real-password')

    const put = sent.find((s) => s.method === 'PUT' && s.path.includes('/items/'))

    expect(put).toBeDefined()
    expect(JSON.stringify(put!.body)).not.toContain('hunter2-the-real-password')
    expect(put!.body.envelope).toHaveProperty('ciphertext')
    expect(put!.body.envelope).not.toHaveProperty('secret')
    expect(put!.body.envelope).not.toHaveProperty('plaintext')
  })

  it('lists labels without decrypting anything', async () => {
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('a', 'Core router', 'secret-a')
    await vault.put('b', 'Lab switch', 'secret-b')

    expect(vault.listItems()).toEqual([
      { id: 'a', label: 'Core router' },
      { id: 'b', label: 'Lab switch' },
    ])
  })

  it('refuses to read or write while locked', async () => {
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('router', 'Router', 'secret')

    vault.lock()

    expect(() => vault.read('router')).toThrow(/locked/i)
    await expect(vault.put('other', 'Other', 'secret')).rejects.toThrow(/locked/i)
    expect(vault.getStatus().unlocked).toBe(false)
  })

  it('returns null for a secret that has been tampered with', async () => {
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('router', 'Router', 'secret')

    // Somebody rewrites the server's copy.
    const stored = items.find((item) => item.id === 'router')!
    const bytes = Buffer.from(stored.envelope.ciphertext, 'base64')
    bytes[0] ^= 0xff
    stored.envelope.ciphertext = bytes.toString('base64')

    const second = build()
    await second.unlock(PASSPHRASE)

    expect(second.read('router')).toBeNull()
  })

  it('removes a secret and stops listing it', async () => {
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('router', 'Router', 'secret')

    await vault.remove('router')

    expect(vault.listItems()).toEqual([])
    expect(vault.read('router')).toBeNull()
  })

  // ------------------------------------------------------- passphrase change

  it('changes the passphrase without making a single secret unreadable', async () => {
    const vault = build()
    await vault.create(PASSPHRASE)
    await vault.put('router', 'Router', 'unchanged-secret')

    await vault.changePassphrase(PASSPHRASE, 'an entirely new passphrase')

    const elsewhere = build()
    await elsewhere.unlock('an entirely new passphrase')

    expect(elsewhere.read('router')).toBe('unchanged-secret')
    await expect(build().unlock(PASSPHRASE)).rejects.toThrow()
  })

  it('needs the current passphrase, not merely an unlocked session', async () => {
    // Otherwise somebody who walks up to an unlocked laptop can lock the owner
    // out of their own vault.
    const vault = build()
    await vault.create(PASSPHRASE)

    await expect(vault.changePassphrase('wrong current one', 'a brand new passphrase')).rejects.toThrow(
      /does not open this vault/i
    )
  })
})
