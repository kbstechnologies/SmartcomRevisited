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

import { FAVOURITES_SET_ID, normaliseTags } from '@shared/types'

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

/**
 * The second filter: button sets assigned to the connection in front.
 *
 * A Cisco switch has no use for the Proxmox set, and with a couple of thousand
 * buttons installed the panel is unusable without narrowing it. That assignment
 * is knowledge about the *device*, not about this screen, so unlike the hidden
 * list it lives on the profile in the database — see `Profile.macroSetIds`.
 *
 * Both filters are subtractive and they compose: a set shows when the
 * connection allows it *and* it has not been ticked off by hand. Assignment is
 * skipped entirely when the profile names no sets, so connections nobody has
 * curated keep behaving exactly as they did before.
 */
export interface SetFilterInput {
  /** Every set that exists, in panel order. */
  setIds: string[]
  /** `Profile.macroSetIds` for the session in front; empty means no opinion. */
  assigned: string[] | undefined
  /** Ids ticked off in the right-click menu. */
  hidden: string[]
  /** `Profile.tags` for the session in front. */
  profileTags?: string[]
  /** Each set's tags, keyed by set id. */
  setTags?: Record<string, string[] | undefined>
  /**
   * Set when the operator has asked to see everything for this session,
   * overriding the connection's assignment but not the manual ticks.
   */
  ignoreAssignment?: boolean
}

export interface SetFilterResult {
  /** Ids the panel should render. */
  visible: string[]
  /** True when the connection's assignment is actually narrowing the list. */
  assignmentActive: boolean
  /** How many sets the assignment alone is keeping out of sight. */
  hiddenByAssignment: number
  /** Ids matched by a shared tag rather than named outright. */
  matchedByTag: string[]
}

/** Tags shared between a connection and a set, normalised on both sides. */
export function sharedTags(profileTags: string[], setTags: string[] | undefined): string[] {
  if (!profileTags.length || !setTags?.length) return []
  const wanted = new Set(normaliseTags(profileTags))
  return normaliseTags(setTags).filter((tag) => wanted.has(tag))
}

export function resolveVisibleSets({
  setIds,
  assigned,
  hidden,
  profileTags = [],
  setTags = {},
  ignoreAssignment = false,
}: SetFilterInput): SetFilterResult {
  // Ids the profile names but this machine no longer has are ignored, so a
  // deleted set cannot leave a connection filtered down to nothing.
  const allowed = new Set((assigned ?? []).filter((id) => setIds.includes(id)))

  /**
   * Tag matches are additive with the named ids, not an alternative to them.
   * Naming a set says "this one specifically"; a tag says "anything for this
   * kind of box" — a connection can reasonably want both, and a set arriving
   * later with a matching tag should appear without anyone editing the
   * connection. That is the whole reason tags exist alongside the id list.
   */
  const matchedByTag: string[] = []
  if (profileTags.length) {
    for (const id of setIds) {
      if (allowed.has(id)) continue
      if (sharedTags(profileTags, setTags[id]).length > 0) {
        allowed.add(id)
        matchedByTag.push(id)
      }
    }
  }

  const assignmentActive = !ignoreAssignment && allowed.size > 0

  // Favourites ignore the connection filter: the point of starring a button is
  // that it follows you between hosts. The manual tick still applies — hiding
  // it is a direct instruction about this set, not a rule inherited from the
  // connection you happen to be on.
  const permitted = assignmentActive
    ? setIds.filter((id) => allowed.has(id) || id === FAVOURITES_SET_ID)
    : setIds

  return {
    visible: permitted.filter((id) => !hidden.includes(id)),
    assignmentActive,
    hiddenByAssignment: assignmentActive ? setIds.length - permitted.length : 0,
    matchedByTag: assignmentActive ? matchedByTag : [],
  }
}

/**
 * Favourites first, then everything else in its existing order.
 *
 * A set that is always on screen is only useful if it is somewhere predictable,
 * and the top of the panel is where the eye starts.
 */
export function orderSets<T extends { id?: string }>(sets: T[]): T[] {
  const favourites = sets.filter((set) => set.id === FAVOURITES_SET_ID)
  return favourites.length ? [...favourites, ...sets.filter((set) => set.id !== FAVOURITES_SET_ID)] : sets
}
