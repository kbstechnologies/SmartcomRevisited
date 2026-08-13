import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  PlusIcon,
  FolderPlusIcon,
  PencilSquareIcon,
  TrashIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  StopIcon,
  PlayIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import MacroForm from './MacroForm'
import MacroSetForm from './MacroSetForm'
import VariableForm from './VariableForm'
import SetVisibilityMenu from './SetVisibilityMenu'
import { getMacroIcon, colorClasses } from '../lib/icons'
import { describeTargets, macroTargets } from '../lib/macroTargets'
import { loadHiddenSets, saveHiddenSets, toggleHiddenSet } from '../lib/setVisibility'
import { interpolate, resolveFields, type Macro, type FormField, type MacroSet } from '@shared/types'

export default function MacroPanel() {
  const macros = useStore((state) => state.macros)
  const macroSets = useStore((state) => state.macroSets)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const sessions = useStore((state) => state.sessions)
  const macroProgress = useStore((state) => state.macroProgress)
  const broadcastInput = useStore((state) => state.broadcastInput)
  const globalVars = useStore((state) => state.globalVars)

  const loadMacros = useStore((state) => state.loadMacros)
  const loadMacroSets = useStore((state) => state.loadMacroSets)
  const runMacro = useStore((state) => state.runMacro)
  const deleteMacro = useStore((state) => state.deleteMacro)
  const deleteMacroSet = useStore((state) => state.deleteMacroSet)
  const exportMacroSets = useStore((state) => state.exportMacroSets)
  const importMacroSets = useStore((state) => state.importMacroSets)
  const saveMacroSet = useStore((state) => state.saveMacroSet)
  const cancelMacro = useStore((state) => state.cancelMacro)
  const resumeMacro = useStore((state) => state.resumeMacro)

  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Sets ticked off in the right-click menu. Remembered between runs. */
  const [hiddenSets, setHiddenSets] = useState<string[]>([])
  const [visibilityMenu, setVisibilityMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingMacro, setEditingMacro] = useState<Macro | null>(null)
  const [creatingInSet, setCreatingInSet] = useState<string | null>(null)
  const [showSetForm, setShowSetForm] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [prompting, setPrompting] = useState<{ macro: Macro; fields: FormField[] } | null>(null)

  useEffect(() => {
    void loadMacros()
    void loadMacroSets()
  }, [loadMacros, loadMacroSets])

  // Read once the sets are known, so ids of sets that have since been deleted
  // are dropped rather than kept forever.
  useEffect(() => {
    setHiddenSets(loadHiddenSets(macroSets.map((set) => set.id!).filter(Boolean)))
  }, [macroSets])

  const updateHidden = (next: string[]) => {
    setHiddenSets(next)
    saveHiddenSets(next)
  }

  // Buttons follow the same broadcast switch as typing does.
  const targets = macroTargets(sessions, activeSessionId, broadcastInput)
  const canRun = targets.length > 0
  const progress = activeSessionId ? macroProgress[activeSessionId] : undefined

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase()
    return macroSets.map((set) => ({
      set,
      items: macros.filter(
        (macro) =>
          macro.setId === set.id &&
          (!term ||
            macro.name.toLowerCase().includes(term) ||
            macro.description?.toLowerCase().includes(term))
      ),
    }))
  }, [macros, macroSets, search])

  const shown = grouped.filter(({ set }) => !hiddenSets.includes(set.id!))
  /**
   * Hidden sets stay hidden while searching — unlike a collapsed folder, being
   * hidden is a choice the user made about this set rather than about the room
   * on screen. But a search that quietly misses matches is indistinguishable
   * from having none, so the count of what is out of sight is always on screen.
   */
  const hiddenMatches = grouped
    .filter(({ set }) => hiddenSets.includes(set.id!))
    .reduce((total, { items }) => total + items.length, 0)

  const toggleSet = (setId: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(setId)) {
        next.delete(setId)
      } else {
        next.add(setId)
      }
      return next
    })

  const execute = async (macro: Macro, variables: Record<string, string>) => {
    const targets = macroTargets(sessions, activeSessionId, broadcastInput)
    if (targets.length === 0) return

    setRunning(true)
    setStatus(`Running ${macro.name} on ${describeTargets(targets)}...`)

    // The form is answered once and the same values go to every session, so a
    // broadcast run does not ask the same question N times. Runs are started
    // together rather than in sequence — that is the point of broadcasting.
    const results = await Promise.all(
      targets.map((target) =>
        runMacro({ macroId: macro.id!, sessionId: target.id, variables }).then((result) => ({
          target,
          result,
        }))
      )
    )

    setRunning(false)

    const failures = results.filter(({ result }) => !result.success)
    if (failures.length === 0) {
      setStatus(`${macro.name} finished on ${describeTargets(targets)}`)
    } else if (failures.length === results.length) {
      setStatus(`${macro.name} failed: ${failures[0].result.error}`)
    } else {
      // Partial failure is the case worth naming: the rest did run.
      setStatus(
        `${macro.name} finished on ${results.length - failures.length} of ${results.length} — ` +
          `failed on ${failures.map(({ target }) => target.profileName).join(', ')}`
      )
    }
    window.setTimeout(() => setStatus(null), 6000)
  }

  const handleRun = async (macro: Macro) => {
    const targets = macroTargets(sessions, activeSessionId, broadcastInput)
    if (targets.length === 0) {
      setStatus('Connect a session first')
      window.setTimeout(() => setStatus(null), 3000)
      return
    }

    // Broadcasting a script to every box at once deserves the count up front.
    if (
      macro.confirmBeforeRun &&
      !window.confirm(`Run "${macro.name}" on ${describeTargets(targets)}?`)
    ) {
      return
    }

    // A default may itself reference a global — `{{KBSTECHLOG}}` as the default
    // of a URL field — so the form shows the resolved value, the same way an
    // `Ask for input` block mid-script already does.
    const values = Object.fromEntries(globalVars.vars.map((entry) => [entry.name, entry.value]))
    const fields = resolveFields(macro).map((field) => ({
      ...field,
      defaultValue: interpolate(field.defaultValue ?? '', values),
    }))

    if (fields.length > 0) {
      setPrompting({ macro, fields })
      return
    }

    await execute(macro, {})
  }

  /**
   * A button has to live in a set, and a fresh install has none — so make one
   * rather than greying the button out and leaving the user with no way in.
   */
  const handleNewButton = async () => {
    let setId = macroSets[0]?.id

    if (!setId) {
      const created = await saveMacroSet({ name: 'My buttons', sortOrder: 0 } as MacroSet)
      setId = created.id
      flash('Created the set "My buttons" to hold it')
    }

    setCreatingInSet(setId ?? '')
  }

  // Deletes report their failures. They used to reject silently, so a delete
  // the database refused looked to the user like a button that did nothing.
  const handleDeleteMacro = async (macro: Macro) => {
    if (!window.confirm(`Delete button "${macro.name}"?`)) return
    try {
      await deleteMacro(macro.id!)
    } catch (error) {
      flash(`Could not delete "${macro.name}": ${error instanceof Error ? error.message : error}`)
    }
  }

  const handleDeleteSet = async (setId: string, name: string) => {
    if (!window.confirm(`Delete set "${name}" and all its buttons?`)) return
    try {
      await deleteMacroSet(setId)
    } catch (error) {
      flash(`Could not delete "${name}": ${error instanceof Error ? error.message : error}`)
    }
  }

  const flash = (message: string) => {
    setStatus(message)
    window.setTimeout(() => setStatus(null), 6000)
  }

  const handleExport = async (setIds: string[]) => {
    try {
      const result = await exportMacroSets(setIds)
      flash(`Exported ${result.sets} set(s), ${result.macros} button(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed'
      if (!message.includes('cancelled')) flash(message)
    }
  }

  const handleImport = async () => {
    try {
      const result = await importMacroSets()
      const notes = [`Imported ${result.sets} set(s), ${result.macros} button(s)`]
      if (result.renamed.length > 0) {
        notes.push(`renamed: ${result.renamed.map((r) => `"${r.to}"`).join(', ')}`)
      }
      if (result.droppedReferences > 0) {
        notes.push(`${result.droppedReferences} external reference(s) dropped`)
      }
      flash(notes.join(' — '))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed'
      if (!message.includes('cancelled')) flash(message)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 space-y-2 border-b border-gray-700">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search buttons..."
            className="w-full pl-8 pr-2 py-1.5 rounded bg-gray-700 border border-gray-600 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-1">
          <button
            onClick={() => setShowSetForm(true)}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            <FolderPlusIcon className="w-3.5 h-3.5" />
            New set
          </button>
          <button
            onClick={() => void handleNewButton()}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New button
          </button>
        </div>

        <div className="flex gap-1">
          <button
            onClick={handleImport}
            title="Import button sets from a .buttons.json file"
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            <ArrowDownTrayIcon className="w-3.5 h-3.5" />
            Import
          </button>
          <button
            onClick={() => handleExport(macroSets.map((set) => set.id!))}
            disabled={macroSets.length === 0}
            title="Export every button set"
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            <ArrowUpTrayIcon className="w-3.5 h-3.5" />
            Export all
          </button>
        </div>

        <p
          className={clsx(
            'text-[11px] truncate',
            broadcastInput && canRun ? 'text-amber-400' : 'text-gray-500'
          )}
        >
          {canRun
            ? `${broadcastInput ? 'Broadcasting to' : 'Target:'} ${describeTargets(targets)}`
            : 'No connected session — buttons are disabled'}
        </p>
      </div>

      {/* Run status / pause controls */}
      {(progress?.awaitingResume || running || status) && (
        <div className="px-2 py-1.5 border-b border-gray-700 bg-gray-900/60 space-y-1">
          {progress?.awaitingResume ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] text-amber-300">
                {progress.message || 'Paused'}
              </span>
              <button
                onClick={() => activeSessionId && resumeMacro(activeSessionId)}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-amber-600 text-white hover:bg-amber-500"
              >
                <PlayIcon className="w-3 h-3" />
                Resume
              </button>
            </div>
          ) : (
            status && <p className="text-[11px] text-gray-400 truncate">{status}</p>
          )}

          {running && (
            <div className="flex items-center gap-2">
              {progress?.stepCount ? (
                <span className="text-[11px] text-gray-500">
                  {progress.macroName} — step {(progress.stepIndex ?? 0) + 1}/{progress.stepCount}
                </span>
              ) : null}
              <div className="flex-1" />
              <button
                onClick={() => activeSessionId && cancelMacro(activeSessionId)}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-red-700 text-white hover:bg-red-600"
              >
                <StopIcon className="w-3 h-3" />
                Stop
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right-click anywhere in the sets area to choose which sets show. */}
      <div
        onContextMenu={(event) => {
          event.preventDefault()
          setVisibilityMenu({ x: event.clientX, y: event.clientY })
        }}
        title="Right-click to choose which button sets are shown"
        className="flex-1 overflow-y-auto p-2 space-y-3"
      >
        {macroSets.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-6">
            Create a button set to get started.
          </p>
        )}

        {macroSets.length > 0 && shown.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-6">
            Every button set is hidden. Right-click here to bring one back.
          </p>
        )}

        {shown.map(({ set, items }) => {
          const isCollapsed = collapsed.has(set.id!)

          return (
            <div key={set.id}>
              <div className="flex items-center gap-1 mb-1.5">
                <button
                  onClick={() => toggleSet(set.id!)}
                  className="flex items-center gap-1 flex-1 min-w-0 text-left text-xs font-medium text-gray-300 hover:text-white"
                >
                  {isCollapsed ? (
                    <ChevronRightIcon className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <ChevronDownIcon className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">{set.name}</span>
                  <span className="text-gray-600">({items.length})</span>
                </button>
                <button
                  onClick={() => setCreatingInSet(set.id!)}
                  title="Add button to this set"
                  className="p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleExport([set.id!])}
                  title="Export this set"
                  className="p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                >
                  <ArrowUpTrayIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDeleteSet(set.id!, set.name)}
                  title="Delete set"
                  className="p-0.5 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </div>

              {!isCollapsed && (
                <div className="grid grid-cols-2 gap-1.5">
                  {items.map((macro) => {
                    const Icon = getMacroIcon(macro.icon)
                    const colors = colorClasses(macro.color)
                    const fieldCount = resolveFields(macro).length

                    return (
                      <div key={macro.id} className="group relative">
                        <button
                          onClick={() => handleRun(macro)}
                          disabled={!canRun || running}
                          title={macro.description || macro.name}
                          className={clsx(
                            'w-full flex items-center gap-1.5 px-2 py-2 rounded text-xs text-white border text-left transition',
                            colors.chip,
                            colors.border,
                            !canRun || running
                              ? 'opacity-40 cursor-not-allowed'
                              : 'hover:brightness-110'
                          )}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="truncate flex-1">{macro.name}</span>
                          {fieldCount > 0 && (
                            <span
                              title={`${fieldCount} input${fieldCount === 1 ? '' : 's'}`}
                              className="text-[10px] opacity-80"
                            >
                              ⌨
                            </span>
                          )}
                        </button>

                        <div className="absolute top-0.5 right-0.5 hidden group-hover:flex gap-0.5">
                          <button
                            onClick={() => setEditingMacro(macro)}
                            title="Edit"
                            className="p-0.5 rounded bg-black/50 text-white hover:bg-black/80"
                          >
                            <PencilSquareIcon className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDeleteMacro(macro)}
                            title="Delete"
                            className="p-0.5 rounded bg-black/50 text-white hover:bg-black/80"
                          >
                            <TrashIcon className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )
                  })}

                  {items.length === 0 && (
                    <p className="col-span-2 text-[11px] text-gray-600 italic px-1">
                      No buttons in this set.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hiddenSets.length > 0 && (
        <button
          type="button"
          onClick={(event) =>
            setVisibilityMenu({ x: event.clientX, y: event.currentTarget.getBoundingClientRect().top })
          }
          title="Choose which button sets are shown"
          className="px-2 py-1 text-left text-[11px] text-gray-500 border-t border-gray-700 hover:bg-gray-700/50 hover:text-gray-300"
        >
          {hiddenSets.length} set{hiddenSets.length === 1 ? '' : 's'} hidden
          {search.trim() && hiddenMatches > 0 && ` — ${hiddenMatches} match(es) not shown`}
        </button>
      )}

      {visibilityMenu && (
        <SetVisibilityMenu
          sets={macroSets}
          hidden={hiddenSets}
          x={visibilityMenu.x}
          y={visibilityMenu.y}
          onToggle={(setId) => updateHidden(toggleHiddenSet(hiddenSets, setId))}
          onShowAll={() => updateHidden([])}
          onHideAll={() => updateHidden(macroSets.map((set) => set.id!).filter(Boolean))}
          onClose={() => setVisibilityMenu(null)}
        />
      )}

      {prompting && (
        <VariableForm
          title={prompting.macro.name}
          description={prompting.macro.description}
          fields={prompting.fields}
          submitLabel="Run"
          onCancel={() => setPrompting(null)}
          onSubmit={(values) => {
            const macro = prompting.macro
            setPrompting(null)
            void execute(macro, values)
          }}
        />
      )}

      {(editingMacro || creatingInSet !== null) && (
        <MacroForm
          macro={editingMacro ?? undefined}
          defaultSetId={creatingInSet ?? undefined}
          onClose={() => {
            setEditingMacro(null)
            setCreatingInSet(null)
          }}
        />
      )}

      {showSetForm && (
        <MacroSetForm onClose={() => setShowSetForm(false)} onSave={() => setShowSetForm(false)} />
      )}
    </div>
  )
}
