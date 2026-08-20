import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  localNameForRemote,
  resolveInTransferDir,
  uniqueLocalPath,
} from './file-transfer'

const root = mkdtempSync(path.join(tmpdir(), 'smartcom-transfer-'))

describe('resolveInTransferDir', () => {
  it('resolves an ordinary relative path inside the folder', () => {
    const resolved = resolveInTransferDir(root, 'capture.pcap')
    expect(resolved).toBe(path.join(root, 'capture.pcap'))
  })

  it('allows a subfolder', () => {
    expect(resolveInTransferDir(root, 'core-sw-01/capture.pcap')).toBe(
      path.join(root, 'core-sw-01', 'capture.pcap')
    )
  })

  /**
   * These are the cases the guard exists for. A button can come from the
   * exchange, written by a stranger — on download an escape overwrites a file
   * outside the folder, and on upload it *reads* one, which is how a private
   * key leaves the machine while the run looks entirely normal.
   */
  it('refuses a parent-directory escape', () => {
    expect(() => resolveInTransferDir(root, '../escaped.txt')).toThrow(/outside the transfer folder/)
    expect(() => resolveInTransferDir(root, '../../../.ssh/id_ed25519')).toThrow(
      /outside the transfer folder/
    )
  })

  it('refuses an escape hidden inside a longer path', () => {
    expect(() => resolveInTransferDir(root, 'sub/../../outside.txt')).toThrow(
      /outside the transfer folder/
    )
  })

  it('refuses an absolute path', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\System32\\x' : '/etc/passwd'
    expect(() => resolveInTransferDir(root, absolute)).toThrow(/outside the transfer folder/)
  })

  it('refuses the folder itself, which is not a file', () => {
    expect(() => resolveInTransferDir(root, '.')).toThrow(/outside the transfer folder/)
    expect(() => resolveInTransferDir(root, '')).toThrow(/outside the transfer folder/)
  })

  it('refuses everything when no folder is configured', () => {
    // Falling back to "anywhere" would quietly remove the whole boundary.
    expect(() => resolveInTransferDir('', 'capture.pcap')).toThrow(/No transfer folder/)
  })

  it('names the folder in the error, so the limit is actionable', () => {
    expect(() => resolveInTransferDir(root, '../x')).toThrow(new RegExp(path.resolve(root).replace(/\\/g, '\\\\')))
  })
})

describe('localNameForRemote', () => {
  it('takes the filename from a remote path', () => {
    expect(localNameForRemote('/tmp/cap-1786982730.pcap')).toBe('cap-1786982730.pcap')
  })

  it('splits on forward slashes whatever this machine runs', () => {
    // The remote is a Unix host even when this is Windows; using path.basename
    // here would treat a backslash as a separator and truncate the name.
    expect(localNameForRemote('/var/log/odd\\name.log')).toBe('odd\\name.log')
  })

  it('ignores a trailing slash', () => {
    expect(localNameForRemote('/tmp/reports/')).toBe('reports')
  })

  it('falls back when there is nothing to name the file after', () => {
    expect(localNameForRemote('/')).toBe('download')
    expect(localNameForRemote('')).toBe('download')
  })
})

describe('uniqueLocalPath', () => {
  it('returns the path unchanged when nothing is there', async () => {
    const target = path.join(root, 'fresh.pcap')
    expect(await uniqueLocalPath(target)).toBe(target)
  })

  it('numbers around an existing file rather than replacing it', async () => {
    // Collecting the same capture twice is normal; losing the first to the
    // second is the outcome nobody asks for.
    const target = path.join(root, 'taken.pcap')
    writeFileSync(target, 'first')

    const second = await uniqueLocalPath(target)
    expect(second).toBe(path.join(root, 'taken (2).pcap'))

    writeFileSync(second, 'second')
    expect(await uniqueLocalPath(target)).toBe(path.join(root, 'taken (3).pcap'))
  })

  it('keeps the extension where it belongs', async () => {
    const target = path.join(root, 'archive.tar.gz')
    writeFileSync(target, 'x')
    // Only the final extension is treated as one, which is what every file
    // manager does — "archive.tar (2).gz" is the expected shape.
    expect(await uniqueLocalPath(target)).toBe(path.join(root, 'archive.tar (2).gz'))
  })

  it('handles a file with no extension', async () => {
    const target = path.join(root, 'noext')
    writeFileSync(target, 'x')
    expect(await uniqueLocalPath(target)).toBe(path.join(root, 'noext (2)'))
  })
})

describe('formatBytes', () => {
  it('reports small sizes in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('scales up through the units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB')
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GB')
  })

  it('drops the decimal once the number is large enough to not need it', () => {
    expect(formatBytes(1024 * 512)).toBe('512 KB')
  })

  it('uses a dot, since these end up in tickets and log files', () => {
    expect(formatBytes(1536)).not.toContain(',')
  })
})
