import { useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import ScriptBuilder from './ScriptBuilder'
import FieldEditor from './FieldEditor'
import { ICON_NAMES, MACRO_COLORS, getMacroIcon, colorClasses } from '../lib/icons'
import type { Macro } from '@shared/types'

interface MacroFormProps {
  macro?: Macro
  /** Set the new button belongs to when creating. */
  defaultSetId?: string
  onClose: () => void
  onSaved?: (macro: Macro) => void
}

const emptyMacro = (setId: string): Macro => ({
  setId,
  name: '',
  description: '',
  steps: [],
  fields: [],
  placeholders: [],
  confirmBeforeRun: false,
})

export default function MacroForm({ macro, defaultSetId, onClose, onSaved }: MacroFormProps) {
  const macros = useStore((state) => state.macros)
  const macroSets = useStore((state) => state.macroSets)
  const saveMacro = useStore((state) => state.saveMacro)

  const [draft, setDraft] = useState<Macro>(
    () => macro ?? emptyMacro(defaultSetId ?? macroSets[0]?.id ?? '')
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'flow' | 'inputs' | 'look'>('flow')

  const update = (patch: Partial<Macro>) => setDraft((current) => ({ ...current, ...patch }))

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setError('Give the button a name')
      return
    }
    if (!draft.setId) {
      setError('Choose a button set')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const saved = await saveMacro(draft)
      onSaved?.(saved)
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const PreviewIcon = getMacroIcon(draft.icon)
  const preview = colorClasses(draft.color)

  const TABS = [
    { id: 'flow' as const, label: `Flow (${draft.steps.length})` },
    { id: 'inputs' as const, label: `Inputs (${draft.fields.length})` },
    { id: 'look' as const, label: 'Appearance' },
  ]

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">
            {macro?.id ? 'Edit button' : 'New button'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-2 border-b border-gray-700">
          <div className="flex gap-2">
            <input
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="Button name"
              className={inputClass}
            />
            <select
              value={draft.setId}
              onChange={(event) => update({ setId: event.target.value })}
              className={inputClass}
            >
              <option value="">— button set —</option>
              {macroSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                </option>
              ))}
            </select>
          </div>
          <input
            value={draft.description ?? ''}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="What this button does (optional)"
            className={inputClass}
          />
        </div>

        <div className="flex border-b border-gray-700 px-2">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={clsx(
                'px-3 py-2 text-xs border-b-2 -mb-px transition-colors',
                tab === entry.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {tab === 'flow' && (
            <ScriptBuilder
              steps={draft.steps}
              onChange={(steps) => update({ steps })}
              macros={macros}
              macroSets={macroSets}
              currentMacroId={draft.id}
            />
          )}

          {tab === 'inputs' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                These inputs are collected once, before the flow starts. To ask for values partway
                through instead, add an <span className="text-pink-400">Ask for input</span> block
                in the Flow tab.
              </p>
              <FieldEditor
                fields={draft.fields}
                onChange={(fields) => update({ fields })}
                emptyHint="No inputs — this button runs immediately when clicked."
              />
              <label className="flex items-center gap-2 text-xs text-gray-400 pt-2">
                <input
                  type="checkbox"
                  checked={draft.confirmBeforeRun}
                  onChange={(event) => update({ confirmBeforeRun: event.target.checked })}
                  className="rounded border-gray-600 bg-gray-700 text-blue-500"
                />
                Ask for confirmation before running
              </label>
            </div>
          )}

          {tab === 'look' && (
            <div className="space-y-4">
              <div>
                <span className="block text-xs font-medium text-gray-300 mb-2">Icon</span>
                <div className="flex flex-wrap gap-1">
                  {ICON_NAMES.map((name) => {
                    const Icon = getMacroIcon(name)
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => update({ icon: name })}
                        title={name}
                        className={clsx(
                          'p-2 rounded border transition-colors',
                          draft.icon === name
                            ? 'border-blue-500 bg-blue-950 text-blue-300'
                            : 'border-gray-600 bg-gray-800 text-gray-400 hover:text-gray-200'
                        )}
                      >
                        <Icon className="w-4 h-4" />
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <span className="block text-xs font-medium text-gray-300 mb-2">Colour</span>
                <div className="flex flex-wrap gap-2">
                  {MACRO_COLORS.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => update({ color: entry.name })}
                      title={entry.name}
                      className={clsx(
                        'w-7 h-7 rounded border-2',
                        entry.chip,
                        draft.color === entry.name ? 'border-white' : 'border-transparent'
                      )}
                    />
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-xs font-medium text-gray-300 mb-2">Preview</span>
                <div
                  className={clsx(
                    'inline-flex items-center gap-2 px-3 py-2 rounded text-sm text-white border',
                    preview.chip,
                    preview.border
                  )}
                >
                  <PreviewIcon className="w-4 h-4" />
                  {draft.name || 'Button name'}
                </div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-red-900 bg-red-950/50 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save button'}
          </button>
        </div>
      </div>
    </div>
  )
}
