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
import type { AiChatMessage, AiSettings } from '@shared/ai'

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

export default function AssistantPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
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

  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [keyMissing, setKeyMissing] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const activeSession = sessions.find((session) => session.id === activeSessionId)

  const refreshConfig = async () => {
    try {
      const loaded = await loadAiSettings()
      setSettings(loaded)
      if (loaded.provider === 'ollama') {
        setKeyMissing(false)
      } else {
        const status = await aiKeyStatus()
        setKeyMissing(!status[loaded.provider])
      }
    } catch {
      setSettings(null)
    }
  }

  useEffect(() => {
    void refreshConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const providerLabel = useMemo(() => {
    if (!settings) return 'not configured'
    return `${settings.provider} · ${settings.model}`
  }, [settings])

  const canSend = Boolean(settings) && !keyMissing && !activeRequest

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-700">
        <span className="text-xs text-gray-400 truncate flex-1" title={providerLabel}>
          {providerLabel}
        </span>
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
                  <p className="text-xs text-gray-500 italic">Thinking…</p>
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
