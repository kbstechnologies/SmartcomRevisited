import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { refreshFeed } = require('./appimage-update-info.js')

/**
 * electron-builder hashes the AppImage, then this tool rewrites bytes inside
 * that same file to add the update information. The section is fixed-size, so
 * the length never changes and the stale hash in latest-linux.yml looks
 * plausible — 1.5.0 shipped with one, and electron-updater rejects the download
 * it has just made.
 */
const APPIMAGE = 'SmartcomRevisited-9.9.9-x86_64.AppImage'
const DEB_SHA = 'ZGViaGFzaA=='
const RPM_SHA = 'cnBtaGFzaA=='

function feed(appImageSha: string) {
  return [
    'version: 9.9.9',
    'files:',
    '  - url: ' + APPIMAGE,
    '    sha512: ' + appImageSha,
    '    size: 999',
    '    blockMapSize: 111',
    '  - url: SmartcomRevisited-9.9.9-amd64.deb',
    '    sha512: ' + DEB_SHA,
    '    size: 222',
    '  - url: SmartcomRevisited-9.9.9-x86_64.rpm',
    '    sha512: ' + RPM_SHA,
    '    size: 333',
    'path: ' + APPIMAGE,
    'sha512: ' + appImageSha,
    "releaseDate: '2026-08-20T00:08:59.106Z'",
    '',
  ].join('\n')
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'appimage-feed-'))
  const image = join(dir, APPIMAGE)
  const body = Buffer.from('an AppImage, patched in place after hashing')
  writeFileSync(image, body)
  const feedPath = join(dir, 'latest-linux.yml')
  writeFileSync(feedPath, feed('c3RhbGVoYXNo'))
  const expected = createHash('sha512').update(body).digest('base64')
  return { image, feedPath, expected, size: body.length }
}

describe('refreshFeed', () => {
  it('rewrites the AppImage hash to match the file on disk', () => {
    const { image, feedPath, expected, size } = fixture()
    refreshFeed(image, feedPath)
    const text = readFileSync(feedPath, 'utf8')
    expect(text).toContain('    sha512: ' + expected)
    expect(text).toContain('    size: ' + size)
    expect(text).not.toContain('c3RhbGVoYXNo')
  })

  it('leaves the deb and the rpm alone', () => {
    // The first version of this walked past the AppImage entry into the next
    // ones — they are indented too — and stamped its hash over both.
    const { image, feedPath } = fixture()
    refreshFeed(image, feedPath)
    const text = readFileSync(feedPath, 'utf8')
    expect(text).toContain('    sha512: ' + DEB_SHA)
    expect(text).toContain('    size: 222')
    expect(text).toContain('    sha512: ' + RPM_SHA)
    expect(text).toContain('    size: 333')
  })

  it('updates the legacy top-level pair when it names this AppImage', () => {
    const { image, feedPath, expected } = fixture()
    refreshFeed(image, feedPath)
    expect(readFileSync(feedPath, 'utf8')).toContain('\nsha512: ' + expected)
  })

  it('keeps blockMapSize, which is not ours to compute', () => {
    const { image, feedPath } = fixture()
    refreshFeed(image, feedPath)
    expect(readFileSync(feedPath, 'utf8')).toContain('blockMapSize: 111')
  })

  it('refuses a feed that does not mention the AppImage at all', () => {
    const { image, feedPath } = fixture()
    writeFileSync(feedPath, feed('x').replace(new RegExp(APPIMAGE, 'g'), 'Other.AppImage'))
    expect(() => refreshFeed(image, feedPath)).toThrow(/no entry for/)
  })
})
