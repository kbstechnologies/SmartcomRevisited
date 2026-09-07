/**
 * The prestage area's variables — what `{{NAME}}` in the scratch pad resolves
 * to, and which names have to be asked for before anything is sent.
 *
 * The scratch pad exists because the real workflow is *edit, then use*: a
 * config fragment or a command gets pasted somewhere, three values in it get
 * changed, and the result goes to a terminal. Doing that in a text editor loses
 * the globals; doing it in a button means saving a button for something used
 * once. So the pad resolves the same `{{NAME}}` syntax every button does, and
 * anything it does not recognise becomes a question instead of an error.
 *
 * Three sources, and which one a name comes from is decided here rather than in
 * the panel so the panel can just render it:
 *
 *  - **global** — the user's globals file. Wins over a built-in of the same
 *    name, matching the precedence the macro engine already uses (built-ins
 *    lowest, then globals, then what the operator typed).
 *  - **builtin** — `{{DATE}}`, `{{RANDOM}}`, `{{SESSION_HOST}}` and the rest.
 *  - **ask** — anything else. Not a typo to be reported: a one-off value the
 *    operator is asked for at the moment they press Insert or Send.
 *
 * `ask` is the whole point of this module. `{{TYPO}}` and `{{var1}}` are
 * indistinguishable to a parser, and guessing wrong in either direction is
 * worse than asking — a typo silently sent to a switch, or a refusal to send
 * something the operator meant. Asking makes a typo visible (you get a box
 * labelled TYPO) without making it fatal.
 */

import { referencedNames } from './global-vars'
import { interpolate } from './types'

/** Where a referenced name's value comes from. */
export type PrestageSource = 'global' | 'builtin' | 'ask'

/** One `{{NAME}}` the pad's text refers to. */
export interface PrestageVar {
  name: string
  source: PrestageSource
  /** What will be substituted. Empty for an `ask` nobody has filled in. */
  value: string
  /** True only for an `ask` with no value yet — what blocks Insert and Send. */
  unanswered: boolean
}

export interface PrestageInputs {
  /** `NAME` -> value from the globals file. */
  globals: Record<string, string>
  /**
   * The built-in set for this run.
   *
   * Passed in rather than computed here, and that is deliberate: `{{EPOCH}}`
   * and `{{RANDOM}}` must be the *same* value in the preview and in what is
   * actually sent, and must not change on every React render. See the frozen
   * snapshot in the store.
   */
  builtins: Record<string, string>
  /** Answers the operator has given for `ask` names. */
  answers: Record<string, string>
}

export interface PrestageAnalysis {
  /** Every referenced name, in the order it first appears in the text. */
  vars: PrestageVar[]
  /** Names of the `ask` variables still waiting for a value, same order. */
  unanswered: string[]
  /** Ready to hand to `interpolate()`. */
  values: Record<string, string>
}

/** Classifies every `{{NAME}}` in `text` and works out what it resolves to. */
export function analysePrestage(text: string, inputs: PrestageInputs): PrestageAnalysis {
  const vars: PrestageVar[] = []
  const values: Record<string, string> = {}
  const unanswered: string[] = []

  for (const name of referencedNames(text)) {
    // Globals before built-ins: the user's file is allowed to redefine a name
    // the app ships, and the alternative is a value they cannot change.
    const source: PrestageSource = Object.prototype.hasOwnProperty.call(inputs.globals, name)
      ? 'global'
      : Object.prototype.hasOwnProperty.call(inputs.builtins, name)
        ? 'builtin'
        : 'ask'

    const value =
      source === 'global'
        ? inputs.globals[name]
        : source === 'builtin'
          ? inputs.builtins[name]
          : (inputs.answers[name] ?? '')

    // Only an `ask` can be unanswered. A global deliberately set to the empty
    // string is answered — that is a value, and prompting for it would make an
    // empty global impossible to use.
    const blank = source === 'ask' && value === ''

    vars.push({ name, source, value, unanswered: blank })
    values[name] = value
    if (blank) unanswered.push(name)
  }

  return { vars, unanswered, values }
}

export interface PrestageResolution {
  /** The text with every known `{{NAME}}` replaced. */
  text: string
  /** Names that still need asking. Empty means the text is ready to use. */
  unanswered: string[]
}

/**
 * Fills in what is known and reports what is not.
 *
 * It substitutes the unanswered names too — as the empty string — rather than
 * leaving `{{NAME}}` in place, because the only caller that ignores
 * `unanswered` is the live preview, and a preview showing a hole is more
 * honest than one showing braces the terminal would never receive.
 */
export function resolvePrestage(text: string, inputs: PrestageInputs): PrestageResolution {
  const { values, unanswered } = analysePrestage(text, inputs)
  return { text: interpolate(text, values), unanswered }
}
