import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDERS,
  type AiProvider,
  type AiSettings,
} from '@shared/ai'

interface AssistantSettingsProps {
  onClose: () => void
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
}

const PROVIDER_NOTE: Record<AiProvider, string> = {
  anthropic: 'Uses the official Anthropic SDK. Requires an API key.',
  openai: 'Any OpenAI-compatible chat completions endpoint. Requires an API key.',
  ollama: 'Runs entirely on this machine — nothing leaves it, and no key is needed.',
}

export default function AssistantSettings({ onClose }: AssistantSettingsProps) {
  const loadAiSettings = useStore((state) => state.loadAiSettings)
  const saveAiSettings = useStore((state) => state.saveAiSettings)
  const setAiKey = useStore((state) => state.setAiKey)
  const aiKeyStatus = useStore((state) => state.aiKeyStatus)

  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [keyInput, setKeyInput] = useState('')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      setSettings(await loadAiSettings())
      setKeys(await aiKeyStatus())
    })()
  }, [loadAiSettings, aiKeyStatus])

  const update = async (patch: Partial<AiSettings>) => {
    const saved = await saveAiSettings(patch)
    setSettings(saved)
    return saved
  }

  const changeProvider = async (provider: AiProvider) => {
    // Model and base URL are provider-specific; reset them together so the
    // combination is never a Claude model pointed at an Ollama endpoint.
    await update({
      provider,
      model: AI_DEFAULT_MODEL[provider],
      baseUrl: AI_DEFAULT_BASE_URL[provider],
    })
    setKeyInput('')
  }

  const saveKey = async () => {
    if (!settings) return
    setBusy(true)
    try {
      await setAiKey(settings.provider, keyInput)
      setKeys(await aiKeyStatus())
      setKeyInput('')
      setStatus(keyInput ? 'Key saved to the OS-encrypted vault' : 'Key removed')
    } finally {
      setBusy(false)
      window.setTimeout(() => setStatus(null), 4000)
    }
  }

  const scanOllama = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const response = await window.electronAPI.invoke<{ models: string[] }>('ai:list-models')
      if (response.success) {
        setOllamaModels(response.data?.models ?? [])
        setStatus(`${response.data?.models.length ?? 0} local model(s) found`)
      } else {
        setStatus(response.error ?? 'Could not reach Ollama')
      }
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
  const labelClass = 'block text-xs font-medium text-gray-300 mb-1'

  if (!settings) return null

  return (
    <div className="fixed inset-0 z-[62] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">Assistant</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <div>
            <label className={labelClass}>Provider</label>
            <div className="flex rounded overflow-hidden border border-gray-600">
              {AI_PROVIDERS.map((provider) => (
                <button
                  key={provider}
                  onClick={() => void changeProvider(provider)}
                  className={clsx(
                    'flex-1 px-2 py-1.5 text-xs transition-colors',
                    settings.provider === provider
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  )}
                >
                  {PROVIDER_LABEL[provider]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-gray-500">{PROVIDER_NOTE[settings.provider]}</p>
          </div>

          <div>
            <label className={labelClass}>Model</label>
            <input
              list="ai-models"
              value={settings.model}
              onChange={(event) => void update({ model: event.target.value })}
              className={inputClass}
            />
            <datalist id="ai-models">
              {(settings.provider === 'ollama' && ollamaModels.length > 0
                ? ollamaModels
                : AI_MODEL_SUGGESTIONS[settings.provider]
              ).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {settings.provider === 'ollama' && (
              <button
                onClick={scanOllama}
                disabled={busy}
                className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200"
              >
                <ArrowPathIcon className={clsx('w-3 h-3', busy && 'animate-spin')} />
                List installed models
              </button>
            )}
          </div>

          <div>
            <label className={labelClass}>
              Endpoint <span className="text-gray-500">(blank uses the default)</span>
            </label>
            <input
              value={settings.baseUrl}
              onChange={(event) => void update({ baseUrl: event.target.value })}
              placeholder={AI_DEFAULT_BASE_URL[settings.provider] || 'https://api.anthropic.com'}
              className={`${inputClass} font-mono text-xs`}
            />
          </div>

          {settings.provider !== 'ollama' && (
            <div>
              <label className={labelClass}>
                API key{' '}
                {keys[settings.provider] && (
                  <span className="text-green-400">— a key is saved</span>
                )}
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  placeholder={keys[settings.provider] ? 'Enter a new key to replace' : 'sk-…'}
                  className={inputClass}
                />
                <button
                  onClick={saveKey}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                Stored with your SSH credentials in the OS-encrypted vault — never in the database
                and never sent anywhere but the provider.
              </p>
            </div>
          )}

          <div className="border-t border-gray-700 pt-3 space-y-3">
            <p className="text-xs font-medium text-gray-300">What the assistant may see</p>

            <div>
              <label className={labelClass}>
                Terminal output shared: {settings.contextLines} lines
              </label>
              <input
                type="range"
                min={0}
                max={1000}
                step={50}
                value={settings.contextLines}
                onChange={(event) => void update({ contextLines: Number(event.target.value) })}
                className="w-full"
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Set to 0 to send no terminal output at all — useful on sensitive networks.
              </p>
            </div>

            <label className="flex items-start gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={settings.redactSecrets}
                onChange={(event) => void update({ redactSecrets: event.target.checked })}
                className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <span>
                Redact secrets before sending
                <span className="block text-[11px] text-gray-500">
                  Strips private keys, tokens, and password-like strings from the output.
                  Best-effort — turn the context down to 0 if the material is truly sensitive.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={settings.includeCommandHistory}
                onChange={(event) => void update({ includeCommandHistory: event.target.checked })}
                className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <span>
                Send commands that already worked on this host
                <span className="block text-[11px] text-gray-500">
                  The strongest signal for which platform this is — better grounding than the
                  model&apos;s general knowledge.
                </span>
              </span>
            </label>

            {settings.provider === 'anthropic' && (
              <label className="flex items-start gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={settings.refusalFallback}
                  onChange={(event) => void update({ refusalFallback: event.target.checked })}
                  className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
                />
                <span>
                  Retry refusals on a fallback model
                  <span className="block text-[11px] text-gray-500">
                    Networking and SSH content sits near the safety classifiers&apos; cyber
                    category, so a legitimate question is occasionally declined. This retries it
                    server-side instead of failing.
                  </span>
                </span>
              </label>
            )}
          </div>

          {status && <p className="text-xs text-green-400">{status}</p>}
        </div>

        <div className="flex justify-end px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
