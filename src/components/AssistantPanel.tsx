import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  PaperAirplaneIcon,
  StopIcon,
  TrashIcon,
  EyeIcon,
  LightBulbIcon,
  ClipboardDocumentIcon,
  PlayIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDERS,
  type AiChatMessage,
  type AiContextReport,
  type AiProvider,
  type AiSettings,
} from '@shared/ai'

/** Short enough for the panel header, which is only as wide as the side panel. */
const PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * Splits an answer into prose and fenced code blocks so commands can carry
 * copy / send actions instead of being retyped by hand.
 */
function segments(text: string): Array<{ type: 'text' | 'code'; body: string }> {
  const parts: Array<{ type: 'text' | 'code'; body: string }> = []
  const fence = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g

  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(text))) {
    if (match.index > cursor) {
      parts.push({ type: 'text', body: text.slice(cursor, match.index) })
    }
    parts.push({ type: 'code', body: match[1].replace(/\n$/, '') })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push({ type: 'text', body: text.slice(cursor) })

  return parts.filter((part) => part.body.trim().length > 0)
}

/**
 * "Thinking…" with a clock on it.
 *
 * A local model has to read the whole terminal context before it emits a single
 * token — measured at roughly 30 tokens/second on a CPU-only host, so a normal
 * 200-line question is minutes of silence. Without the elapsed count that is
 * indistinguishable from a hang.
 */
function Thinking({ local }: { local: boolean }) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <p className="text-xs text-gray-500 italic">
      Thinking… {seconds}s
      {local && seconds > 15 && (
        <span className="not-italic text-gray-600">
          {' '}
          — a local model reads the whole context before it answers.
        </span>
      )}
    </p>
  )
}

/**
 * One line saying what the answer was actually based on.
 *
 * Worth the space: a model that was handed no terminal output does not reliably
 * say so — it either claims it cannot see a terminal (which reads as the app
 * being broken) or invents a screen. This makes the difference visible without
 * having to trust the answer.
 */
function ContextBadge({ context }: { context: AiContextReport }) {
  if (!context.grounded) {
    return (
      <p className="text-[10px] text-amber-500/80 mb-1">
        No terminal output was attached — the answer is from general knowledge only.
      </p>
    )
  }

  const kb = context.chars >= 1024 ? `${Math.round(context.chars / 1024)} KB` : `${context.chars} B`

  return (
    <p className="text-[10px] text-gray-600 mb-1">
      Saw {context.lines} lines ({kb})
      {context.commands > 0 && ` · ${context.commands} past commands`}
      {context.buttons > 0 && ` · ${context.buttons} buttons`}
      {context.truncated && (
        <span className="text-amber-500/80"> · trimmed to fit the model window</span>
      )}
    </p>
  )
}

interface AssistantPanelProps {
  onOpenSettings: () => void
  /** The settings dialog renders beside this panel rather than replacing it,
   *  so the header has to re-read its config when the dialog closes. */
  settingsOpen: boolean
}

export default function AssistantPanel({ onOpenSettings, settingsOpen }: AssistantPanelProps) {
  const activeSessionId = useStore((state) => state.activeSessionId)
  const sessions = useStore((state) => state.sessions)
  const sendToSession = useStore((state) => state.sendToSession)
  const askAssistant = useStore((state) => state.askAssistant)
  const cancelAssistant = useStore((state) => state.cancelAssistant)
  const loadAiSettings = useStore((state) => state.loadAiSettings)
  const aiKeyStatus = useStore((state) => state.aiKeyStatus)

  // The conversation lives in the store so switching to the buttons tab (which
  // unmounts this panel) no longer throws it away. Provider config stays local:
  // it is re-read on mount and costs nothing to rebuild.
  const turns = useStore((state) => state.assistantTurns)
  const setTurns = useStore((state) => state.setAssistantTurns)
  const input = useStore((state) => state.assistantInput)
  const setInput = useStore((state) => state.setAssistantInput)
  const activeRequest = useStore((state) => state.assistantRequestId)
  const setActiveRequest = useStore((state) => state.setAssistantRequestId)

  const saveAiSettings = useStore((state) => state.saveAiSettings)

  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [keyMissing, setKeyMissing] = useState(false)
  /** Models installed in Ollama, so the picker offers what is actually there. */
  const [localModels, setLocalModels] = useState<string[]>([])
  const [ollamaError, setOllamaError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)

  /**
   * Ollama needs no key but does need to be running, and an unreachable daemon
   * otherwise only shows up as a failed request after the question is typed.
   */
  const probeOllama = async () => {
    const response = await window.electronAPI.invoke<{ models: string[] }>('ai:list-models')
    if (response.success) {
      setLocalModels(response.data?.models ?? [])
      setOllamaError(
        (response.data?.models ?? []).length === 0
          ? 'Ollama is running but has no models installed (try `ollama pull llama3.1`).'
          : null
      )
    } else {
      setLocalModels([])
      setOllamaError(response.error ?? 'Could not reach Ollama on this machine.')
    }
  }

  const refreshConfig = async (loadedSettings?: AiSettings) => {
    try {
      const loaded = loadedSettings ?? (await loadAiSettings())
      setSettings(loaded)
      if (loaded.provider === 'ollama') {
        setKeyMissing(false)
        await probeOllama()
      } else {
        setOllamaError(null)
        const status = await aiKeyStatus()
        setKeyMissing(!status[loaded.provider])
      }
    } catch {
      setSettings(null)
    }
  }

  useEffect(() => {
    if (settingsOpen) return
    void refreshConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  /**
   * Switching provider resets model and endpoint together — the combination is
   * never valid across providers, and leaving a Claude model pointed at the
   * Ollama endpoint is a confusing way to fail.
   */
  const changeProvider = async (provider: AiProvider) => {
    const saved = await saveAiSettings({
      provider,
      model: AI_DEFAULT_MODEL[provider],
      baseUrl: AI_DEFAULT_BASE_URL[provider],
    })
    await refreshConfig(saved)
  }

  const changeModel = async (model: string) => {
    setSettings(await saveAiSettings({ model }))
  }

  const modelOptions = useMemo(() => {
    if (!settings) return []
    const base =
      settings.provider === 'ollama' && localModels.length > 0
        ? localModels
        : AI_MODEL_SUGGESTIONS[settings.provider]
    // The user may have typed something custom in the settings dialog; keep it
    // selectable rather than silently switching them to a suggestion.
    return base.includes(settings.model) ? base : [settings.model, ...base]
  }, [settings, localModels])

  // Deltas are folded into the conversation by the app-level 'ai-stream'
  // listener in App.tsx, so a reply keeps arriving while this panel is
  // unmounted. Re-mounting just reads the result out of the store.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns])

  const send = async (prompt: string, mode: 'ask' | 'explain' | 'suggest' = 'ask') => {
    const text = prompt.trim()
    if (!text || activeRequest) return

    const requestId = uid()
    const history: AiChatMessage[] = [
      ...turns.filter((turn) => !turn.error).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ]

    setTurns((current) => [
      ...current,
      { role: 'user', content: text },
      { role: 'assistant', content: '', streaming: true },
    ])
    setInput('')
    setActiveRequest(requestId)

    try {
      await askAssistant({
        requestId,
        messages: history,
        sessionId: activeSessionId ?? undefined,
        mode,
      })
    } catch (error) {
      setTurns((current) => {
        const next = [...current]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            streaming: false,
            error: error instanceof Error ? error.message : 'Request failed',
          }
        }
        return next
      })
      setActiveRequest(null)
    }
  }

  const canSend = Boolean(settings) && !keyMissing && !activeRequest

  const selectClass =
    'min-w-0 rounded bg-gray-800 border border-gray-600 text-[11px] text-gray-200 px-1 py-0.5 ' +
    'focus:outline-none focus:ring-1 focus:ring-blue-500 hover:border-gray-500'

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700">
        {/* Provider and model switch here rather than only in the settings
            dialog: trying a question against a local model and then against
            Claude is a normal thing to do mid-conversation. */}
        <select
          value={settings?.provider ?? 'anthropic'}
          onChange={(event) => void changeProvider(event.target.value as AiProvider)}
          disabled={!settings || Boolean(activeRequest)}
          title="AI provider"
          className={`${selectClass} shrink-0 disabled:opacity-50`}
        >
          {AI_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {PROVIDER_LABEL[provider]}
            </option>
          ))}
        </select>

        <select
          value={settings?.model ?? ''}
          onChange={(event) => void changeModel(event.target.value)}
          disabled={!settings || Boolean(activeRequest)}
          title={settings ? `Model: ${settings.model}` : 'Model'}
          className={`${selectClass} flex-1 disabled:opacity-50`}
        >
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>

        <button
          onClick={onOpenSettings}
          title="Assistant settings"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
        >
          <Cog6ToothIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => setTurns([])}
          disabled={turns.length === 0}
          title="Clear conversation"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 disabled:opacity-30"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {keyMissing && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-950/40 border-b border-amber-900 text-[11px] text-amber-200">
          <ExclamationTriangleIcon className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            No API key saved for {settings?.provider}.{' '}
            <button onClick={onOpenSettings} className="underline hover:text-amber-100">
              Add one
            </button>{' '}
            — or switch to Ollama to run locally.
          </span>
        </div>
      )}

      {ollamaError && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-950/40 border-b border-amber-900 text-[11px] text-amber-200">
          <ExclamationTriangleIcon className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {ollamaError}{' '}
            <button onClick={() => void probeOllama()} className="underline hover:text-amber-100">
              Retry
            </button>
          </span>
        </div>
      )}

      <div className="flex gap-1 px-2 py-1.5 border-b border-gray-700">
        <button
          onClick={() => send('What is happening in this terminal right now?', 'explain')}
          disabled={!canSend || !activeSessionId}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
        >
          <EyeIcon className="w-3.5 h-3.5" />
          What&apos;s happening?
        </button>
        <button
          onClick={() => send('What should I check next?', 'suggest')}
          disabled={!canSend || !activeSessionId}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
        >
          <LightBulbIcon className="w-3.5 h-3.5" />
          Suggest next step
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-3">
        {turns.length === 0 && (
          <div className="text-[11px] text-gray-500 space-y-2 px-1 py-3">
            <p>
              Ask about the connection in focus
              {activeSession ? ` (${activeSession.profileName})` : ''}. The assistant sees this
              connection&apos;s recent output, the commands that have already worked on it, and
              your button sets.
            </p>
            <p className="text-gray-600">
              It never runs anything — it proposes commands you choose to send.
            </p>
          </div>
        )}

        {turns.map((turn, index) => (
          <div key={index} className={clsx(turn.role === 'user' ? 'pl-4' : '')}>
            <div className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
              {turn.role === 'user' ? 'You' : 'Assistant'}
            </div>

            {turn.role === 'user' ? (
              <div className="text-xs text-gray-300 whitespace-pre-wrap rounded bg-gray-700/40 px-2 py-1.5">
                {turn.content}
              </div>
            ) : (
              <div className="space-y-2">
                {turn.context && <ContextBadge context={turn.context} />}
                {segments(turn.content).map((segment, i) =>
                  segment.type === 'code' ? (
                    <div key={i} className="rounded border border-gray-600 overflow-hidden">
                      <pre className="px-2 py-1.5 text-[11px] font-mono text-cyan-200 bg-gray-950 overflow-x-auto whitespace-pre">
                        {segment.body}
                      </pre>
                      <div className="flex gap-1 px-1 py-1 bg-gray-800 border-t border-gray-700">
                        <button
                          onClick={() => void navigator.clipboard.writeText(segment.body)}
                          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700"
                        >
                          <ClipboardDocumentIcon className="w-3 h-3" />
                          Copy
                        </button>
                        <button
                          onClick={() =>
                            activeSessionId && sendToSession(activeSessionId, segment.body)
                          }
                          disabled={!activeSessionId}
                          title="Type into the focused terminal without pressing Enter"
                          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 disabled:opacity-40"
                        >
                          <PlayIcon className="w-3 h-3" />
                          Insert
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      key={i}
                      className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed"
                    >
                      {segment.body.trim()}
                    </p>
                  )
                )}

                {turn.streaming && turn.content.length === 0 && (
                  <Thinking local={settings?.provider === 'ollama'} />
                )}
                {turn.error && <p className="text-xs text-red-400">{turn.error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-gray-700">
        <div className="flex gap-1">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(input)
              }
            }}
            placeholder={
              activeSessionId
                ? 'Ask about this box… (Enter to send, Shift+Enter for a new line)'
                : 'Connect a session to ground answers, or ask anyway…'
            }
            rows={2}
            className="flex-1 px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {activeRequest ? (
            <button
              onClick={() => void cancelAssistant(activeRequest)}
              title="Stop"
              className="px-2 rounded bg-red-700 text-white hover:bg-red-600"
            >
              <StopIcon className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => void send(input)}
              disabled={!canSend || !input.trim()}
              title="Send"
              className="px-2 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
            >
              <PaperAirplaneIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
