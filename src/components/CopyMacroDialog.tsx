import { useMemo, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import SearchableSelect from './SearchableSelect'
import type { Macro, MacroSet } from '@shared/types'

interface Props {
  macro: Macro
  sets: MacroSet[]
  onCancel: () => void
  onCopy: (targetSetId: string, name: string) => void
}

/**
 * Asks where a button should be copied to, and what it should be called there.
 *
 * The copy is a snapshot, not a link, so the dialog says so: the most common
 * reason to copy a button is to take a vendor command and adjust it, and
 * finding out afterwards that both changed together would be a nasty surprise.
 */
export default function CopyMacroDialog({ macro, sets, onCancel, onCopy }: Props) {
  const [targetSetId, setTargetSetId] = useState(macro.setId)
  const [name, setName] = useState(macro.name)

  const options = useMemo(
    () => sets.map((set) => ({ value: set.id!, label: set.name })),
    [sets]
  )

  const sameSet = targetSetId === macro.setId
  const clash = sets.length > 0 && sameSet && name.trim() === macro.name.trim()

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">Copy button</h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1">Copy to set</label>
            <SearchableSelect
              value={targetSetId}
              onChange={setTargetSetId}
              options={options}
              placeholder="— choose a button set —"
              countNoun="sets"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300 mb-1">Name</label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
              placeholder={macro.name}
            />
            {clash && (
              <p className="mt-1 text-[11px] text-amber-400">
                Same set and same name — the copy will be saved as “{macro.name} (copy)”.
              </p>
            )}
          </div>

          <p className="text-[11px] text-gray-500">
            The copy is independent: editing it later will not change{' '}
            <span className="text-gray-400">{macro.name}</span>, and editing the original will not
            change the copy.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => onCopy(targetSetId, name)}
            disabled={!targetSetId}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Copy button
          </button>
        </div>
      </div>
    </div>
  )
}
