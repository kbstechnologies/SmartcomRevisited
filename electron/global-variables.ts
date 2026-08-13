import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { parseGlobalVars, type ParsedGlobalVars } from '../src/shared/global-vars'

/**
 * The store behind the global variables: one text file the user owns.
 *
 * It is read at *run* time rather than cached at start-up, so editing the file
 * in another editor — or letting a colleague drop one in — takes effect on the
 * next button press with no restart. The file is a few hundred bytes; the read
 * costs nothing next to opening an SSH channel.
 */

export const GLOBALS_FILENAME = 'global-variables.env'

/** A guard against pointing this at something that is not a settings file. */
export const MAX_GLOBALS_BYTES = 256 * 1024

/** Written into a file created by the app, so an empty one still explains itself. */
export const GLOBALS_HEADER = [
  '# Global variables for Smartcom Revisited.',
  '#',
  '# Every NAME=value line here is available to every button, script and form',
  '# default as {{NAME}} — exactly like an input you typed into a button form.',
  '#',
  '#   KBSTECHLOG=https://fake.com/log',
  '#   ...then a button that sends: wget {{KBSTECHLOG}}',
  '#',
  '# Everything after the first = is the value, so a # in a URL is safe. Wrap a',
  '# value in "quotes" if it has leading or trailing spaces, or use \\n for a',
  "# line break. 'Single quotes' are taken literally.",
  '#',
  '# A value the button asks for wins over the same name here.',
].join('\n')

export function globalsFilePath(userDataDir: string): string {
  return path.join(userDataDir, GLOBALS_FILENAME)
}

/**
 * Reads the file's raw text. A missing file is not an error — it just means no
 * globals have been set yet.
 */
export function readGlobalsText(filePath: string): string {
  if (!existsSync(filePath)) return ''

  const stats = statSync(filePath)
  if (stats.size > MAX_GLOBALS_BYTES) {
    throw new Error(
      `${path.basename(filePath)} is ${(stats.size / 1024).toFixed(0)} KB; the limit is ` +
        `${MAX_GLOBALS_BYTES / 1024} KB`
    )
  }

  return readFileSync(filePath, 'utf8')
}

/**
 * Parsed globals for a macro run. Never throws: a broken or unreadable file
 * must not take a button down with it, so it degrades to "no globals" and the
 * problems surface in the editor instead.
 */
export function loadGlobals(filePath: string): ParsedGlobalVars {
  try {
    return parseGlobalVars(readGlobalsText(filePath))
  } catch (error) {
    console.error('Could not read global variables:', error)
    return { vars: [], values: {}, problems: [] }
  }
}

/**
 * Writes the file through a temporary neighbour and renames it into place, so a
 * crash mid-write cannot leave the user with half a variable file.
 */
export function writeGlobalsText(filePath: string, text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_GLOBALS_BYTES) {
    throw new Error(`That is larger than the ${MAX_GLOBALS_BYTES / 1024} KB limit`)
  }

  mkdirSync(path.dirname(filePath), { recursive: true })

  const withHeader = text.trim() === '' ? `${GLOBALS_HEADER}\n` : text
  const body = withHeader.endsWith('\n') ? withHeader : `${withHeader}\n`

  const temporary = `${filePath}.tmp`
  writeFileSync(temporary, body, 'utf8')
  renameSync(temporary, filePath)
}

/** Creates the file with just its header if it is not there yet. */
export function ensureGlobalsFile(filePath: string): string {
  if (!existsSync(filePath)) writeGlobalsText(filePath, '')
  return filePath
}
