import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TldrService } from './tldr-service'
import {
  TLDR_ARCHIVE_NAME,
  TLDR_ARCHIVE_URL,
  TLDR_CHECKSUMS_URL,
  buildIndex,
  isStale,
  readMeta,
  tldrPaths,
} from './tldr-store'

/**
 * Exercises the whole cache path with a real ZIP, because the parts that break
 * are the seams: what the archive layout is, what happens when a download only
 * half-succeeds, and whether a corrupt cache degrades or explodes.
 */

const page = (command: string, description: string, examples: string) =>
  `# ${command}\n\n> ${description}\n> More information: <https://example.com/${command}>.\n\n${examples}`

const PAGES: Record<string, string> = {
  'common/tcpdump.md': page(
    'tcpdump',
    'Dump traffic on a network.',
    '- Capture the traffic of a specific interface:\n\n`sudo tcpdump {{[-i|--interface]}} {{eth0}}`\n'
  ),
  'common/rsync.md': page(
    'rsync',
    'Transfer files to or from a remote host.',
    '- Transfer a file:\n\n`rsync {{path/to/source}} {{path/to/destination}}`\n'
  ),
  'linux/ip.md': page(
    'ip',
    'Show / manipulate routing, devices and tunnels.',
    '- Show routes:\n\n`ip route show`\n'
  ),
  'linux/systemctl.md': page(
    'systemctl',
    'Control the systemd system and service manager.',
    '- Restart a service:\n\n`systemctl restart {{nginx}}`\n'
  ),
  'windows/systeminfo.md': page(
    'systeminfo',
    'Display operating system configuration.',
    '- Show the configuration:\n\n`systeminfo`\n'
  ),
  'cisco-ios/show.md': page('show', 'Show various system information.', '- Running config:\n\n`show running-config`\n'),
  // Present in the real archive at the root, and not a page.
  'LICENSE.md': '# Licence\n',
  // A platform we do not model; must be skipped, not crash the index.
  'plan9/rc.md': page('rc', 'The Plan 9 shell.', '- Nothing:\n\n`rc`\n'),
}

const archive = (): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(PAGES).map(([name, body]) => [name, strToU8(body)])))

/** A fetch that serves the archive and a matching checksums file. */
function fakeFetch(options: { corruptChecksum?: boolean; failArchive?: boolean } = {}) {
  const bytes = archive()
  const digest = createHash('sha256').update(bytes).digest('hex')

  return vi.fn(async (url: string) => {
    if (url === TLDR_ARCHIVE_URL) {
      if (options.failArchive) return { ok: false, status: 503 } as any
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(bytes.byteLength)]]),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as any
    }
    if (url === TLDR_CHECKSUMS_URL) {
      const hash = options.corruptChecksum ? 'deadbeef'.repeat(8) : digest
      return { ok: true, status: 200, text: async () => `${hash}  ${TLDR_ARCHIVE_NAME}\n` } as any
    }
    // The release API, for the version label.
    return { ok: true, status: 200, json: async () => ({ tag_name: 'v9.9' }) } as any
  }) as unknown as typeof fetch
}

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'smartcom-tldr-'))
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

const service = (fetchImpl: typeof fetch, hostPlatform = 'linux') =>
  new TldrService({ cacheDir, fetchImpl, hostPlatform })

describe('first run', () => {
  it('reports itself unavailable before anything is downloaded', () => {
    const status = service(fakeFetch()).getStatus()
    expect(status.ready).toBe(false)
    expect(status.pageCount).toBe(0)
    expect(status.error).toBeNull()
  })

  it('downloads, extracts and indexes the archive', async () => {
    const tldr = service(fakeFetch())
    await tldr.ensureCache()

    const status = tldr.getStatus()
    expect(status.ready).toBe(true)
    expect(status.datasetVersion).toBe('v9.9')
    expect(status.languages).toEqual(['en'])
    expect(status.platforms).toEqual(
      expect.arrayContaining(['common', 'linux', 'windows', 'cisco-ios'])
    )
    // LICENSE.md and the unmodelled platform are not pages.
    expect(status.pageCount).toBe(6)
  })

  it('writes meta last, so a half-written cache reads as absent', async () => {
    const tldr = service(fakeFetch())
    await tldr.update()

    const paths = tldrPaths(cacheDir)
    const meta = readMeta(paths)
    expect(meta?.page_count).toBe(6)
    expect(meta?.checksum).toBeTruthy()
  })
})

describe('lookup', () => {
  let tldr: TldrService

  beforeEach(async () => {
    tldr = service(fakeFetch())
    await tldr.ensureCache()
  })

  it('finds a common page for a Linux session', () => {
    expect(tldr.lookup('tcpdump', 'linux')).toEqual({ found: true, platform: 'common' })
  })

  it('prefers the platform-specific page', () => {
    expect(tldr.lookup('ip', 'linux').platform).toBe('linux')
    expect(tldr.lookup('systeminfo', 'windows').platform).toBe('windows')
  })

  it('gives a switch its own page rather than a Linux one', () => {
    expect(tldr.lookup('show', 'cisco-ios').platform).toBe('cisco-ios')
  })

  it('reports honestly when nothing documents a command', () => {
    expect(tldr.lookup('definitely-not-a-command', 'linux')).toEqual({
      found: false,
      platform: null,
    })
  })

  it('is not fooled by an empty command', () => {
    expect(tldr.lookup('', 'linux').found).toBe(false)
  })

  it('returns a parsed page, not markdown', () => {
    const page = tldr.getPage('tcpdump', 'linux')
    expect(page).toMatchObject({
      command: 'tcpdump',
      platform: 'common',
      description: ['Dump traffic on a network.'],
      moreInfo: 'https://example.com/tcpdump',
    })
    expect(page?.examples[0].placeholders.map((item) => item.token)).toEqual([
      '[-i|--interface]',
      'eth0',
    ])
  })

  it('names the other platforms that document the same command', () => {
    expect(tldr.getPage('tcpdump', 'linux')?.otherPlatforms).toEqual([])
    expect(tldr.getPlatforms('ip')).toEqual(['linux'])
  })

  it('can be asked for one specific platform variant', () => {
    expect(tldr.getExactPage('show', 'cisco-ios')?.command).toBe('show')
    expect(tldr.getExactPage('show', 'linux')).toBeNull()
  })
})

describe('search', () => {
  let tldr: TldrService

  beforeEach(async () => {
    tldr = service(fakeFetch())
    await tldr.ensureCache()
  })

  it('finds by exact name', () => {
    expect(tldr.search('rsync', 'linux')[0].command).toBe('rsync')
  })

  it('finds by description', () => {
    expect(tldr.search('routing', 'linux')[0].command).toBe('ip')
  })

  it('finds by what you want to do', () => {
    expect(tldr.search('restart a service', 'linux')[0].command).toBe('systemctl')
  })

  it('returns nothing rather than throwing when there is no cache', () => {
    const empty = mkdtempSync(join(tmpdir(), 'smartcom-tldr-empty-'))
    try {
      const cold = new TldrService({ cacheDir: empty, fetchImpl: fakeFetch() })
      expect(cold.search('rsync', 'linux')).toEqual([])
      expect(cold.getPage('rsync', 'linux')).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('failures degrade, they do not throw', () => {
  it('survives a download failure and records why', async () => {
    const tldr = service(fakeFetch({ failArchive: true }))
    // ensureCache is the unattended start-up path: it must never reject.
    await expect(tldr.ensureCache()).resolves.toBeUndefined()

    const status = tldr.getStatus()
    expect(status.ready).toBe(false)
    expect(status.error).toContain('503')
    // And the app can still ask it questions.
    expect(tldr.lookup('tcpdump', 'linux').found).toBe(false)
  })

  it('refuses an archive whose checksum does not match', async () => {
    const tldr = service(fakeFetch({ corruptChecksum: true }))
    await expect(tldr.update()).rejects.toThrow(/checksum/i)
    expect(tldr.getStatus().ready).toBe(false)
  })

  it('treats a corrupt index as no index at all', async () => {
    const tldr = service(fakeFetch())
    await tldr.ensureCache()

    const paths = tldrPaths(cacheDir)
    writeFileSync(paths.index, '{ this is not json', 'utf8')

    const fresh = service(fakeFetch())
    expect(fresh.getStatus().ready).toBe(false)
    expect(() => fresh.search('rsync', 'linux')).not.toThrow()
  })

  it('rebuilds the index from the pages already on disk, without a network', async () => {
    const tldr = service(fakeFetch())
    await tldr.ensureCache()
    writeFileSync(tldrPaths(cacheDir).index, 'broken', 'utf8')

    const offline = new TldrService({
      cacheDir,
      hostPlatform: 'linux',
      fetchImpl: (() => {
        throw new Error('the network must not be touched by a rebuild')
      }) as unknown as typeof fetch,
    })

    await offline.rebuildIndex()
    expect(offline.getStatus().ready).toBe(true)
    expect(offline.lookup('rsync', 'linux').found).toBe(true)
  })

  it('refuses to rebuild when there are no pages to rebuild from', async () => {
    await expect(service(fakeFetch()).rebuildIndex()).rejects.toThrow(/update/i)
  })

  it('clears the cache and reports itself unavailable again', async () => {
    const tldr = service(fakeFetch())
    await tldr.ensureCache()
    expect(tldr.getStatus().ready).toBe(true)

    await tldr.clear()
    expect(tldr.getStatus().ready).toBe(false)
    expect(tldr.getCacheSize()).toBe(0)
  })
})

describe('update policy', () => {
  it('does not re-download a fresh cache', async () => {
    const fetchImpl = fakeFetch()
    const tldr = service(fetchImpl)
    await tldr.ensureCache()

    const callsAfterFirst = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await tldr.ensureCache()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirst
    )
  })

  it('shares one download between concurrent callers', async () => {
    const fetchImpl = fakeFetch()
    const tldr = service(fetchImpl)

    await Promise.all([tldr.update(), tldr.update(), tldr.update()])

    const archiveCalls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => url === TLDR_ARCHIVE_URL
    )
    expect(archiveCalls).toHaveLength(1)
  })

  it('knows when a cache has gone stale', () => {
    const now = Date.parse('2026-01-10T00:00:00Z')
    const meta = (days: number) => ({
      last_updated: new Date(now - days * 86_400_000).toISOString(),
      dataset_version: 'v1',
      languages: ['en'],
      platforms: [],
      index_version: 1,
      page_count: 1,
      source: '',
      checksum: null,
    })

    expect(isStale(meta(3), 7, now)).toBe(false)
    expect(isStale(meta(8), 7, now)).toBe(true)
    expect(isStale(null, 7, now)).toBe(true)
    expect(isStale({ ...meta(1), last_updated: 'nonsense' }, 7, now)).toBe(true)
  })
})

describe('the index built from pages', () => {
  it('skips non-pages and unmodelled platforms', () => {
    const index = buildIndex(
      Object.fromEntries(
        Object.entries(PAGES).map(([name, body]) => [name.replace(/\.md$/, ''), body])
      )
    )
    expect(index.entries.map((entry) => entry.c).sort()).toEqual([
      'ip',
      'rsync',
      'show',
      'systemctl',
      'systeminfo',
      'tcpdump',
    ])
  })

  it('indexes example text so intent searches can work', () => {
    const index = buildIndex({ 'common/tcpdump': PAGES['common/tcpdump.md'] })
    expect(index.entries[0].k).toContain('capture the traffic')
    expect(index.entries[0].k).toContain('tcpdump')
  })
})

describe('licence attribution travels with the data', () => {
  it('is documented where the cache lives', () => {
    // The archive carries upstream's own LICENSE.md; the app's notice lives in
    // the About dialog and docs/TLDR_INTEGRATION.md. This test keeps the doc
    // from being deleted quietly along with the feature.
    const doc = readFileSync(
      join(__dirname, '../../docs/TLDR_INTEGRATION.md'),
      'utf8'
    )
    expect(doc).toMatch(/CC[ -]BY[ -]4\.0/i)
    expect(doc).toContain('tldr-pages')
  })
})
