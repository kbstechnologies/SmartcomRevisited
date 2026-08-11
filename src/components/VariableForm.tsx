import { useMemo, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import type { FormField } from '@shared/types'

interface VariableFormProps {
  title: string
  description?: string
  fields: FormField[]
  submitLabel?: string
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

/** Seeds each field with its default so the form is submit-ready. */
function initialValues(fields: FormField[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.type === 'checkbox') {
      values[field.name] = field.defaultValue || 'false'
    } else if (field.type === 'select') {
      values[field.name] = field.defaultValue || field.options[0] || ''
    } else {
      values[field.name] = field.defaultValue || ''
    }
  }
  return values
}

export default function VariableForm({
  title,
  description,
  fields,
  submitLabel = 'Run',
  onSubmit,
  onCancel,
}: VariableFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(fields))
  const [touched, setTouched] = useState(false)

  const missing = useMemo(
    () =>
      fields
        .filter((field) => field.required && field.type !== 'checkbox')
        .filter((field) => !values[field.name]?.trim())
        .map((field) => field.name),
    [fields, values]
  )

  const update = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (missing.length > 0) return
    onSubmit(values)
  }

  const inputClass =
    'w-full px-3 py-2 rounded bg-gray-700 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-gray-700 text-gray-400"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {description && <p className="text-xs text-gray-400">{description}</p>}

          {fields.length === 0 && (
            <p className="text-sm text-gray-400">This script takes no inputs.</p>
          )}

          {fields.map((field) => {
            const showError = touched && missing.includes(field.name)

            return (
              <div key={field.name}>
                <label className="block text-xs font-medium text-gray-300 mb-1">
                  {field.label || field.name}
                  {field.required && field.type !== 'checkbox' && (
                    <span className="text-red-400 ml-1">*</span>
                  )}
                  <span className="ml-2 font-mono text-gray-500">{`{{${field.name}}}`}</span>
                </label>

                {field.type === 'select' ? (
                  <select
                    value={values[field.name] ?? ''}
                    onChange={(event) => update(field.name, event.target.value)}
                    className={inputClass}
                  >
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'checkbox' ? (
                  <label className="flex items-center gap-2 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={values[field.name] === 'true'}
                      onChange={(event) =>
                        update(field.name, event.target.checked ? 'true' : 'false')
                      }
                      className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                    />
                    {field.placeholder || 'Enabled'}
                  </label>
                ) : field.type === 'textarea' ? (
                  <textarea
                    value={values[field.name] ?? ''}
                    onChange={(event) => update(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    rows={4}
                    className={`${inputClass} font-mono`}
                  />
                ) : (
                  <input
                    type={
                      field.type === 'password'
                        ? 'password'
                        : field.type === 'number'
                          ? 'number'
                          : 'text'
                    }
                    value={values[field.name] ?? ''}
                    onChange={(event) => update(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    autoFocus={fields[0]?.name === field.name}
                    className={inputClass}
                  />
                )}

                {field.description && (
                  <p className="mt-1 text-xs text-gray-500">{field.description}</p>
                )}
                {showError && <p className="mt-1 text-xs text-red-400">This value is required.</p>}
              </div>
            )
          })}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
