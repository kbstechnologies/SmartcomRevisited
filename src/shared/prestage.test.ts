import { describe, it, expect } from 'vitest'
import { analysePrestage, resolvePrestage, type PrestageInputs } from './prestage'

const inputs = (over: Partial<PrestageInputs> = {}): PrestageInputs => ({
  globals: {},
  builtins: {},
  answers: {},
  ...over,
})

describe('analysePrestage', () => {
  it('finds nothing in text with no variables', () => {
    const result = analysePrestage('show running-config', inputs())
    expect(result.vars).toEqual([])
    expect(result.unanswered).toEqual([])
  })

  it('classifies a global, a built-in and an unknown name', () => {
    const result = analysePrestage('{{SITE}} {{DATE}} {{var1}}', {
      globals: { SITE: 'leeds' },
      builtins: { DATE: '2026-09-07' },
      answers: {},
    })

    expect(result.vars).toEqual([
      { name: 'SITE', source: 'global', value: 'leeds', unanswered: false },
      { name: 'DATE', source: 'builtin', value: '2026-09-07', unanswered: false },
      { name: 'var1', source: 'ask', value: '', unanswered: true },
    ])
    expect(result.unanswered).toEqual(['var1'])
  })

  it('lets the globals file redefine a built-in name', () => {
    // Matches the macro engine's precedence: built-ins lowest, then globals.
    const result = analysePrestage('{{DATE}}', {
      globals: { DATE: 'whenever' },
      builtins: { DATE: '2026-09-07' },
      answers: {},
    })

    expect(result.vars[0]).toEqual({
      name: 'DATE',
      source: 'global',
      value: 'whenever',
      unanswered: false,
    })
  })

  it('treats an answered ask as resolved', () => {
    const result = analysePrestage('{{var1}}', inputs({ answers: { var1: 'Gi1/0/24' } }))
    expect(result.vars[0].unanswered).toBe(false)
    expect(result.unanswered).toEqual([])
    expect(result.values).toEqual({ var1: 'Gi1/0/24' })
  })

  it('does not ask for a global that is deliberately empty', () => {
    // An empty global is a value. Prompting for it would make it unusable.
    const result = analysePrestage('{{SUFFIX}}', inputs({ globals: { SUFFIX: '' } }))
    expect(result.unanswered).toEqual([])
    expect(result.vars[0].source).toBe('global')
  })

  it('reports each name once, in the order it first appears', () => {
    const result = analysePrestage('{{b}} {{a}} {{b}}', inputs())
    expect(result.vars.map((entry) => entry.name)).toEqual(['b', 'a'])
  })

  it('accepts the whitespace the interpolation regex accepts', () => {
    const result = analysePrestage('{{ SITE }}', inputs({ globals: { SITE: 'leeds' } }))
    expect(result.vars[0].name).toBe('SITE')
  })

  it('ignores Go template syntax, as the button sets rely on', () => {
    // The shipped Docker buttons contain {{range .Networks}} and must survive
    // being staged here untouched.
    const result = analysePrestage('{{range .NetworkSettings.Networks}}', inputs())
    expect(result.vars).toEqual([])
  })
})

describe('resolvePrestage', () => {
  it('substitutes every known name', () => {
    const result = resolvePrestage('ping {{TARGET}} source {{SRC}}', {
      globals: { TARGET: '10.0.0.1' },
      builtins: {},
      answers: { SRC: 'Lo0' },
    })

    expect(result.text).toBe('ping 10.0.0.1 source Lo0')
    expect(result.unanswered).toEqual([])
  })

  it('substitutes an unanswered name as nothing and still reports it', () => {
    const result = resolvePrestage('ping {{TARGET}}', inputs())
    expect(result.text).toBe('ping ')
    expect(result.unanswered).toEqual(['TARGET'])
  })

  it('leaves text with no variables exactly as it was', () => {
    const source = 'interface Gi1/0/24\n description {{ not a name }}\n'
    expect(resolvePrestage(source, inputs()).text).toBe(source)
  })
})
