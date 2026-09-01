/**
 * Reconstructs the command line the operator is typing, per session.
 *
 * Smartcom has no command input box — a session is a raw pty and xterm, and
 * every keystroke goes straight to the far end. So the only way to know what is
 * being typed is to watch the keystrokes go past, which is what this does.
 *
 * It is a *model* of the remote's line editor, not the line editor itself, and
 * it can be wrong: readline history, tab completion and cursor movement all
 * change the line in ways this cannot see. Rather than pretend, the model says
 * when it has lost track (`reliable: false`) and the UI reports a detection it
 * is unsure of accordingly. Being wrong costs a documentation page that was not
 * wanted, which is why a rough model is worth having at all.
 *
 * ## Passwords
 *
 * A password typed at a prompt is keystrokes like any other, and this would
 * otherwise capture it, put it on screen in the indicator, and offer to send it
 * to an AI provider. So output is watched for a prompt that is asking for a
 * secret, and while one is on screen nothing is recorded at all. That is a
 * heuristic and not a guarantee — see `SENSITIVE_PROMPT` — so nothing derived
 * from this buffer is sent anywhere without the redaction in `@shared/ai`.
 */

export interface CommandLineState {
  /** What the operator appears to have typed so far, not yet submitted. */
  line: string
  /** The last line submitted with Enter. Kept so help survives the keypress. */
  lastSubmitted: string
  /**
   * False once something happened that this model cannot follow — history
   * recall, tab completion, cursor movement.
   */
  reliable: boolean
  /** True while the far end appears to be asking for a secret. */
  sensitive: boolean
}

type Listener = (state: CommandLineState) => void

/** A typed line longer than this is a paste, not a command being composed. */
const MAX_LINE = 4096

/** How much recent output to keep for the prompt check. */
const TAIL = 160

/**
 * Output that looks like a request for something that must not be captured.
 *
 * Matched against the tail of what is on screen, so it only holds while the
 * prompt is the last thing written. Covers `sudo`'s prompt, OpenSSH's,
 * `[sudo] password for x:`, enable-password prompts on network gear, and the
 * generic "Enter passphrase for key ...:".
 */
const SENSITIVE_PROMPT = /(?:password|passphrase|passcode|secret|token|pin)[^\n]{0,60}:\s*$/i

interface Tracked extends CommandLineState {
  /** Rolling tail of output, for the prompt check only. */
  outputTail: string
}

const tracked = new Map<string, Tracked>()
const listeners = new Map<string, Set<Listener>>()

const blank = (): Tracked => ({
  line: '',
  lastSubmitted: '',
  reliable: true,
  sensitive: false,
  outputTail: '',
})

function stateOf(sessionId: string): Tracked {
  let state = tracked.get(sessionId)
  if (!state) {
    state = blank()
    tracked.set(sessionId, state)
  }
  return state
}

function publish(sessionId: string, state: Tracked): void {
  const snapshot: CommandLineState = {
    line: state.line,
    lastSubmitted: state.lastSubmitted,
    reliable: state.reliable,
    sensitive: state.sensitive,
  }
  listeners.get(sessionId)?.forEach((listener) => listener(snapshot))
}

/**
 * Folds one chunk of keystrokes into the model.
 *
 * Called from xterm's `onData`, so it runs on the typing path: it must stay a
 * handful of string operations and must never throw. A chunk is usually one
 * character, but a paste or a fast key repeat arrives as several.
 */
export function noteKeystrokes(sessionId: string, data: string): void {
  if (!data) return
  const state = stateOf(sessionId)
  const before = state.line
  const wasReliable = state.reliable

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index]

    // Escape sequences: arrow keys, function keys, mouse reports.
    if (char === '\x1b') {
      // Up/down recall a different line entirely; left/right move the cursor so
      // the next character does not land where this model would put it. Either
      // way the buffer is now fiction, so say so rather than guess.
      // `ESC [ A`..`D` and `ESC O A`..`D`, compared rather than matched: a
      // regular expression containing a literal escape is exactly what
      // `no-control-regex` is there to catch.
      const introducer = data[index + 1]
      const final = data[index + 2]
      if ((introducer === '[' || introducer === 'O') && final && 'ABCD'.includes(final)) {
        state.line = ''
        state.reliable = false
      }
      // Skip to the end of the sequence. The introducer (`[` or `O`) has to be
      // stepped over first: it is itself in the @-~ range that terminates a
      // CSI, so scanning from it ends the sequence immediately and leaves the
      // final byte to be read as text — an arrow key that typed a literal `A`.
      let cursor = index + 1
      if (data[cursor] === '[' || data[cursor] === 'O') cursor += 1
      while (cursor < data.length && !/[@-~]/.test(data[cursor])) cursor += 1
      index = cursor
      continue
    }

    if (char === '\r' || char === '\n') {
      const submitted = state.line.trim()
      if (submitted && state.reliable && !state.sensitive) state.lastSubmitted = submitted
      state.line = ''
      // A fresh line is one this model can follow again.
      state.reliable = true
      continue
    }

    // Backspace / delete.
    if (char === '\x7f' || char === '\b') {
      state.line = state.line.slice(0, -1)
      continue
    }

    // Ctrl+C, Ctrl+U, Ctrl+G: the line is abandoned.
    if (char === '\x03' || char === '\x15' || char === '\x07') {
      state.line = ''
      state.reliable = true
      continue
    }

    // Ctrl+W deletes the word before the cursor.
    if (char === '\x17') {
      state.line = state.line.replace(/\s*\S*$/, '')
      continue
    }

    // Tab completion rewrites the line on the far end, invisibly to us. The
    // command name is usually already complete by then, so the buffer is kept
    // and only marked doubtful.
    if (char === '\t') {
      state.reliable = false
      continue
    }

    // Every other control character (Ctrl+A, Ctrl+E, Ctrl+R …) moves or
    // replaces without adding text.
    if (char < ' ') {
      if (char === '\x01' || char === '\x05' || char === '\x12' || char === '\x0b') {
        state.reliable = false
      }
      continue
    }

    if (state.sensitive) continue
    if (state.line.length >= MAX_LINE) continue
    state.line += char
  }

  if (state.line !== before || state.reliable !== wasReliable) publish(sessionId, state)
}

/**
 * Folds one chunk of terminal *output* in, purely to spot secret prompts.
 *
 * Only the tail is kept, and only one regular expression is run against it —
 * this sits on the output path, which on a busy console is the hottest code in
 * the app.
 */
export function noteOutput(sessionId: string, chunk: string): void {
  if (!chunk) return
  const state = stateOf(sessionId)

  const combined = state.outputTail + chunk
  state.outputTail = combined.length > TAIL ? combined.slice(-TAIL) : combined

  const sensitive = SENSITIVE_PROMPT.test(state.outputTail)
  if (sensitive === state.sensitive) return

  state.sensitive = sensitive
  if (sensitive) {
    // Anything typed since the prompt appeared is part of the secret.
    state.line = ''
  }
  publish(sessionId, state)
}

export function getCommandLine(sessionId: string): CommandLineState {
  const state = stateOf(sessionId)
  return {
    line: state.line,
    lastSubmitted: state.lastSubmitted,
    reliable: state.reliable,
    sensitive: state.sensitive,
  }
}

export function subscribeToCommandLine(sessionId: string, listener: Listener): () => void {
  let subscribers = listeners.get(sessionId)
  if (!subscribers) {
    subscribers = new Set()
    listeners.set(sessionId, subscribers)
  }
  subscribers.add(listener)
  listener(getCommandLine(sessionId))

  return () => {
    subscribers!.delete(listener)
    if (subscribers!.size === 0) listeners.delete(sessionId)
  }
}

/** Drops everything held for a session. Called when the session closes. */
export function clearCommandLine(sessionId: string): void {
  tracked.delete(sessionId)
  listeners.delete(sessionId)
}
