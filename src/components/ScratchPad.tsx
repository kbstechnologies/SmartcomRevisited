import { useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  ArrowPathIcon,
  ArrowRightCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ClipboardIcon,
  PaperAirplaneIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import { analysePrestage, type PrestageSource } from '@shared/prestage'
import { interpolate } from '@shared/types'
import PrestageVarsDialog from './PrestageVarsDialog'

/**
 * The scratch pad: somewhere to stage text before it goes to a terminal.
 *
 * Not a notepad. There is no file, no name, no save, and nothing survives
 * closing Smartcom — the text lives in the store and only in the store. That is
 * the whole design: the thing you most often want to park while working on a
 * live box is a config fragment, a key fingerprint, or a password, and a
 * notepad that quietly wrote one to disk would be a worse feature than no
 * notepad at all. So the panel says so, on screen, rather than leaving it to be
 * assumed either way.
 *
 * It is in the store rather than in this component's own state because the side
 * panel unmounts every time you switch tabs, which would otherwise throw away
 * what you parked a second ago.
 *
 * ## Staging
 *
 * The pad resolves `{{NAME}}` the same way a button does — globals first, then
 * the built-ins — and adds one thing buttons do not have: a name it does not
 * recognise becomes a **question**, asked once, at the moment an action is
 * pressed. That is what makes this worth using for the copy-it-out, change
 * three values, put-it-back job that otherwise goes through a text editor and
 * loses the globals on the way.
 *
 * Three ways out, and the difference between them is the whole safety story:
 *
 *  - **Copy** — the resolved text on the clipboard. Touches no session.
 *  - **Insert** — onto the command line and left there, through the same
 *    `insertSuggestion` the assistant uses. It strips a trailing newline and
 *    refuses multi-line text on a remote that cannot tell a paste from typing,
 *    so it cannot run anything.
 *  - **Send** — an actual paste, which is what a multi-line config block needs
 *    and which *will* run a line that ends in a newline. The same thing as
 *    pressing Ctrl+V in the terminal, so it is no new capability — but it is
 *    the one button here that makes something happen, and it is separated and
 *    coloured as such rather than sitting flush with the other two.
 *
 * Every action works on the selection when there is one, exactly as Copy
 * already did: staging a long block and sending three lines of it is the
 * common case, not an edge case.
 */

/** How each kind of variable reads in the strip. Colour carries the meaning. */
const SOURCE_STYLE: Record<PrestageSource, { className: string; title: string }> = {
  global: { className: 'text-blue-300', title: 'From your global variables file' },
  builtin: { className: 'text-purple-300', title: 'Built in — computed, not stored' },
  ask: { className: 'text-amber-300', title: 'Not defined anywhere — the pad will ask for it' },
}

/** Which button was pressed, so the dialog can carry on afterwards. */
type PrestageAction = 'copy' | 'insert' | 'send'

const ACTION_LABEL: Record<PrestageAction, string> = {
  copy: 'Copy',
  insert: 'Insert',
  send: 'Send',
}

export default function ScratchPad() {
  const text = useStore((state) => state.scratchpad)
  const setText = useStore((state) => state.setScratchpad)
  const answers = useStore((state) => state.prestageAnswers)
  const builtins = useStore((state) => state.prestageBuiltins)
  const setAnswer = useStore((state) => state.setPrestageAnswer)
  const clearPrestage = useStore((state) => state.clearPrestage)
  const rerollBuiltins = useStore((state) => state.rerollPrestageBuiltins)

  const globalVars = useStore((state) => state.globalVars)
  const profiles = useStore((state) => state.profiles)
  const sessions = useStore((state) => state.sessions)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const insertSuggestion = useStore((state) => state.insertSuggestion)
  const pasteToSession = useStore((state) => state.pasteToSession)

  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showVars, setShowVars] = useState(true)
  /**
   * The action waiting on the ad-hoc dialog: what it will act on, and the
   * names it opened asking for.
   *
   * `names` is captured here rather than recomputed while the dialog is up,
   * and that is not a detail. Deriving it live meant a field removed itself
   * the instant the first character was typed into it — the name stopped being
   * unanswered, so it stopped being in the list. Found by using it.
   */
  const [pending, setPending] = useState<{
    action: PrestageAction
    payload: string
    names: string[]
  } | null>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  /** `NAME` -> value, from the globals file as the main process last read it. */
  const globals = useMemo(() => {
    const values: Record<string, string> = {}
    for (const entry of globalVars.vars) values[entry.name] = entry.value
    return values
  }, [globalVars.vars])

  /**
   * The built-in set, with the session-derived three merged in live.
   *
   * The stored snapshot deliberately holds only the time and random values —
   * those must not move under the operator's feet between the preview and the
   * paste. `SESSION_*` is the opposite: it means "the terminal in front of me",
   * so it follows the tab.
   *
   * Host and username come from the connection rather than the session, which
   * carries neither, and are interpolated in case the connection itself uses
   * globals. `interpolate` and not `resolveProfileVars` on purpose — a preview
   * showing `{{TYPO}}` is more use than one that throws.
   */
  const inputs = useMemo(() => {
    const profile = activeSession
      ? (profiles.find((entry) => entry.id === activeSession.profileId) ?? null)
      : null

    const session: Record<string, string> = {}
    if (profile?.host) session.SESSION_HOST = interpolate(profile.host, globals)
    if (profile?.username) session.SESSION_USER = interpolate(profile.username, globals)
    if (activeSession) session.SESSION_NAME = activeSession.profileName

    return { globals, builtins: { ...builtins, ...session }, answers }
  }, [globals, builtins, answers, activeSession, profiles])

  /** What the strip shows: every name the whole pad refers to. */
  const analysis = useMemo(() => analysePrestage(text, inputs), [text, inputs])

  const usesBuiltins = analysis.vars.some((entry) => entry.source === 'builtin')

  /** Fades on its own so the footer does not accumulate stale confirmations. */
  const say = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4000)
  }

  /** The selection if there is one, otherwise everything. */
  const payloadText = (): string => {
    const area = areaRef.current
    if (area && area.selectionStart !== area.selectionEnd) {
      return text.slice(area.selectionStart, area.selectionEnd)
    }
    return text
  }

  /**
   * Writes to the clipboard through the main process, as everywhere else in
   * the app: the sandboxed renderer does not reliably get permission for the
   * async clipboard API.
   */
  const writeClipboard = async (payload: string) => {
    if (!payload) return
    await window.electronAPI.invoke('clipboard:write', { text: payload })
  }

  /** Appends the clipboard at the cursor, so pasting twice keeps both. */
  const paste = async () => {
    const response = await window.electronAPI.invoke<{ text: string }>('clipboard:read')
    const clipboard = response.success ? (response.data?.text ?? '') : ''
    if (!clipboard) {
      say('Nothing on the clipboard.')
      return
    }

    const area = areaRef.current
    const start = area?.selectionStart ?? text.length
    const end = area?.selectionEnd ?? text.length
    const next = text.slice(0, start) + clipboard + text.slice(end)
    setText(next)

    // Put the cursor after what was just pasted, so a second paste follows it
    // rather than replacing it.
    window.requestAnimationFrame(() => {
      const caret = start + clipboard.length
      area?.focus()
      area?.setSelectionRange(caret, caret)
    })
  }

  /** Carries out an action on text whose variables are all answered. */
  const perform = async (action: PrestageAction, payload: string) => {
    const resolved = interpolate(payload, analysePrestage(payload, inputs).values)
    const filled = payload !== resolved
    const whole = payload === text

    if (action === 'copy') {
      await writeClipboard(resolved)
      say(
        `Copied ${whole ? 'everything' : 'the selection'}${filled ? ', variables filled in' : ''}.`
      )
      return
    }

    if (!activeSessionId) {
      say('No terminal in front to send it to.')
      return
    }

    if (action === 'insert') {
      const result = await insertSuggestion(activeSessionId, resolved)
      say(
        result.inserted
          ? 'Put on the command line — not run. Press Enter yourself.'
          : (result.reason ?? 'Could not insert that.')
      )
      return
    }

    const sent = await pasteToSession(activeSessionId, resolved)
    say(
      sent
        ? `Sent to ${activeSession?.profileName ?? 'the terminal'}.`
        : 'Session is not connected.'
    )
  }

  /**
   * The entry point for all three buttons: ask for anything undefined first.
   *
   * The check is against the *payload*, not the whole pad, so selecting three
   * lines does not prompt for a name that only appears in the part left behind.
   */
  const run = (action: PrestageAction) => {
    const payload = payloadText()
    if (payload.trim() === '') {
      say('Nothing staged.')
      return
    }

    const { unanswered } = analysePrestage(payload, inputs)
    if (unanswered.length > 0) {
      setPending({ action, payload, names: unanswered })
      return
    }

    void perform(action, payload)
  }

  const lines = text ? text.split('\n').length : 0
  const needing = analysis.unanswered.length

  const iconButton =
    'p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent'

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700">
        <span className="text-sm text-gray-300 flex-1">Scratch pad</span>

        <button
          onClick={() => void writeClipboard(payloadText())}
          disabled={!text}
          title="Copy as typed, without filling in variables"
          className={iconButton}
        >
          <ClipboardDocumentIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => void paste()}
          title="Paste the clipboard in at the cursor"
          className={iconButton}
        >
          <ClipboardIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            clearPrestage()
            areaRef.current?.focus()
          }}
          disabled={!text && Object.keys(answers).length === 0}
          title="Clear the pad, and the values you were asked for"
          className="p-1 rounded text-gray-500 hover:text-red-300 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      <textarea
        ref={areaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        placeholder={
          'Stage text here before it goes to a terminal.\n\n' +
          'Paste something in, change what needs changing, then Insert or Send it.\n\n' +
          'Use {{NAME}} for a global variable — anything the pad does not recognise, it asks you for.'
        }
        className="flex-1 min-h-0 w-full resize-none bg-gray-900 px-2 py-2 font-mono text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-0"
      />

      {/* The variables strip. Absent entirely when nothing is referenced, so
          the pad stays a plain text box for the times it is only a text box. */}
      {analysis.vars.length > 0 && (
        <div className="border-t border-gray-700 shrink-0">
          <div className="flex items-center gap-1 px-2 py-1">
            <button
              onClick={() => setShowVars((open) => !open)}
              className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-200"
            >
              {showVars ? (
                <ChevronDownIcon className="w-3 h-3" />
              ) : (
                <ChevronRightIcon className="w-3 h-3" />
              )}
              {analysis.vars.length} {analysis.vars.length === 1 ? 'variable' : 'variables'}
              {needing > 0 && <span className="text-amber-300">{` · ${needing} to fill in`}</span>}
            </button>

            <div className="flex-1" />

            {usesBuiltins && (
              <button
                onClick={rerollBuiltins}
                title="Re-roll the built-ins — a fresh timestamp and new random values"
                className={iconButton}
              >
                <ArrowPathIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {showVars && (
            <div className="max-h-32 overflow-y-auto px-2 pb-1.5 space-y-0.5">
              {analysis.vars.map((entry) => (
                <div key={entry.name} className="flex items-center gap-2 text-[10px]">
                  <span
                    title={SOURCE_STYLE[entry.source].title}
                    className={clsx(
                      'font-mono shrink-0 max-w-[45%] truncate',
                      SOURCE_STYLE[entry.source].className
                    )}
                  >
                    {entry.name}
                  </span>

                  {entry.source === 'ask' ? (
                    <input
                      type="text"
                      spellCheck={false}
                      value={answers[entry.name] ?? ''}
                      placeholder="value"
                      onChange={(event) => setAnswer(entry.name, event.target.value)}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 font-mono text-[10px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                    />
                  ) : (
                    <span
                      title={entry.value}
                      className="flex-1 min-w-0 truncate text-right font-mono text-gray-400"
                    >
                      {entry.value === '' ? '—' : entry.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions. Copy touches nothing; Insert cannot run anything; Send can,
          and is separated and coloured for that reason alone. */}
      {text !== '' && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-gray-700">
          <button
            onClick={() => run('copy')}
            title="Copy with variables filled in — the selection if there is one"
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-gray-700 text-gray-200 hover:bg-gray-600"
          >
            <ClipboardDocumentIcon className="w-3.5 h-3.5" />
            Copy
          </button>
          <button
            onClick={() => run('insert')}
            disabled={!activeSessionId}
            title={
              activeSessionId
                ? 'Put it on the command line without running it'
                : 'No terminal in front'
            }
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            <ArrowRightCircleIcon className="w-3.5 h-3.5" />
            Insert
          </button>

          <div className="flex-1" />

          <button
            onClick={() => run('send')}
            disabled={!activeSessionId}
            title={
              activeSessionId
                ? `Paste it into ${activeSession?.profileName ?? 'the terminal'} — a line ending in a newline will run`
                : 'No terminal in front'
            }
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-amber-600/60 text-amber-300 hover:bg-amber-600/20 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PaperAirplaneIcon className="w-3.5 h-3.5" />
            Send
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 px-2 py-1 border-t border-gray-700 text-[10px] text-gray-600">
        {notice ? (
          <span className="text-blue-300 truncate" title={notice}>
            {notice}
          </span>
        ) : (
          // Said plainly and permanently, not in a tooltip: what someone parks
          // here decides whether they would have wanted it written to disk.
          <span className="truncate">Not saved — cleared when Smartcom closes.</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {lines} {lines === 1 ? 'line' : 'lines'} · {text.length}
        </span>
      </div>

      {pending && (
        <PrestageVarsDialog
          names={pending.names}
          answers={answers}
          actionLabel={ACTION_LABEL[pending.action]}
          onChange={setAnswer}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const { action, payload } = pending
            setPending(null)
            void perform(action, payload)
          }}
        />
      )}
    </div>
  )
}
