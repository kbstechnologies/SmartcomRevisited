/**
 * Variables every button gets for free, computed rather than stored.
 *
 * Two rules decide the whole design:
 *
 * **Names use underscores, never spaces.** The interpolation regex only accepts
 * `[A-Za-z_][A-Za-z0-9_]*`, and widening it to allow spaces would start
 * matching the Go templates in the shipped Docker buttons —
 * `{{range .NetworkSettings.Networks}}` and friends — which currently pass
 * through untouched because they do not look like identifiers. So it is
 * `{{RANDOM_NUMBER}}`, not `{{random number}}`.
 *
 * **They are evaluated once per run, not once per use.** This is the important
 * one. A capture written as `tcpdump -w cap-{{EPOCH}}.pcap` and collected later
 * as `cap-{{EPOCH}}.pcap` has to name the same file both times; a value that
 * changed between steps would produce a button that looks right, runs cleanly
 * and silently fetches nothing. The cost is that two uses of `{{RANDOM}}` in
 * one button give the same number — which is the safer of the two surprises,
 * and the one the filename case needs.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const MIXED = `${LOWER}${LOWER.toUpperCase()}${DIGITS}`

/** Cryptographically-seeded where available; these end up in filenames. */
function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length)

  const crypto = globalThis.crypto
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }

  let out = ''
  // Modulo bias is irrelevant here — these name temporary files, they are not
  // secrets — but the alphabet lengths are close enough to a power of two that
  // it would not matter anyway.
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** Two digits, zero padded. */
const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

export interface BuiltinContext {
  /** Host of the session the button is running against, when there is one. */
  host?: string
  username?: string
  /** The connection's display name. */
  profileName?: string
  /** Overridable so tests are not at the mercy of the clock. */
  now?: Date
  /** Length of the generated random strings. */
  randomLength?: number
}

/**
 * Builds one set of values. Call once per run and reuse it for every step —
 * see the note above about why these must not be recomputed per use.
 */
export function builtinVariables(context: BuiltinContext = {}): Record<string, string> {
  const now = context.now ?? new Date()
  const length = context.randomLength ?? 8

  const yyyy = now.getFullYear()
  const mm = pad(now.getMonth() + 1)
  const dd = pad(now.getDate())
  const hh = pad(now.getHours())
  const mi = pad(now.getMinutes())
  const ss = pad(now.getSeconds())

  const values: Record<string, string> = {
    // --- Time -------------------------------------------------------------
    /** Unix seconds. The usual choice for a unique-ish filename suffix. */
    EPOCH: String(Math.floor(now.getTime() / 1000)),
    EPOCH_MS: String(now.getTime()),
    /** Full ISO 8601, UTC. Contains colons — not safe in a filename. */
    DATE_ISO: now.toISOString(),
    /** ISO 8601 with the colons replaced, so it can be used in a filename. */
    DATE_ISO_SAFE: now.toISOString().replace(/[:.]/g, '-'),
    DATE: `${yyyy}-${mm}-${dd}`,
    /** Local time with hyphens rather than colons, for the same reason. */
    TIME: `${hh}-${mi}-${ss}`,
    /** Compact local stamp: 20260817-142530. Sorts correctly as text. */
    TIMESTAMP: `${yyyy}${mm}${dd}-${hh}${mi}${ss}`,
    YEAR: String(yyyy),
    MONTH: mm,
    DAY: dd,

    // --- Randomness -------------------------------------------------------
    /** Six digits. `RANDOM` and `RANDOM_NUMBER` are the same value. */
    RANDOM: randomFrom(DIGITS, 6),
    RANDOM_NUMBER: '',
    RANDOM_LOWER: randomFrom(LOWER, length),
    RANDOM_MIX: randomFrom(MIXED, length),
    RANDOM_HEX: randomFrom('0123456789abcdef', length),
  }

  // Kept identical rather than generated twice: a button using both names for
  // the same intended value would otherwise get two different numbers.
  values.RANDOM_NUMBER = values.RANDOM

  // --- Session ------------------------------------------------------------
  // Prefixed, because HOST and USER are ordinary field names in the shipped
  // button sets — an unprefixed built-in would shadow or be shadowed by them
  // depending on precedence, and either way somebody's button changes meaning.
  if (context.host) values.SESSION_HOST = context.host
  if (context.username) values.SESSION_USER = context.username
  if (context.profileName) values.SESSION_NAME = context.profileName

  return values
}

/** Documentation for the editor's variable helper. */
export const BUILTIN_VARIABLE_HELP: Array<{ name: string; description: string; example: string }> = [
  { name: 'EPOCH', description: 'Unix time in seconds', example: '1786982730' },
  { name: 'EPOCH_MS', description: 'Unix time in milliseconds', example: '1786982730123' },
  { name: 'DATE', description: 'Local date', example: '2026-08-17' },
  { name: 'TIME', description: 'Local time, safe in a filename', example: '14-25-30' },
  { name: 'TIMESTAMP', description: 'Compact local stamp, sorts as text', example: '20260817-142530' },
  { name: 'DATE_ISO', description: 'Full ISO 8601 — contains colons', example: '2026-08-17T14:25:30.000Z' },
  { name: 'DATE_ISO_SAFE', description: 'ISO 8601 with colons replaced', example: '2026-08-17T14-25-30-000Z' },
  { name: 'YEAR', description: 'Four-digit year', example: '2026' },
  { name: 'MONTH', description: 'Two-digit month', example: '08' },
  { name: 'DAY', description: 'Two-digit day', example: '17' },
  { name: 'RANDOM', description: 'Six random digits', example: '481920' },
  { name: 'RANDOM_NUMBER', description: 'Same value as RANDOM', example: '481920' },
  { name: 'RANDOM_LOWER', description: 'Random lower-case letters', example: 'kfqbnzra' },
  { name: 'RANDOM_MIX', description: 'Random letters and digits', example: 'Kf3QbN9a' },
  { name: 'RANDOM_HEX', description: 'Random hex digits', example: '9f3ab20c' },
  { name: 'SESSION_HOST', description: 'Host of the current session', example: '10.0.0.1' },
  { name: 'SESSION_USER', description: 'Username of the current session', example: 'admin' },
  { name: 'SESSION_NAME', description: 'Name of the current connection', example: 'core-sw-01' },
]
