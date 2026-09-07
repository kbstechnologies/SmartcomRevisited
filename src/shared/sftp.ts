/**
 * The SFTP explorer and its download queue.
 *
 * Browsing and downloading are separate ideas on purpose. Browsing is a
 * question the operator asks and gets an answer to immediately; a download is
 * work that outlives the panel it was started from — a capture file is
 * routinely hundreds of megabytes, and the pane it was queued in may be popped
 * out to another monitor, switched away from, or closed while it runs.
 *
 * So the queue lives in the main process and every window watches it. Closing
 * the explorer does not cancel a transfer, and the same queue is visible from
 * wherever it is looked at.
 */

/** One entry in a remote directory listing. */
export interface SftpEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  /** ISO 8601, or null where the host reported no modification time. */
  modifiedAt: string | null
}

export interface SftpListing {
  /** The path the host resolved the request to — `.` becomes the login directory. */
  path: string
  entries: SftpEntry[]
}

/**
 * Where a queued transfer has got to.
 *
 * `cancelled` and `failed` are kept apart because they mean different things to
 * the person looking at the list: one they did, the other happened to them.
 */
export type SftpTransferStatus = 'queued' | 'active' | 'done' | 'failed' | 'cancelled'

export interface SftpTransfer {
  id: string
  sessionId: string
  /** Host label, so a queue watched from another window can name the device. */
  profileName: string
  remotePath: string
  localPath: string
  /** Bytes, from the host's own stat. Zero when it could not be determined. */
  size: number
  transferred: number
  status: SftpTransferStatus
  /** Set only on `failed`. */
  error?: string
  queuedAt: string
  finishedAt?: string
}

/** Everything a queue view needs, in one push. */
export interface SftpQueueState {
  transfers: SftpTransfer[]
  /** True while something is being fetched, so a window can show it anywhere. */
  active: boolean
}

/** How many bytes, for people rather than for arithmetic. */
export function formatSftpBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * The pane id for a session's explorer.
 *
 * An explorer is a pane in the same workspace as the terminals — same tab
 * strip, same grid, same pop-out — so it needs an id of the same kind. Deriving
 * it from the session id rather than generating one means a window handed
 * `sftp:abc` can render the explorer for session `abc` knowing nothing else,
 * which is exactly what a detached window gets in its query string.
 */
export const SFTP_PANE_PREFIX = 'sftp:'

export const sftpPaneId = (sessionId: string): string => `${SFTP_PANE_PREFIX}${sessionId}`

export const isSftpPaneId = (paneId: string): boolean => paneId.startsWith(SFTP_PANE_PREFIX)

export const sessionIdFromPane = (paneId: string): string =>
  paneId.startsWith(SFTP_PANE_PREFIX) ? paneId.slice(SFTP_PANE_PREFIX.length) : paneId
