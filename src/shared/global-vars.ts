/**
 * Global variables — a plain text file of `NAME=value` lines whose contents are
 * available to *every* button, script and form default as `{{NAME}}`.
 *
 * The file on disk is the source of truth, the same choice the script library
 * made: it can be edited in your own editor, kept in git, or written by the form
 * in the app. Parsing therefore has to survive a hand-edited file — an unusable
 * line is reported as a problem and skipped rather than throwing the whole file
 * away.
 *
 * Deliberately *not* dotenv: there is no inline-comment rule, so everything
 * after the first `=` is the value. A trailing `# note` after an unquoted value
 * stays part of it. URLs with fragments are far more common in this file than
 * trailing comments, and "the value is the rest of the line" is a rule an
 * operator can hold in their head.
 */

/** A name that `interpolate()` can actually reference. */
export const GLOBAL_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One usable assignment. */
export interface GlobalVar {
  name: string
  value: string
}

/** A line that could not be used, kept so the editor can point at it. */
export interface GlobalVarProblem {
  /** 1-based, matching what an editor shows. */
  line: number
  text: string
  message: string
}

export interface ParsedGlobalVars {
  vars: GlobalVar[]
  /** Ready to hand to `interpolate()`. Later assignments win. */
  values: Record<string, string>
  problems: GlobalVarProblem[]
}

export function isValidGlobalName(name: string): boolean {
  return GLOBAL_VAR_NAME.test(name)
}

/**
 * Unwraps a quoted value. Double quotes take the usual escapes so a multi-line
 * value can live on one line; single quotes are literal, like a shell's.
 */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1)
  }

  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\([nrt"\\])/g, (_match, escape: string) =>
        escape === 'n' ? '\n' : escape === 'r' ? '\r' : escape === 't' ? '\t' : escape
      )
  }

  return raw
}

/** True when writing `value` bare would not read back as the same string. */
function needsQuoting(value: string): boolean {
  return value !== value.trim() || /[\n\r"']/.test(value) || value === ''
}

/** Renders one value for the file, quoting only when it has to. */
export function formatGlobalValue(value: string): string {
  if (!needsQuoting(value)) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `"${escaped}"`
}

export function parseGlobalVars(text: string): ParsedGlobalVars {
  const vars: GlobalVar[] = []
  const values: Record<string, string> = {}
  const problems: GlobalVarProblem[] = []
  const seen = new Set<string>()

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) return

    // `export NAME=value` is what you get when the file is pasted out of a
    // shell profile, which is exactly where these values usually come from.
    const assignment = line.replace(/^export\s+/, '')
    const equals = assignment.indexOf('=')

    if (equals <= 0) {
      problems.push({
        line: index + 1,
        text: rawLine,
        message: 'Not a NAME=value assignment',
      })
      return
    }

    const name = assignment.slice(0, equals).trim()
    const value = unquote(assignment.slice(equals + 1).trim())

    if (!isValidGlobalName(name)) {
      problems.push({
        line: index + 1,
        text: rawLine,
        message: `"${name}" cannot be used as a name — letters, digits and _ only, not starting with a digit`,
      })
      return
    }

    if (seen.has(name)) {
      // Last one wins, which is what a reader of the file would assume, but say
      // so: a duplicate is usually a half-finished edit.
      problems.push({
        line: index + 1,
        text: rawLine,
        message: `${name} is set more than once — this line wins`,
      })
      const previous = vars.findIndex((entry) => entry.name === name)
      vars.splice(previous, 1)
    }

    seen.add(name)
    vars.push({ name, value })
    values[name] = value
  })

  return { vars, values, problems }
}

/** Serialises the editor's rows back to file text, one assignment per line. */
export function formatGlobalVars(vars: GlobalVar[], header?: string): string {
  const body = vars.map((entry) => `${entry.name}=${formatGlobalValue(entry.value)}`).join('\n')
  const prefix = header ? `${header.trimEnd()}\n\n` : ''
  return `${prefix}${body}${body ? '\n' : ''}`
}

/**
 * Rewrites `originalText` so it holds exactly `vars`, in that order, while
 * keeping every comment and blank line where it was.
 *
 * The row editor could just re-serialise the list, but the file is the user's:
 * a comment saying *why* a URL is what it is must survive someone changing a
 * value in the form. Assignments are edited in place, removed names take their
 * line with them, and new ones are appended.
 */
export function mergeGlobalVars(originalText: string, vars: GlobalVar[]): string {
  const wanted = new Map(vars.map((entry) => [entry.name, entry.value]))
  const written = new Set<string>()
  const lines = originalText === '' ? [] : originalText.split(/\r?\n/)
  const kept: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === '' || line.startsWith('#')) {
      kept.push(rawLine)
      continue
    }

    const assignment = line.replace(/^export\s+/, '')
    const equals = assignment.indexOf('=')
    const name = equals > 0 ? assignment.slice(0, equals).trim() : ''

    // A line that is not a usable assignment is left exactly as it is: it is
    // either something we do not understand or something being typed, and
    // either way silently deleting it would be worse.
    if (!name || !isValidGlobalName(name)) {
      kept.push(rawLine)
      continue
    }

    if (!wanted.has(name) || written.has(name)) continue

    kept.push(`${name}=${formatGlobalValue(wanted.get(name)!)}`)
    written.add(name)
  }

  // Trailing blank lines would push every new variable further down each save.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()

  for (const entry of vars) {
    if (written.has(entry.name)) continue
    kept.push(`${entry.name}=${formatGlobalValue(entry.value)}`)
  }

  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

/**
 * Names a piece of text refers to. Used to tell the operator which of their
 * globals a button actually uses, and to spot a `{{TYPO}}` that resolves to
 * nothing.
 */
export function referencedNames(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    found.add(match[1])
  }
  return [...found]
}
