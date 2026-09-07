import { useEffect, useRef } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'

/**
 * "You used {{var1}} and nothing defines it — what is it?"
 *
 * The scratch pad resolves globals and built-ins silently. Everything else
 * lands here, at the moment the operator presses Copy, Insert or Send, and not
 * before: half a typed name is not a question, and prompting while somebody is
 * still writing would put a modal over the text they are writing.
 *
 * These values are not saved anywhere. They are answers to *this* staged text,
 * kept in the store only so the pad can be edited without retyping them, and
 * they go when the pad is cleared. A one-off value that deserved keeping is a
 * global, and the globals editor is where that is done.
 */

interface Props {
  /** Names still needing a value, in the order they appear in the text. */
  names: string[]
  /** What has already been typed for them, so re-opening does not start over. */
  answers: Record<string, string>
  /** The action the operator pressed, e.g. "Insert" — named on the button. */
  actionLabel: string
  onChange: (name: string, value: string) => void
  onCancel: () => void
  onConfirm: () => void
}

export default function PrestageVarsDialog({
  names,
  answers,
  actionLabel,
  onChange,
  onCancel,
  onConfirm,
}: Props) {
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
    firstRef.current?.select()
  }, [])

  // Escape closes, as everywhere else. Deliberately no Enter-to-confirm on the
  // last field: this dialog exists on the path to a live terminal, and the one
  // keystroke that should not be able to fire it by reflex is Enter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const blank = names.filter((name) => (answers[name] ?? '').trim() === '')

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="min-w-0">
            <h2 className="text-lg font-medium text-white">
              {names.length === 1 ? 'One value needed' : `${names.length} values needed`}
            </h2>
            <p className="text-xs text-gray-400">
              Not a global variable and not built in, so the pad is asking.
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-white p-1">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <form
          className="p-5 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          {names.map((name, index) => (
            <div key={name}>
              <label
                className="block text-xs font-mono text-blue-300 mb-1"
                htmlFor={`prestage-var-${name}`}
              >
                {`{{${name}}}`}
              </label>
              <input
                id={`prestage-var-${name}`}
                ref={index === 0 ? firstRef : undefined}
                type="text"
                spellCheck={false}
                value={answers[name] ?? ''}
                onChange={(event) => onChange(name, event.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm"
              />
            </div>
          ))}

          {/* Blank is allowed — sometimes the answer really is nothing — but it
              is worth saying out loud, because a blank here is invisible in the
              resolved text once it is sent. */}
          {blank.length > 0 && (
            <p className="text-xs text-amber-300">
              {blank.length === 1
                ? `${blank[0]} is still empty and will resolve to nothing.`
                : `${blank.length} of these are still empty and will resolve to nothing.`}
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm"
            >
              {actionLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
