import { describe, expect, it } from 'vitest'
import { decideTldrRun } from './tldr-run'

/**
 * Session safety. These are the cases where being wrong sends a command to the
 * wrong machine, so they are stated as behaviour rather than left to the UI.
 */

const connected = { name: 'router-okc-01', status: 'connected' as const }

describe('decideTldrRun', () => {
  it('allows an ordinary command on a connected session', () => {
    expect(
      decideTldrRun({ target: connected, command: 'tcpdump -i eth0', confirmedDestructive: false })
    ).toEqual({ allow: true, destructive: false, reasons: [] })
  })

  it('refuses when the session has gone, rather than picking another', () => {
    const decision = decideTldrRun({
      target: null,
      command: 'ls -la',
      confirmedDestructive: false,
    })
    expect(decision.allow).toBe(false)
    expect(decision).toMatchObject({ kind: 'no-session' })
  })

  it.each(['connecting', 'disconnected', 'error'] as const)(
    'refuses while the session is %s',
    (status) => {
      const decision = decideTldrRun({
        target: { name: 'server-prod-02', status },
        command: 'ls -la',
        confirmedDestructive: false,
      })
      expect(decision).toMatchObject({ kind: 'not-connected' })
      expect(decision.allow).toBe(false)
      if (!decision.allow && decision.kind === 'not-connected') {
        // Names the box, so the panel does not have to guess which one.
        expect(decision.message).toContain('server-prod-02')
      }
    }
  )

  it('asks before a destructive command, and says why', () => {
    const decision = decideTldrRun({
      target: connected,
      command: 'rm -rf /some/path',
      confirmedDestructive: false,
    })
    expect(decision.allow).toBe(false)
    expect(decision).toMatchObject({ kind: 'needs-confirmation' })
    if (!decision.allow && decision.kind === 'needs-confirmation') {
      expect(decision.reasons.length).toBeGreaterThan(0)
    }
  })

  it('allows a destructive command once it has been confirmed', () => {
    expect(
      decideTldrRun({
        target: connected,
        command: 'rm -rf /some/path',
        confirmedDestructive: true,
      })
    ).toMatchObject({ allow: true, destructive: true })
  })

  it('checks the session before it checks the risk', () => {
    // A confirmation for a session that no longer exists must not become a
    // licence to run the command somewhere else.
    expect(
      decideTldrRun({ target: null, command: 'rm -rf /', confirmedDestructive: true })
    ).toMatchObject({ allow: false, kind: 'no-session' })
  })

  it('re-classifies rather than trusting the caller', () => {
    // `confirmedDestructive` only ever unlocks; it can never mark something
    // safe that the classifier considers destructive.
    const decision = decideTldrRun({
      target: connected,
      command: 'mkfs.ext4 /dev/sdb1',
      confirmedDestructive: true,
    })
    expect(decision).toMatchObject({ allow: true, destructive: true })
  })
})
