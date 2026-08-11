import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { listLibrary, readScript, resolveInLibrary } from './script-library'
import { buildScriptCommand, shellQuote } from './ssh-manager'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartcom-scripts-'))
  await fs.mkdir(path.join(root, 'cisco'))
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(root, 'cisco', 'backup.sh'), '#!/bin/bash\necho backup\n')
  await fs.writeFile(path.join(root, 'top-level.sh'), 'echo hi\n')
  await fs.writeFile(path.join(root, '.hidden.sh'), 'echo hidden\n')
  await fs.writeFile(path.join(root, '.git', 'config'), 'nope\n')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('resolveInLibrary', () => {
  /**
   * The relative path comes from the renderer and from saved buttons, so a
   * shared button set must not be able to reach outside the library folder.
   */
  it('refuses to escape the library root', () => {
    expect(() => resolveInLibrary(root, '../../etc/passwd')).toThrow(/outside the library/)
    expect(() => resolveInLibrary(root, 'cisco/../../../secrets')).toThrow(/outside the library/)
    expect(() => resolveInLibrary(root, '')).toThrow(/outside the library/)
  })

  it('refuses an absolute path', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    expect(() => resolveInLibrary(root, absolute)).toThrow(/outside the library/)
  })

  it('resolves a path inside the library', () => {
    expect(resolveInLibrary(root, 'cisco/backup.sh')).toBe(path.join(root, 'cisco', 'backup.sh'))
  })

  it('throws when no library folder is configured', () => {
    expect(() => resolveInLibrary('', 'anything.sh')).toThrow(/No script library/)
  })
})

describe('listLibrary', () => {
  it('lists folders first, skipping dotfiles and vcs noise', async () => {
    const entries = await listLibrary(root)

    expect(entries.map((e) => e.name)).toEqual(['cisco', 'top-level.sh'])
    expect(entries[0].type).toBe('folder')
    expect(entries[0].children?.map((c) => c.path)).toEqual(['cisco/backup.sh'])
  })

  it('returns nothing when no folder is configured', async () => {
    expect(await listLibrary('')).toEqual([])
  })
})

describe('readScript', () => {
  it('reads a script inside the library', async () => {
    const script = await readScript(root, 'cisco/backup.sh')
    expect(script.content).toContain('echo backup')
  })

  it('will not read outside the library', async () => {
    await expect(readScript(root, '../../etc/passwd')).rejects.toThrow(/outside the library/)
  })
})

describe('shellQuote', () => {
  it('quotes paths and neutralises embedded quotes', () => {
    expect(shellQuote('/tmp/plain.sh')).toBe(`'/tmp/plain.sh'`)
    expect(shellQuote("/tmp/it's here.sh")).toBe(`'/tmp/it'\\''s here.sh'`)
  })
})

describe('buildScriptCommand', () => {
  const remotePath = '/tmp/.smartcom-ab12-backup.sh'

  it('chmods and runs, then deletes', () => {
    expect(buildScriptCommand({ remotePath, cleanup: true })).toBe(
      `chmod +x '${remotePath}' && '${remotePath}'; rm -f '${remotePath}'`
    )
  })

  it('uses an interpreter instead of chmod when one is given', () => {
    expect(buildScriptCommand({ remotePath, interpreter: 'bash', cleanup: true })).toBe(
      `bash '${remotePath}'; rm -f '${remotePath}'`
    )
  })

  it('leaves the file behind when cleanup is off', () => {
    const command = buildScriptCommand({ remotePath, cleanup: false })
    expect(command).not.toContain('rm -f')
  })

  it('appends arguments', () => {
    expect(buildScriptCommand({ remotePath, interpreter: 'bash', args: '--dry-run', cleanup: true }))
      .toBe(`bash '${remotePath}' --dry-run; rm -f '${remotePath}'`)
  })

  /**
   * Cleanup is separated with `;` rather than `&&` on purpose: a script that
   * fails or is interrupted must not leave its copy on the host.
   */
  it('cleans up even when the script fails', () => {
    expect(buildScriptCommand({ remotePath, cleanup: true })).toMatch(/; rm -f /)
  })

  it('is a single line, so a script reading stdin cannot eat its own cleanup', () => {
    expect(buildScriptCommand({ remotePath, cleanup: true })).not.toContain('\n')
  })
})
