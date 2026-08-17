import type { ConnectionGroup, Profile } from './types'

/**
 * Export saved connections as a CSV for SecureCRT 9.2+
 * ("Tools → Import Settings from Text File").
 *
 * This exports *connections only*. Buttons, audit history, session logs,
 * global variables and assistant settings have no equivalent in a SecureCRT
 * session and are not attempted — the feature is deliberately named "Export
 * connections for SecureCRT" so nobody reads it as "export Smartcom".
 *
 * Nothing secret is emitted. The row is built from a fixed whitelist of seven
 * fields, so a password, passphrase, private key, vault reference or button
 * script cannot reach the file even if a future Profile gains one: a new field
 * would have to be added to `COLUMNS` by hand to appear.
 */

export const SECURECRT_COLUMNS = [
  'Session Name',
  'Folder',
  'Hostname/IP Address',
  'Port',
  'Protocol',
  'Username',
  'Emulation',
] as const

/** SecureCRT's default terminal emulation, and the closest match to xterm.js. */
const DEFAULT_EMULATION = 'Xterm'

export interface SecureCrtOptions {
  /**
   * Off by default. A username in an exported file is not a credential, but it
   * is an account name leaving the machine, and the person exporting is not
   * always the person importing.
   */
  includeUsernames?: boolean
  emulation?: string
}

export interface SkippedConnection {
  name: string
  reason: string
}

export interface SecureCrtExport {
  csv: string
  summary: {
    exported: number
    /** Connections SecureCRT could hold but this one could not be built. */
    skipped: SkippedConnection[]
    /** Connections of a kind the text importer cannot represent at all. */
    unsupported: SkippedConnection[]
  }
}

/**
 * RFC 4180 quoting. A field is quoted when it holds a comma, a quote, a line
 * break or leading/trailing spaces that would otherwise be eaten, and inner
 * quotes are doubled.
 */
export function csvField(value: string): string {
  const needsQuotes = /[",\r\n]/.test(value) || value !== value.trim()
  if (!needsQuotes) return value
  return `"${value.replace(/"/g, '""')}"`
}

const csvRow = (values: string[]): string => values.map(csvField).join(',')

/**
 * Folder path for a connection.
 *
 * Smartcom's folders are a single level today, so this is usually just the
 * group name. A name containing a separator is treated as a path and normalised
 * to SecureCRT's backslash form, which means a nested layout survives if the
 * model ever grows one — and a user who has already faked nesting by naming a
 * group "Sites/London" gets what they meant.
 */
export function folderPath(group: ConnectionGroup | undefined): string {
  if (!group) return ''
  return group.name
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\\')
}

/** Builds the CSV and a summary of what did and did not make it in. */
export function toSecureCrtCsv(
  profiles: Profile[],
  groups: ConnectionGroup[],
  options: SecureCrtOptions = {}
): SecureCrtExport {
  const { includeUsernames = false, emulation = DEFAULT_EMULATION } = options

  const groupById = new Map(groups.map((group) => [group.id, group]))
  const rows: string[] = [csvRow([...SECURECRT_COLUMNS])]
  const skipped: SkippedConnection[] = []
  const unsupported: SkippedConnection[] = []

  for (const profile of profiles) {
    if (profile.transport === 'serial') {
      // SecureCRT does have a Serial protocol, but the text-import wizard has
      // no column for baud rate, data bits, parity or flow control — so an
      // imported serial session would carry the port and silently wrong line
      // settings. A session that looks right and is not is worse than one that
      // was never created, so these are reported instead.
      unsupported.push({
        name: profile.name,
        reason:
          `Serial connection (${profile.serialPath || 'no port set'}). SecureCRT's text ` +
          'importer has no columns for baud rate, data bits, parity or flow control, so the ' +
          'line settings would not survive. Recreate it in SecureCRT by hand.',
      })
      continue
    }

    if (!profile.host?.trim()) {
      skipped.push({ name: profile.name, reason: 'No hostname or IP address set' })
      continue
    }

    rows.push(
      csvRow([
        profile.name,
        folderPath(profile.groupId ? groupById.get(profile.groupId) : undefined),
        profile.host.trim(),
        String(profile.port),
        // Smartcom speaks SSH2 only; SecureCRT names the protocol "SSH2".
        'SSH2',
        includeUsernames ? (profile.username ?? '').trim() : '',
        emulation,
      ])
    )
  }

  return {
    // CRLF is what RFC 4180 specifies and what the wizard is happiest with on
    // Windows, where SecureCRT overwhelmingly runs.
    csv: `${rows.join('\r\n')}\r\n`,
    summary: { exported: rows.length - 1, skipped, unsupported },
  }
}

/** One-line description of the outcome, for the toast after an export. */
export function describeExport(summary: SecureCrtExport['summary']): string {
  const parts = [`${summary.exported} connection${summary.exported === 1 ? '' : 's'} exported`]
  if (summary.skipped.length) parts.push(`${summary.skipped.length} skipped`)
  if (summary.unsupported.length) parts.push(`${summary.unsupported.length} unsupported`)
  return parts.join(', ')
}

/**
 * The instructions that ship beside the CSV.
 *
 * Written to a file rather than shown only on screen: the export is often done
 * on one machine and imported on another, days later, by someone else.
 */
export function importInstructions(summary: SecureCrtExport['summary'], csvName: string): string {
  const lines = [
    'Importing these connections into SecureCRT',
    '=========================================',
    '',
    `File: ${csvName}`,
    '',
    'This file holds saved connections only. Buttons, audit history, session logs,',
    'global variables and assistant settings are not part of a SecureCRT session and',
    'are not included.',
    '',
    'It contains no passwords, passphrases, private keys or vault references. After',
    'importing you will need to set up authentication for each session in SecureCRT.',
    '',
    'Steps (SecureCRT 9.2 or newer)',
    '------------------------------',
    '1. Open SecureCRT.',
    '2. Tools -> Import Settings from Text File...',
    `3. Choose ${csvName}.`,
    '4. Set the delimiter to Comma, and tick "First row contains column headings".',
    '5. Check the column mapping. The headings match SecureCRT\'s own field names,',
    '   so they normally map themselves; confirm Session Name, Folder,',
    '   Hostname/IP Address, Port, Protocol, Username and Emulation line up.',
    '6. Finish the wizard. Sessions appear in the Session Manager under the folders',
    '   named in the Folder column.',
    '',
    `Exported: ${summary.exported}`,
  ]

  if (summary.skipped.length) {
    lines.push('', `Skipped (${summary.skipped.length}) — incomplete connections:`)
    for (const item of summary.skipped) lines.push(`  - ${item.name}: ${item.reason}`)
  }

  if (summary.unsupported.length) {
    lines.push('', `Not supported by the text importer (${summary.unsupported.length}):`)
    for (const item of summary.unsupported) lines.push(`  - ${item.name}: ${item.reason}`)
  }

  lines.push('')
  return lines.join('\n')
}
