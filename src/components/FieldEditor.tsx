import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import type { FormField } from '@shared/types'

interface FieldEditorProps {
  fields: FormField[]
  onChange: (fields: FormField[]) => void
  /** Shown when the list is empty. */
  emptyHint?: string
}

const FIELD_TYPES: Array<FormField['type']> = [
  'text',
  'number',
  'password',
  'select',
  'checkbox',
  'textarea',
]

export const makeField = (index: number): FormField => ({
  name: `VAR${index + 1}`,
  label: '',
  type: 'text',
  defaultValue: '',
  options: [],
  required: false,
})

/** Builds the input list for a popup form; each field becomes a `{{VAR}}`. */
export default function FieldEditor({ fields, onChange, emptyHint }: FieldEditorProps) {
  const update = (index: number, patch: Partial<FormField>) => {
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)))
  }

  const remove = (index: number) => onChange(fields.filter((_, i) => i !== index))

  const inputClass =
    'px-2 py-1 rounded bg-gray-800 border border-gray-600 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-2">
      {fields.length === 0 && (
        <p className="text-xs text-gray-500">{emptyHint ?? 'No inputs — runs immediately.'}</p>
      )}

      {fields.map((field, index) => (
        <div key={index} className="rounded border border-gray-600 bg-gray-900/50 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={field.name}
              onChange={(event) =>
                update(index, { name: event.target.value.replace(/[^A-Za-z0-9_]/g, '') })
              }
              placeholder="VARNAME"
              className={`${inputClass} w-28 font-mono`}
            />
            <input
              value={field.label ?? ''}
              onChange={(event) => update(index, { label: event.target.value })}
              placeholder="Label shown to user"
              className={`${inputClass} flex-1`}
            />
            <select
              value={field.type}
              onChange={(event) =>
                update(index, { type: event.target.value as FormField['type'] })
              }
              className={inputClass}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => remove(index)}
              className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700"
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={field.defaultValue}
              onChange={(event) => update(index, { defaultValue: event.target.value })}
              placeholder="Default value"
              className={`${inputClass} flex-1`}
            />
            {field.type === 'select' ? (
              <input
                value={field.options.join(', ')}
                onChange={(event) =>
                  update(index, {
                    options: event.target.value
                      .split(',')
                      .map((option) => option.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Choices, comma separated"
                className={`${inputClass} flex-1`}
              />
            ) : (
              <input
                value={field.placeholder ?? ''}
                onChange={(event) => update(index, { placeholder: event.target.value })}
                placeholder="Hint text"
                className={`${inputClass} flex-1`}
              />
            )}
            <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => update(index, { required: event.target.checked })}
                className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
              />
              Required
            </label>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...fields, makeField(fields.length)])}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add input
      </button>
    </div>
  )
}
