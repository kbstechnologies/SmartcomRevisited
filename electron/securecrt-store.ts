import { promises as fs } from 'fs'
import path from 'path'
import {
  parseSessionIni,
  planImport,
  type ImportPlan,
  type SecureCrtSession,
} from '../src/shared/securecrt-import'

/**
 * Walks a SecureCRT session folder and reads every session in it.
 *
 * The folder tree is the hierarchy — there is no index file — so this is a
 * plain recursive read. Kept out of the parser so the parsing stays testable
 * without a filesystem.
 */

/** Depth cap: a store is a handful of levels, and a symlink loop is not. */
const MAX_DEPTH = 12

/** SecureCRT's own bookkeeping, not a session. */
const IGNORED = new Set(['__FolderData__.ini'.toLowerCase()])

/**
 * Reads the store into an import plan.
 *
 * Files are read as UTF-8 with a fallback to UTF-16LE: SecureCRT has written
 * both across versions, and a UTF-16 file read as UTF-8 comes back as text with
 * a NUL between every character — which parses to nothing at all rather than
 * failing, so it would look like an empty store.
 */
export async function readSecureCrtStore(root: string): Promise<ImportPlan & { scanned: number }> {
  const sessions: SecureCrtSession[] = []
  let scanned = 0

  const walk = async (dir: string, folders: string[], depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable subfolder should not abandon the whole import.
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(full, [...folders, entry.name], depth + 1)
        continue
      }

      if (!entry.name.toLowerCase().endsWith('.ini')) continue
      if (IGNORED.has(entry.name.toLowerCase())) continue

      scanned++
      try {
        sessions.push(parseSessionIni(await readText(full), path.basename(entry.name, '.ini'), folders))
      } catch {
        // A single unreadable file is reported by its absence from the plan
        // rather than stopping a store of hundreds.
      }
    }
  }

  await walk(root, [], 0)

  return { ...planImport(sessions), scanned }
}

/** Reads a file that may be UTF-8 or UTF-16LE. */
async function readText(file: string): Promise<string> {
  const buffer = await fs.readFile(file)

  // UTF-16LE BOM. Without this check the content decodes to a string with a NUL
  // between every character, which matches no line and yields an empty session.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le')
  }

  return buffer.toString('utf8')
}
