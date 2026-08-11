import Anthropic from '@anthropic-ai/sdk'
import http from 'node:http'
import https from 'node:https'
import {
  AI_DEFAULT_BASE_URL,
  type AiChatMessage,
  type AiProvider,
  type AiSettings,
} from '../../src/shared/ai'

export interface ChatRequest {
  settings: AiSettings
  apiKey: string
  system: string
  messages: AiChatMessage[]
  signal: AbortSignal
  /** Called for each chunk of generated text. */
  onDelta: (text: string) => void
}

export interface ChatResult {
  /** Model that actually produced the answer (may differ after a fallback). */
  model: string
  /** Set when the provider declined rather than answered. */
  refused?: boolean
}

const baseUrlFor = (settings: AiSettings): string =>
  settings.baseUrl.trim() || AI_DEFAULT_BASE_URL[settings.provider]

// ---------------------------------------------------------------------------
// Anthropic — official SDK
// ---------------------------------------------------------------------------

/**
 * Claude via `@anthropic-ai/sdk`.
 *
 * Two model-specific rules are load-bearing here:
 *  - Claude Opus 5 rejects `temperature` / `top_p` / `top_k` outright, so no
 *    sampling parameters are sent for any Anthropic model.
 *  - Thinking is on by default and `max_tokens` caps thinking *plus* text.
 *    Rather than disabling thinking (which can make the model emit tool calls
 *    as plain prose), latency is controlled with a low effort level.
 */
async function chatAnthropic(request: ChatRequest): Promise<ChatResult> {
  const { settings, apiKey, system, messages, signal, onDelta } = request

  const client = new Anthropic({
    apiKey,
    ...(settings.baseUrl.trim() ? { baseURL: settings.baseUrl.trim() } : {}),
  })

  const params = {
    model: settings.model,
    // Streaming, so a generous ceiling costs nothing when answers are short.
    max_tokens: 8192,
    system,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    // `low` keeps the assistant responsive; it still reasons, just briefly.
    output_config: { effort: 'low' as const },
  }

  let served = settings.model
  let refused = false

  const handleStream = async (stream: {
    on: (event: 'text', handler: (delta: string) => void) => void
    finalMessage: () => Promise<{ model?: string; stop_reason?: string | null }>
  }) => {
    stream.on('text', (delta) => onDelta(delta))
    const message = await stream.finalMessage()
    served = message.model ?? served
    refused = message.stop_reason === 'refusal'
  }

  if (settings.refusalFallback) {
    // Server-side fallback: on a policy decline the API re-runs the request on
    // Anthropic's recommended substitute instead of returning a dead end.
    // Network and SSH content sits close to the cyber classifier, so a false
    // positive is a realistic failure mode for this app in particular.
    const stream = client.beta.messages.stream(
      {
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as never,
      { signal }
    )
    await handleStream(stream as never)
  } else {
    const stream = client.messages.stream(params, { signal })
    await handleStream(stream as never)
  }

  return { model: served, refused }
}

// ---------------------------------------------------------------------------
// Shared SSE reader for the HTTP providers
// ---------------------------------------------------------------------------

/** Yields decoded `data:` payloads from a Server-Sent Events body. */
async function* readServerSentEvents(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response had no body')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line; keep any partial tail.
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim()
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

async function assertOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  const detail = body.slice(0, 400) || response.statusText
  throw new Error(`${provider} request failed (${response.status}): ${detail}`)
}

// ---------------------------------------------------------------------------
// OpenAI — chat completions, SSE
// ---------------------------------------------------------------------------

async function chatOpenAi(request: ChatRequest): Promise<ChatResult> {
  const { settings, apiKey, system, messages, signal, onDelta } = request

  const response = await fetch(`${baseUrlFor(settings).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  })

  await assertOk(response, 'OpenAI')

  for await (const payload of readServerSentEvents(response, signal)) {
    if (payload === '[DONE]') break
    try {
      const parsed = JSON.parse(payload)
      const delta = parsed.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) onDelta(delta)
    } catch {
      // A partial or keep-alive frame; the next one will carry content.
    }
  }

  return { model: settings.model }
}

// ---------------------------------------------------------------------------
// Ollama — local, newline-delimited JSON
// ---------------------------------------------------------------------------

/**
 * Ollama defaults `num_ctx` to a couple of thousand tokens and silently drops
 * whatever does not fit, oldest first — which is the system prompt, and with
 * it the terminal output the question is about. Measured against llama3.1 with
 * a normal 200-line context: the default evaluated 50 of ~5900 prompt tokens
 * and the model answered that it could not see any terminal; sized to the
 * prompt it evaluated all 7718 and read the output correctly.
 *
 * So the window is sized to the request. Roughly 3.5 characters per token is
 * deliberately pessimistic for terminal output, which tokenises badly.
 */
export function ollamaContextWindow(system: string, messages: AiChatMessage[]): number {
  const chars = system.length + messages.reduce((total, m) => total + m.content.length, 0)
  const needed = Math.ceil(chars / CHARS_PER_TOKEN) + RESPONSE_HEADROOM_TOKENS
  const rounded = Math.ceil(needed / 1024) * 1024
  return Math.min(OLLAMA_MAX_CONTEXT, Math.max(OLLAMA_MIN_CONTEXT, rounded))
}

/**
 * Characters per token, used to size the window from the prompt.
 *
 * This has to be a *worst case*, not an average: under-estimating tokens sizes
 * `num_ctx` too small, and a prompt that does not fit is discarded whole. The
 * earlier value of 3.5 was an average for prose and was wrong for everything
 * this app actually sends. Measured against llama3.1:
 *
 *   prose          4.96 chars/token
 *   Cisco config   2.75
 *   journalctl     2.49
 *   hexdump        1.53   <- `cat` of a binary, base64 key material, packet dumps
 *
 * 1.5 covers the worst of those. Over-sizing costs KV cache memory, which is
 * cheap; under-sizing costs the entire system prompt, which is the bug.
 */
const CHARS_PER_TOKEN = 1.5
/** Room left for the answer on top of the prompt. */
const RESPONSE_HEADROOM_TOKENS = 1024
const OLLAMA_MIN_CONTEXT = 4096
/**
 * KV cache for llama3.1-8B runs about 128 KB per token, so 16k tokens is ~2 GB
 * — the point past which a laptop starts swapping. Prefill time is set by the
 * prompt's real length rather than by the window, so this bound is about memory
 * and the character budget below is what bounds the wait.
 */
const OLLAMA_MAX_CONTEXT = 16384

/**
 * How many characters of prompt a provider will actually read.
 *
 * Sizing `num_ctx` to the request is only half the fix — the window is capped,
 * and a prompt past the cap is discarded exactly as before. The transcript is
 * kept to 120,000 characters, well past any window here, so the caller must
 * trim to this budget rather than assume the window can be grown to fit.
 *
 * For Ollama this is also the wait: prefill measured about 30 tokens/second on
 * a CPU-only host, so ~23,000 characters of worst-case output is already a
 * couple of minutes before the first word appears. Cutting it further would
 * quietly answer from less of the screen than the operator asked for, so the
 * budget stays and the panel reports what was sent instead.
 *
 * Anthropic and OpenAI have windows far larger than anything this app sends and
 * error rather than truncating silently, so their budget only exists to keep a
 * runaway console from turning into an expensive request.
 */
export function promptBudgetChars(provider: AiProvider): number {
  if (provider === 'ollama') {
    return Math.floor((OLLAMA_MAX_CONTEXT - RESPONSE_HEADROOM_TOKENS) * CHARS_PER_TOKEN)
  }
  return 400_000
}

/**
 * Ollama goes over `node:http` rather than `fetch`, unlike the other providers.
 *
 * Ollama does not send response headers until generation actually starts, so
 * the whole prefill happens before a single byte comes back — and undici (the
 * fetch behind Node and Electron's main process) gives up after 300 seconds
 * with `HeadersTimeoutError`. On a CPU-only host prefill measured about 30
 * tokens/second, so an ordinary 200-line question crosses that line and the
 * request dies with "fetch failed" after five minutes of waiting. `node:http`
 * imposes no such deadline; cancellation is still the operator's Stop button.
 */
function ollamaChatStream(
  url: string,
  payload: string,
  signal: AbortSignal,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http

    const request = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0

        if (status < 200 || status >= 300) {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
          })
          response.on('end', () =>
            reject(
              new Error(
                `Ollama request failed (${status}): ${body.slice(0, 400) || response.statusMessage}`
              )
            )
          )
          return
        }

        // Ollama streams bare NDJSON rather than SSE, so it is read line by line.
        let buffer = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) onLine(line)
            newline = buffer.indexOf('\n')
          }
        })
        response.on('end', () => {
          if (buffer.trim()) onLine(buffer.trim())
          resolve()
        })
        response.on('error', reject)
      }
    )

    // Stop is an abort, and the caller treats it as a normal end of turn.
    const abort = () => request.destroy(new Error('aborted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })

    request.on('error', reject)
    request.end(payload)
  })
}

async function chatOllama(request: ChatRequest): Promise<ChatResult> {
  const { settings, system, messages, signal, onDelta } = request

  const payload = JSON.stringify({
    model: settings.model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...messages],
    options: { num_ctx: ollamaContextWindow(system, messages) },
  })

  let finished = false

  await ollamaChatStream(
    `${baseUrlFor(settings).replace(/\/$/, '')}/api/chat`,
    payload,
    signal,
    (line) => {
      if (finished) return
      try {
        const parsed = JSON.parse(line)
        const delta = parsed.message?.content
        if (typeof delta === 'string' && delta) onDelta(delta)
        if (parsed.done) finished = true
      } catch {
        /* partial or keep-alive line */
      }
    }
  )

  return { model: settings.model }
}

// ---------------------------------------------------------------------------

const HANDLERS: Record<AiProvider, (request: ChatRequest) => Promise<ChatResult>> = {
  anthropic: chatAnthropic,
  openai: chatOpenAi,
  ollama: chatOllama,
}

export function chat(request: ChatRequest): Promise<ChatResult> {
  return HANDLERS[request.settings.provider](request)
}

/** Lists locally installed models. Ollama only — the others are not enumerable without a key. */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${(baseUrl || AI_DEFAULT_BASE_URL.ollama).replace(/\/$/, '')}/api/tags`)
  await assertOk(response, 'Ollama')
  const data = (await response.json()) as { models?: Array<{ name: string }> }
  return (data.models ?? []).map((entry) => entry.name)
}
