import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeFeeds } = require('./merge-mac-feed.js')

/**
 * The two macOS runners each write a latest-mac.yml describing only their own
 * architecture, and both attach it to the release. Without this merge the
 * second upload wins and half the Macs are offered a build they cannot run.
 *
 * The sha512 values matter character for character — electron-updater verifies
 * the download against them — so these tests check the merged text keeps them
 * verbatim rather than checking a re-parsed object.
 */
const ARM64 = [
  'version: 1.5.0',
  'files:',
  '  - url: SmartcomRevisited-1.5.0-arm64-mac.zip',
  '    sha512: QUJDREVGarm64zip==',
  '    size: 104857600',
  '  - url: SmartcomRevisited-1.5.0-arm64.dmg',
  '    sha512: QUJDREVGarm64dmg==',
  '    size: 109051904',
  'path: SmartcomRevisited-1.5.0-arm64-mac.zip',
  'sha512: QUJDREVGarm64zip==',
  "releaseDate: '2026-08-20T13:20:00.000Z'",
  '',
].join('\n')

const X64 = [
  'version: 1.5.0',
  'files:',
  '  - url: SmartcomRevisited-1.5.0-x64-mac.zip',
  '    sha512: QUJDREVGx64zip==',
  '    size: 110100480',
  '  - url: SmartcomRevisited-1.5.0-x64.dmg',
  '    sha512: QUJDREVGx64dmg==',
  '    size: 115343360',
  'path: SmartcomRevisited-1.5.0-x64-mac.zip',
  'sha512: QUJDREVGx64zip==',
  "releaseDate: '2026-08-20T13:31:00.000Z'",
  '',
].join('\n')

describe('mergeFeeds', () => {
  it('lists every file from both architectures', () => {
    const merged = mergeFeeds([X64, ARM64], ['x64', 'arm64'])
    for (const url of [
      'SmartcomRevisited-1.5.0-x64-mac.zip',
      'SmartcomRevisited-1.5.0-x64.dmg',
      'SmartcomRevisited-1.5.0-arm64-mac.zip',
      'SmartcomRevisited-1.5.0-arm64.dmg',
    ]) {
      expect(merged).toContain('url: ' + url)
    }
    expect(merged.match(/^ {2}- /gm)).toHaveLength(4)
  })

  it('copies the checksums verbatim', () => {
    const merged = mergeFeeds([X64, ARM64], ['x64', 'arm64'])
    expect(merged).toContain('sha512: QUJDREVGarm64dmg==')
    expect(merged).toContain('sha512: QUJDREVGx64dmg==')
  })

  it('keeps the primary feed outside the files list, so the legacy fallback is Intel', () => {
    const merged = mergeFeeds([X64, ARM64], ['x64', 'arm64'])
    expect(merged).toContain('path: SmartcomRevisited-1.5.0-x64-mac.zip')
    expect(merged).toContain("releaseDate: '2026-08-20T13:31:00.000Z'")
    expect(merged).not.toContain('path: SmartcomRevisited-1.5.0-arm64-mac.zip')
    expect(merged.match(/^version: /gm)).toHaveLength(1)
  })

  it('is idempotent, so re-running never duplicates an entry', () => {
    const once = mergeFeeds([X64, ARM64], ['x64', 'arm64'])
    const twice = mergeFeeds([once, ARM64], ['merged', 'arm64'])
    expect(twice).toBe(once)
  })

  it('refuses to merge feeds for different versions', () => {
    const other = X64.replace('version: 1.5.0', 'version: 1.6.0')
    expect(() => mergeFeeds([other, ARM64], ['x64', 'arm64'])).toThrow(/disagree on version/)
  })

  it('refuses a feed with no files block', () => {
    expect(() => mergeFeeds(['version: 1.5.0\n', ARM64], ['broken', 'arm64'])).toThrow(/files:/)
  })
})
