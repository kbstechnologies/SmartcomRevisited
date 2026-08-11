import { EventEmitter } from 'events'
import { chat } from './providers'
import {
  AiSettingsSchema,
  redactSecrets,
  tailLines,
  type AiAsk,
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

  /** Builds the grounding block appended to the system prompt. */
  private buildContext(settings: AiSettings, sessionId?: string): string {
    if (!sessionId || !this.contextProvider) return ''

    const context = this.contextProvider(sessionId)
    if (!context) return ''

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

    if (context.availableButtons.length > 0) {
      parts.push(
        '\n### Buttons already configured (prefer these over new commands)\n' +
          context.availableButtons
            .map((button) => `- ${button.set} › ${button.name}${button.description ? ` — ${button.description}` : ''}`)
            .join('\n')
      )
    }

    if (settings.includeCommandHistory && context.recentCommands.length > 0) {
      parts.push(
        '\n### Commands previously run on this connection (ground truth for what this box accepts)\n' +
          context.recentCommands.slice(-40).map((command) => `- ${command}`).join('\n')
      )
    }

    if (settings.contextLines > 0 && context.recentOutput.trim()) {
      const tail = tailLines(context.recentOutput, settings.contextLines)
      const body = settings.redactSecrets ? redactSecrets(tail) : tail
      parts.push(`\n### Recent terminal output\n\`\`\`\n${body.trimEnd()}\n\`\`\``)
    }

    return parts.join('\n')
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

    const system =
      BASE_SYSTEM + MODE_FRAMING[ask.mode] + this.buildContext(settings, ask.sessionId)

    try {
      const result = await chat({
        settings,
        apiKey,
        system,
        messages: ask.messages,
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
