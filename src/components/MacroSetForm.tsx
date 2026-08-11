import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { MacroSetSchema } from '@shared/types'
import type { MacroSet } from '@shared/types'

interface MacroSetFormProps {
  macroSet?: MacroSet | null
  onClose: () => void
  onSave: () => void
}

export default function MacroSetForm({ macroSet, onClose, onSave }: MacroSetFormProps) {
  const { saveMacroSet } = useStore()
  const [formData, setFormData] = useState({
    name: '',
    description: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (macroSet) {
      setFormData({
        name: macroSet.name,
        description: macroSet.description || '',
      })
    }
  }, [macroSet])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setSaving(true)

    try {
      const macroSetData = {
        id: macroSet?.id,
        name: formData.name,
        description: formData.description || undefined,
      }

      const validatedMacroSet = MacroSetSchema.parse(macroSetData)
      await saveMacroSet(validatedMacroSet)
      onSave()
    } catch (error: any) {
      if (error.errors) {
        const validationErrors: Record<string, string> = {}
        error.errors.forEach((err: any) => {
          validationErrors[err.path[0]] = err.message
        })
        setErrors(validationErrors)
      } else {
        setErrors({ general: error.message || 'Failed to save macro set' })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-800">
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 className="text-lg font-medium text-white">
          {macroSet ? 'Edit Macro Set' : 'New Macro Set'}
        </h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white p-1"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 flex flex-col p-4">
        {errors.general && (
          <div className="bg-red-600 text-white p-3 rounded-md text-sm mb-4">
            {errors.general}
          </div>
        )}

        <div className="space-y-4 flex-1">
          <div className="form-group">
            <label className="form-label">Set Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              className="form-input"
              placeholder="Network Commands"
              required
            />
            {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              className="form-input resize-none h-24"
              placeholder="Optional description for this macro set"
            />
          </div>

          <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Tips</h3>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• Group related macros together (e.g., &quot;Network Troubleshooting&quot;)</li>
              <li>• Use descriptive names to make organization easier</li>
              <li>• You can drag and drop macros between sets later</li>
            </ul>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                Saving...
              </>
            ) : (
              macroSet ? 'Update' : 'Create'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}