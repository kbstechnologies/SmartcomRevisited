/**
 * The search index and its scoring.
 *
 * Deliberately a scored scan over a flat array rather than an inverted index or
 * a dependency. The whole corpus is roughly 7,500 entries; a scan costs a few
 * milliseconds, which is well inside "feels instantaneous", and it keeps the
 * on-disk format something a human can open and read when something looks
 * wrong. Anything heavier would be solving a problem this corpus does not have.
 *
 * Lives in `shared/` because the ranking is the part most likely to need
 * tuning, and tuning without tests is guessing.
 */

import type { TldrPlatform, TldrSearchResult } from './tldr'
import { platformSearchOrder } from './tldr'

/** Bumped when the entry shape changes, which forces a rebuild on next start. */
export const TLDR_INDEX_VERSION = 2

/**
 * One indexed page. Short keys because there are thousands of these and the
 * file is read on every cold start.
 */
export interface TldrIndexEntry {
  /** Command name. */
  c: string
  /** Platform directory. */
  p: TldrPlatform
  /** First description line. */
  d: string
  /**
   * Lower-cased haystack: example descriptions and command templates joined.
   * Pre-folded at index time so a keystroke-rate search does no case work.
   */
  k: string
  /**
   * How many examples the page has.
   *
   * The corpus carries no popularity signal, and without one a prefix query
   * ranks by name length — so `tcp` answered `tcpick` before `tcpdump`, which
   * is not what anyone typing `tcp` means. How thoroughly a command is
   * documented is the closest honest proxy the data actually contains.
   */
  n: number
}

export interface TldrIndexFile {
  indexVersion: number
  builtAt: string
  entries: TldrIndexEntry[]
}

/**
 * Whether `query` appears in `text` as an in-order subsequence.
 *
 * This is the "fuzzy" in fuzzy search: `dkr` finds `docker`, `sysctl` finds
 * `systemctl`. Only ever applied to command names — run against descriptions it
 * matches everything and ranks nothing.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true
  let cursor = 0
  for (const char of text) {
    if (char === query[cursor]) {
      cursor += 1
      if (cursor === query.length) return true
    }
  }
  return false
}

/** How well one entry answers one whole-query term. Zero means no match. */
function scoreTerm(entry: TldrIndexEntry, term: string): { score: number; matched: TldrSearchResult['matched'] } | null {
  const command = entry.c.toLowerCase()

  if (command === term) return { score: 1000, matched: 'command' }
  if (command.startsWith(term)) {
    // Shorter commands are better answers to a prefix: `ip` beats `ipcalc`.
    return { score: 800 - Math.min(99, command.length - term.length), matched: 'command' }
  }
  if (command.includes(term)) return { score: 600, matched: 'command' }

  const description = entry.d.toLowerCase()
  if (description.includes(term)) return { score: 320, matched: 'description' }

  if (entry.k.includes(term)) return { score: 180, matched: 'example' }

  // Fuzzy is the last resort and scores accordingly: it is there so a typo or
  // an abbreviation still finds the page, not so it can outrank a real match.
  if (term.length >= 3 && fuzzyMatch(term, command)) return { score: 90, matched: 'fuzzy' }

  return null
}

export interface SearchOptions {
  /** Platform to prefer. Results for it sort above equally-scored others. */
  platform?: string
  limit?: number
}

/**
 * Ranked search across the index.
 *
 * Every whitespace-separated term must match something, which is what makes
 * "capture packets" behave: pages matching only "packets" are not the answer.
 */
export function searchIndex(
  entries: TldrIndexEntry[],
  query: string,
  options: SearchOptions = {}
): TldrSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const preference = options.platform ? platformSearchOrder(options.platform) : []

  /**
   * Platform affects rank by *demotion*, not promotion.
   *
   * A `common` page applies to a Linux session exactly as much as a `linux`
   * one, so rewarding `linux` for being more specific is wrong — it buried
   * `tcpdump` (common) under `tcpick` (linux) for the query `tcp`. What is
   * genuinely worth acting on is the opposite: a Windows or Cisco page is not
   * an answer for a Linux session at all, so it is pushed right down.
   *
   * The fraction is only a tie-break, deliberately smaller than any real
   * score difference, so the exact platform wins between two otherwise
   * identical rows and never over a better match.
   */
  const platformScore = (platform: TldrPlatform): number => {
    if (preference.length === 0) return 0
    const rank = preference.indexOf(platform)
    if (rank === -1) return -250
    return (preference.length - rank) * 0.5
  }

  /** Documentation depth, capped so it can never beat a better text match. */
  const depthScore = (entry: TldrIndexEntry): number => Math.min(30, (entry.n ?? 0) * 3)

  /**
   * One pass over the corpus.
   *
   * The score is divided by the *total* term count either way, so a page
   * matching one term of three keeps a third of its score. That is what lets
   * the relaxed pass rank sensibly instead of degenerating into an OR of
   * everything.
   */
  const collect = (requireAll: boolean): TldrSearchResult[] => {
    const found: TldrSearchResult[] = []

    for (const entry of entries) {
      let total = 0
      let hits = 0
      let best: TldrSearchResult['matched'] = 'fuzzy'
      let bestScore = -1

      for (const term of terms) {
        const hit = scoreTerm(entry, term)
        if (!hit) {
          if (!requireAll) continue
          hits = -1
          break
        }
        hits += 1
        total += hit.score
        if (hit.score > bestScore) {
          bestScore = hit.score
          best = hit.matched
        }
      }

      if (hits <= 0) continue

      found.push({
        command: entry.c,
        platform: entry.p,
        description: entry.d,
        score: total / terms.length + platformScore(entry.p) + depthScore(entry),
        matched: best,
      })
    }

    return found
  }

  /**
   * Every term must match — unless that leaves almost nothing.
   *
   * Requiring all of them is what keeps "capture packets" from returning every
   * page that mentions packets. But "find large files" is the opposite case:
   * `find` is plainly the answer and its page never says "large", so the strict
   * pass drops it and leaves two incidental matches. Falling back only when the
   * strict pass is nearly empty keeps precision where precision exists, and
   * still answers the question where it does not.
   */
  const strict = collect(true)
  const results = strict.length >= 5 ? strict : collect(false)

  results.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))

  // The same command exists on several platforms; the list should show it once,
  // on the platform that ranked highest, or it fills with near-duplicates.
  const seen = new Set<string>()
  const deduped: TldrSearchResult[] = []
  for (const result of results) {
    if (seen.has(result.command)) continue
    seen.add(result.command)
    deduped.push(result)
    if (deduped.length >= (options.limit ?? 50)) break
  }

  return deduped
}

/**
 * The best platform variant of one command, given a session's platform.
 *
 * Returns null when the command has no page at all, which is the answer that
 * drives the indicator's "not found" state.
 */
export function resolvePlatform(
  entries: TldrIndexEntry[],
  command: string,
  platform: string
): TldrPlatform | null {
  const wanted = command.toLowerCase()
  const available = entries.filter((entry) => entry.c.toLowerCase() === wanted).map((entry) => entry.p)
  if (available.length === 0) return null

  for (const candidate of platformSearchOrder(platform)) {
    if (available.includes(candidate)) return candidate
  }
  // Documented, but not for anything resembling this session. Still better than
  // nothing — the panel labels which platform it ended up showing.
  return available.includes('common') ? 'common' : available[0]
}

/** Every platform that documents a command, for the panel's platform switcher. */
export function platformsFor(entries: TldrIndexEntry[], command: string): TldrPlatform[] {
  const wanted = command.toLowerCase()
  return entries.filter((entry) => entry.c.toLowerCase() === wanted).map((entry) => entry.p)
}
