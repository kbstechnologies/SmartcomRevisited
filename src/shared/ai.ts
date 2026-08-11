import { z } from 'zod'

/**
 * Assistant configuration and the shared chat contract.
 *
 * Three providers are supported. They differ enough at the wire level that each
 * gets its own implementation in `electron/ai/`, but everything above this
 * boundary sees one interface.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'ollama'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

/** Sensible starting models. The UI lets the user type anything else. */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  // Opus 5 is the default; Sonnet 5 and Haiku 4.5 trade capability for cost.
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'mistral', 'phi3'],
}

export const AI_DEFAULT_MODEL: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
  ollama: 'llama3.1',
}

/** Ollama runs locally; the others use their hosted endpoints by default. */
export const AI_DEFAULT_BASE_URL: Record<AiProvider, string> = {
  anthropic: '',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434',
}

export const AiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS).default('anthropic'),
  model: z.string().default(AI_DEFAULT_MODEL.anthropic),
  /** Override for self-hosted or proxied endpoints. Blank uses the default. */
  baseUrl: z.string().default(''),
  /**
   * How much of the terminal's recent output to attach as context, in lines.
   * Kept modest by default — a busy console can produce a lot of tokens.
   */
  contextLines: z.number().min(0).max(2000).default(200),
  /** Strip password-like strings from terminal output before it is sent. */
  redactSecrets: z.boolean().default(true),
  /** Send the audit log's recent commands for this host as grounding. */
  includeCommandHistory: z.boolean().default(true),
  /**
   * Anthropic only. Claude Opus 5's safety classifiers can decline requests,
   * and SSH/network content sits close to the cyber category — a server-side
   * fallback keeps a false positive from becoming a dead end.
   */
  refusalFallback: z.boolean().default(true),
})

export type AiSettings = z.infer<typeof AiSettingsSchema>

export const AiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

export type AiChatMessage = z.infer<typeof AiChatMessageSchema>

/**
 * One message as the panel shows it. The conversation lives in the store, not
 * in the panel's own state: the side panel unmounts whenever you switch to the
 * buttons tab or collapse it, which used to throw the whole conversation away.
 */
export interface AssistantTurn extends AiChatMessage {
  /** Set while the assistant's reply is still streaming in. */
  streaming?: boolean
  error?: string
  /** What this answer was grounded in, reported by the main process. */
  context?: AiContextReport
}

/** What the renderer sends when asking a question about a session. */
export const AiAskSchema = z.object({
  requestId: z.string(),
  /** Conversation so far, oldest first. The newest user turn is last. */
  messages: z.array(AiChatMessageSchema).min(1),
  /** Session whose output and device context should ground the answer. */
  sessionId: z.string().optional(),
  /** Overrides the "explain what you're seeing" default framing. */
  mode: z.enum(['ask', 'explain', 'suggest']).default('ask'),
})

export type AiAsk = z.infer<typeof AiAskSchema>

/**
 * What was actually attached to the request. Reported to the renderer so the
 * operator can see the assistant is grounded instead of having to infer it
 * from the answer — a model given no context does not reliably say so.
 */
export interface AiContextReport {
  /** False when no session was in focus, or the context provider had nothing. */
  grounded: boolean
  lines: number
  chars: number
  /** Output had to be cut to fit the model's window. */
  truncated: boolean
  commands: number
  buttons: number
}

/** Streamed back to the renderer as the answer is generated. */
export interface AiStreamEvent {
  requestId: string
  type: 'delta' | 'done' | 'error' | 'refusal' | 'context'
  text?: string
  error?: string
  /** Model that actually served the response (may differ after a fallback). */
  model?: string
  /** Present on `context`, emitted once before the first delta. */
  context?: AiContextReport
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns for material that must never leave the machine.
 *
 * Terminal output routinely contains passwords being typed at a prompt, key
 * material pasted into a heredoc, and tokens echoed by a config dump. This is
 * a best-effort scrub, not a guarantee — the setting exists so an operator on
 * a sensitive network can also turn the context off entirely.
 */
const REDACTIONS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'PRIVATE KEY' },
  // The keyword may be embedded in a longer identifier (`db_secret`,
  // `MY_API_KEY`, `auth-token`), so no word boundary is required around it —
  // `\bsecret` would not match after an underscore, which is a word character.
  {
    pattern: /[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key)[\w.-]*\s*[:=]\s*\S+/gi,
    label: 'SECRET',
  },
  // A prompt asking for a password, plus whatever followed it on that line.
  { pattern: /\b(?:password|passphrase)\s*(?:for[^:]*)?:\s*\S+/gi, label: 'SECRET' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, label: 'BEARER TOKEN' },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/g, label: 'API KEY' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'EMAIL' },
  // SNMP community strings and shared secrets in network device configs.
  { pattern: /\b(?:community|key|md5|sha)\s+\S+/gi, label: 'SECRET' },
]

export function redactSecrets(text: string): string {
  let output = text
  for (const { pattern, label } of REDACTIONS) {
    output = output.replace(pattern, `[REDACTED ${label}]`)
  }
  return output
}

/** Keeps the last `lines` lines, so context is the most recent activity. */
export function tailLines(text: string, lines: number): string {
  if (lines <= 0) return ''
  const split = text.split('\n')
  return split.length <= lines ? text : split.slice(-lines).join('\n')
}

// ---------------------------------------------------------------------------
// Fitting the terminal into the model's context window
// ---------------------------------------------------------------------------

/**
 * Collapses carriage returns the way the screen does: everything before the
 * last `\r` on a line was overwritten and is not what the operator is looking
 * at.
 *
 * This is a size fix as much as a fidelity one. `tailLines` counts `\n`, but a
 * progress bar, a `top` refresh or a serial console that pads with `\r` emits
 * *one* line that can run to hundreds of kilobytes — so a 200-line context
 * could still be far larger than any model's window.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      const last = line.lastIndexOf('\r')
      return last === -1 ? line : line.slice(last + 1)
    })
    .join('\n')
}

/**
 * Drops the oldest turns until the conversation fits `maxChars`.
 *
 * The prompt budget is shared between the chat and the terminal context, so a
 * long conversation would otherwise crowd out the very output the questions are
 * about — the assistant would go blind partway through a session rather than
 * all at once, which is harder to notice. The newest turn is always kept, even
 * if it alone exceeds the budget: dropping the actual question would be worse
 * than a tight fit.
 */
export function trimConversation(messages: AiChatMessage[], maxChars: number): AiChatMessage[] {
  if (messages.length === 0) return messages

  const kept: AiChatMessage[] = []
  let used = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const cost = message.content.length
    if (kept.length > 0 && used + cost > maxChars) break
    kept.unshift(message)
    used += cost
  }

  return kept
}

/** Marks where output was dropped, so the model knows it is seeing a tail. */
const TRIM_NOTICE = '[… earlier output trimmed to fit the model context window …]\n'

export interface FittedContext {
  text: string
  lines: number
  chars: number
  /** True when the line budget was not the binding constraint — size was. */
  truncated: boolean
}

/**
 * Produces the terminal block that goes into the prompt, guaranteed to fit in
 * `maxChars`.
 *
 * Overflowing the window is not a graceful degradation: Ollama silently drops
 * whatever does not fit, oldest first, and the system prompt goes with it — the
 * assistant then answers that it cannot see any terminal. Measured on llama3.1,
 * a 27,000-character prompt against a 4,096-token window evaluated **19** of
 * its tokens. So the content is trimmed to the budget here rather than left for
 * the provider to discard.
 */
export function fitTerminalContext(
  raw: string,
  options: { lines: number; maxChars: number; redact: boolean }
): FittedContext {
  const empty: FittedContext = { text: '', lines: 0, chars: 0, truncated: false }
  if (options.lines <= 0 || options.maxChars <= 0) return empty

  const collapsed = collapseCarriageReturns(raw)
  let body = tailLines(collapsed, options.lines).trimEnd()
  // Redaction runs before the size check: it can only shrink the text, and a
  // budget measured on unredacted output would be wrong in the safe direction
  // but wasteful.
  if (options.redact) body = redactSecrets(body)
  if (!body.trim()) return empty

  let truncated = false
  if (body.length > options.maxChars) {
    truncated = true
    const room = Math.max(0, options.maxChars - TRIM_NOTICE.length)
    const cut = body.slice(-room)
    // Start at a line boundary so the first line is not a fragment.
    const newline = cut.indexOf('\n')
    body = TRIM_NOTICE + (newline === -1 ? cut : cut.slice(newline + 1))
  }

  return {
    text: body,
    lines: body ? body.split('\n').length : 0,
    chars: body.length,
    truncated,
  }
}
