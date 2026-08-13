import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  XMarkIcon,
  PlusIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import {
  isValidGlobalName,
  mergeGlobalVars,
  parseGlobalVars,
  type GlobalVar,
} from '@shared/global-vars'

/**
 * Editor for the global variables — the values every button, script and form
 * default can reference as `{{NAME}}` without the button declaring anything.
 *
 * It is a form over a text file the user owns, so it offers both: rows for the
 * ordinary case, and the file itself for anyone who would rather edit it (or
 * paste one in) directly. Saving from the rows keeps the file's comments,
 * because a note explaining *why* a value is what it is must survive someone
 * changing that value here.
 */
export default function GlobalVariables({ onClose }: { onClose: () => void }) {
  const globalVars = useStore((state) => state.globalVars)
  const loadGlobalVars = useStore((state) => state.loadGlobalVars)
  const saveGlobalVars = useStore((state) => state.saveGlobalVars)
  const revealGlobalVars = useStore((state) => state.revealGlobalVars)
  const macros = useStore((state) => state.macros)

  const [rows, setRows] = useState<GlobalVar[]>([])
  const [rawText, setRawText] = useState('')
  const [mode, setMode] = useState<'form' | 'text'>('form')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadGlobalVars()
  }, [loadGlobalVars])

  // Reload from the store while the user has not started editing; once they
  // have, their work is what is on screen.
  useEffect(() => {
    if (dirty) return
    setRows(globalVars.vars)
    setRawText(globalVars.text)
  }, [globalVars, dirty])

  const names = rows.map((row) => row.name.trim())

  const rowProblem = (row: GlobalVar, index: number): string | null => {
    const name = row.name.trim()
    if (name === '') return row.value === '' ? null : 'Needs a name'
    if (!isValidGlobalName(name)) return 'Letters, digits and _ only, not starting with a digit'
    if (names.indexOf(name) !== index) return 'Already set above'
    return null
  }

  const formErrors = rows
    .map((row, index) => rowProblem(row, index))
    .filter((problem): problem is string => problem !== null)

  /** How many buttons would notice if this name changed. */
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const macro of macros) {
      const text = JSON.stringify(macro)
      for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
      }
    }
    return counts
  }, [macros])

  const updateRow = (index: number, patch: Partial<GlobalVar>) => {
    setDirty(true)
    setNotice(null)
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const addRow = () => {
    setDirty(true)
    setRows((current) => [...current, { name: '', value: '' }])
  }

  const removeRow = (index: number) => {
    setDirty(true)
    setNotice(null)
    setRows((current) => current.filter((_row, i) => i !== index))
  }

  /**
   * Switching views carries the edits across, so nothing typed in one is lost
   * by looking at the other.
   */
  const switchMode = (next: 'form' | 'text') => {
    if (next === mode) return

    if (next === 'text') {
      setRawText(mergeGlobalVars(rawText, usableRows()))
    } else {
      setRows(parseGlobalVars(rawText).vars)
    }
    setMode(next)
  }

  /** Rows worth writing: a blank trailing row is not an error, just unfinished. */
  const usableRows = () =>
    rows
      .map((row) => ({ name: row.name.trim(), value: row.value }))
      .filter((row) => row.name !== '')

  const save = async () => {
    setError(null)
    setNotice(null)

    if (mode === 'form' && formErrors.length > 0) {
      setError('Fix the highlighted names first')
      return
    }

    setSaving(true)
    try {
      const text = mode === 'form' ? mergeGlobalVars(rawText, usableRows()) : rawText
      const saved = await saveGlobalVars(text)

      setRows(saved.vars)
      setRawText(saved.text)
      setDirty(false)
      setNotice(
        saved.vars.length === 0
          ? 'Saved — no variables set'
          : `Saved ${saved.vars.length} variable${saved.vars.length === 1 ? '' : 's'}`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    setError(null)
    setNotice(null)
    setDirty(false)
    await loadGlobalVars()
    setNotice('Reloaded from disk')
  }

  const inputClass =
    'px-2 py-1 rounded bg-gray-900 border text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl h-[80vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-100">Global variables</h2>
            <p className="text-[11px] text-gray-500 truncate" title={globalVars.path}>
              {globalVars.path || 'Not created yet'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex rounded overflow-hidden border border-gray-600 mr-1">
              {(['form', 'text'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => switchMode(option)}
                  className={clsx(
                    'px-2 py-1 text-xs transition-colors',
                    mode === option
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  )}
                >
                  {option === 'form' ? 'Form' : 'File'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void reload()}
              title="Reload the file from disk"
              className="p-1 rounded text-gray-400 hover:bg-gray-700"
            >
              <ArrowPathIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => void revealGlobalVars()}
              title="Open the file in your editor"
              className="p-1 rounded text-gray-400 hover:bg-gray-700"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:bg-gray-700"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        <p className="px-4 py-2 text-[11px] text-gray-400 border-b border-gray-700">
          Every name here is available to <em>every</em> button, script and form default as{' '}
          <code className="text-gray-200">{'{{NAME}}'}</code> — the same as an input you typed.
          Set <code className="text-gray-200">KBSTECHLOG</code> here and a button can send{' '}
          <code className="text-gray-200">{'wget {{KBSTECHLOG}}'}</code>. A value the button asks
          for wins over the one set here.
        </p>

        <div className="flex-1 overflow-y-auto p-3">
          {mode === 'form' ? (
            <div className="space-y-1.5">
              {rows.length === 0 && (
                <p className="text-[11px] text-gray-500 py-6 text-center">
                  No global variables yet. Add one below.
                </p>
              )}

              {rows.map((row, index) => {
                const problem = rowProblem(row, index)
                const used = usage.get(row.name.trim()) ?? 0

                return (
                  <div key={index}>
                    <div className="flex items-start gap-1.5">
                      <div className="w-56 shrink-0">
                        <input
                          value={row.name}
                          onChange={(event) => updateRow(index, { name: event.target.value })}
                          placeholder="KBSTECHLOG"
                          spellCheck={false}
                          className={clsx(
                            inputClass,
                            'w-full',
                            problem ? 'border-red-500' : 'border-gray-600'
                          )}
                        />
                      </div>
                      <input
                        value={row.value}
                        onChange={(event) => updateRow(index, { value: event.target.value })}
                        placeholder="https://fake.com/log"
                        spellCheck={false}
                        className={clsx(inputClass, 'flex-1 min-w-0 border-gray-600')}
                      />
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        title="Remove"
                        className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>

                    {problem ? (
                      <p className="pl-1 pt-0.5 text-[10px] text-red-400">{problem}</p>
                    ) : (
                      used > 0 && (
                        <p className="pl-1 pt-0.5 text-[10px] text-gray-600">
                          Referenced by {used} button step{used === 1 ? '' : 's'}
                        </p>
                      )
                    )}
                  </div>
                )
              })}

              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-1 mt-2 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
              >
                <PlusIcon className="w-3.5 h-3.5" />
                Add variable
              </button>
            </div>
          ) : (
            <>
              <textarea
                value={rawText}
                onChange={(event) => {
                  setRawText(event.target.value)
                  setDirty(true)
                  setNotice(null)
                }}
                spellCheck={false}
                placeholder={'# NAME=value, one per line\nKBSTECHLOG=https://fake.com/log'}
                className="w-full h-full min-h-[16rem] px-2 py-1.5 rounded bg-gray-900 border border-gray-600 text-xs font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              {globalVars.problems.length > 0 && !dirty && (
                <div className="mt-2 space-y-0.5">
                  {globalVars.problems.map((problem) => (
                    <p key={problem.line} className="text-[10px] text-amber-400">
                      Line {problem.line}: {problem.message}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700">
          <div className="flex-1 min-w-0">
            {error && <p className="text-[11px] text-red-400 truncate">{error}</p>}
            {!error && notice && <p className="text-[11px] text-green-400 truncate">{notice}</p>}
            {!error && !notice && dirty && (
              <p className="text-[11px] text-amber-400">Unsaved changes</p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
