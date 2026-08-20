import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from 'ssh2'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { MacroSchema, type Macro } from '../src/shared/types'
import { SSHManager } from './ssh-manager'

/**
 * Transfers against the container in ../test-server, which runs a real
 * sftp-server subsystem.
 *
 * The unit tests cover the path guard and the naming; what they cannot cover is
 * whether a `download` step actually retrieves the bytes a device wrote, which
 * is the only claim that matters. Skipped when the container is not up, so
 * `npm test` stays hermetic.
 */
const HOST = process.env.SMARTCOM_TEST_HOST ?? '127.0.0.1'
const PORT = Number(process.env.SMARTCOM_TEST_PORT ?? 2222)
const USER = process.env.SMARTCOM_TEST_USER ?? 'testuser'
const PASSWORD = process.env.SMARTCOM_TEST_PASSWORD ?? 'testpass'

const transferRoot = mkdtempSync(path.join(tmpdir(), 'smartcom-xfer-'))

async function canReach(): Promise<boolean> {
  const net = await import('net')
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(2000)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/** A live session registered with the manager, as the app would have. */
function connect(manager: SSHManager, id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => {
        const { EventEmitter } = require('events')
        const session: any = Object.assign(new EventEmitter(), {
          id,
          profile: {
            id: 'p1',
            name: 'docker-test',
            transport: 'ssh',
            host: HOST,
            port: PORT,
            username: USER,
            authMethod: 'password',
          },
          client,
          status: 'connected',
          lastActivity: new Date(),
          createdAt: new Date(),
          shell: { write: () => undefined },
        })
        ;(manager as any).sessions.set(id, session)
        resolve(session)
      })
      .on('error', reject)
      .connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 10000 })
  })
}

/** Runs a command over its own connection, to set up and inspect the host. */
function remoteExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            client.end()
            reject(err)
            return
          }
          let out = ''
          stream.on('data', (chunk: Buffer) => (out += chunk.toString()))
          stream.on('close', () => {
            client.end()
            resolve(out.trim())
          })
        })
      })
      .on('error', reject)
      .connect({ host: HOST, port: PORT, username: USER, password: PASSWORD, readyTimeout: 10000 })
  })
}

const macro = (name: string, steps: Record<string, unknown>[]): Macro =>
  MacroSchema.parse({ id: name, setId: 'set-1', name, steps })

let reachable = false
let manager: SSHManager

describe('file transfer against a live SFTP server', () => {
  beforeAll(async () => {
    reachable = await canReach()
    if (!reachable) {
      console.warn(
        `[skip] no SSH server on ${HOST}:${PORT} — run "npm run testserver:up" to include these tests`
      )
      return
    }
    manager = new SSHManager('/tmp/logs')
    manager.setTransferDirProvider(() => transferRoot)
  })

  afterAll(() => {
    if (reachable) manager?.shutdown()
  })

  const requireServer = (ctx: { skip: () => void }) => {
    if (!reachable) ctx.skip()
  }

  it('downloads a file the host wrote', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'dl-1')

    const body = `captured at ${Date.now()}`
    await remoteExec(`printf '%s' '${body}' > /tmp/smartcom-dl.txt`)

    const result = await manager.runMacro(
      'dl-1',
      macro('collect', [{ type: 'download', remotePath: '/tmp/smartcom-dl.txt' }]),
      {}
    )

    expect(result.success).toBe(true)
    // Blank localPath means "call it whatever it is called on the host".
    const landed = path.join(transferRoot, 'smartcom-dl.txt')
    expect(readFileSync(landed, 'utf8')).toBe(body)
    // The transfer is recorded like any other thing the button did.
    expect(result.commands.some((line) => line.startsWith('sftp get'))).toBe(true)
  }, 60000)

  it('exposes where the file landed, so a later step can act on it', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'dl-2')

    await remoteExec("printf 'x' > /tmp/smartcom-var.txt")

    // DOWNLOADED_PATH is what makes a collect-then-do-something button possible.
    const result = await manager.runMacro(
      'dl-2',
      macro('collect', [
        { type: 'download', remotePath: '/tmp/smartcom-var.txt', localPath: 'named.txt' },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(readFileSync(path.join(transferRoot, 'named.txt'), 'utf8')).toBe('x')
  }, 60000)

  it('saves beside an existing file rather than replacing it', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'dl-3')

    await remoteExec("printf 'second' > /tmp/smartcom-twice.txt")
    writeFileSync(path.join(transferRoot, 'smartcom-twice.txt'), 'first')

    await manager.runMacro(
      'dl-3',
      macro('collect', [{ type: 'download', remotePath: '/tmp/smartcom-twice.txt' }]),
      {}
    )

    // The earlier collection has to survive the later one.
    expect(readFileSync(path.join(transferRoot, 'smartcom-twice.txt'), 'utf8')).toBe('first')
    expect(readFileSync(path.join(transferRoot, 'smartcom-twice (2).txt'), 'utf8')).toBe('second')
  }, 60000)

  it('uploads a local file to the host', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'up-1')

    const body = `sent at ${Date.now()}`
    writeFileSync(path.join(transferRoot, 'to-send.txt'), body)

    const result = await manager.runMacro(
      'up-1',
      macro('send', [
        { type: 'upload', localPath: 'to-send.txt', remotePath: '/tmp/smartcom-up.txt' },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(await remoteExec('cat /tmp/smartcom-up.txt')).toBe(body)
  }, 60000)

  it('substitutes variables into both paths', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'var-1')

    await remoteExec("printf 'interpolated' > /tmp/smartcom-9.txt")

    const result = await manager.runMacro(
      'var-1',
      macro('collect', [
        { type: 'download', remotePath: '/tmp/smartcom-{{ID}}.txt', localPath: 'got-{{ID}}.txt' },
      ]),
      { ID: '9' }
    )

    expect(result.success).toBe(true)
    expect(readFileSync(path.join(transferRoot, 'got-9.txt'), 'utf8')).toBe('interpolated')
  }, 60000)

  it('collects a file named by an expect capture — the capture workflow end to end', async (ctx) => {
    requireServer(ctx)
    const session = await connect(manager, 'cap-1')

    await remoteExec("printf 'capture body' > /tmp/smartcom-cap-77.pcap")

    const run = manager.runMacro(
      'cap-1',
      macro('capture and collect', [
        { type: 'expect', pattern: 'saved to (?<CAPFILE>\\S+\\.pcap)', timeoutMs: 5000 },
        { type: 'download', remotePath: '{{CAPFILE}}' },
      ]),
      {}
    )

    // Stand in for the device announcing the filename it chose.
    await new Promise((resolve) => setTimeout(resolve, 100))
    session.emit('output', 'saved to /tmp/smartcom-cap-77.pcap\n')

    const result = await run
    expect(result.success).toBe(true)
    expect(readFileSync(path.join(transferRoot, 'smartcom-cap-77.pcap'), 'utf8')).toBe('capture body')
  }, 60000)

  it('says the remote file is missing rather than failing obscurely', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'missing-1')

    const result = await manager.runMacro(
      'missing-1',
      macro('collect', [{ type: 'download', remotePath: '/tmp/definitely-not-here.pcap' }]),
      {}
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not readable on the host/i)
  }, 60000)

  it('refuses a local path that escapes the transfer folder', async (ctx) => {
    requireServer(ctx)
    await connect(manager, 'escape-1')

    await remoteExec("printf 'x' > /tmp/smartcom-escape.txt")

    const result = await manager.runMacro(
      'escape-1',
      macro('escape', [
        {
          type: 'download',
          remotePath: '/tmp/smartcom-escape.txt',
          localPath: '../../escaped.txt',
        },
      ]),
      {}
    )

    // The guard has to hold with a real connection open, not only in isolation.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/outside the transfer folder/i)
  }, 60000)
})
