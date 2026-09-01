import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  ClipboardDocumentIcon,
  ArrowRightCircleIcon,
  PlayIcon,
  SparklesIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import {
  defaultValues,
  fillTemplate,
  unresolvedPlaceholders,
  type TldrExample,
} from '@shared/tldr'
import { classifyCommand } from '@shared/tldr-detect'

/**
 * One tldr example, turned into a small command builder.
 *
 * This is the part that makes tldr more than a man page. Upstream writes
 *
 *     rsync {{path/to/source}} {{path/to/destination}}
 *
 * and every other client renders that literally, leaving the operator to retype
 * it with the braces removed. Here each `{{…}}` becomes a field, the filled
 * command is shown as it will actually be sent, and the template stays visible
 * beside it so it is clear what was substituted where.
 *
 * Fields are pre-filled from the token itself, because upstream tokens are real
 * examples — `{{eth0}}` is a working default. Tokens that merely *describe* a
 * value (`{{path/to/file}}`) are pre-filled too, but they hold Run back until
 * they have been edited: a command built from a description is not a command.
 */

export interface TldrExampleActions {
  copy: (command: string) => void
  insert: (command: string) => void
  run: (command: string, exampleDescription: string) => void
  askAi: (command: string, exampleDescription: string) => void
  /** False when there is no target session at all. */
  canInsert: boolean
  /** False when the target is gone or disconnected. */
  canRun: boolean
  /** Why Run is unavailable, when it is. */
  runBlockedReason: string | null
}

interface TldrExampleCardProps {
  example: TldrExample
  actions: TldrExampleActions
}

export default function TldrExampleCard({ example, actions }: TldrExampleCardProps) {
  const [values, setValues] = useState<Record<string, string>>(() => defaultValues(example))

  // A different page — or a different example at the same index — must not
  // inherit the previous one's answers.
  useEffect(() => {
    setValues(defaultValues(example))
  }, [example])

  const command = useMemo(() => fillTemplate(example.template, values), [example, values])
  const unresolved = useMemo(() => unresolvedPlaceholders(example, values), [example, values])
  const risk = useMemo(() => classifyCommand(command), [command])

  const substituted = command !== example.template
  const runnable = actions.canRun && unresolved.length === 0

  const runTitle = (() => {
    if (actions.runBlockedReason) return actions.runBlockedReason
    if (unresolved.length > 0) {
      return `Fill in ${unresolved.map((item) => item.label).join(', ')} first`
    }
    return risk.destructive ? 'Review this command before it is sent' : 'Send this to the session'
  })()

  return (
    <div className="rounded border border-gray-700 bg-gray-800/40 overflow-hidden">
      <p className="px-2 pt-2 pb-1.5 text-xs text-gray-300 leading-snug">{example.description}</p>

      {/* The template, kept visible. Losing sight of what upstream actually
          wrote makes it impossible to tell a substitution from a typo. */}
      <pre className="px-2 pb-1.5 text-[11px] font-mono text-gray-500 whitespace-pre-wrap break-all">
        {example.template}
      </pre>

      {example.placeholders.length > 0 && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-gray-700/60 pt-2">
          {example.placeholders.map((placeholder) => (
            <label key={placeholder.token} className="block">
              <span
                className={clsx(
                  'block text-[10px] uppercase tracking-wide mb-0.5',
                  unresolved.includes(placeholder) ? 'text-amber-500/90' : 'text-gray-500'
                )}
              >
                {placeholder.label}
                {unresolved.includes(placeholder) && ' — needs a real value'}
              </span>

              {placeholder.choices ? (
                <select
                  value={values[placeholder.token] ?? placeholder.defaultValue}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [placeholder.token]: event.target.value }))
                  }
                  className="w-full px-1.5 py-1 rounded bg-gray-900 border border-gray-600 text-[11px] font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {placeholder.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={values[placeholder.token] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [placeholder.token]: event.target.value }))
                  }
                  spellCheck={false}
                  className={clsx(
                    'w-full px-1.5 py-1 rounded bg-gray-900 border text-[11px] font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500',
                    unresolved.includes(placeholder) ? 'border-amber-700/70' : 'border-gray-600'
                  )}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {substituted && (
        <div className="px-2 pb-1.5">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
            Generated command
          </span>
          <pre className="px-2 py-1.5 rounded bg-gray-950 text-[11px] font-mono text-cyan-200 whitespace-pre-wrap break-all">
            {command}
          </pre>
        </div>
      )}

      {risk.destructive && (
        <p className="flex items-start gap-1.5 px-2 pb-1.5 text-[10px] text-amber-400">
          <ExclamationTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>This {risk.reasons.join(', and ')}.</span>
        </p>
      )}

      <div className="flex flex-wrap gap-1 px-1 py-1 bg-gray-800 border-t border-gray-700">
        <button
          onClick={() => actions.copy(command)}
          title="Copy the generated command"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700"
        >
          <ClipboardDocumentIcon className="w-3 h-3" />
          Copy
        </button>

        <button
          onClick={() => actions.insert(command)}
          disabled={!actions.canInsert}
          // The safe default, and the one to reach for: it puts the command on
          // the command line and stops, so it can be read, edited and submitted
          // by the person whose session it is.
          title="Put this on the terminal's command line without running it"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ArrowRightCircleIcon className="w-3 h-3" />
          Insert
        </button>

        <button
          onClick={() => actions.run(command, example.description)}
          disabled={!runnable}
          title={runTitle}
          className={clsx(
            'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded disabled:opacity-40 disabled:hover:bg-transparent',
            risk.destructive
              ? 'text-amber-300 hover:text-amber-100 hover:bg-amber-900/40'
              : 'text-gray-400 hover:text-gray-100 hover:bg-gray-700'
          )}
        >
          <PlayIcon className="w-3 h-3" />
          {risk.destructive ? 'Review & Run' : 'Run'}
        </button>

        <button
          onClick={() => actions.askAi(command, example.description)}
          title="Ask the assistant to explain this command"
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700"
        >
          <SparklesIcon className="w-3 h-3" />
          Ask AI
        </button>
      </div>
    </div>
  )
}
