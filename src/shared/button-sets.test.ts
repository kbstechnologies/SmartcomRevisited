import { describe, expect, it } from 'vitest'
import { remapBundle, uniqueSetName } from './button-sets'
import { ButtonSetBundleSchema, BUTTON_SET_FORMAT, MacroSchema, MacroSetSchema } from './types'
import type { ButtonSetBundle } from './types'

/** Deterministic ids so assertions can name them. */
function idFactory() {
  let n = 0
  return () => `new-${++n}`
}

const bundle = (
  sets: Array<Partial<ReturnType<typeof MacroSetSchema.parse>>>,
  macros: Array<Record<string, unknown>>
): ButtonSetBundle =>
  ButtonSetBundleSchema.parse({
    format: BUTTON_SET_FORMAT,
    version: 1,
    sets: sets.map((s) => MacroSetSchema.parse({ name: 'Set', ...s })),
    macros: macros.map((m) => MacroSchema.parse({ setId: 'set-a', name: 'Button', steps: [], ...m })),
  })

describe('uniqueSetName', () => {
  it('keeps a free name unchanged', () => {
    expect(uniqueSetName('Ops', () => false)).toBe('Ops')
  })

  it('suffixes until free', () => {
    const taken = new Set(['Ops', 'Ops (imported)', 'Ops (imported 2)'])
    expect(uniqueSetName('Ops', (n) => taken.has(n))).toBe('Ops (imported 3)')
  })
})

describe('remapBundle', () => {
  it('gives every set and button a fresh id', () => {
    const result = remapBundle(
      bundle([{ id: 'set-a', name: 'Ops' }], [{ id: 'macro-1', setId: 'set-a', name: 'Uptime' }]),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    expect(result.sets[0].id).not.toBe('set-a')
    expect(result.macros[0].id).not.toBe('macro-1')
    expect(result.macros[0].setId).toBe(result.sets[0].id)
    expect(result.renamed).toEqual([])
  })

  it('renames a set whose name is already installed', () => {
    const result = remapBundle(bundle([{ id: 'set-a', name: 'Ops' }], []), {
      newId: idFactory(),
      isSetNameTaken: (name) => name === 'Ops',
    })

    expect(result.sets[0].name).toBe('Ops (imported)')
    expect(result.renamed).toEqual([{ from: 'Ops', to: 'Ops (imported)' }])
  })

  it('keeps two identically named sets in one bundle distinct', () => {
    const result = remapBundle(
      bundle([{ id: 'set-a', name: 'Ops' }, { id: 'set-b', name: 'Ops' }], []),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    expect(result.sets.map((s) => s.name)).toEqual(['Ops', 'Ops (imported)'])
  })

  it('repoints callMacro and callSet at the imported copies', () => {
    const result = remapBundle(
      bundle(
        [{ id: 'set-a', name: 'Targets' }],
        [
          { id: 'macro-leaf', setId: 'set-a', name: 'Leaf' },
          {
            id: 'macro-caller',
            setId: 'set-a',
            name: 'Caller',
            steps: [
              { type: 'callMacro', targetMacroId: 'macro-leaf' },
              { type: 'callSet', targetSetId: 'set-a' },
            ],
          },
        ]
      ),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    const leaf = result.macros.find((m) => m.name === 'Leaf')!
    const caller = result.macros.find((m) => m.name === 'Caller')!

    expect(caller.steps[0].targetMacroId).toBe(leaf.id)
    expect(caller.steps[1].targetSetId).toBe(result.sets[0].id)
    expect(result.droppedReferences).toBe(0)
  })

  it('repoints references nested inside if branches', () => {
    const result = remapBundle(
      bundle(
        [{ id: 'set-a', name: 'Targets' }],
        [
          { id: 'macro-leaf', setId: 'set-a', name: 'Leaf' },
          {
            id: 'macro-branch',
            setId: 'set-a',
            name: 'Branching',
            steps: [
              {
                type: 'if',
                pattern: 'ready',
                thenSteps: [
                  {
                    type: 'if',
                    pattern: 'deeper',
                    thenSteps: [{ type: 'callMacro', targetMacroId: 'macro-leaf' }],
                    elseSteps: [],
                  },
                ],
                elseSteps: [{ type: 'callSet', targetSetId: 'set-a' }],
              },
            ],
          },
        ]
      ),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    const leaf = result.macros.find((m) => m.name === 'Leaf')!
    const branch = result.macros.find((m) => m.name === 'Branching')!.steps[0]

    // Two levels deep, to prove the recursion is not one level only.
    expect(branch.thenSteps[0].thenSteps[0].targetMacroId).toBe(leaf.id)
    expect(branch.elseSteps[0].targetSetId).toBe(result.sets[0].id)
  })

  it('clears references pointing outside the bundle and counts them', () => {
    const result = remapBundle(
      bundle(
        [{ id: 'set-a', name: 'Exported' }],
        [
          {
            id: 'macro-caller',
            setId: 'set-a',
            name: 'Caller',
            steps: [
              { type: 'callMacro', targetMacroId: 'macro-elsewhere' },
              { type: 'callSet', targetSetId: 'set-elsewhere' },
            ],
          },
        ]
      ),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    const caller = result.macros[0]
    expect(caller.steps[0].targetMacroId).toBeUndefined()
    expect(caller.steps[1].targetSetId).toBeUndefined()
    expect(result.droppedReferences).toBe(2)
  })

  it('drops buttons whose set is not part of the bundle', () => {
    const result = remapBundle(
      bundle([{ id: 'set-a', name: 'Ops' }], [{ id: 'orphan', setId: 'set-missing', name: 'Orphan' }]),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    expect(result.macros).toHaveLength(0)
  })

  it('preserves fields, colour, icon and step text', () => {
    const result = remapBundle(
      bundle(
        [{ id: 'set-a', name: 'Rich' }],
        [
          {
            id: 'macro-1',
            setId: 'set-a',
            name: 'Ping',
            color: 'blue',
            icon: 'bolt',
            confirmBeforeRun: true,
            steps: [{ type: 'send', text: 'ping {{HOST}}', appendEnter: true }],
            fields: [
              { name: 'HOST', label: 'Target', type: 'text', required: true, defaultValue: '', options: [] },
            ],
          },
        ]
      ),
      { newId: idFactory(), isSetNameTaken: () => false }
    )

    const macro = result.macros[0]
    expect(macro.color).toBe('blue')
    expect(macro.icon).toBe('bolt')
    expect(macro.confirmBeforeRun).toBe(true)
    expect(macro.steps[0].text).toBe('ping {{HOST}}')
    expect(macro.fields[0].name).toBe('HOST')
  })

  it('does not mutate the bundle it was given', () => {
    const input = bundle(
      [{ id: 'set-a', name: 'Ops' }],
      [{ id: 'm1', setId: 'set-a', name: 'C', steps: [{ type: 'callSet', targetSetId: 'set-a' }] }]
    )
    const snapshot = JSON.stringify(input)

    remapBundle(input, { newId: idFactory(), isSetNameTaken: () => false })

    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('ButtonSetBundleSchema', () => {
  it('rejects a foreign or malformed file', () => {
    expect(() => ButtonSetBundleSchema.parse({ format: 'something/else', version: 1 })).toThrow()
    expect(() => ButtonSetBundleSchema.parse({})).toThrow()
    expect(() =>
      ButtonSetBundleSchema.parse({ format: BUTTON_SET_FORMAT, version: 2, sets: [], macros: [] })
    ).toThrow()
  })

  it('accepts a minimal valid bundle', () => {
    expect(() =>
      ButtonSetBundleSchema.parse({ format: BUTTON_SET_FORMAT, version: 1, sets: [], macros: [] })
    ).not.toThrow()
  })
})
