import { describe, expect, it } from 'vitest'
import { builtinVariables, BUILTIN_VARIABLE_HELP } from './builtin-vars'
import { interpolate } from './types'

const AT = new Date('2026-08-17T14:25:30.000Z')

describe('builtinVariables', () => {
  it('produces a stamp that is safe in a filename', () => {
    const vars = builtinVariables({ now: AT })

    // Colons are the whole reason TIME and DATE_ISO_SAFE exist: a capture file
    // named with DATE_ISO cannot be written on Windows and confuses scp.
    expect(vars.TIME).not.toContain(':')
    expect(vars.TIMESTAMP).not.toContain(':')
    expect(vars.DATE_ISO_SAFE).not.toContain(':')
    expect(vars.DATE_ISO).toContain(':')
  })

  it('formats the time fields from the given moment', () => {
    const vars = builtinVariables({ now: AT })

    expect(vars.EPOCH).toBe(String(Math.floor(AT.getTime() / 1000)))
    expect(vars.EPOCH_MS).toBe(String(AT.getTime()))
    expect(vars.DATE_ISO).toBe('2026-08-17T14:25:30.000Z')
    // DATE/TIME are local, so assert the shape rather than the value — the
    // test must not depend on the machine's timezone.
    expect(vars.DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(vars.TIME).toMatch(/^\d{2}-\d{2}-\d{2}$/)
    expect(vars.TIMESTAMP).toMatch(/^\d{8}-\d{6}$/)
  })

  it('gives RANDOM and RANDOM_NUMBER the same value', () => {
    // Two names for one idea; generating twice would hand back different
    // numbers to a button that used both meaning the same thing.
    const vars = builtinVariables()
    expect(vars.RANDOM_NUMBER).toBe(vars.RANDOM)
  })

  it('produces random values of the right alphabet and length', () => {
    const vars = builtinVariables({ randomLength: 10 })

    expect(vars.RANDOM).toMatch(/^\d{6}$/)
    expect(vars.RANDOM_LOWER).toMatch(/^[a-z]{10}$/)
    expect(vars.RANDOM_MIX).toMatch(/^[A-Za-z0-9]{10}$/)
    expect(vars.RANDOM_HEX).toMatch(/^[0-9a-f]{10}$/)
  })

  it('actually varies between calls', () => {
    const runs = new Set(Array.from({ length: 20 }, () => builtinVariables().RANDOM_MIX))
    // Twenty identical values would mean the generator is not being seeded.
    expect(runs.size).toBeGreaterThan(15)
  })

  it('holds a value steady within one set, which is the point', () => {
    // A capture written as cap-{{EPOCH}}.pcap and collected as cap-{{EPOCH}}.pcap
    // has to name the same file. That only works because the set is computed
    // once per run and reused for every step.
    const vars = builtinVariables()

    const written = interpolate('tcpdump -w /tmp/cap-{{RANDOM_MIX}}.pcap', vars)
    const collected = interpolate('download /tmp/cap-{{RANDOM_MIX}}.pcap', vars)

    expect(written.split('cap-')[1]).toBe(collected.split('cap-')[1])
  })

  it('only includes session fields when there is a session', () => {
    expect(builtinVariables()).not.toHaveProperty('SESSION_HOST')

    const withSession = builtinVariables({
      host: '10.0.0.1',
      username: 'admin',
      profileName: 'core-sw-01',
    })
    expect(withSession.SESSION_HOST).toBe('10.0.0.1')
    expect(withSession.SESSION_USER).toBe('admin')
    expect(withSession.SESSION_NAME).toBe('core-sw-01')
  })

  it('uses names the interpolator actually accepts', () => {
    // The regex only takes [A-Za-z_][A-Za-z0-9_]*. A built-in it cannot match
    // would sit in the help list looking usable and never substitute.
    const vars = builtinVariables({ host: 'h', username: 'u', profileName: 'p' })

    for (const name of Object.keys(vars)) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(interpolate(`{{${name}}}`, vars)).toBe(vars[name])
    }
  })

  it('does not disturb the Go templates in the shipped Docker buttons', () => {
    // Widening the interpolation regex to allow spaces — which `{{random
    // number}}` would have needed — would start matching these.
    const vars = builtinVariables()
    const docker = 'docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"'

    expect(interpolate(docker, vars)).toBe(docker)
  })

  it('documents every variable it produces', () => {
    const documented = new Set(BUILTIN_VARIABLE_HELP.map((entry) => entry.name))
    const produced = Object.keys(
      builtinVariables({ host: 'h', username: 'u', profileName: 'p' })
    )

    for (const name of produced) expect(documented.has(name)).toBe(true)
  })
})
