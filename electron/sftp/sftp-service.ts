import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'fs'
import { extname, join } from 'path'
import type { SftpQueueState, SftpTransfer } from '../../src/shared/sftp'

/**
 * The SFTP download queue, and the record of which sessions have an explorer
 * open.
 *
 * Both live in the main process rather than in a panel, for the same reason:
 * **a transfer outlives the thing that started it.** The explorer can be popped
 * out to another monitor, switched away from, or closed while a download runs,
 * and every window has to be able to see the same queue. A queue held in React
 * state would be three different queues that disagree.
 *
 * ## One at a time, per session
 *
 * Transfers are serialised. Not because SFTP cannot do better, but because the
 * far end is routinely a switch or a firewall whose SFTP subsystem is a
 * courtesy rather than a product: several concurrent channels are a good way to
 * find out that a device supports two. Serialising also makes progress
 * meaningful — three transfers at 30% tells nobody when anything will finish.
 *
 * Sessions run independently of each other, so two hosts do fetch at once.
 */

export interface SftpServiceOptions {
  /** Fetches one file. Injected so the queue can be tested without a host. */
  download: (
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress: (transferred: number, total: number) => void,
    shouldCancel: () => boolean
  ) => Promise<{ bytes: number }>
  /** Host label for a session, for a queue read in another window. */
  profileName: (sessionId: string) => string
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export class SftpService extends EventEmitter {
  private readonly options: SftpServiceOptions
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  private transfers: SftpTransfer[] = []
  /** Transfer ids asked to stop. Checked on every chunk. */
  private cancelling = new Set<string>()
  /** Sessions with a transfer in flight, so each host runs one at a time. */
  private running = new Set<string>()

  /** Sessions with an explorer pane open, in the order they were opened. */
  private panes: string[] = []

  constructor(options: SftpServiceOptions) {
    super()
    this.options = options
    this.log = options.log ?? (() => {})
  }

  // ------------------------------------------------------------------ panes

  openPane(sessionId: string): string[] {
    if (!this.panes.includes(sessionId)) {
      this.panes.push(sessionId)
      this.emit('panes-changed', this.listPanes())
    }

    return this.listPanes()
  }

  closePane(sessionId: string): string[] {
    const next = this.panes.filter((id) => id !== sessionId)

    if (next.length !== this.panes.length) {
      this.panes = next
      this.emit('panes-changed', this.listPanes())
    }

    return this.listPanes()
  }

  listPanes(): string[] {
    return [...this.panes]
  }

  /**
   * Drops a session's explorer when the session goes.
   *
   * Queued transfers for it are cancelled rather than left: they cannot
   * succeed, and a queue full of items that will never move is worse than an
   * empty one.
   */
  forgetSession(sessionId: string): void {
    this.closePane(sessionId)

    for (const transfer of this.transfers) {
      if (
        transfer.sessionId === sessionId &&
        (transfer.status === 'queued' || transfer.status === 'active')
      ) {
        this.cancel(transfer.id)
      }
    }
  }

  // ------------------------------------------------------------------ queue

  getQueue(): SftpQueueState {
    return { transfers: [...this.transfers], active: this.running.size > 0 }
  }

  private announce(): void {
    this.emit('queue-changed', this.getQueue())
  }

  /**
   * Adds files to the queue and starts working through them.
   *
   * Returns the ids so a caller can watch specific items. Directories are
   * rejected by the caller — this takes files.
   */
  enqueue(
    sessionId: string,
    localDirectory: string,
    files: Array<{ remotePath: string; name: string; size: number }>
  ): string[] {
    const profileName = this.options.profileName(sessionId)
    const ids: string[] = []

    for (const file of files) {
      const transfer: SftpTransfer = {
        id: randomUUID(),
        sessionId,
        profileName,
        remotePath: file.remotePath,
        localPath: uniqueLocalPath(localDirectory, file.name),
        size: file.size,
        transferred: 0,
        status: 'queued',
        queuedAt: new Date().toISOString(),
      }

      this.transfers.push(transfer)
      ids.push(transfer.id)
    }

    this.announce()
    void this.pump(sessionId)

    return ids
  }

  /**
   * Stops a transfer, whether it has started or not.
   *
   * A queued item becomes `cancelled` immediately; an active one is flagged and
   * stops at its next chunk, because `fastGet` gives no other way in.
   */
  cancel(transferId: string): void {
    const transfer = this.transfers.find((item) => item.id === transferId)
    if (!transfer) return

    if (transfer.status === 'queued') {
      transfer.status = 'cancelled'
      transfer.finishedAt = new Date().toISOString()
      this.announce()
      return
    }

    if (transfer.status === 'active') {
      this.cancelling.add(transferId)
    }
  }

  /** Everything not finished, for the "stop all" a person reaches for. */
  cancelAll(): void {
    for (const transfer of this.transfers) {
      if (transfer.status === 'queued' || transfer.status === 'active') {
        this.cancel(transfer.id)
      }
    }
  }

  /**
   * Removes everything that has stopped moving.
   *
   * Deliberately keeps failures out of nothing: they are cleared too, because
   * the error is on screen when it happens and a list that only ever grows
   * stops being read.
   */
  clearFinished(): void {
    this.transfers = this.transfers.filter(
      (transfer) => transfer.status === 'queued' || transfer.status === 'active'
    )
    this.announce()
  }

  /** Puts a failed or cancelled transfer back at the end of the queue. */
  retry(transferId: string): void {
    const transfer = this.transfers.find((item) => item.id === transferId)
    if (!transfer || transfer.status === 'queued' || transfer.status === 'active') return

    transfer.status = 'queued'
    transfer.transferred = 0
    transfer.error = undefined
    transfer.finishedAt = undefined
    // A new name, in case the earlier attempt left a partial file behind or the
    // destination has since been taken by something else.
    transfer.localPath = uniqueLocalPath(
      directoryOf(transfer.localPath),
      fileNameOf(transfer.localPath)
    )

    this.announce()
    void this.pump(transfer.sessionId)
  }

  /**
   * Works through one session's queue, one file at a time.
   *
   * Re-entrant by design: every enqueue and every completion calls it, and the
   * `running` guard means only the first of those actually starts anything.
   */
  private async pump(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return

    const next = this.transfers.find(
      (transfer) => transfer.sessionId === sessionId && transfer.status === 'queued'
    )

    if (!next) return

    this.running.add(sessionId)
    next.status = 'active'
    this.announce()

    let lastReport = 0

    try {
      await this.options.download(
        sessionId,
        next.remotePath,
        next.localPath,
        (transferred, total) => {
          next.transferred = transferred
          // The host's stat can be wrong or absent on some devices; whatever
          // has actually arrived is a better denominator than a zero.
          if (total > next.size) next.size = total

          // Throttled: `fastGet` reports every chunk, which for a large file is
          // thousands of IPC messages competing with the terminal for the same
          // thread. The final one always goes, below.
          const now = Date.now()
          if (now - lastReport < 150) return
          lastReport = now
          this.announce()
        },
        () => this.cancelling.has(next.id)
      )

      next.status = 'done'
      next.transferred = next.size
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (this.cancelling.has(next.id)) {
        next.status = 'cancelled'
      } else {
        next.status = 'failed'
        next.error = message
        this.log('transfer-failed', { remotePath: next.remotePath, message })
      }
    } finally {
      this.cancelling.delete(next.id)
      next.finishedAt = new Date().toISOString()
      this.running.delete(sessionId)
      this.announce()

      // Straight on to the next one. Not awaited — this is the tail of the
      // previous transfer, and chaining awaits here would hold the whole queue
      // in one stack.
      void this.pump(sessionId)
    }
  }
}

const directoryOf = (fullPath: string): string =>
  fullPath.slice(0, Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/')))

const fileNameOf = (fullPath: string): string =>
  fullPath.slice(Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/')) + 1)

/**
 * A local path that is not already taken.
 *
 * Downloading `config.txt` twice gives `config.txt` and `config (2).txt` rather
 * than one file that silently became the other. The queue takes whole folders
 * of similarly-named files off devices, and overwriting by default would lose
 * data in a way nobody would notice until they needed it.
 */
function uniqueLocalPath(directory: string, name: string): string {
  const safe = sanitiseFileName(name)
  const candidate = join(directory, safe)

  if (!existsSync(candidate)) return candidate

  const extension = extname(safe)
  const stem = extension ? safe.slice(0, -extension.length) : safe

  for (let counter = 2; counter < 1000; counter++) {
    const next = join(directory, `${stem} (${counter})${extension}`)
    if (!existsSync(next)) return next
  }

  return join(directory, `${stem} (${Date.now()})${extension}`)
}

/**
 * Strips anything from a remote filename that would mean something else here.
 *
 * The name comes from the far end, and a device — or somebody with access to
 * one — can call a file `..\..\startup.bat`. Everything down to the last
 * separator is dropped and the reserved Windows characters go with it, so the
 * download lands in the folder that was chosen and nowhere else.
 */
function sanitiseFileName(name: string): string {
  // Both separators, not just the POSIX one: a name of `..\startup.bat` from a
  // hostile or eccentric device is a Windows path here even though the far end
  // never meant it as one.
  const base = name.split(/[/\\]/).pop() ?? ''

  // Filtered against a set rather than matched against a character class: a
  // class holding a quote, a star and a control-character range is easy to
  // escape subtly wrong, and wrong here either lets a dangerous name through
  // or mangles an ordinary one.
  //
  // Spaces and hyphens deliberately survive. `show tech-support.txt` is an
  // ordinary name off a switch, and rewriting it would make the saved file
  // hard to match against what is on the device.
  const cleaned = Array.from(base)
    .filter((character) => !RESERVED_NAME_CHARS.has(character) && character >= ' ')
    .join('')
    .replace(/^\.+$/, '')

  return cleaned || 'download'
}

/** Characters Windows refuses in a filename. `/` and `\` are split off above. */
const RESERVED_NAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*'])
