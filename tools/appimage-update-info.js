#!/usr/bin/env node
'use strict'

/**
 * Adds AppImage update information and the matching .zsync file.
 *
 * There are two independent update mechanisms in play and they are easy to
 * confuse:
 *
 *   - `latest-linux.yml` is electron-builder's feed, read by electron-updater
 *     inside the running app. electron-builder already writes it.
 *   - The `.upd_info` ELF section plus a `.zsync` file is the AppImage
 *     mechanism, read by AppImageUpdate and by third-party managers such as
 *     KEM-A AppManager. electron-builder does **not** write it — a build with
 *     `-p never` leaves the section allocated and entirely zeroed, which is
 *     what a fresh 1.3.0 AppImage was verified to contain.
 *
 * So an AppImage can update itself perfectly through the app's own updater
 * while being invisible to every external manager. This script closes that gap.
 *
 * Run it on Linux after electron-builder, with zsync installed:
 *
 *   node tools/appimage-update-info.js release/SmartcomRevisited-1.3.0-x86_64.AppImage
 *
 * The section is a fixed-size region reserved by the AppImage runtime, so the
 * string is written in place rather than by rebuilding the file — the payload
 * and its signature are untouched.
 */

const { execFileSync } = require('child_process')
const {
  closeSync,
  openSync,
  writeSync,
  readSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
} = require('fs')
const { basename, dirname, join } = require('path')
const { createHash } = require('crypto')

const OWNER = process.env.APPIMAGE_GH_OWNER || 'kbstechnologies'
const REPO = process.env.APPIMAGE_GH_REPO || 'SmartcomRevisited'

/**
 * The filename pattern the updater globs against on the latest release. The
 * `*` stands in for the version, which is the entire point: a client holding
 * 1.3.0 has to be able to name the file belonging to a release it has never
 * heard of.
 */
const ZSYNC_PATTERN = 'SmartcomRevisited-*-x86_64.AppImage.zsync'

const updateInformation = () => `gh-releases-zsync|${OWNER}|${REPO}|latest|${ZSYNC_PATTERN}`

/** Reads the file offset and size of a named ELF section. */
function findSection(file, name) {
  const output = execFileSync('readelf', ['-S', '-W', file], { encoding: 'utf8' })

  // "  [16] .upd_info  PROGBITS  0000000000000000  002000  000200  00   A  0   0  1"
  const line = output.split('\n').find((row) => row.includes(` ${name} `))
  if (!line) throw new Error(`${basename(file)} has no ${name} section — is it an AppImage?`)

  const fields = line.replace(/^\s*\[\s*\d+\]\s*/, '').trim().split(/\s+/)
  // fields: name type address offset size ...
  const offset = parseInt(fields[3], 16)
  const size = parseInt(fields[4], 16)

  if (!Number.isFinite(offset) || !Number.isFinite(size) || size === 0) {
    throw new Error(`Could not read the ${name} section header from:\n${line}`)
  }
  return { offset, size }
}

function writeUpdateInformation(file) {
  const info = updateInformation()
  const { offset, size } = findSection(file, '.upd_info')

  const payload = Buffer.from(info, 'utf8')
  if (payload.length + 1 > size) {
    throw new Error(
      `Update information is ${payload.length} bytes but .upd_info holds only ${size}`
    )
  }

  // The whole region is overwritten, so re-running never leaves a tail of an
  // older, longer string behind the NUL terminator.
  const region = Buffer.alloc(size)
  payload.copy(region)

  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, region, 0, size, offset)

    const check = Buffer.alloc(size)
    readSync(fd, check, 0, size, offset)
    const readBack = check.subarray(0, check.indexOf(0)).toString('utf8')
    if (readBack !== info) {
      throw new Error(`Wrote update information but read back "${readBack}"`)
    }
  } finally {
    closeSync(fd)
  }

  return info
}

/**
 * Re-hashes the AppImage in electron-builder's own feed.
 *
 * electron-builder computes latest-linux.yml's sha512 when it writes the
 * AppImage, and writeUpdateInformation() then rewrites bytes *inside* that same
 * file. The section is fixed-size, so the length never changes and nothing
 * looks wrong — but the recorded hash now describes a file that no longer
 * exists, and electron-updater rejects the download it has just made. That is
 * how 1.5.0 shipped, and it would have been every Linux release from 1.4.0 on.
 *
 * Only this AppImage's entry is touched; the deb and rpm were never modified.
 */
function refreshFeed(file, feedPath) {
  const feed = feedPath || join(dirname(file), 'latest-linux.yml')
  if (!existsSync(feed)) {
    console.warn(`no ${basename(feed)} beside the AppImage — skipping hash refresh`)
    return null
  }

  const name = basename(file)
  const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64')
  const size = statSync(file).size
  const lines = readFileSync(feed, 'utf8').split(/\r?\n/)
  let replaced = 0

  // Matched line by line rather than with a regex built from the filename:
  // version numbers and dots in that name are regex metacharacters, and an
  // escaping mistake there would silently match nothing and report success.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `- url: ${name}`) continue
    for (let j = i + 1; j < lines.length; j++) {
      // Stop at the next list item. Its lines are indented too, so testing only
      // for indentation walks straight on into the deb and the rpm and rewrites
      // their hashes with this one — which is what the first version did.
      if (!/^\s/.test(lines[j]) || /^\s*- /.test(lines[j])) break
      if (/^\s+sha512:/.test(lines[j])) {
        lines[j] = lines[j].replace(/sha512:.*$/, `sha512: ${sha512}`)
        replaced++
      } else if (/^\s+size:/.test(lines[j])) {
        lines[j] = lines[j].replace(/size:.*$/, `size: ${size}`)
      }
    }
  }

  // electron-updater also reads the legacy top-level path/sha512 pair, which
  // names whichever artifact is primary — usually this AppImage.
  const pathLine = lines.findIndex((l) => l.startsWith('path: '))
  if (pathLine !== -1 && lines[pathLine].slice('path: '.length).trim() === name) {
    const top = lines.findIndex((l) => /^sha512: /.test(l))
    if (top !== -1) {
      lines[top] = `sha512: ${sha512}`
      replaced++
    }
  }

  if (!replaced) {
    throw new Error(`${basename(feed)} has no entry for ${name}`)
  }

  writeFileSync(feed, lines.join('\n'))
  return { feed, sha512, size, replaced }
}

function makeZsync(file) {
  // -u is the URL a client fetches to get the file itself. AppImageUpdate
  // resolves a bare filename against the release the .zsync came from, which is
  // what makes the same metadata work for every future release.
  execFileSync('zsyncmake', ['-u', basename(file), '-o', `${file}.zsync`, file], {
    stdio: 'inherit',
  })
  return `${file}.zsync`
}

function main() {
  const args = process.argv.slice(2)
  // --feed-only repairs an artifact set that is already built: it re-hashes the
  // feed without touching the AppImage or calling zsyncmake, so it runs on any
  // platform. A full run needs readelf and zsync, which means Linux.
  const feedOnly = args.includes('--feed-only')
  const file = args.filter((a) => !a.startsWith('--'))[0]
  if (!file) {
    console.error('usage: node tools/appimage-update-info.js <path to .AppImage>')
    process.exit(2)
  }

  statSync(file)

  if (!feedOnly) {
    const info = writeUpdateInformation(file)
    console.log(`update information: ${info}`)

    const zsync = makeZsync(file)
    console.log(`wrote ${basename(zsync)} (${statSync(zsync).size} bytes)`)
  }

  // Always last, and never skipped: the recorded hash has to describe the file
  // as it is after patching, not as electron-builder first wrote it.
  const refreshed = refreshFeed(file)
  if (refreshed) {
    console.log(`refreshed ${basename(refreshed.feed)}: size ${refreshed.size}`)
  }

  console.log(
    '\nPublish BOTH files on the GitHub release, with the AppImage keeping the\n' +
      'exact name the .zsync pattern matches. A .zsync without its AppImage, or\n' +
      'an AppImage renamed after this step, leaves the updater unable to resolve\n' +
      'anything.'
  )
}

module.exports = { refreshFeed }

if (require.main === module) {
  main()
}
