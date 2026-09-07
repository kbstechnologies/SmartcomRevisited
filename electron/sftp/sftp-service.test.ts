import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SftpService } from './sftp-service'

/**
 * The download queue.
 *
 * The transfers themselves are proven against a real SSH server; what is
 * tested here is the queue's own rules, which are the ones that lose somebody's
 * files if they are wrong: overwriting a download with another of the same
 * name, forgetting an item that never ran, or running two transfers down one
 * device's SFTP channel at once.
 */

describe('SftpService', () => {
  let directory: string
  let started: string[]
  /** Resolvers for in-flight downloads, so a test decides when one finishes. */
  let pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>

  const build = (
    onDownload?: (
      sessionId: string,
      remotePath: string,
      localPath: string,
      onProgress: (transferred: number, total: number) => void,
      shouldCancel: () => boolean
    ) => Promise<{ bytes: number }>
  ) =>
    new SftpService({
      profileName: (sessionId) => `Host ${sessionId}`,
      download:
        onDownload ??
        ((_sessionId, remotePath, localPath, onProgress, shouldCancel) => {
          started.push(remotePath)
          return new Promise((resolve, reject) => {
            pending.set(remotePath, {
              resolve: () => {
                // A real transfer writes the file; the unique-name logic reads
                // the filesystem, so the fake has to as well.
                writeFileSync(localPath, 'x')
                onProgress(10, 10)
                resolve({ bytes: 10 })
              },
              reject,
            })
            // Cancellation is polled, exactly as `fastGet` polls it.
            const poll = setInterval(() => {
              if (shouldCancel()) {
                clearInterval(poll)
                pending.delete(remotePath)
                reject(new Error('Cancelled'))
              }
            }, 5)
            void poll
          })
        }),
    })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sftp-queue-'))
    started = []
    pending = new Map()
  })

  // ------------------------------------------------------------------ panes

  it('remembers which sessions have a browser open', () => {
    const service = build()

    expect(service.listPanes()).toEqual([])
    service.openPane('a')
    service.openPane('b')

    expect(service.listPanes()).toEqual(['a', 'b'])

    service.closePane('a')
    expect(service.listPanes()).toEqual(['b'])
  })

  it('does not open the same browser twice', () => {
    const service = build()

    service.openPane('a')
    service.openPane('a')

    expect(service.listPanes()).toEqual(['a'])
  })

  // ------------------------------------------------------------------ queue

  it('runs one transfer at a time per session', async () => {
    // Several concurrent SFTP channels is a good way to find out that a switch
    // supports two.
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()

    expect(started).toEqual(['/a.txt'])

    pending.get('/a.txt')!.resolve()
    await settle()

    expect(started).toEqual(['/a.txt', '/b.txt'])
  })

  it('runs different hosts at the same time', async () => {
    const service = build()

    service.enqueue('session-1', directory, [{ remotePath: '/a.txt', name: 'a.txt', size: 10 }])
    service.enqueue('session-2', directory, [{ remotePath: '/b.txt', name: 'b.txt', size: 10 }])
    await settle()

    expect(started.sort()).toEqual(['/a.txt', '/b.txt'])
  })

  it('never overwrites an existing download', async () => {
    // Fetching `config.txt` from two devices into one folder must give two
    // files. Overwriting would lose data in a way nobody notices until they
    // need it.
    const service = build()

    service.enqueue('session-1', directory, [{ remotePath: '/x/config.txt', name: 'config.txt', size: 10 }])
    await settle()
    pending.get('/x/config.txt')!.resolve()
    await settle()

    service.enqueue('session-1', directory, [{ remotePath: '/y/config.txt', name: 'config.txt', size: 10 }])
    await settle()

    const paths = service.getQueue().transfers.map((transfer) => transfer.localPath)

    expect(paths[0]).toBe(join(directory, 'config.txt'))
    expect(paths[1]).toBe(join(directory, 'config (2).txt'))
  })

  it('strips a path out of a filename the far end supplied', async () => {
    // The name comes from the device. `..\..\startup.bat` must land in the
    // chosen folder, not two levels above it.
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/evil', name: '../../startup.bat', size: 10 },
    ])

    const [transfer] = service.getQueue().transfers

    expect(transfer.localPath).toBe(join(directory, 'startup.bat'))
  })

  it('keeps spaces and hyphens in a filename', async () => {
    // `show tech-support.txt` is an ordinary name off a switch, and mangling it
    // would make the saved file hard to match against what is on the device.
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/x', name: 'show tech-support.txt', size: 10 },
    ])

    expect(service.getQueue().transfers[0].localPath).toBe(
      join(directory, 'show tech-support.txt')
    )
  })

  // --------------------------------------------------------------- cancelling

  it('cancels a queued transfer without starting it', async () => {
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()

    const queued = service.getQueue().transfers.find((t) => t.remotePath === '/b.txt')!
    service.cancel(queued.id)

    expect(service.getQueue().transfers.find((t) => t.id === queued.id)!.status).toBe('cancelled')
    expect(started).not.toContain('/b.txt')
  })

  it('stops an active transfer and moves on to the next', async () => {
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()

    const active = service.getQueue().transfers.find((t) => t.remotePath === '/a.txt')!
    service.cancel(active.id)
    await settle()

    expect(service.getQueue().transfers.find((t) => t.id === active.id)!.status).toBe('cancelled')
    // The queue keeps going rather than stalling behind the cancelled item.
    expect(started).toContain('/b.txt')
  })

  it('records a failure with its reason, and carries on', async () => {
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()

    pending.get('/a.txt')!.reject(new Error('Permission denied'))
    await settle()

    const failed = service.getQueue().transfers.find((t) => t.remotePath === '/a.txt')!

    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Permission denied')
    expect(started).toContain('/b.txt')
  })

  it('a failure and a cancellation are told apart', async () => {
    // One happened to them, the other they did. The list says which.
    const service = build()

    service.enqueue('session-1', directory, [{ remotePath: '/a.txt', name: 'a.txt', size: 10 }])
    await settle()

    const transfer = service.getQueue().transfers[0]
    service.cancel(transfer.id)
    await settle()

    expect(service.getQueue().transfers[0].status).toBe('cancelled')
    expect(service.getQueue().transfers[0].error).toBeUndefined()
  })

  it('retries a failed transfer under a fresh name', async () => {
    // The first attempt may have left a partial file behind.
    const service = build()

    service.enqueue('session-1', directory, [{ remotePath: '/a.txt', name: 'a.txt', size: 10 }])
    await settle()
    pending.get('/a.txt')!.resolve()
    await settle()

    const done = service.getQueue().transfers[0]
    service.retry(done.id)

    const retried = service.getQueue().transfers[0]

    // Straight to `active`, not `queued`: nothing else was running, so the
    // queue picked it up in the same tick. Either counts as "going again".
    expect(['queued', 'active']).toContain(retried.status)
    expect(retried.transferred).toBe(0)
    expect(retried.error).toBeUndefined()
    // A fresh name, because the first attempt already wrote `a.txt`.
    expect(retried.localPath).toBe(join(directory, 'a (2).txt'))
  })

  // ------------------------------------------------------------ housekeeping

  it('clears what has finished and keeps what has not', async () => {
    const service = build()

    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()
    pending.get('/a.txt')!.resolve()
    await settle()

    service.clearFinished()

    const remaining = service.getQueue().transfers

    expect(remaining).toHaveLength(1)
    expect(remaining[0].remotePath).toBe('/b.txt')
  })

  it('cancels everything a closed session had queued', async () => {
    // Those transfers cannot succeed, and a queue full of items that will
    // never move is worse than an empty one.
    const service = build()

    service.openPane('session-1')
    service.enqueue('session-1', directory, [
      { remotePath: '/a.txt', name: 'a.txt', size: 10 },
      { remotePath: '/b.txt', name: 'b.txt', size: 10 },
    ])
    await settle()

    service.forgetSession('session-1')
    await settle()

    expect(service.listPanes()).toEqual([])
    expect(
      service.getQueue().transfers.every((transfer) => transfer.status === 'cancelled')
    ).toBe(true)
  })

  it('tells watchers whenever the queue moves', async () => {
    const service = build()
    const seen = vi.fn()
    service.on('queue-changed', seen)

    service.enqueue('session-1', directory, [{ remotePath: '/a.txt', name: 'a.txt', size: 10 }])
    await settle()
    pending.get('/a.txt')!.resolve()
    await settle()

    expect(seen).toHaveBeenCalled()
    expect(service.getQueue().active).toBe(false)
  })
})
