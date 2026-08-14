import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { ChevronUpDownIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'

export interface SearchableOption {
  value: string
  label: string
  /** Optional heading the option is filed under, e.g. the button's set name. */
  group?: string
  /** Extra text matched by the search but shown greyed after the label. */
  hint?: string
}

interface Props {
  value: string | undefined
  onChange: (value: string) => void
  options: SearchableOption[]
  /** Shown on the closed control when nothing is picked. */
  placeholder?: string
  /** Offer a "none" entry that clears the selection. */
  clearable?: boolean
  clearLabel?: string
  disabled?: boolean
  className?: string
  /** Announced above the list, e.g. "1,842 buttons". */
  countNoun?: string
}

/**
 * A `<select>` replacement for lists too long to scroll.
 *
 * A native select is fine for a dozen entries and useless for two thousand:
 * picking a button to call meant scrolling a flat list of every button on the
 * machine, with no way to type at it beyond the browser's first-letter jump.
 * This keeps the same single-value contract but opens a filter box, so the
 * common case — "the one with `bgp` in the name" — is three keystrokes.
 *
 * Matching is substring, case-insensitive, and spans the label, its group and
 * its hint, so typing a set name narrows to that set without an extra control.
 */
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = '— choose —',
  clearable = false,
  clearLabel = '— none —',
  disabled = false,
  className,
  countNoun = 'options',
}: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dropUp, setDropUp] = useState(false)

  const selected = options.find((option) => option.value === value)

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return options
    // Every word has to appear somewhere, so "cisco bgp" narrows on both.
    const words = term.split(/\s+/)
    return options.filter((option) => {
      const haystack = `${option.group ?? ''} ${option.label} ${option.hint ?? ''}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  }, [options, search])

  // Keep the highlight on a real row when the filter shrinks the list.
  useEffect(() => setActive(0), [search])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  // Opened near the bottom of a scrolling dialog the list would fall off the
  // edge, so flip it above the control when there is more room up there.
  useLayoutEffect(() => {
    if (!open) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom
    setDropUp(below < 260 && rect.top > below)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown, true)
    return () => window.removeEventListener('mousedown', onPointerDown, true)
  }, [open])

  // Follow the keyboard highlight, otherwise arrowing past the fold looks like
  // the list has stopped responding.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const close = () => {
    setOpen(false)
    setSearch('')
  }

  const choose = (next: string) => {
    onChange(next)
    close()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, matches.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = matches[active]
      if (option) choose(option.value)
    }
  }

  const controlClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        className={clsx(controlClass, 'flex items-center gap-2 text-left disabled:opacity-40')}
      >
        <span className={clsx('flex-1 truncate', !selected && 'text-gray-500')}>
          {selected ? (
            <>
              {selected.group && <span className="text-gray-400">{selected.group} › </span>}
              {selected.label}
            </>
          ) : (
            placeholder
          )}
        </span>
        {selected && clearable && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onClick={(event) => {
              event.stopPropagation()
              onChange('')
            }}
            className="shrink-0 text-gray-500 hover:text-gray-300"
          >
            <XMarkIcon className="w-3.5 h-3.5" />
          </span>
        )}
        <ChevronUpDownIcon className="w-4 h-4 shrink-0 text-gray-500" />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute z-[70] left-0 right-0 rounded border border-gray-600 bg-gray-800 shadow-xl',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
          )}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-700">
            <MagnifyingGlassIcon className="w-3.5 h-3.5 shrink-0 text-gray-500" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Search ${options.length.toLocaleString()} ${countNoun}…`}
              className="w-full bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
            />
          </div>

          <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
            {clearable && !search.trim() && (
              <button
                type="button"
                onClick={() => choose('')}
                className="w-full px-3 py-1.5 text-xs text-left text-gray-400 hover:bg-gray-700"
              >
                {clearLabel}
              </button>
            )}

            {matches.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-500">Nothing matches “{search.trim()}”.</p>
            )}

            {matches.map((option, index) => {
              // Group headings only earn their space when the list is grouped
              // and the previous row belonged to a different one.
              const heading =
                option.group && option.group !== matches[index - 1]?.group ? option.group : null

              return (
                <div key={option.value}>
                  {heading && (
                    <p className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-gray-500">
                      {heading}
                    </p>
                  )}
                  <button
                    type="button"
                    data-active={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(option.value)}
                    className={clsx(
                      'w-full flex items-baseline gap-2 px-3 py-1.5 text-xs text-left',
                      index === active ? 'bg-gray-700 text-white' : 'text-gray-200',
                      option.value === value && 'font-medium text-blue-300'
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.hint && (
                      <span className="ml-auto shrink-0 text-[10px] text-gray-500">{option.hint}</span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
