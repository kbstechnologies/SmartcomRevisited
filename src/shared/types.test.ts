import { describe, expect, it } from 'vitest'
import { MacroSchema, MacroSetSchema, ProfileSchema, resolveFields, interpolate } from './types'

describe('null tolerance on optional text', () => {
  // SQLite returns NULL for empty nullable columns. Loading a row and saving it
  // straight back used to fail IPC validation with
  // "expected string, received null" — reported when editing a button.
  it('accepts null for a macro colour and icon', () => {
    const parsed = MacroSchema.parse({
      id: 'm1',
      setId: 's1',
      name: 'Edited button',
      description: null,
      color: null,
      icon: null,
      steps: [],
      fields: [{ name: 'HOST', type: 'text', defaultValue: '', options: [], required: true }],
    })

    expect(parsed.color).toBeUndefined()
    expect(parsed.icon).toBeUndefined()
    expect(parsed.description).toBeUndefined()
    expect(parsed.fields).toHaveLength(1)
  })

  it('accepts null for profile key columns', () => {
    const parsed = ProfileSchema.parse({
      id: 'p1',
      name: 'host',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      authMethod: 'password',
      keyPath: null,
      keyId: null,
      startupMacroId: null,
    })

    expect(parsed.keyPath).toBeUndefined()
    expect(parsed.keyId).toBeUndefined()
    expect(parsed.startupMacroId).toBeUndefined()
  })

  it('accepts null for macro set description and colour', () => {
    const parsed = MacroSetSchema.parse({ id: 's1', name: 'Set', description: null, color: null })
    expect(parsed.description).toBeUndefined()
    expect(parsed.color).toBeUndefined()
  })

  it('still rejects a genuinely wrong type', () => {
    expect(() => MacroSchema.parse({ setId: 's1', name: 'x', steps: [], color: 42 })).toThrow()
  })
})

describe('resolveFields', () => {
  it('prefers explicit fields', () => {
    const fields = resolveFields({
      fields: [{ name: 'A', type: 'text', defaultValue: '', options: [], required: false }],
      placeholders: ['B'],
    })
    expect(fields.map((f) => f.name)).toEqual(['A'])
  })

  it('migrates legacy placeholders into required text inputs', () => {
    const fields = resolveFields({ fields: [], placeholders: ['HOST', 'PORT'] })
    expect(fields.map((f) => f.name)).toEqual(['HOST', 'PORT'])
    expect(fields.every((f) => f.required && f.type === 'text')).toBe(true)
  })
})

describe('interpolate', () => {
  it('substitutes known variables and tolerates whitespace', () => {
    expect(interpolate('ping {{HOST}} -c {{ COUNT }}', { HOST: 'a', COUNT: '2' })).toBe(
      'ping a -c 2'
    )
  })

  it('leaves unknown placeholders intact rather than blanking them', () => {
    expect(interpolate('echo {{NOPE}}', {})).toBe('echo {{NOPE}}')
  })
})
