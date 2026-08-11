import { promises as fs } from 'fs'
import path from 'path'

/**
 * The script library is a plain folder on disk that the app indexes — the user
 * asked for it that way so scripts stay editable in their own editor and can
 * live in git. Nothing is copied into app storage; files are read at send time,
 * so what you edited is what ships.
 */

import type { ScriptEntry } from '../src/shared/types'

export type { ScriptEntry }

/**
 * Scripts are text sent to a shell, so anything oversized is a mistake rather
 * than a script. Also the ceiling on what may be staged on a host.
 */
export const MAX_SCRIPT_BYTES = 1024 * 1024

/** Folders that are never worth showing in a script tree. */
const IGNORED = new Set(['.git', 'node_modules', '.svn', '__pycache__', '.DS_Store'])

/** Guards against symlink loops and pathological trees. */
const MAX_DEPTH = 8

/**
 * Resolves `relativePath` inside `root`, refusing anything that escapes it.
 *
 * The relative path arrives from the renderer and from saved buttons, so it is
 * untrusted input: `../../../../etc/passwd` must not resolve, or a shared
 * button set could exfiltrate arbitrary files off the machine that runs it.
 */
export function resolveInLibrary(root: string, relativePath: string): string {
  if (!root) throw new Error('No script library folder is configured')

  const normalisedRoot = path.resolve(root)
  const target = path.resolve(normalisedRoot, relativePath)
  const relative = path.relative(normalisedRoot, target)

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Script path is outside the library: ${relativePath}`)
  }

  return target
}

/** Reads the library tree, folders first and each level sorted by name. */
export async function listLibrary(root: string): Promise<ScriptEntry[]> {
  if (!root) return []

  const walk = async (dir: string, depth: number): Promise<ScriptEntry[]> => {
    if (depth > MAX_DEPTH) return []

    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // A folder that has been deleted or is unreadable is not an error worth
      // failing the whole tree over.
      return []
    }

    const entries: ScriptEntry[] = []

    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || IGNORED.has(dirent.name)) continue

      const absolute = path.join(dir, dirent.name)
      const relative = path.relative(path.resolve(root), absolute).split(path.sep).join('/')

      let stats
      try {
        stats = await fs.stat(absolute)
      } catch {
        continue
      }

      if (dirent.isDirectory()) {
        entries.push({
          path: relative,
          name: dirent.name,
          type: 'folder',
          size: 0,
          modifiedAt: stats.mtime.toISOString(),
          children: await walk(absolute, depth + 1),
        })
      } else if (dirent.isFile()) {
        entries.push({
          path: relative,
          name: dirent.name,
          type: 'file',
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        })
      }
    }

    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  return walk(path.resolve(root), 0)
}

/** Reads one script for preview or upload. Rejects anything oversized. */
export async function readScript(
  root: string,
  relativePath: string
): Promise<{ path: string; content: string; size: number }> {
  const absolute = resolveInLibrary(root, relativePath)
  const stats = await fs.stat(absolute)

  if (!stats.isFile()) throw new Error(`Not a file: ${relativePath}`)
  if (stats.size > MAX_SCRIPT_BYTES) {
    throw new Error(
      `Script is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_SCRIPT_BYTES / 1024 / 1024} MB`
    )
  }

  return {
    path: relativePath,
    content: await fs.readFile(absolute, 'utf8'),
    size: stats.size,
  }
}
