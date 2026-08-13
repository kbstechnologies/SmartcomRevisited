import { EventEmitter } from 'events'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./keychain', () => ({
  keytar: { getPassword: vi.fn().mockResolvedValue(null), setPassword: vi.fn(), deletePassword: vi.fn() },
  getKeychainManager: vi.fn(),
}))
vi.mock('ssh2', () => ({ Client: class {}, ConnectConfig: {} }))

import { SSHManager } from './ssh-manager'

/**
 * `insertSuggestion` is the only way assistant text reaches a session, and it
 * exists to keep one promise: the panel proposes commands and never runs them.
 * See src/shared/assistant-contract.ts.
 */

function fakeSession(bracketedPaste: boolean) {
  const written: string[] = []
  const session: any = Object.assign(new EventEmitter(), {
    id: 'session-1',
    profile: { id: 'p1', name: 'test', host: 'h', port: 22, username: 'u', authMethod: 'password' },
    client: {},
    status: 'connected',
    bracketedPaste,
    lastActivity: new Date(),
    createdAt: new Date(),
    shell: { write: (text: string) => written.push(text) },
  })
  return { session, written }
}

describe('inserting an assistant suggestion', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  const withSession = (session: any) => (manager as any).sessions.set(session.id, session)

  it('never submits the command it inserts', () => {
    const { session, written } = fakeSession(true)
    withSession(session)

    const result = manager.insertSuggestion(session.id, 'show version\n')

    expect(result.inserted).toBe(true)
    // The text lands on the command line; pressing Enter stays the operator's.
    expect(written.join('')).not.toMatch(/[\r\n](\x1b\[201~)?$/)
    expect(written.join('')).toContain('show version')
  })

  it('strips every trailing newline, however many arrived', () => {
    const { session, written } = fakeSession(true)
    withSession(session)

    manager.insertSuggestion(session.id, 'uptime\r\n\r\n')
    expect(written.join('')).toBe('\x1b[200~uptime\x1b[201~')
  })

  it('refuses multi-line text when the remote would run each line', () => {
    // A serial console or a device CLI that has not enabled bracketed paste
    // cannot tell a paste from typing: every CR is Enter.
    const { session, written } = fakeSession(false)
    withSession(session)

    const result = manager.insertSuggestion(session.id, 'show version\nshow running-config')

    expect(result.inserted).toBe(false)
    expect(result.lines).toBe(2)
    expect(result.reason).toMatch(/run one by one|paste from typing/i)
    expect(written).toEqual([])
  })

  it('allows multi-line text when the remote brackets pastes', () => {
    const { session, written } = fakeSession(true)
    withSession(session)

    const result = manager.insertSuggestion(session.id, 'line one\nline two')

    expect(result.inserted).toBe(true)
    expect(written.join('')).toBe('\x1b[200~line one\rline two\x1b[201~')
  })

  it('still inserts a single line on a remote without bracketed paste', () => {
    const { session, written } = fakeSession(false)
    withSession(session)

    expect(manager.insertSuggestion(session.id, 'show version').inserted).toBe(true)
    expect(written).toEqual(['show version'])
  })

  it('reports rather than throwing when there is nothing to insert', () => {
    const { session, written } = fakeSession(true)
    withSession(session)

    expect(manager.insertSuggestion(session.id, '\n\n').inserted).toBe(false)
    expect(written).toEqual([])
  })

  it('reports an unknown session', () => {
    expect(manager.insertSuggestion('nope', 'ls').inserted).toBe(false)
  })
})
