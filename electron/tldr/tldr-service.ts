/**
 * TldrService — everything the rest of the app asks about tldr.
 *
 * The one rule this class exists to enforce: **a lookup never waits on the
 * network and never waits on disk more than once.** Contextual lookups fire
 * while someone is typing into a live console, so they answer from an index
 * already in memory or they answer "no".
 *
 * Failure is always local. A missing cache, a corrupt index, a download that
 * times out — each degrades to "no tldr for now" and is reported through
 * `getStatus()`. Nothing here can prevent the app starting, and nothing here
 * can prevent a terminal working.
 */

import { EventEmitter } from 'events'
import {
  parseTldrPage,
  platformSearchOrder,
  type TldrPage,
  type TldrPlatform,
  type TldrSearchResult,
  type TldrCacheStatus,
} from '../../src/shared/tldr'
import {
  platformsFor,
  resolvePlatform,
  searchIndex,
  TLDR_INDEX_VERSION,
  type TldrIndexEntry,
} from '../../src/shared/tldr-search'
import {
  DEFAULT_UPDATE_INTERVAL_DAYS,
  buildIndex,
  cacheSize,
  clearCache,
  downloadDataset,
  isStale,
  pageKey,
  readIndex,
  readMeta,
  readPages,
  tldrPaths,
  writeCache,
  type TldrMeta,
  type TldrPaths,
  type TldrProgress,
} from './tldr-store'

export interface TldrServiceOptions {
  cacheDir: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
  /** Injected in tests; the real one is `process.platform`. */
  hostPlatform?: string
  /** Structured debug events. Wired to the app's console logging in main. */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

/** What `tldr-status` carries to the renderer. */
export interface TldrStatusEvent {
  status: TldrCacheStatus
  progress?: TldrProgress
}

export class TldrService extends EventEmitter {
  private readonly paths: TldrPaths
  private readonly fetchImpl: typeof fetch
  private readonly hostPlatform: string
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  /** Index and meta are held in memory once read; pages are read lazily. */
  private entries: TldrIndexEntry[] | null = null
  private meta: TldrMeta | null = null
  private pages: Record<string, string> | null = null

  /** Parsed pages, so opening the same page twice parses once. */
  private parsed = new Map<string, TldrPage>()

  /** The in-flight update, so two callers cannot download at the same time. */
  private updating: Promise<TldrCacheStatus> | null = null
  private lastError: string | null = null
  private lastProgress: TldrProgress | undefined

  constructor(options: TldrServiceOptions) {
    super()
    this.paths = tldrPaths(options.cacheDir)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.hostPlatform = options.hostPlatform ?? process.platform
    this.log = options.log ?? (() => undefined)
  }

  // -------------------------------------------------------------------------
  // Cache lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reads whatever is already on disk. Cheap enough to call on demand, and
   * called lazily rather than in the constructor so nothing is read on the
   * start-up path.
   */
  private load(): TldrIndexEntry[] | null {
    if (this.entries) return this.entries

    this.meta = readMeta(this.paths)
    const index = readIndex(this.paths)
    if (!index) return null

    this.entries = index.entries
    return this.entries
  }

  /**
   * Brings the cache up to date if it needs it, in the background.
   *
   * Called once at start-up. Returns immediately when a usable cache exists and
   * is fresh; when it exists and is stale the *stale cache stays in use* and the
   * refresh happens behind it, because documentation that is a fortnight old is
   * worth far more than a spinner.
   */
  async ensureCache(options: { intervalDays?: number; force?: boolean } = {}): Promise<void> {
    const interval = options.intervalDays ?? DEFAULT_UPDATE_INTERVAL_DAYS
    const index = this.load()

    if (index && !options.force && !isStale(this.meta, interval)) {
      this.log('tldr.cache-fresh', { pages: this.meta?.page_count })
      return
    }

    if (index && !options.force) {
      this.log('tldr.cache-stale', { lastUpdated: this.meta?.last_updated })
    } else if (!index) {
      this.log('tldr.cache-missing')
    }

    try {
      await this.update()
    } catch (error) {
      // Deliberately swallowed: this runs unattended at start-up, and the
      // failure is already recorded in the status the settings screen shows.
      this.log('tldr.update-failed', { error: String(error) })
    }
  }

  /**
   * Downloads the dataset and replaces the cache.
   *
   * Concurrent callers share one download — the settings screen's "Update now"
   * pressed twice, or pressed while the start-up refresh is still running.
   */
  update(): Promise<TldrCacheStatus> {
    if (this.updating) return this.updating

    this.lastError = null
    this.updating = (async () => {
      this.log('tldr.update-start')
      this.emitStatus()

      try {
        const { pages, meta } = await downloadDataset({
          fetchImpl: this.fetchImpl,
          onProgress: (progress) => {
            this.lastProgress = progress
            this.emitStatus(progress)
          },
        })

        const index = writeCache(this.paths, pages, meta, (progress) => {
          this.lastProgress = progress
          this.emitStatus(progress)
        })

        this.entries = index.entries
        this.meta = meta
        this.pages = pages
        this.parsed.clear()
        this.log('tldr.update-done', { pages: meta.page_count, version: meta.dataset_version })
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.log('tldr.update-error', { error: this.lastError })
        throw error
      } finally {
        this.lastProgress = undefined
        this.updating = null
        this.emitStatus()
      }

      return this.getStatus()
    })()

    return this.updating
  }

  /**
   * Rebuilds the search index from the pages already on disk.
   *
   * The repair for a cache whose index is wrong or missing but whose pages are
   * fine, which is what a version bump of the entry shape produces. No network.
   */
  async rebuildIndex(): Promise<TldrCacheStatus> {
    const pages = this.pages ?? readPages(this.paths)
    if (!pages) throw new Error('No cached tldr pages to index. Run an update first.')

    this.log('tldr.rebuild-start', { pages: Object.keys(pages).length })
    const meta: TldrMeta = this.meta ?? {
      last_updated: new Date().toISOString(),
      dataset_version: 'unknown',
      languages: ['en'],
      platforms: [],
      index_version: TLDR_INDEX_VERSION,
      page_count: Object.keys(pages).length,
      source: 'local',
      checksum: null,
    }

    const index = writeCache(this.paths, pages, { ...meta, page_count: Object.keys(pages).length })
    this.entries = index.entries
    this.pages = pages
    this.parsed.clear()
    this.log('tldr.rebuild-done', { entries: index.entries.length })
    this.emitStatus()
    return this.getStatus()
  }

  /** Deletes the cache. The next `ensureCache` downloads it again. */
  async clear(): Promise<TldrCacheStatus> {
    clearCache(this.paths)
    this.entries = null
    this.meta = null
    this.pages = null
    this.parsed.clear()
    this.lastError = null
    this.log('tldr.cache-cleared')
    this.emitStatus()
    return this.getStatus()
  }

  getStatus(): TldrCacheStatus {
    const entries = this.load()
    return {
      ready: Boolean(entries && entries.length > 0),
      busy: this.updating !== null,
      lastUpdated: this.meta?.last_updated ?? null,
      datasetVersion: this.meta?.dataset_version ?? null,
      languages: this.meta?.languages ?? [],
      platforms: this.meta?.platforms ?? [],
      indexVersion: this.meta?.index_version ?? TLDR_INDEX_VERSION,
      pageCount: entries?.length ?? 0,
      cacheDir: this.paths.dir,
      error: this.lastError,
      hostPlatform: this.hostPlatform,
    }
  }

  /** Bytes on disk, for the settings screen. */
  getCacheSize(): number {
    return cacheSize(this.paths)
  }

  private emitStatus(progress?: TldrProgress): void {
    const event: TldrStatusEvent = { status: this.getStatus(), progress: progress ?? this.lastProgress }
    this.emit('status', event)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Does a page exist for this command on this platform, and which one.
   *
   * The hot path: called on a debounce while someone is typing. Index-only —
   * it never touches `pages.json`, so it costs one array scan and no I/O.
   */
  lookup(command: string, platform: string): { found: boolean; platform: TldrPlatform | null } {
    const entries = this.load()
    if (!entries || !command) return { found: false, platform: null }

    const resolved = resolvePlatform(entries, command, platform)
    return { found: resolved !== null, platform: resolved }
  }

  /** Ranked search over commands, descriptions and example text. */
  search(query: string, platform: string, limit = 40): TldrSearchResult[] {
    const entries = this.load()
    if (!entries) return []
    return searchIndex(entries, query, { platform, limit })
  }

  /**
   * A parsed page, or null when there is none.
   *
   * `platform` is the session's platform, not necessarily the page's: the
   * preference order decides which variant is returned, and the returned page
   * says which one that was.
   */
  getPage(command: string, platform: string): TldrPage | null {
    const entries = this.load()
    if (!entries || !command) return null

    const resolved = resolvePlatform(entries, command, platform)
    if (!resolved) return null
    return this.getExactPage(command, resolved)
  }

  /** A page on one specific platform, for the panel's platform switcher. */
  getExactPage(command: string, platform: TldrPlatform): TldrPage | null {
    const entries = this.load()
    if (!entries) return null

    // The index holds the canonical spelling; the caller may have any case.
    const entry = entries.find(
      (candidate) => candidate.c.toLowerCase() === command.toLowerCase() && candidate.p === platform
    )
    if (!entry) return null

    const key = pageKey(platform, entry.c)
    const cached = this.parsed.get(key)
    if (cached) return cached

    const pages = this.loadPages()
    const markdown = pages?.[key]
    if (!markdown) {
      // Indexed but not present: the pages file is out of step with the index.
      this.log('tldr.page-missing', { key })
      return null
    }

    try {
      const page = parseTldrPage(markdown, { command: entry.c, platform })
      page.otherPlatforms = platformsFor(entries, entry.c).filter((item) => item !== platform)
      this.parsed.set(key, page)
      return page
    } catch (error) {
      this.log('tldr.parse-error', { key, error: String(error) })
      return null
    }
  }

  /** Every platform that documents a command. */
  getPlatforms(command: string): TldrPlatform[] {
    const entries = this.load()
    if (!entries) return []
    return platformsFor(entries, command)
  }

  /**
   * Related commands: pages whose examples mention this one.
   *
   * Cheap and surprisingly good — `tcpdump` surfaces `tshark` because the
   * Wireshark pages reference each other. Capped tightly; this is a footnote in
   * the panel, not a feature.
   */
  getRelated(command: string, platform: string, limit = 5): TldrSearchResult[] {
    if (!command) return []
    return this.search(command, platform, limit + 1).filter(
      (result) => result.command.toLowerCase() !== command.toLowerCase()
    ).slice(0, limit)
  }

  /**
   * Loads the raw pages file on first use.
   *
   * Deferred until someone actually opens a page: the indicator and the search
   * box both work off the index alone, so a session where nobody opens the
   * panel never pays for reading four megabytes.
   */
  private loadPages(): Record<string, string> | null {
    if (this.pages) return this.pages
    this.pages = readPages(this.paths)
    if (!this.pages) this.log('tldr.pages-unreadable', { path: this.paths.pages })
    return this.pages
  }

  /** Exposed for tests and for the "rebuild" path. */
  rebuildIndexInMemory(pages: Record<string, string>): void {
    this.entries = buildIndex(pages).entries
    this.pages = pages
    this.parsed.clear()
  }

  /** Platform preference order, so main can report what it searched. */
  static searchOrder(platform: string): TldrPlatform[] {
    return platformSearchOrder(platform)
  }
}
