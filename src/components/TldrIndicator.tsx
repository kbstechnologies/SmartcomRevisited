import { clsx } from 'clsx'
import { BookOpenIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import { useTldrDetection } from '../lib/useTldr'
import { buildTldrAiPrompt } from '@shared/tldr-ai'

/**
 * The contextual tldr and AI chips, above the terminal.
 *
 * Placement note: the mock-ups for this feature put these inside a command
 * input box. Smartcom has no command input box — a session is a raw pty and an
 * xterm, and every keystroke goes straight to the far end. The toolbar directly
 * above the panes is the closest thing to "beside what you are typing" that
 * this UI has, and it is already where the per-workspace controls live.
 *
 * The two chips are deliberately different shapes of help:
 *
 *     TLDR   command → documentation, examples, a builder
 *     AI     command → explanation, reasoning, risks
 *
 * Neither ever acts on its own. TLDR opens a panel; AI writes a question into
 * the assistant.
 */

interface TldrIndicatorProps {
  /** The pane this window is showing. Null when there is no session. */
  sessionId: string | null
}

export default function TldrIndicator({ sessionId }: TldrIndicatorProps) {
  const sessions = useStore((store) => store.sessions)
  const profiles = useStore((store) => store.profiles)
  const enabled = useStore((store) => store.settings.tldrEnabled !== false)
  const status = useStore((store) => store.tldrStatus)
  const openTldr = useStore((store) => store.openTldr)
  const setTldrSearchOpen = useStore((store) => store.setTldrSearchOpen)
  const askAiAbout = useStore((store) => store.askAiAbout)

  const { detected, command, platform, state, sensitive } = useTldrDetection(sessionId)

  if (!enabled) return null

  const session = sessions.find((item) => item.id === sessionId)
  const profile = profiles.find((item) => item.id === session?.profileId)

  const openPage = () => {
    // Nothing detected, or nothing documented: the search box is the useful
    // answer rather than an empty panel.
    if (!command || state === 'missing') {
      setTldrSearchOpen(true)
      return
    }
    // Pinned to the pane the command was actually detected in, not to whatever
    // holds focus: on a multi-monitor setup those are not always the same.
    openTldr({ command, platform, sessionId })
  }

  const askAi = () => {
    askAiAbout(
      buildTldrAiPrompt({
        command: detected.line || command,
        baseCommand: command,
        platform,
        sessionType: profile?.transport,
        targetName: session?.profileName,
      })
    )
  }

  const label = (() => {
    if (!status?.ready) return 'TLDR'
    if (sensitive) return 'TLDR'
    if (state === 'searching') return 'TLDR ✦'
    if (state === 'found') return `TLDR ✓ ${command}`
    if (state === 'missing') return `TLDR — ${command}`
    return 'TLDR'
  })()

  const title = (() => {
    if (!status) return 'tldr documentation is still starting up'
    if (!status.ready) {
      return status.error
        ? `tldr documentation unavailable: ${status.error}. The terminal is unaffected.`
        : 'tldr documentation has not been downloaded yet — Settings › tldr'
    }
    if (sensitive) return 'Paused: the session is asking for a password'
    if (state === 'found') return `Open the tldr page for ${command}`
    if (state === 'missing') return `No tldr page for ${command} — search instead`
    if (state === 'searching') return `Looking for ${command}…`
    return 'Search tldr commands (Ctrl+Shift+T)'
  })()

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={openPage}
        title={title}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors max-w-56',
          state === 'found' && status?.ready
            ? 'bg-blue-600/20 border-blue-500 text-blue-200 hover:bg-blue-600/30'
            : state === 'searching'
              ? 'bg-gray-700 border-blue-500/60 text-blue-300/90 animate-pulse'
              : 'bg-gray-700 border-gray-600 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
        )}
      >
        <BookOpenIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate font-mono">{label}</span>
      </button>

      <button
        onClick={askAi}
        disabled={!command}
        title={
          command
            ? `Ask the assistant about ${command}`
            : 'Type a command to ask the assistant about it'
        }
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border bg-gray-700 border-gray-600 text-gray-400 hover:bg-gray-600 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-gray-700"
      >
        <SparklesIcon className="w-3.5 h-3.5 shrink-0" />
        AI
      </button>
    </div>
  )
}
