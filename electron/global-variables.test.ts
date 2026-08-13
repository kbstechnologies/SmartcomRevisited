import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import {
  GLOBALS_FILENAME,
  MAX_GLOBALS_BYTES,
  ensureGlobalsFile,
  globalsFilePath,
  loadGlobals,
  readGlobalsText,
  writeGlobalsText,
} from './global-variables'

let dir: string
const created: string[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartcom-globals-'))
  created.push(dir)
})

afterAll(async () => {
  await Promise.all(created.map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

describe('the globals file', () => {
  it('lives beside the database in userData', () => {
    expect(globalsFilePath(dir)).toBe(path.join(dir, GLOBALS_FILENAME))
  })

  it('reads as empty before anything has been saved', () => {
    expect(readGlobalsText(globalsFilePath(dir))).toBe('')
    expect(loadGlobals(globalsFilePath(dir)).values).toEqual({})
  })

  it('round-trips what was written', () => {
    const file = globalsFilePath(dir)
    writeGlobalsText(file, 'KBSTECHLOG=https://fake.com/log\nSITE=hq')

    expect(loadGlobals(file).values).toEqual({
      KBSTECHLOG: 'https://fake.com/log',
      SITE: 'hq',
    })
    // Always newline-terminated, so appending a line by hand cannot join two.
    expect(readGlobalsText(file).endsWith('\n')).toBe(true)
  })

  it('leaves the explanatory header behind when everything is deleted', () => {
    const file = globalsFilePath(dir)
    writeGlobalsText(file, 'A=1')
    writeGlobalsText(file, '')

    const text = readGlobalsText(file)
    expect(text).toContain('{{NAME}}')
    expect(loadGlobals(file).values).toEqual({})
  })

  it('creates the file on reveal so opening it is never a no-op', async () => {
    const file = ensureGlobalsFile(globalsFilePath(dir))
    await expect(fs.stat(file)).resolves.toBeDefined()
  })

  it('leaves no temporary file behind', async () => {
    const file = globalsFilePath(dir)
    writeGlobalsText(file, 'A=1')
    expect(await fs.readdir(dir)).toEqual([GLOBALS_FILENAME])
  })

  it('refuses something far too large to be a variables file', () => {
    const file = globalsFilePath(dir)
    expect(() => writeGlobalsText(file, 'A='.padEnd(MAX_GLOBALS_BYTES + 10, 'x'))).toThrow(/limit/)
  })

  it('degrades to no globals rather than failing a run', async () => {
    // A directory where the file should be: readable path, unreadable content.
    const file = globalsFilePath(dir)
    await fs.mkdir(file)
    expect(loadGlobals(file).values).toEqual({})
  })
})
