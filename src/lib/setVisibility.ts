/**
 * Which button sets the panel shows.
 *
 * A working install ends up with far more sets than fit on screen — sets are
 * shared and installed like plugins — so the panel needs a way to put the ones
 * you are not using today out of sight without deleting anything. Hiding is a
 * *view* preference, so it lives in localStorage next to the collapsed
 * connection folders rather than in the database: it belongs to this machine,
 * and an exported button set must not carry someone else's idea of what to
 * show.
 */

export const HIDDEN_SETS_KEY = 'smartcom.hiddenMacroSets'

/**
 * Reads stored ids, dropping any set that no longer exists.
 *
 * The pruning matters: a set that is deleted and later re-imported gets a fresh
 * id, but without this a stale id would sit in storage forever, and an id that
 * happened to come back would return hidden for no reason the user can see.
 */
export function parseHiddenSets(raw: string | null, existingIds: string[]): string[] {
  if (!raw) return []

  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(stored)) return []

  const existing = new Set(existingIds)
  return [...new Set(stored.filter((id): id is string => typeof id === 'string' && existing.has(id)))]
}

export function loadHiddenSets(existingIds: string[]): string[] {
  try {
    return parseHiddenSets(localStorage.getItem(HIDDEN_SETS_KEY), existingIds)
  } catch {
    // Storage can be unavailable; showing everything is the safe fallback.
    return []
  }
}

export function saveHiddenSets(hidden: string[]): void {
  try {
    localStorage.setItem(HIDDEN_SETS_KEY, JSON.stringify([...new Set(hidden)]))
  } catch {
    /* not being able to remember the preference is not worth an error */
  }
}

/** Flips one set between shown and hidden. */
export function toggleHiddenSet(hidden: string[], setId: string): string[] {
  return hidden.includes(setId) ? hidden.filter((id) => id !== setId) : [...hidden, setId]
}

/** True when this set should appear in the panel. */
export function isSetVisible(hidden: string[], setId: string | undefined): boolean {
  return !setId || !hidden.includes(setId)
}
