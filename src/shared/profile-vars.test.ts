import { describe, it, expect } from 'vitest'
import {
  inspectProfileField,
  resolveProfileField,
  resolveProfileVars,
} from './profile-vars'

const globals = { SITE_CORE: '10.20.0.1', BASTION_USER: 'netops', SITE: 'leeds' }

describe('inspectProfileField', () => {
  it('reports nothing for a plain value', () => {
    expect(inspectProfileField('10.0.0.1', globals)).toEqual({ names: [], missing: [] })
  })

  it('separates names it can supply from names it cannot', () => {
    expect(inspectProfileField('{{SITE_CORE}}-{{TYPO}}', globals)).toEqual({
      names: ['SITE_CORE', 'TYPO'],
      missing: ['TYPO'],
    })
  })

  it('treats a global set to the empty string as defined', () => {
    expect(inspectProfileField('{{EMPTY}}', { EMPTY: '' }).missing).toEqual([])
  })

  it('survives an undefined field', () => {
    expect(inspectProfileField(undefined as unknown as string, globals).names).toEqual([])
  })
})

describe('resolveProfileField', () => {
  it('substitutes a known name', () => {
    expect(resolveProfileField('host', '{{SITE_CORE}}', globals)).toBe('10.20.0.1')
  })

  it('substitutes inside surrounding text', () => {
    expect(resolveProfileField('name', '{{SITE}} core switch', globals)).toBe('leeds core switch')
  })

  it('leaves a plain value alone', () => {
    expect(resolveProfileField('username', 'admin', globals)).toBe('admin')
  })

  it('refuses an unresolved name rather than sending the braces', () => {
    // The whole point: a literal {{TYPO}} reaching a remote is a DNS failure
    // naming a host nobody typed, or an auth failure against a lockable account.
    expect(() => resolveProfileField('host', '{{TYPO}}', globals)).toThrow(
      /Host refers to \{\{TYPO\}\}, which is not set in your global variables file/
    )
  })

  it('names the box the operator has to go and fix', () => {
    expect(() => resolveProfileField('password', '{{VAULT_PW}}', globals)).toThrow(/^Password refers/)
  })

  it('lists every missing name at once, so one connect fixes them all', () => {
    expect(() => resolveProfileField('username', '{{A}}.{{B}}', globals)).toThrow(
      /\{\{A\}\}, \{\{B\}\}, which are not set/
    )
  })
})

describe('resolveProfileVars', () => {
  it('substitutes name, host and username and keeps everything else', () => {
    const resolved = resolveProfileVars(
      {
        id: 'p1',
        name: '{{SITE}} core',
        host: '{{SITE_CORE}}',
        username: '{{BASTION_USER}}',
        port: 22,
      },
      globals
    )

    expect(resolved).toEqual({
      id: 'p1',
      name: 'leeds core',
      host: '10.20.0.1',
      username: 'netops',
      port: 22,
    })
  })

  it('returns a copy rather than editing the stored connection', () => {
    const profile = { name: '{{SITE}}', host: '{{SITE_CORE}}', username: 'admin' }
    const resolved = resolveProfileVars(profile, globals)

    expect(profile.name).toBe('{{SITE}}')
    expect(resolved).not.toBe(profile)
  })

  it('is a no-op for a connection that uses no variables', () => {
    const profile = { name: 'core-01', host: '10.0.0.1', username: 'admin' }
    expect(resolveProfileVars(profile, globals)).toEqual(profile)
  })
})
