import { EventEmitter } from 'events'
import { chat, promptBudgetChars } from './providers'
import {
  AiSettingsSchema,
  fitTerminalContext,
  trimConversation,
  type AiAsk,
  type AiContextReport,
  type AiSettings,
} from '../../src/shared/ai'
import type { Profile } from '../../src/shared/types'

/** Everything the assistant knows about the session being asked about. */
export interface SessionContext {
  profile: Profile
  /** Recent terminal output, newest last. */
  recentOutput: string
  /** Commands previously run against this host, from the audit log. */
  recentCommands: string[]
  /** Buttons available to suggest instead of inventing commands. */
  availableButtons: Array<{ set: string; name: string; description?: string }>
}

export type SessionContextProvider = (sessionId: string) => SessionContext | null

const BASE_SYSTEM = `You are the built-in assistant for Smartcom Revisited, an SSH and serial terminal used by network and telephony engineers.

You are read-only. You never execute anything: you explain what is on screen and propose commands the operator runs themselves. Say plainly when you are unsure.

Ground every answer in what you were given:
- Prefer commands the operator has already run successfully on this box over commands you recall for the platform generally.
- If the transport is serial, remember the device may be a switch, router or PBX at a console prompt, possibly mid-boot or in a recovery mode, and that a wrong command can drop the very link being used.
- If an existing button already does what was asked, name it instead of writing a new command.
- State which platform you believe this is and what that belief is based on. If the evidence is thin, say so rather than guessing a vendor.

Mark any command that changes configuration or state clearly as a change, separately from read-only commands. Never suggest something destructive without saying what it will do.

Keep answers short and concrete. Lead with the answer, then the reasoning. Use a fenced code block for commands, one command per line.`

/**
 * Told to the model when there is nothing to ground on.
 *
 * A model handed no context does not reliably admit it — llama3.1 given only
 * the base prompt invented a serial session, a tab that does not exist and a
 * command for it. Saying so explicitly is cheaper than letting the operator
 * act on a fabricated screen.
 */
const UNGROUNDED_NOTE = `

## No connection context was attached to this question
You have NOT been given any terminal output, host details, or command history for this request — either no session is in focus or context sharing is switched off. Do not describe or guess at what is on the operator's screen. Say plainly that you cannot see a session, and answer only from general knowledge.`

/** Same, but a session *is* in focus and its output happens to be empty. */
const NO_OUTPUT_NOTE = `### Recent terminal output
There is none yet — the session is connected but has produced no output, or output sharing is set to 0 lines. Do not invent what is on screen.`

/** Guard rails on the parts of the prompt that would otherwise be unbounded. */
const MAX_BUTTONS = 60
const MAX_COMMANDS = 40
/** Most the chat history may take, leaving the rest for the screen. */
const CONVERSATION_SHARE = 0.35
/** The fences and newlines wrapped around the terminal block. */
const FENCE_CHARS = 16

const MODE_FRAMING: Record<AiAsk['mode'], string> = {
  ask: '',
  explain:
    '\n\nThe operator wants to know what is happening in the terminal right now. Describe what the recent output means in plain words, call out anything that looks like an error or a warning, and say what you would check next.',
  suggest:
    '\n\nThe operator wants a concrete next step. Propose the smallest safe command that moves them forward, and explain what its output will tell them.',
}

export class Assistant extends EventEmitter {
  private inFlight = new Map<string, AbortController>()
  private contextProvider: SessionContextProvider | null = null

  setContextProvider(provider: SessionContextProvider) {
    this.contextProvider = provider
  }

  cancel(requestId: string): boolean {
    const controller = this.inFlight.get(requestId)
    if (!controller) return false
    controller.abort()
    this.inFlight.delete(requestId)
    return true
  }

  cancelAll() {
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  /**
   * Builds the grounding block appended to the system prompt, sized so the
   * whole prompt fits the provider's window.
   *
   * `budgetChars` is what the *entire* prompt may occupy; everything except the
   * terminal output is assembled first and the remainder is what the terminal
   * gets. Overflowing is not survivable — Ollama drops the oldest content
   * without saying so, which is the system prompt, and the assistant then
   * replies that it cannot see a terminal.
   */
  private buildContext(
    settings: AiSettings,
    budgetChars: number,
    sessionId?: string
  ): { text: string; report: AiContextReport } {
    const none: AiContextReport = {
      grounded: false,
      lines: 0,
      chars: 0,
      truncated: false,
      commands: 0,
      buttons: 0,
    }

    if (!sessionId || !this.contextProvider) return { text: UNGROUNDED_NOTE, report: none }

    const context = this.contextProvider(sessionId)
    if (!context) return { text: UNGROUNDED_NOTE, report: none }

    const { profile } = context
    const parts: string[] = ['\n\n## The connection you are being asked about']

    if (profile.transport === 'serial') {
      parts.push(
        `Transport: serial console on ${profile.serialPath} at ${profile.baudRate} ` +
          `${profile.dataBits}${profile.parity[0].toUpperCase()}${profile.stopBits}. ` +
          `There is no remote OS to query — you are talking to whatever is on the other end of the cable.`
      )
    } else {
      parts.push(
        `Transport: SSH to ${profile.host}:${profile.port} as ${profile.username} ` +
          `(${profile.authMethod} authentication).`
      )
    }

    // The button list is unbounded — a user with many sets could otherwise
    // spend the whole budget describing buttons instead of showing output.
    const buttons = context.availableButtons.slice(0, MAX_BUTTONS)
    if (buttons.length > 0) {
      parts.push(
        '\n### Buttons already configured (prefer these over new commands)\n' +
          buttons
            .map((button) => `- ${button.set} › ${button.name}${button.description ? ` — ${button.description}` : ''}`)
            .join('\n')
      )
    }

    const commands = settings.includeCommandHistory
      ? context.recentCommands.slice(-MAX_COMMANDS)
      : []
    if (commands.length > 0) {
      parts.push(
        '\n### Commands previously run on this connection (ground truth for what this box accepts)\n' +
          commands.map((command) => `- ${command}`).join('\n')
      )
    }

    const fixed = parts.join('\n')
    const heading = '\n\n### Recent terminal output (this is what is on the operator\'s screen)\n'
    const overhead = fixed.length + heading.length + FENCE_CHARS

    const fitted = fitTerminalContext(context.recentOutput, {
      lines: settings.contextLines,
      maxChars: Math.max(0, budgetChars - overhead),
      redact: settings.redactSecrets,
    })

    const text = fitted.text
      ? `${fixed}${heading}\`\`\`\n${fitted.text}\n\`\`\``
      : `${fixed}\n\n${NO_OUTPUT_NOTE}`

    return {
      text,
      report: {
        grounded: fitted.chars > 0,
        lines: fitted.lines,
        chars: fitted.chars,
        truncated: fitted.truncated,
        commands: commands.length,
        buttons: buttons.length,
      },
    }
  }

  /**
   * Streams an answer. Text arrives as `ai-stream` events so the panel can
   * render it as it is generated rather than after the whole turn.
   */
  async ask(
    ask: AiAsk,
    rawSettings: Partial<AiSettings>,
    apiKey: string
  ): Promise<{ model: string }> {
    const settings = AiSettingsSchema.parse(rawSettings ?? {})

    if (settings.provider !== 'ollama' && !apiKey) {
      throw new Error(
        `No API key saved for ${settings.provider}. Add one in Settings → Assistant.`
      )
    }

    const controller = new AbortController()
    this.inFlight.set(ask.requestId, controller)

    // The prompt budget is split between the conversation and the terminal
    // context. The context gets the larger share on purpose: an assistant that
    // has forgotten an earlier turn is still useful, one that cannot see the
    // screen is not — and that is the failure the operator actually hit.
    const framing = BASE_SYSTEM + MODE_FRAMING[ask.mode]
    const total = promptBudgetChars(settings.provider) - framing.length
    const messages = trimConversation(ask.messages, Math.floor(total * CONVERSATION_SHARE))
    const used = messages.reduce((sum, message) => sum + message.content.length, 0)

    const { text: context, report } = this.buildContext(settings, total - used, ask.sessionId)
    const system = framing + context

    // Sent before the first token so the panel can show what the answer is
    // based on, rather than leaving the operator to trust the model's word.
    this.emit('stream', { requestId: ask.requestId, type: 'context', context: report })

    try {
      const result = await chat({
        settings,
        apiKey,
        system,
        messages,
        signal: controller.signal,
        onDelta: (text) => {
          this.emit('stream', { requestId: ask.requestId, type: 'delta', text })
        },
      })

      if (result.refused) {
        this.emit('stream', {
          requestId: ask.requestId,
          type: 'refusal',
          error:
            'The model declined this request. Security and networking topics sometimes trip safety classifiers — rephrasing usually helps.',
        })
      } else {
        this.emit('stream', { requestId: ask.requestId, type: 'done', model: result.model })
      }

      return { model: result.model }
    } catch (error) {
      // An abort is the operator pressing Stop, not a failure worth reporting.
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && /abort/i.test(error.name + error.message))

      this.emit('stream', {
        requestId: ask.requestId,
        type: aborted ? 'done' : 'error',
        error: aborted ? undefined : error instanceof Error ? error.message : String(error),
      })

      if (!aborted) throw error
      return { model: settings.model }
    } finally {
      this.inFlight.delete(ask.requestId)
    }
  }
}
