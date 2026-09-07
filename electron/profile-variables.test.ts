import { describe, expect, it, vi, beforeEach } from 'vitest'

const getPassword = vi.fn()

vi.mock('./keychain', () => ({
  keytar: { getPassword: (...args: unknown[]) => getPassword(...args), setPassword: vi.fn(), deletePassword: vi.fn() },
  getKeychainManager: vi.fn(),
}))
// Enough of an ssh2 client to be wired up and torn down. Nothing here connects
// — every assertion below is about what happens *before* a packet is sent.
vi.mock('ssh2', () => ({
  Client: class {
    on() {
      return this
    }
    connect() {
      return this
    }
    end() {}
  },
  ConnectConfig: {},
}))

import { SSHManager } from './ssh-manager'
import type { Profile } from '../src/shared/types'

/**
 * `{{NAME}}` in a connection's own boxes, resolved from the globals file.
 *
 * The rules live in src/shared/profile-vars.ts and are tested there. What is
 * tested here is the wiring, which is where this can go quietly wrong: three
 * separate paths reach a remote — opening a session, building the connect
 * config, and Test — and a name resolved on two of them is worse than a name
 * resolved on none. The password matters most, because an unresolved one is
 * sent to the host as the literal `{{NAME}}` and reads as a wrong password
 * against an account that may lock out.
 */

const sshProfile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: 'p1',
    name: 'core',
    transport: 'ssh',
    host: '10.0.0.1',
    port: 22,
    username: 'admin',
    authMethod: 'password',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    shellArgs: [],
    shellKind: 'other',
    macroSetIds: [],
    tags: [],
    ...over,
  }) as Profile

describe('global variables in a connection', () => {
  let manager: SSHManager

  beforeEach(() => {
    getPassword.mockReset().mockResolvedValue(null)
    manager = new SSHManager('/tmp/logs')
    manager.setGlobalVariableProvider(() => ({
      SITE_CORE: '10.20.0.1',
      BASTION_USER: 'netops',
      SITE: 'leeds',
      VAULT_PW: 'hunter2',
    }))
  })

  const build = (profile: Profile) =>
    (manager as unknown as { buildConnectConfig: (p: Profile) => Promise<Record<string, unknown>> })
      .buildConnectConfig(profile)

  describe('the connect config', () => {
    it('resolves a password stored as a variable', async () => {
      getPassword.mockResolvedValue('{{VAULT_PW}}')
      const config = await build(sshProfile())
      expect(config.password).toBe('hunter2')
    })

    it('never sends an unresolved name as the password', async () => {
      // The failure this prevents: a literal {{TYPO}} arriving at the host as
      // a password attempt, which looks exactly like a wrong password.
      getPassword.mockResolvedValue('{{TYPO}}')
      await expect(build(sshProfile())).rejects.toThrow(/^Password refers to \{\{TYPO\}\}/)
    })

    it('leaves an ordinary password alone', async () => {
      getPassword.mockResolvedValue('literal-password')
      const config = await build(sshProfile())
      expect(config.password).toBe('literal-password')
    })

    it('does not touch the keychain for key authentication', async () => {
      await expect(
        build(sshProfile({ authMethod: 'key', keyPath: undefined, keyId: undefined }))
      ).rejects.toThrow(/no key was configured/)
    })
  })

  describe('opening a session', () => {
    it('resolves name, host and username onto the session', async () => {
      const stored = sshProfile({
        name: '{{SITE}} core',
        host: '{{SITE_CORE}}',
        username: '{{BASTION_USER}}',
      })

      const sessionId = await manager.createSession(stored)
      const session = manager.listSessions().find((entry) => entry.id === sessionId)

      // listSessions reports the name; the profile on the session carries the
      // rest, and is what `{{SESSION_HOST}}` and the log header read.
      expect(session?.profileName).toBe('leeds core')

      const live = (manager as unknown as { sessions: Map<string, { profile: Profile }> }).sessions
      expect(live.get(sessionId)?.profile.host).toBe('10.20.0.1')
      expect(live.get(sessionId)?.profile.username).toBe('netops')
    })

    it('leaves the saved connection holding the variable, not the value', async () => {
      const stored = sshProfile({ host: '{{SITE_CORE}}' })
      await manager.createSession(stored)

      // Resolving on the way out and never writing back is what lets one
      // connection follow whichever site the globals file currently names.
      expect(stored.host).toBe('{{SITE_CORE}}')
    })

    it('refuses to open rather than dialling a name it cannot resolve', async () => {
      await expect(manager.createSession(sshProfile({ host: '{{TYPO}}' }))).rejects.toThrow(
        /^Host refers to \{\{TYPO\}\}/
      )
      expect(manager.listSessions()).toHaveLength(0)
    })
  })

  describe('Test connection', () => {
    it('reports an unresolved name instead of a connection failure', async () => {
      // Test and Connect have to agree. A Test that dialled the literal
      // {{SITE_CORE}} would report the connection broken when it is fine.
      const result = await manager.testConnection(sshProfile({ host: '{{TYPO}}' }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/^Host refers to \{\{TYPO\}\}/)
    })
  })
})
