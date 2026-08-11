import type { ButtonSetBundle, Macro, MacroSet, MacroStep } from './types'

export interface RemapOptions {
  /** Generates a fresh id. Injected so tests can make it deterministic. */
  newId: () => string
  /** True when a set name is already used, so the copy gets renamed. */
  isSetNameTaken: (name: string) => boolean
}

export interface RemapResult {
  sets: MacroSet[]
  macros: Macro[]
  renamed: Array<{ from: string; to: string }>
  /** References to entities outside the bundle, which cannot be resolved. */
  droppedReferences: number
}

/** Appends " (imported)" / " (imported 2)" until the name is free. */
export function uniqueSetName(name: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(name)) return name

  let candidate = `${name} (imported)`
  let counter = 2
  while (isTaken(candidate)) {
    candidate = `${name} (imported ${counter++})`
  }
  return candidate
}

/**
 * Rewrites a bundle so it can be installed alongside what already exists.
 *
 * Every set and button gets a fresh id, and `callMacro` / `callSet` steps are
 * repointed at the new copies — including inside `if` branches, which nest
 * arbitrarily deep. A reference to something outside the bundle cannot be
 * resolved, so it is cleared rather than left dangling at an unrelated id.
 */
export function remapBundle(bundle: ButtonSetBundle, options: RemapOptions): RemapResult {
  const setIdMap = new Map<string, string>()
  const macroIdMap = new Map<string, string>()
  const renamed: Array<{ from: string; to: string }> = []
  let droppedReferences = 0

  for (const set of bundle.sets) {
    if (set.id) setIdMap.set(set.id, options.newId())
  }
  for (const macro of bundle.macros) {
    if (macro.id) macroIdMap.set(macro.id, options.newId())
  }

  const remapSteps = (steps: MacroStep[]): MacroStep[] =>
    steps.map((step) => {
      const next: MacroStep = { ...step }

      if (next.targetMacroId) {
        const mapped = macroIdMap.get(next.targetMacroId)
        if (mapped) {
          next.targetMacroId = mapped
        } else {
          next.targetMacroId = undefined
          droppedReferences++
        }
      }

      if (next.targetSetId) {
        const mapped = setIdMap.get(next.targetSetId)
        if (mapped) {
          next.targetSetId = mapped
        } else {
          next.targetSetId = undefined
          droppedReferences++
        }
      }

      if (next.thenSteps?.length) next.thenSteps = remapSteps(next.thenSteps)
      if (next.elseSteps?.length) next.elseSteps = remapSteps(next.elseSteps)

      return next
    })

  // Names are claimed in order, so two identically named sets in one bundle
  // still end up distinct.
  const claimed = new Set<string>()
  const isTaken = (candidate: string) => claimed.has(candidate) || options.isSetNameTaken(candidate)

  const sets = bundle.sets.map((set) => {
    const name = uniqueSetName(set.name, isTaken)
    claimed.add(name)
    if (name !== set.name) renamed.push({ from: set.name, to: name })

    return { ...set, id: set.id ? setIdMap.get(set.id)! : options.newId(), name }
  })

  const macros = bundle.macros
    // A button whose set is not in the bundle has nowhere to live.
    .filter((macro) => setIdMap.has(macro.setId))
    .map((macro) => ({
      ...macro,
      id: macro.id ? macroIdMap.get(macro.id)! : options.newId(),
      setId: setIdMap.get(macro.setId)!,
      steps: remapSteps(macro.steps ?? []),
    }))

  return { sets, macros, renamed, droppedReferences }
}
