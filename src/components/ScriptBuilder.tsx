import { clsx } from 'clsx'
import {
  ChevronUpIcon,
  ChevronDownIcon,
  TrashIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { useEffect, useMemo } from 'react'
import FieldEditor from './FieldEditor'
import SearchableSelect from './SearchableSelect'
import { useStore } from '../store/useStore'
import type { Macro, MacroSet, MacroStep, MacroStepType, ScriptEntry } from '@shared/types'

/** Depth-first list of every file in the library, as library-relative paths. */
export function flattenScripts(entries: ScriptEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.type === 'folder' ? flattenScripts(entry.children ?? []) : [entry.path]
  )
}

interface ScriptBuilderProps {
  steps: MacroStep[]
  onChange: (steps: MacroStep[]) => void
  /** Call targets available to `callMacro` / `callSet` blocks. */
  macros: Macro[]
  macroSets: MacroSet[]
  /** Excluded from the call list so a script cannot call itself. */
  currentMacroId?: string
}

interface BlockMeta {
  label: string
  hint: string
  /** Scratch-style palette: each action category gets its own colour. */
  accent: string
  chip: string
}

const BLOCKS: Record<MacroStepType, BlockMeta> = {
  send: {
    label: 'Send text',
    hint: 'Type text into the session',
    accent: 'border-l-blue-500',
    chip: 'bg-blue-600',
  },
  expect: {
    label: 'Wait for prompt',
    hint: 'Block until output matches',
    accent: 'border-l-purple-500',
    chip: 'bg-purple-600',
  },
  delay: {
    label: 'Wait seconds',
    hint: 'Pause for a fixed time',
    accent: 'border-l-slate-400',
    chip: 'bg-slate-500',
  },
  form: {
    label: 'Ask for input',
    hint: 'Pop a form; answers become variables',
    accent: 'border-l-pink-500',
    chip: 'bg-pink-600',
  },
  confirm: {
    label: 'Confirm action',
    hint: 'Ask yes/no; no stops the script',
    accent: 'border-l-yellow-500',
    chip: 'bg-yellow-600',
  },
  pause: {
    label: 'Pause',
    hint: 'Wait for the operator to resume',
    accent: 'border-l-amber-500',
    chip: 'bg-amber-600',
  },
  if: {
    label: 'If prompt … else',
    hint: 'Branch on whether output matches',
    accent: 'border-l-orange-500',
    chip: 'bg-orange-600',
  },
  exit: {
    label: 'Exit',
    hint: 'Stop the script',
    accent: 'border-l-red-500',
    chip: 'bg-red-600',
  },
  runScript: {
    label: 'Run script file',
    hint: 'Copy a script to the host, run it, delete it',
    accent: 'border-l-cyan-500',
    chip: 'bg-cyan-600',
  },
  callMacro: {
    label: 'Run button',
    hint: 'Run another button’s script',
    accent: 'border-l-green-500',
    chip: 'bg-green-600',
  },
  callSet: {
    label: 'Run button set',
    hint: 'Run every button in a set',
    accent: 'border-l-teal-500',
    chip: 'bg-teal-600',
  },
}

const PALETTE: MacroStepType[] = [
  'send',
  'expect',
  'delay',
  'form',
  'confirm',
  'pause',
  'if',
  'runScript',
  'callMacro',
  'callSet',
  'exit',
]

export function makeStep(type: MacroStepType): MacroStep {
  return {
    type,
    text: '',
    appendEnter: type === 'send',
    pattern: type === 'expect' || type === 'if' ? '\\$ $' : undefined,
    delayMs: 0,
    timeoutMs: type === 'expect' || type === 'if' ? 10000 : undefined,
    args: {},
    fields: [],
    // A confirm is only worth adding for something worth stopping, so it
    // starts with wording the operator can run with.
    message: type === 'confirm' ? 'Do you want to continue?' : undefined,
    title: type === 'confirm' ? 'Confirm action' : undefined,
    confirmLabel: type === 'confirm' ? 'Yes' : undefined,
    cancelLabel: type === 'confirm' ? 'No' : undefined,
    destructive: false,
    // Staging a script and leaving it behind is the surprising outcome, so
    // cleanup is on unless the operator turns it off.
    cleanupAfterRun: true,
    remoteDir: type === 'runScript' ? '/tmp' : undefined,
    continueOnError: false,
    exitAll: false,
    thenSteps: [],
    elseSteps: [],
  }
}

const inputClass =
  'px-2 py-1 rounded bg-gray-800 border border-gray-600 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

/** Key/value editor for the variables handed to a called script. */
function ArgsEditor({
  args,
  onChange,
}: {
  args: Record<string, string>
  onChange: (args: Record<string, string>) => void
}) {
  const entries = Object.entries(args)

  return (
    <div className="space-y-1">
      <span className="text-[11px] text-gray-500">
        Variables passed down (values may use {'{{VAR}}'} from this script)
      </span>
      {entries.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            value={key}
            onChange={(event) => {
              const next = { ...args }
              delete next[key]
              next[event.target.value] = value
              onChange(next)
            }}
            placeholder="NAME"
            className={`${inputClass} w-24 font-mono`}
          />
          <span className="text-gray-600 text-xs">=</span>
          <input
            value={value}
            onChange={(event) => onChange({ ...args, [key]: event.target.value })}
            placeholder="value or {{VAR}}"
            className={`${inputClass} flex-1`}
          />
          <button
            type="button"
            onClick={() => {
              const next = { ...args }
              delete next[key]
              onChange(next)
            }}
            className="p-1 rounded text-gray-500 hover:text-red-400"
          >
            <TrashIcon className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...args, [`VAR${entries.length + 1}`]: '' })}
        className="text-[11px] text-gray-400 hover:text-gray-200"
      >
        + pass a variable
      </button>
    </div>
  )
}

interface StepListProps extends Omit<ScriptBuilderProps, 'steps' | 'onChange'> {
  steps: MacroStep[]
  onChange: (steps: MacroStep[]) => void
  depth: number
}

function StepList({ steps, onChange, macros, macroSets, currentMacroId, depth }: StepListProps) {
  const update = (index: number, patch: Partial<MacroStep>) =>
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)))

  const remove = (index: number) => onChange(steps.filter((_, i) => i !== index))

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= steps.length) return
    const next = [...steps]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  /**
   * Options for the two pickers. Buttons are grouped by their set and sorted by
   * it, so the set headings in the dropdown are contiguous — and so a search
   * for a set name pulls up everything in it.
   */
  const setOptions = useMemo(
    () => macroSets.map((set) => ({ value: set.id!, label: set.name })),
    [macroSets]
  )

  const callableOptions = useMemo(() => {
    const setName = new Map(macroSets.map((set) => [set.id, set.name]))
    return macros
      .filter((macro) => macro.id !== currentMacroId)
      .map((macro) => ({
        value: macro.id!,
        label: macro.name,
        group: setName.get(macro.setId) ?? 'Unknown set',
        hint: macro.fields.length ? `${macro.fields.length} field(s)` : undefined,
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  }, [macros, macroSets, currentMacroId])

  // The library tree is folders-and-files; the picker wants a flat list of the
  // files, each labelled by its path relative to the library root.
  const scriptLibrary = useStore((state) => state.scriptLibrary)
  const chooseScriptFolder = useStore((state) => state.chooseScriptFolder)
  const loadScriptLibrary = useStore((state) => state.loadScriptLibrary)

  useEffect(() => {
    void loadScriptLibrary()
  }, [loadScriptLibrary])

  const scriptFiles = useMemo(() => flattenScripts(scriptLibrary.entries), [scriptLibrary])

  return (
    <div className="space-y-2">
      {steps.map((step, index) => {
        const meta = BLOCKS[step.type] ?? BLOCKS.send

        return (
          <div
            key={index}
            className={clsx(
              'rounded border border-gray-700 border-l-4 bg-gray-800/80 overflow-hidden',
              meta.accent
            )}
          >
            <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-800">
              <span
                className={clsx(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold text-white uppercase tracking-wide',
                  meta.chip
                )}
              >
                {index + 1}
              </span>
              <span className="text-xs font-medium text-gray-100">{meta.label}</span>
              <span className="text-[11px] text-gray-500 hidden md:inline">{meta.hint}</span>

              <div className="flex-1" />

              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="p-0.5 rounded text-gray-500 hover:text-gray-200 disabled:opacity-30"
              >
                <ChevronUpIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === steps.length - 1}
                className="p-0.5 rounded text-gray-500 hover:text-gray-200 disabled:opacity-30"
              >
                <ChevronDownIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(index)}
                className="p-0.5 rounded text-gray-500 hover:text-red-400"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="px-2 py-2 space-y-2">
              {step.type === 'send' && (
                <>
                  <textarea
                    value={step.text ?? ''}
                    onChange={(event) => update(index, { text: event.target.value })}
                    placeholder="command to send — use {{VAR}} for form values"
                    rows={2}
                    className={`${inputClass} w-full font-mono`}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1 text-xs text-gray-400">
                      <input
                        type="checkbox"
                        checked={step.appendEnter}
                        onChange={(event) => update(index, { appendEnter: event.target.checked })}
                        className="rounded border-gray-600 bg-gray-700 text-blue-500"
                      />
                      Press Enter
                    </label>
                    <label className="flex items-center gap-1 text-xs text-gray-400">
                      Repeat
                      <input
                        type="number"
                        min={1}
                        value={step.repeat ?? 1}
                        onChange={(event) =>
                          update(index, { repeat: Math.max(1, Number(event.target.value) || 1) })
                        }
                        className={`${inputClass} w-16`}
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-gray-400">
                      Delay before (ms)
                      <input
                        type="number"
                        min={0}
                        value={step.delayMs}
                        onChange={(event) =>
                          update(index, { delayMs: Math.max(0, Number(event.target.value) || 0) })
                        }
                        className={`${inputClass} w-20`}
                      />
                    </label>
                  </div>
                </>
              )}

              {(step.type === 'expect' || step.type === 'if') && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={step.pattern ?? ''}
                    onChange={(event) => update(index, { pattern: event.target.value })}
                    placeholder="regex to wait for, e.g. \\$ $ or Password:"
                    className={`${inputClass} flex-1 font-mono`}
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-400">
                    Timeout (ms)
                    <input
                      type="number"
                      min={0}
                      value={step.timeoutMs ?? 10000}
                      onChange={(event) =>
                        update(index, { timeoutMs: Math.max(0, Number(event.target.value) || 0) })
                      }
                      className={`${inputClass} w-24`}
                    />
                  </label>
                </div>
              )}

              {step.type === 'if' && (
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-500">
                    Timing out counts as “no match” and runs the else branch.
                  </p>
                  <div className="rounded border border-orange-700/50 bg-orange-950/20 p-2">
                    <div className="text-[11px] font-semibold text-orange-300 mb-1">
                      Then — pattern matched
                    </div>
                    <StepList
                      steps={step.thenSteps ?? []}
                      onChange={(thenSteps) => update(index, { thenSteps })}
                      macros={macros}
                      macroSets={macroSets}
                      currentMacroId={currentMacroId}
                      depth={depth + 1}
                    />
                  </div>
                  <div className="rounded border border-gray-600/50 bg-gray-900/40 p-2">
                    <div className="text-[11px] font-semibold text-gray-300 mb-1">
                      Else — no match
                    </div>
                    <StepList
                      steps={step.elseSteps ?? []}
                      onChange={(elseSteps) => update(index, { elseSteps })}
                      macros={macros}
                      macroSets={macroSets}
                      currentMacroId={currentMacroId}
                      depth={depth + 1}
                    />
                  </div>
                </div>
              )}

              {step.type === 'delay' && (
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  Wait
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={step.delayMs}
                    onChange={(event) =>
                      update(index, { delayMs: Math.max(0, Number(event.target.value) || 0) })
                    }
                    className={`${inputClass} w-28`}
                  />
                  ms ({((step.delayMs || 0) / 1000).toFixed(1)}s)
                </label>
              )}

              {step.type === 'pause' && (
                <input
                  value={step.message ?? ''}
                  onChange={(event) => update(index, { message: event.target.value })}
                  placeholder="Message shown while paused"
                  className={`${inputClass} w-full`}
                />
              )}

              {step.type === 'form' && (
                <>
                  <input
                    value={step.title ?? ''}
                    onChange={(event) => update(index, { title: event.target.value })}
                    placeholder="Form heading"
                    className={`${inputClass} w-full`}
                  />
                  <FieldEditor
                    fields={step.fields ?? []}
                    onChange={(fields) => update(index, { fields })}
                    emptyHint="Add the inputs to collect at this point in the flow."
                  />
                </>
              )}

              {step.type === 'runScript' && (
                <>
                  <div className="flex gap-1">
                    <select
                      value={step.scriptPath ?? ''}
                      onChange={(event) => update(index, { scriptPath: event.target.value })}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="">Choose a script…</option>
                      {scriptFiles.map((file) => (
                        <option key={file} value={file}>
                          {file}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void chooseScriptFolder()}
                      title="Choose the script library folder"
                      className="px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
                    >
                      Folder…
                    </button>
                  </div>

                  {scriptFiles.length === 0 && (
                    <p className="text-[11px] text-gray-500">
                      No scripts yet — point the app at a folder of scripts with
                      <span className="text-gray-300"> Folder… </span>
                      and they appear here.
                    </p>
                  )}

                  <div className="flex gap-1">
                    <input
                      value={step.remoteDir ?? ''}
                      onChange={(event) => update(index, { remoteDir: event.target.value })}
                      placeholder="/tmp"
                      title="Directory on the host to copy it into"
                      className={`${inputClass} w-28`}
                    />
                    <input
                      value={step.interpreter ?? ''}
                      onChange={(event) => update(index, { interpreter: event.target.value })}
                      placeholder="bash (blank = chmod +x)"
                      title="Run it with this, e.g. bash, sh, python3, sudo bash"
                      className={`${inputClass} w-40`}
                    />
                    <input
                      value={step.scriptArgs ?? ''}
                      onChange={(event) => update(index, { scriptArgs: event.target.value })}
                      placeholder="arguments — {{VAR}} allowed"
                      className={`${inputClass} flex-1`}
                    />
                  </div>

                  <label className="flex items-center gap-1 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={step.cleanupAfterRun}
                      onChange={(event) =>
                        update(index, { cleanupAfterRun: event.target.checked })
                      }
                      className="rounded border-gray-600 bg-gray-700 text-blue-500"
                    />
                    Delete the copy from the host after it runs
                  </label>

                  <p className="text-[11px] text-gray-500">
                    Copied over SFTP to a random hidden name, then run in this session so you
                    watch it happen. SSH only — not available on serial.
                  </p>
                </>
              )}

              {step.type === 'confirm' && (
                <>
                  <input
                    value={step.message ?? ''}
                    onChange={(event) => update(index, { message: event.target.value })}
                    placeholder="Question, e.g. Do you want to reboot?"
                    className={`${inputClass} w-full`}
                  />
                  <div className="flex gap-1">
                    <input
                      value={step.title ?? ''}
                      onChange={(event) => update(index, { title: event.target.value })}
                      placeholder="Heading"
                      className={`${inputClass} flex-1`}
                    />
                    <input
                      value={step.confirmLabel ?? ''}
                      onChange={(event) => update(index, { confirmLabel: event.target.value })}
                      placeholder="Yes"
                      className={`${inputClass} w-24`}
                    />
                    <input
                      value={step.cancelLabel ?? ''}
                      onChange={(event) => update(index, { cancelLabel: event.target.value })}
                      placeholder="No"
                      className={`${inputClass} w-24`}
                    />
                  </div>
                  <label className="flex items-center gap-1 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={step.destructive}
                      onChange={(event) => update(index, { destructive: event.target.checked })}
                      className="rounded border-gray-600 bg-gray-700 text-blue-500"
                    />
                    Destructive — warn in red (reboots, wipes, reloads)
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-400">
                    <input
                      type="checkbox"
                      checked={step.exitAll}
                      onChange={(event) => update(index, { exitAll: event.target.checked })}
                      className="rounded border-gray-600 bg-gray-700 text-blue-500"
                    />
                    Answering no also stops the script that called this one
                  </label>
                </>
              )}

              {step.type === 'exit' && (
                <label className="flex items-center gap-1 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={step.exitAll}
                    onChange={(event) => update(index, { exitAll: event.target.checked })}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500"
                  />
                  Also stop the script that called this one
                </label>
              )}

              {step.type === 'callMacro' && (
                <>
                  <SearchableSelect
                    value={step.targetMacroId}
                    onChange={(targetMacroId) => update(index, { targetMacroId })}
                    options={callableOptions}
                    placeholder="— choose a button —"
                    countNoun="buttons"
                    clearable
                  />
                  <ArgsEditor
                    args={step.args ?? {}}
                    onChange={(args) => update(index, { args })}
                  />
                </>
              )}

              {step.type === 'callSet' && (
                <>
                  <SearchableSelect
                    value={step.targetSetId}
                    onChange={(targetSetId) => update(index, { targetSetId })}
                    options={setOptions}
                    placeholder="— choose a button set —"
                    countNoun="sets"
                    clearable
                  />
                  <ArgsEditor
                    args={step.args ?? {}}
                    onChange={(args) => update(index, { args })}
                  />
                </>
              )}

              {step.type !== 'exit' && (
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={step.continueOnError}
                    onChange={(event) => update(index, { continueOnError: event.target.checked })}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500"
                  />
                  Keep going if this step fails
                </label>
              )}
            </div>
          </div>
        )
      })}

      {steps.length === 0 && (
        <p className="text-xs text-gray-600 italic px-1 py-2">
          Empty — add a block below to start the flow.
        </p>
      )}

      <div className="flex flex-wrap gap-1 pt-1">
        {PALETTE.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onChange([...steps, makeStep(type)])}
            title={BLOCKS[type].hint}
            className={clsx(
              'flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white hover:brightness-110 transition',
              BLOCKS[type].chip
            )}
          >
            <PlusIcon className="w-3 h-3" />
            {BLOCKS[type].label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Scratch-style flow editor: stacked blocks, nested branches, click to add. */
export default function ScriptBuilder(props: ScriptBuilderProps) {
  return <StepList {...props} depth={0} />
}
