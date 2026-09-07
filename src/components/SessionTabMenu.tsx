import {
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  FolderOpenIcon,
} from '@heroicons/react/24/outline'
import ContextMenu from './ContextMenu'
import type { Session } from '@shared/types'

interface Props {
  session: Session
  /** Where the right-click happened, in viewport coordinates. */
  x: number
  y: number
  /** True while the duplicate is being opened — connecting is not instant. */
  duplicating: boolean
  onDuplicate: () => void
  onDownloadFile: () => void
  onBrowseFiles: () => void
  /** True when this session already has a file browser open. */
  browsing: boolean
  onClose: () => void
}

/**
 * Right-click menu on a session tab.
 *
 * Duplicating opens a second session to the same saved connection rather than
 * cloning the live one: an SSH channel cannot be forked, so "the same tab
 * again" can only mean "connect to that host again". Nothing is carried over
 * from the running session — not the working directory, not what is on screen.
 *
 * Downloading is offered only on SSH connections, because it is SFTP. Serial
 * and local shells get a disabled item that says why rather than no item at
 * all: a control that silently disappears reads as a bug, and the reason is
 * worth one line.
 */
export default function SessionTabMenu({
  session,
  x,
  y,
  duplicating,
  onDuplicate,
  onDownloadFile,
  onBrowseFiles,
  browsing,
  onClose,
}: Props) {
  // The transport is on the profile, and a session that is not connected has
  // no SFTP channel to open even when it is SSH.
  const isSsh = session.transport === undefined || session.transport === 'ssh'
  const connected = session.status === 'connected'

  const downloadHint = !isSsh
    ? 'File transfer needs SSH — this connection is a ' +
      (session.transport === 'serial' ? 'serial port.' : 'local shell.')
    : !connected
      ? 'Connect first — a file transfer needs a live session.'
      : `Fetch a file from ${session.profileName}`

  return (
    <ContextMenu x={x} y={y} onClose={onClose} className="w-56">
      <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500 truncate">
        {session.profileName}
      </p>

      <button
        type="button"
        onClick={onDuplicate}
        disabled={duplicating}
        title={`Open another session to ${session.profileName}`}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <DocumentDuplicateIcon className="w-3.5 h-3.5 shrink-0" />
        {duplicating ? 'Duplicating…' : 'Duplicate tab'}
      </button>

      {/* Browsing first: it is the one you want when you do not already know
          the path, which is most of the time. "Download file…" stays for when
          you do — typing a path you can see on screen beats hunting for it. */}
      <button
        type="button"
        onClick={onBrowseFiles}
        disabled={!isSsh || !connected || browsing}
        title={
          browsing
            ? `The file browser for ${session.profileName} is already open`
            : !isSsh || !connected
              ? downloadHint
              : `Browse files on ${session.profileName}`
        }
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <FolderOpenIcon className="w-3.5 h-3.5 shrink-0" />
        {browsing ? 'Files already open' : 'Browse files…'}
      </button>

      <button
        type="button"
        onClick={onDownloadFile}
        disabled={!isSsh || !connected}
        title={downloadHint}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <ArrowDownTrayIcon className="w-3.5 h-3.5 shrink-0" />
        Download file…
      </button>
    </ContextMenu>
  )
}
