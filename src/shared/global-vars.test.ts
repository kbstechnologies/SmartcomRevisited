import { describe, expect, it } from 'vitest'
import {
  formatGlobalVars,
  formatGlobalValue,
  mergeGlobalVars,
  parseGlobalVars,
  referencedNames,
} from './global-vars'
import { interpolate } from './types'

describe('parseGlobalVars', () => {
  it('reads plain assignments, ignoring blank lines and comments', () => {
    const parsed = parseGlobalVars(
      ['# where the logs go', 'KBSTECHLOG=https://fake.com/log', '', 'SITE=hq'].join('\n')
    )

    expect(parsed.values).toEqual({ KBSTECHLOG: 'https://fake.com/log', SITE: 'hq' })
    expect(parsed.problems).toEqual([])
  })

  it('accepts an exported line and trims around the =', () => {
    expect(parseGlobalVars('export TOKEN = abc123').values).toEqual({ TOKEN: 'abc123' })
  })

  it('keeps everything after the first = , including = and #', () => {
    const parsed = parseGlobalVars('URL=https://host/path?a=1#frag')
    expect(parsed.values.URL).toBe('https://host/path?a=1#frag')
  })

  it('unwraps quotes so spaces and newlines survive', () => {
    const parsed = parseGlobalVars(['A="  padded  "', 'B="one\\ntwo"', "C='literal \\n'"].join('\n'))

    expect(parsed.values.A).toBe('  padded  ')
    expect(parsed.values.B).toBe('one\ntwo')
    expect(parsed.values.C).toBe('literal \\n')
  })

  it('reports a line that is not an assignment and keeps going', () => {
    const parsed = parseGlobalVars(['GOOD=1', 'this is not a variable', 'ALSOGOOD=2'].join('\n'))

    expect(parsed.values).toEqual({ GOOD: '1', ALSOGOOD: '2' })
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0].line).toBe(2)
  })

  it('refuses a name {{...}} could never reference', () => {
    const parsed = parseGlobalVars(['2FA=x', 'MY-VAR=y', 'OK_1=z'].join('\n'))

    expect(parsed.values).toEqual({ OK_1: 'z' })
    expect(parsed.problems.map((problem) => problem.line)).toEqual([1, 2])
  })

  it('lets the last of a duplicated name win, and says so', () => {
    const parsed = parseGlobalVars(['HOST=first', 'HOST=second'].join('\n'))

    expect(parsed.values.HOST).toBe('second')
    expect(parsed.vars).toEqual([{ name: 'HOST', value: 'second' }])
    expect(parsed.problems[0].message).toContain('more than once')
  })
})

describe('formatGlobalVars', () => {
  it('quotes only what would not read back the same', () => {
    expect(formatGlobalValue('https://fake.com/log')).toBe('https://fake.com/log')
    expect(formatGlobalValue('two words')).toBe('two words')
    expect(formatGlobalValue(' padded ')).toBe('" padded "')
    expect(formatGlobalValue('line\nbreak')).toBe('"line\\nbreak"')
    expect(formatGlobalValue('')).toBe('""')
  })

  it('round-trips every awkward value through the file format', () => {
    const vars = [
      { name: 'URL', value: 'https://fake.com/log#frag' },
      { name: 'BANNER', value: 'hello\nworld' },
      { name: 'PADDED', value: '  spaces  ' },
      { name: 'QUOTED', value: 'say "hi"' },
      { name: 'EMPTY', value: '' },
      { name: 'WINPATH', value: 'C:\\tools\\bin' },
    ]

    expect(parseGlobalVars(formatGlobalVars(vars)).vars).toEqual(vars)
  })

  it('writes a header comment above the assignments', () => {
    const text = formatGlobalVars([{ name: 'A', value: '1' }], '# mine')
    expect(text).toBe('# mine\n\nA=1\n')
    expect(parseGlobalVars(text).values).toEqual({ A: '1' })
  })

  it('produces a file an empty list can still be written to', () => {
    expect(formatGlobalVars([])).toBe('')
  })
})

describe('mergeGlobalVars', () => {
  const original = [
    '# Where the nightly logs go',
    'KBSTECHLOG=https://fake.com/log',
    '',
    '# Site code, used by the switch buttons',
    'SITE=hq',
  ].join('\n')

  it('changes a value without disturbing the comments around it', () => {
    const merged = mergeGlobalVars(original, [
      { name: 'KBSTECHLOG', value: 'https://real.com/log' },
      { name: 'SITE', value: 'hq' },
    ])

    expect(merged).toBe(
      [
        '# Where the nightly logs go',
        'KBSTECHLOG=https://real.com/log',
        '',
        '# Site code, used by the switch buttons',
        'SITE=hq',
        '',
      ].join('\n')
    )
  })

  it('appends a new variable at the end', () => {
    const merged = mergeGlobalVars(original, [
      { name: 'KBSTECHLOG', value: 'https://fake.com/log' },
      { name: 'SITE', value: 'hq' },
      { name: 'TOKEN', value: 'abc' },
    ])

    expect(merged.trimEnd().split('\n').pop()).toBe('TOKEN=abc')
    expect(parseGlobalVars(merged).values.SITE).toBe('hq')
  })

  it('removes the line of a deleted variable, comments included in place', () => {
    const merged = mergeGlobalVars(original, [{ name: 'SITE', value: 'hq' }])

    expect(parseGlobalVars(merged).values).toEqual({ SITE: 'hq' })
    expect(merged).toContain('# Where the nightly logs go')
    expect(merged).not.toContain('KBSTECHLOG=')
  })

  it('collapses a name that was assigned twice into one line', () => {
    const merged = mergeGlobalVars('A=1\nA=2\n', [{ name: 'A', value: '3' }])
    expect(merged).toBe('A=3\n')
  })

  it('does not grow trailing blank lines when saved repeatedly', () => {
    const once = mergeGlobalVars('A=1\n\n\n', [{ name: 'A', value: '1' }])
    const twice = mergeGlobalVars(once, [{ name: 'A', value: '1' }])
    expect(twice).toBe(once)
    expect(once).toBe('A=1\n')
  })

  it('starts a file from nothing', () => {
    expect(mergeGlobalVars('', [{ name: 'A', value: '1' }])).toBe('A=1\n')
    expect(mergeGlobalVars('', [])).toBe('')
  })
})

describe('globals feed interpolate', () => {
  it('substitutes exactly like a form input does', () => {
    const { values } = parseGlobalVars('KBSTECHLOG=https://fake.com/log')
    expect(interpolate('wget {{KBSTECHLOG}}', values)).toBe('wget https://fake.com/log')
  })
})

describe('referencedNames', () => {
  it('lists each placeholder once, whitespace and all', () => {
    expect(referencedNames('{{A}} then {{ B }} then {{A}}').sort()).toEqual(['A', 'B'])
    expect(referencedNames('no placeholders here')).toEqual([])
  })
})
