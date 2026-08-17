import { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { normaliseTag } from '@shared/types'

interface Props {
  value: string[]
  onChange: (tags: string[]) => void
  /**
   * Tags already in use elsewhere, offered as suggestions. The whole feature
   * depends on both sides spelling a tag the same way, so making the existing
   * ones one click away matters more than it looks — a typed `ciscos` silently
   * matches nothing.
   */
  suggestions?: string[]
  placeholder?: string
}

/** Tag chips with add-on-Enter, plus one-click reuse of tags already in use. */
export default function TagEditor({ value, onChange, suggestions = [], placeholder }: Props) {
  const [draft, setDraft] = useState('')

  const add = (raw: string) => {
    const tag = normaliseTag(raw)
    if (!tag || value.includes(tag)) {
      setDraft('')
      return
    }
    onChange([...value, tag].sort())
    setDraft('')
  }

  const remove = (tag: string) => onChange(value.filter((item) => item !== tag))

  const unused = useMemo(() => {
    const term = normaliseTag(draft)
    return suggestions
      .filter((tag) => !value.includes(tag))
      .filter((tag) => !term || tag.includes(term))
      .slice(0, 12)
  }, [suggestions, value, draft])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Comma too: pasting "cisco, switch" is a natural thing to try.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(draft)
      return
    }
    // Backspace on an empty box removes the last chip, as tag inputs do.
    if (event.key === 'Backspace' && !draft && value.length) {
      remove(value[value.length - 1])
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 items-center min-h-[1.75rem]">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-blue-600/25 border border-blue-500/40 text-[11px] text-blue-100"
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(tag)}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 hover:bg-blue-500/40 text-blue-200"
            >
              <XMarkIcon className="w-3 h-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-[11px] text-gray-500">No tags</span>}
      </div>

      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        placeholder={placeholder ?? 'Add a tag and press Enter'}
        className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />

      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              className={clsx(
                'px-2 py-0.5 rounded-full border text-[11px] transition-colors',
                'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white'
              )}
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
