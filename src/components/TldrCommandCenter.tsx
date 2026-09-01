import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { MagnifyingGlassIcon, StarIcon } from '@heroicons/react/24/solid'
import { useStore } from '../store/useStore'
import { useSessionPlatform } from '../lib/useTldr'
import { PLATFORM_LABEL, type TldrSearchResult } from '@shared/tldr'

/**
 * The tldr Command Center: search the whole page set, open the result.
 *
 * Deliberately built like `CommandPalette` rather than beside it. The palette
 * is about *this installation* — your connections, your buttons — and mixing
 * seven thousand documentation pages into it would drown that. Same shape, same
 * keys, separate list, separate shortcut.
 *
 * It searches command names, descriptions and the example text, which is what
 * makes "capture packets" and "find large files" work as queries — the useful
 * case, because someone who already knows the command name usually does not
 * need to look it up.
 */

/** Search is index-only in the main process, so this can stay short. */
const SEARCH_DEBOUNCE_MS = 120

interface TldrCommandCenterProps {
  onClose: () => void
}

export default function TldrCommandCenter({ onClose }: TldrCommandCenterProps) {
  const activeSessionId = useStore((store) => store.activeSessionId)
  const status = useStore((store) => store.tldrStatus)
  const favourites = useStore((store) => store.settings.tldrFavourites ?? [])
  const search = useStore((store) => store.tldrSearch)
  const openTldr = useStore((store) => store.openTldr)

  const platform = useSessionPlatform(activeSessionId)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TldrSearchResult[]>([])
  const [selected, setSelected] = useState(0)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /** Newest query wins, so a slower earlier answer cannot overwrite it. */
  const generation = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    generation.current += 1
    const mine = generation.current

    if (!trimmed) {
      setResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    const timer = window.setTimeout(() => {
      void search(trimmed, platform, 60).then((found) => {
        if (generation.current !== mine) return
        setResults(found)
        setSelected(0)
        setSearching(false)
      })
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [query, platform, search])

  /** With no query the favourites are the list — an empty box is not useful. */
  const shown = useMemo<TldrSearchResult[]>(() => {
    if (query.trim()) return results
    return favourites.map((command) => ({
      command,
      platform: 'common' as const,
      description: 'Favourite',
      score: 0,
      matched: 'command' as const,
    }))
  }, [query, results, favourites])

  const open = (result: TldrSearchResult) => {
    // Opened against the *session's* platform, not the result's: the result
    // list ranks across platforms, but the page shown should be the variant
    // that applies to the box in front of the operator.
    openTldr({ command: result.command, platform })
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => Math.min(shown.length - 1, index + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === 'Enter' && shown[selected]) {
      event.preventDefault()
      open(shown[selected])
    }
  }

  return (
    <div className="command-palette-backdrop flex items-start justify-center p-4" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-2xl mt-24 rounded-lg bg-gray-800 border border-gray-600 shadow-xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
          <MagnifyingGlassIcon className="w-4 h-4 text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tldr — a command, or what you want to do"
            spellCheck={false}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-0"
          />
          <span className="shrink-0 text-[10px] text-gray-500">
            {PLATFORM_LABEL[platform]} first
          </span>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {!status?.ready && (
            <p className="px-3 py-4 text-xs text-gray-400">
              tldr documentation unavailable.{' '}
              {status?.error ?? 'Open Settings › tldr to download the page set.'}
            </p>
          )}

          {status?.ready && shown.length === 0 && (
            <p className="px-3 py-4 text-xs text-gray-500">
              {query.trim()
                ? searching
                  ? 'Searching…'
                  : `Nothing matched "${query.trim()}".`
                : `Type to search ${status.pageCount.toLocaleString()} pages. Starred commands appear here.`}
            </p>
          )}

          {shown.map((result, index) => (
            <button
              key={`${result.platform}/${result.command}`}
              onClick={() => open(result)}
              onMouseEnter={() => setSelected(index)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2 text-left',
                index === selected ? 'bg-gray-700' : 'hover:bg-gray-700/50'
              )}
            >
              <span className="font-mono text-sm text-gray-100 w-40 shrink-0 truncate">
                {result.command}
              </span>
              <span className="flex-1 text-xs text-gray-400 truncate">{result.description}</span>
              {favourites.includes(result.command) && (
                <StarIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <span className="shrink-0 text-[10px] text-gray-600">
                {PLATFORM_LABEL[result.platform]}
              </span>
            </button>
          ))}
        </div>

        <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-600">
          ↑↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  )
}
