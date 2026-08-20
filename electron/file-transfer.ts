import { promises as fs } from 'fs'
import path from 'path'

/**
 * Local-path handling for `upload` and `download` steps.
 *
 * Every path here can come from a button somebody else wrote and shared through
 * the exchange, which makes this a trust boundary rather than a convenience
 * layer. Two attacks it exists to stop:
 *
 *  - **Download escaping the transfer folder.** A `localPath` of
 *    `../../../.ssh/authorized_keys` would let a shared button overwrite files
 *    outside anywhere the operator agreed to.
 *  - **Upload exfiltrating a local file.** This is the nastier one, because it
 *    reads rather than writes: a button with `localPath: ~/.ssh/id_ed25519` and
 *    a `remotePath` on the author's own host would quietly post the operator's
 *    private key to it. Nothing about the button would look wrong while running.
 *
 * So both directions are confined to a configured root. It costs the ability to
 * grab a file from anywhere on disk, which is a real limitation and is why the
 * error says exactly where files are expected to live.
 */

/** Fallback name when the remote path has nothing usable on the end. */
const FALLBACK_NAME = 'download'

/**
 * Resolves a local path inside `root`, refusing anything that escapes it.
 *
 * Mirrors `resolveInLibrary` deliberately — one traversal check written twice
 * is how the second one ends up subtly weaker.
 */
export function resolveInTransferDir(root: string, requested: string): string {
  if (!root) {
    throw new Error(
      'No transfer folder is configured. Set one in Settings before a button can upload or download.'
    )
  }

  const normalisedRoot = path.resolve(root)
  const target = path.resolve(normalisedRoot, requested)
  const relative = path.relative(normalisedRoot, target)

  // `relative === ''` means the path resolved to the root itself, which is a
  // directory — never a valid file to read or write.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `"${requested}" is outside the transfer folder. Files must sit under ${normalisedRoot} — ` +
        'a button cannot reach elsewhere on this machine.'
    )
  }

  return target
}

/**
 * Turns a remote path into the local filename to save it as.
 *
 * POSIX-only splitting: the remote is a Unix host whatever this machine runs,
 * so `path.basename` on Windows would treat a backslash in a filename as a
 * separator and silently truncate the name.
 */
export function localNameForRemote(remotePath: string): string {
  const trimmed = remotePath.trim().replace(/\/+$/, '')
  const name = trimmed.split('/').pop() ?? ''
  // A remote path of "/" or "" leaves nothing to name the file after.
  return name || FALLBACK_NAME
}

/**
 * Picks a free filename, so a second capture never silently replaces the first.
 *
 * Collecting the same file twice is normal — the same button run against the
 * same host an hour later — and overwriting is the outcome nobody asks for.
 */
export async function uniqueLocalPath(desired: string): Promise<string> {
  const dir = path.dirname(desired)
  const extension = path.extname(desired)
  const stem = path.basename(desired, extension)

  let candidate = desired
  let counter = 2

  // Bounded: a directory holding thousands of collisions is a bug of its own,
  // and an unbounded loop here would hang the run.
  while (counter < 1000) {
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
    candidate = path.join(dir, `${stem} (${counter})${extension}`)
    counter++
  }

  throw new Error(`Could not find a free filename for ${desired}`)
}

/** Creates the directory a download is about to be written into. */
export async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
}

/**
 * Human-readable size, for the progress line and the audit entry.
 *
 * Deliberately not localised: it goes into log files and audit rows that get
 * pasted into tickets, where a comma decimal separator reads as a typo.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
