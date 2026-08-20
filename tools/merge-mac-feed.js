#!/usr/bin/env node
// Merge the per-architecture macOS update feeds into one latest-mac.yml.
//
// macOS is built on two runners — arm64 on macos-latest, x64 on macos-15-intel —
// because building both on one host fails in `hdiutil detach` (both DMGs mount
// the same volume name) and forces a cross-architecture rebuild of the native
// modules. Each of those jobs writes its own `release/latest-mac.yml` listing
// only the files it produced, and both attach it to the release, so whichever
// job finishes second silently overwrites the other. The published feed then
// describes one architecture and electron-updater has nothing correct to offer
// the other.
//
// This merges the `files:` lists back into a single document. It works on the
// text rather than parsing and re-emitting YAML, so the sha512 values are
// copied exactly as electron-builder wrote them — a re-serialised feed that
// differs by a single character fails the updater's integrity check.
//
//   node tools/merge-mac-feed.js <output> <primary.yml> <secondary.yml> [...]
//
// The primary document supplies everything outside the files list, including
// the legacy top-level `path`/`sha512` pair that electron-updater versions too
// old to read `files:` fall back to. Pass the x64 feed as primary: a client old
// enough to need that fallback is far more likely to be an Intel Mac.

const fs = require('fs')

function parseFeed(text, label) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l === 'files:')
  if (start === -1) throw new Error(label + ': no "files:" block')

  const items = []
  let i = start + 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' && i === lines.length - 1) break
    if (!/^\s/.test(line)) break
    if (/^ {2}- /.test(line)) items.push([line])
    else if (items.length) items[items.length - 1].push(line)
    else throw new Error(label + ': continuation line before any list item')
  }
  if (!items.length) throw new Error(label + ': "files:" block is empty')

  return {
    head: lines.slice(0, start),
    items,
    tail: lines.slice(i),
  }
}

function urlOf(item) {
  for (const line of item) {
    const m = line.match(/^\s*-?\s*url:\s*(.+?)\s*$/)
    if (m) return m[1]
  }
  throw new Error('list item has no url: ' + item.join(' / '))
}

function versionOf(feed) {
  const line = feed.head.find((l) => /^version:/.test(l))
  return line ? line.replace(/^version:\s*/, '').trim() : null
}

function mergeFeeds(texts, labels) {
  const feeds = texts.map((t, n) => parseFeed(t, labels[n]))

  // Merging feeds for different versions would publish a manifest whose files
  // do not all exist on the release, so refuse rather than produce it.
  const versions = feeds.map(versionOf)
  if (new Set(versions).size > 1) {
    throw new Error('feeds disagree on version: ' + versions.join(', '))
  }

  const seen = new Set()
  const items = []
  for (const feed of feeds) {
    for (const item of feed.items) {
      const url = urlOf(item)
      if (seen.has(url)) continue
      seen.add(url)
      items.push(item)
    }
  }

  const primary = feeds[0]
  return [...primary.head, 'files:', ...items.flat(), ...primary.tail].join('\n')
}

module.exports = { mergeFeeds }

if (require.main === module) {
  const [out, ...inputs] = process.argv.slice(2)
  if (!out || inputs.length < 2) {
    console.error('usage: merge-mac-feed.js <output> <primary.yml> <secondary.yml> [...]')
    process.exit(2)
  }
  const texts = inputs.map((p) => fs.readFileSync(p, 'utf8'))
  const merged = mergeFeeds(texts, inputs)
  fs.writeFileSync(out, merged)
  const count = (merged.match(/^ {2}- /gm) || []).length
  console.log('wrote ' + out + ' with ' + count + ' files from ' + inputs.length + ' feeds')
}
