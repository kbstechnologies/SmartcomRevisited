/**
 * Where tldr data lives on disk, and how it gets there.
 *
 * The app owns its own copy of the dataset. Nothing here depends on a `tldr`
 * client being installed, and nothing here reaches the network on the path
 * between a keystroke and a lookup — a contextual lookup only ever reads an
 * index that is already in memory.
 *
 * Layout, under `<userData>/tldr/`:
 *
 *     meta.json    what we have, where it came from, when
 *     pages.json   { "<platform>/<command>": "<raw markdown>" }
 *     index.json   the search index, rebuilt from pages.json
 *
 * One file per artefact rather than 7,500 markdown files: extraction is a
 * single write instead of thousands of them, which on Windows is the difference
 * between a second and a minute, and a half-finished extraction cannot leave
 * the cache in a state where some pages exist and others do not.
 */

import { createHash } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { unzipSync } from 'fflate'
import { isTldrPlatform, parseTldrPage } from '../../src/shared/tldr'
import { TLDR_INDEX_VERSION, type TldrIndexEntry, type TldrIndexFile } from '../../src/shared/tldr-search'

/**
 * The English page archive from the project's own releases.
 *
 * `latest/download/` rather than a pinned tag so an install picks up the
 * current dataset without an app update, and rather than the GitHub API so the
 * common path is not subject to the API's unauthenticated rate limit. The API
 * is consulted separately, and only to learn the version number for display.
 *
 * Explicitly not tldr.sh HTML: these are the assets the project publishes for
 * clients to consume.
 */
export const TLDR_RELEASE_BASE = 'https://github.com/tldr-pages/tldr/releases/latest/download'
export const TLDR_ARCHIVE_URL = `${TLDR_RELEASE_BASE}/tldr-pages.en.zip`
export const TLDR_CHECKSUMS_URL = `${TLDR_RELEASE_BASE}/tldr.sha256sums`
export const TLDR_ARCHIVE_NAME = 'tldr-pages.en.zip'
export const TLDR_RELEASE_API = 'https://api.github.com/repos/tldr-pages/tldr/releases/latest'

/** Refuse anything wildly larger than the real archive (about 3.3 MB). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** How old the cache may get before an automatic refresh is attempted. */
export const DEFAULT_UPDATE_INTERVAL_DAYS = 7

export interface TldrMeta {
  last_updated: string
  dataset_version: string
  languages: string[]
  platforms: string[]
  index_version: number
  page_count: number
  source: string
  /** SHA-256 of the archive, when the checksums file could be read. */
  checksum: string | null
}

export interface TldrPaths {
  dir: string
  meta: string
  pages: string
  index: string
}

export function tldrPaths(cacheDir: string): TldrPaths {
  return {
    dir: cacheDir,
    meta: join(cacheDir, 'meta.json'),
    pages: join(cacheDir, 'pages.json'),
    index: join(cacheDir, 'index.json'),
  }
}

/** `platform/command` — the key used by both files and by lookup. */
export const pageKey = (platform: string, command: string) => `${platform}/${command}`

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Reads a JSON file, treating any failure as "not there".
 *
 * A cache is a convenience, so a corrupt one must degrade to "no tldr" and
 * never to a crash — a truncated write from a machine that lost power at the
 * wrong moment is a routine event, not an exceptional one.
 */
function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export const readMeta = (paths: TldrPaths): TldrMeta | null => readJson<TldrMeta>(paths.meta)

export function readIndex(paths: TldrPaths): TldrIndexFile | null {
  const file = readJson<TldrIndexFile>(paths.index)
  if (!file || !Array.isArray(file.entries)) return null
  // A stale index is not an error, but it is not usable either: the entry shape
  // it was written with is not the shape this build reads.
  if (file.indexVersion !== TLDR_INDEX_VERSION) return null
  return file
}

export const readPages = (paths: TldrPaths): Record<string, string> | null =>
  readJson<Record<string, string>>(paths.pages)

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Builds the search index from raw pages.
 *
 * Parsing every page to index it is the expensive part — a couple of seconds
 * for the full corpus — and it happens once, after a download or on an explicit
 * rebuild, never on a lookup.
 */
export function buildIndex(pages: Record<string, string>): TldrIndexFile {
  const entries: TldrIndexEntry[] = []

  for (const [key, markdown] of Object.entries(pages)) {
    const slash = key.indexOf('/')
    if (slash === -1) continue
    const platform = key.slice(0, slash)
    const command = key.slice(slash + 1)
    if (!isTldrPlatform(platform)) continue

    try {
      const page = parseTldrPage(markdown, { command, platform })
      entries.push({
        c: page.command,
        p: platform,
        d: page.description[0] ?? '',
        // Example prose and the command templates both, so "capture packets"
        // and "-i eth0" are each findable.
        k: page.examples
          .map((example) => `${example.description} ${example.template}`)
          .join('  ')
          .toLowerCase(),
        n: page.examples.length,
      })
    } catch {
      // One malformed page must not cost the other 7,454.
      continue
    }
  }

  entries.sort((a, b) => a.c.localeCompare(b.c) || a.p.localeCompare(b.p))

  return { indexVersion: TLDR_INDEX_VERSION, builtAt: new Date().toISOString(), entries }
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

export type TldrProgressPhase = 'downloading' | 'extracting' | 'indexing' | 'writing'

export interface TldrProgress {
  phase: TldrProgressPhase
  /** Bytes received, during `downloading`. */
  received?: number
  /** Total bytes, when the server declared a length. */
  total?: number
  /** Pages seen so far, during `extracting`. */
  pages?: number
}

export interface DownloadOptions {
  onProgress?: (progress: TldrProgress) => void
  signal?: AbortSignal
  /** Injected in tests; the real one is the global. */
  fetchImpl?: typeof fetch
}

/**
 * Fetches the expected SHA-256 of the archive from the release's checksums file.
 *
 * Best effort: the checksums file is a separate asset and a network that served
 * the archive may still fail to serve this. A missing checksum downgrades to
 * "unverified" rather than blocking the update, but a checksum that is present
 * and wrong stops it.
 */
async function expectedChecksum(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchImpl(TLDR_CHECKSUMS_URL, { signal })
    if (!response.ok) return null
    const body = await response.text()
    for (const line of body.split(/\r?\n/)) {
      const [hash, name] = line.trim().split(/\s+/)
      if (name && name.replace(/^\*/, '') === TLDR_ARCHIVE_NAME) return hash.toLowerCase()
    }
    return null
  } catch {
    return null
  }
}

/** The release tag, purely so the settings screen can name what is installed. */
async function releaseVersion(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetchImpl(TLDR_RELEASE_API, {
      signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'smartcom-revisited' },
    })
    if (!response.ok) return 'latest'
    const body = (await response.json()) as { tag_name?: string }
    return body.tag_name || 'latest'
  } catch {
    // Rate-limited or offline-ish. The pages are what matter.
    return 'latest'
  }
}

export interface DownloadResult {
  pages: Record<string, string>
  meta: TldrMeta
}

/**
 * Downloads and unpacks the dataset, without touching disk.
 *
 * Kept separate from the write so a failure part-way through leaves the
 * existing cache exactly as it was — the operator keeps working with slightly
 * stale documentation instead of losing it to a flaky connection.
 */
export async function downloadDataset(options: DownloadOptions = {}): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const { onProgress, signal } = options

  onProgress?.({ phase: 'downloading', received: 0 })

  const response = await fetchImpl(TLDR_ARCHIVE_URL, { signal })
  if (!response.ok) {
    throw new Error(`tldr archive download failed: HTTP ${response.status}`)
  }

  const declared = Number(response.headers.get('content-length')) || undefined
  if (declared && declared > MAX_ARCHIVE_BYTES) {
    throw new Error('tldr archive is implausibly large; refusing to download it')
  }

  const archive = new Uint8Array(await response.arrayBuffer())
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('tldr archive is implausibly large; refusing to unpack it')
  }
  onProgress?.({ phase: 'downloading', received: archive.byteLength, total: declared })

  const actual = createHash('sha256').update(archive).digest('hex')
  const expected = await expectedChecksum(fetchImpl, signal)
  if (expected && expected !== actual) {
    throw new Error('tldr archive failed its checksum; the download was not used')
  }

  onProgress?.({ phase: 'extracting', pages: 0 })

  const files = unzipSync(archive)
  const pages: Record<string, string> = {}
  const platforms = new Set<string>()

  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.md')) continue
    const parts = name.split('/')
    // Entries are `<platform>/<command>.md`; the archive's own LICENSE.md sits
    // at the root and is not a page.
    if (parts.length !== 2) continue

    const [platform, file] = parts
    if (!isTldrPlatform(platform)) continue
    const command = file.slice(0, -3)
    if (!command) continue

    pages[pageKey(platform, command)] = Buffer.from(bytes).toString('utf8')
    platforms.add(platform)
  }

  if (Object.keys(pages).length === 0) {
    throw new Error('tldr archive contained no pages')
  }

  onProgress?.({ phase: 'extracting', pages: Object.keys(pages).length })

  const meta: TldrMeta = {
    last_updated: new Date().toISOString(),
    dataset_version: await releaseVersion(fetchImpl, signal),
    languages: ['en'],
    platforms: [...platforms].sort(),
    index_version: TLDR_INDEX_VERSION,
    page_count: Object.keys(pages).length,
    source: TLDR_ARCHIVE_URL,
    checksum: expected ? actual : null,
  }

  return { pages, meta }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Writes pages, index and meta.
 *
 * `meta.json` is written **last** and deliberately: it is what the service
 * treats as proof the cache is complete, so a crash between the pages and the
 * index leaves a cache that reports itself as absent and gets rebuilt, rather
 * than one that reports itself as ready and answers nothing.
 */
export function writeCache(
  paths: TldrPaths,
  pages: Record<string, string>,
  meta: TldrMeta,
  onProgress?: (progress: TldrProgress) => void
): TldrIndexFile {
  mkdirSync(paths.dir, { recursive: true })

  onProgress?.({ phase: 'writing' })
  writeFileSync(paths.pages, JSON.stringify(pages), 'utf8')

  onProgress?.({ phase: 'indexing' })
  const index = buildIndex(pages)
  writeFileSync(paths.index, JSON.stringify(index), 'utf8')

  writeFileSync(paths.meta, JSON.stringify({ ...meta, index_version: index.indexVersion }, null, 2), 'utf8')
  return index
}

/** Removes the whole cache directory. Next start downloads it again. */
export function clearCache(paths: TldrPaths): void {
  rmSync(paths.dir, { recursive: true, force: true })
}

/** Bytes the cache occupies, for the settings screen. Zero when absent. */
export function cacheSize(paths: TldrPaths): number {
  let total = 0
  for (const file of [paths.meta, paths.pages, paths.index]) {
    try {
      total += statSync(file).size
    } catch {
      /* missing files contribute nothing */
    }
  }
  return total
}

/** Whether the cache is older than the configured refresh interval. */
export function isStale(meta: TldrMeta | null, intervalDays: number, now = Date.now()): boolean {
  if (!meta?.last_updated) return true
  const age = now - Date.parse(meta.last_updated)
  if (Number.isNaN(age)) return true
  return age > intervalDays * 24 * 60 * 60 * 1000
}
