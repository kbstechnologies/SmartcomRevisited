import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { MacroSchema, MacroStepSchema, type MacroStep } from '@shared/types'

interface MacroRecorderProps {
  onClose: () => void
  onSave: () => void
}

export default function MacroRecorder({ onClose, onSave }: MacroRecorderProps) {
  const {
    macroSets,
    recordedCommands,
    isMacroRecording,
    setMacroRecording,
    clearRecordedCommands,
    saveMacro
  } = useStore()

  const [macroName, setMacroName] = useState('')
  const [macroDescription, setMacroDescription] = useState('')
  const [selectedSetId, setSelectedSetId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (macroSets.length > 0 && !selectedSetId) {
      setSelectedSetId(macroSets[0].id!)
    }
  }, [macroSets, selectedSetId])

  useEffect(() => {
    // Start recording when component mounts
    if (!isMacroRecording) {
      clearRecordedCommands()
      setMacroRecording(true)
    }

    return () => {
      // Stop recording when component unmounts
      setMacroRecording(false)
    }
  }, [isMacroRecording, setMacroRecording, clearRecordedCommands])

  const handleStopRecording = () => {
    setMacroRecording(false)
  }

  const handleSave = async () => {
    if (!macroName.trim()) {
      setError('Macro name is required')
      return
    }

    if (!selectedSetId) {
      setError('Please select a macro set')
      return
    }

    if (recordedCommands.length === 0) {
      setError('No commands recorded')
      return
    }

    setSaving(true)
    setError('')

    try {
      // Built through the schema so every step carries the full shape
      // (appendEnter, args, branches, …) that the engine expects.
      const steps: MacroStep[] = recordedCommands.map((command) =>
        MacroStepSchema.parse({ type: 'send', text: command, delayMs: 0 })
      )

      const macro = MacroSchema.parse({
        name: macroName.trim(),
        description: macroDescription.trim() || undefined,
        setId: selectedSetId,
        steps,
      })

      await saveMacro(macro)
      clearRecordedCommands()
      onSave()
    } catch (error: any) {
      setError(error.message || 'Failed to save macro')
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    setMacroRecording(false)
    clearRecordedCommands()
    onClose()
  }

  return (
    <div className="h-full flex flex-col bg-gray-800">
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-medium text-white">Macro Recorder</h2>
          {isMacroRecording && (
            <div className="flex items-center gap-2 text-red-400">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
              <span className="text-sm">Recording...</span>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white p-1"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 flex flex-col p-4">
        {/* Recording Status */}
        <div className="bg-gray-700 border border-gray-600 rounded-lg p-4 mb-4">
          {isMacroRecording ? (
            <div>
              <div className="flex items-center gap-2 text-red-400 mb-2">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="font-medium">Recording in Progress</span>
              </div>
              <p className="text-sm text-gray-400 mb-3">
                Switch to a terminal session and type your commands. They will be captured automatically.
              </p>
              <button
                onClick={handleStopRecording}
                className="btn btn-secondary btn-sm"
              >
                Stop Recording
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 text-green-400 mb-2">
                <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                <span className="font-medium">Recording Stopped</span>
              </div>
              <p className="text-sm text-gray-400">
                Captured {recordedCommands.length} commands. Fill in the details below to save your macro.
              </p>
            </div>
          )}
        </div>

        {/* Recorded Commands */}
        <div className="bg-gray-700 border border-gray-600 rounded-lg mb-4 flex-1 min-h-0">
          <div className="p-3 border-b border-gray-600">
            <h3 className="text-sm font-medium text-gray-300">
              Recorded Commands ({recordedCommands.length})
            </h3>
          </div>
          <div className="p-3 overflow-y-auto max-h-48">
            {recordedCommands.length === 0 ? (
              <p className="text-gray-500 text-sm italic">No commands recorded yet...</p>
            ) : (
              <div className="space-y-2">
                {recordedCommands.map((command, index) => (
                  <div
                    key={index}
                    className="bg-gray-800 border border-gray-600 rounded p-2 font-mono text-sm"
                  >
                    <span className="text-gray-500 mr-2">{index + 1}.</span>
                    <span className="text-green-400">{command}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Macro Details Form */}
        {!isMacroRecording && recordedCommands.length > 0 && (
          <div className="space-y-4">
            {error && (
              <div className="bg-red-600 text-white p-3 rounded-md text-sm">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Macro Name</label>
                <input
                  type="text"
                  value={macroName}
                  onChange={(e) => setMacroName(e.target.value)}
                  className="form-input"
                  placeholder="e.g., System Status Check"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Macro Set</label>
                <select
                  value={selectedSetId}
                  onChange={(e) => setSelectedSetId(e.target.value)}
                  className="form-select"
                  required
                >
                  <option value="">Select a set</option>
                  {macroSets.map(set => (
                    <option key={set.id} value={set.id}>{set.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description (optional)</label>
              <textarea
                value={macroDescription}
                onChange={(e) => setMacroDescription(e.target.value)}
                className="form-input resize-none h-20"
                placeholder="Brief description of what this macro does"
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-gray-700 mt-4">
          <button
            onClick={handleDiscard}
            className="btn btn-secondary"
          >
            Discard
          </button>
          
          {!isMacroRecording && recordedCommands.length > 0 && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save Macro'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}