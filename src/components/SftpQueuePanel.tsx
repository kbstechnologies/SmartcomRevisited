import { useState } from 'react'
import { clsx } from 'clsx'
import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FolderOpenIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import { formatSftpBytes, type SftpTransfer } from '@shared/sftp'

/**
 * The download queue, shown at the foot of an explorer pane.
 *
 * The queue itself lives in the main process, so this is a view of shared
 * state rather than an owner of it: the same transfers appear in every window,
 * closing the pane does not cancel anything, and a transfer started before a
 * pop-out carries on being watched afterwards.
 *
 * It shows **this session's** transfers by default, because that is what the
 * pane is about — with a count of anything running elsewhere, so a queue on
 * another host is not invisible.
 */

interface Props {
  sessionId: string
  expandedByDefault?: boolean
}

const statusLabel: Record<SftpTransfer['status'], string> = {
  queued: 'Waiting',
  active: 'Downloading',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const statusColour: Record<SftpTransfer['status'], string> = {
  queued: 'text-gray-400',
  active: 'text-blue-400',
  done: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-500',
}

export default function SftpQueuePanel({ sessionId, expandedByDefault = false }: Props) {
  const queue = useStore((store) => store.sftpQueue)
  const cancel = useStore((store) => store.sftpCancel)
  const cancelAll = useStore((store) => store.sftpCancelAll)
  const clearFinished = useStore((store) => store.sftpClearFinished)
  const retry = useStore((store) => store.sftpRetry)
  const reveal = useStore((store) => store.sftpReveal)

  const [expanded, setExpanded] = useState(expandedByDefault)

  const mine = queue.transfers.filter((transfer) => transfer.sessionId === sessionId)
  const elsewhere = queue.transfers.filter(
    (transfer) =>
      transfer.sessionId !== sessionId &&
      (transfer.status === 'queued' || transfer.status === 'active')
  ).length

  const running = mine.filter(
    (transfer) => transfer.status === 'queued' || transfer.status === 'active'
  ).length

  if (mine.length === 0 && elsewhere === 0) return null

  return (
    <div className="border-t border-gray-700 bg-gray-850 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
      >
        {expanded ? (
          <ChevronDownIcon className="w-3.5 h-3.5" />
        ) : (
          <ChevronUpIcon className="w-3.5 h-3.5" />
        )}
        <span className="font-medium">Downloads</span>
        <span className="text-gray-500">
          {running > 0 ? `${running} in progress` : `${mine.length} finished`}
          {elsewhere > 0 && ` · ${elsewhere} on other hosts`}
        </span>
        <span className="flex-1" />
        {running > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation()
              void cancelAll()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation()
                void cancelAll()
              }
            }}
            className="text-gray-400 hover:text-red-300"
          >
            Stop all
          </span>
        )}
        {mine.some((transfer) => transfer.status !== 'queued' && transfer.status !== 'active') && (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation()
              void clearFinished()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation()
                void clearFinished()
              }
            }}
            className="text-gray-400 hover:text-gray-200"
          >
            Clear finished
          </span>
        )}
      </button>

      {expanded && (
        <ul className="max-h-44 overflow-auto border-t border-gray-800">
          {mine.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-500">
              Nothing for this host. {elsewhere} transfer{elsewhere === 1 ? '' : 's'} running
              elsewhere.
            </li>
          )}

          {mine.map((transfer) => {
            const percent =
              transfer.size > 0
                ? Math.min(100, Math.round((transfer.transferred / transfer.size) * 100))
                : null

            return (
              <li key={transfer.id} className="px-3 py-1.5 border-b border-gray-800 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs text-gray-200 flex-1" title={transfer.remotePath}>
                    {transfer.remotePath}
                  </span>
                  <span className={clsx('text-[10px] shrink-0', statusColour[transfer.status])}>
                    {statusLabel[transfer.status]}
                  </span>

                  {(transfer.status === 'queued' || transfer.status === 'active') && (
                    <button
                      onClick={() => void cancel(transfer.id)}
                      title="Stop this download"
                      className="p-0.5 rounded hover:bg-gray-700 text-gray-400 shrink-0"
                    >
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  )}
                  {(transfer.status === 'failed' || transfer.status === 'cancelled') && (
                    <button
                      onClick={() => void retry(transfer.id)}
                      title="Try again"
                      className="p-0.5 rounded hover:bg-gray-700 text-gray-400 shrink-0"
                    >
                      <ArrowPathIcon className="w-3 h-3" />
                    </button>
                  )}
                  {transfer.status === 'done' && (
                    <button
                      onClick={() => void reveal(transfer.id)}
                      title="Show where it was saved"
                      className="p-0.5 rounded hover:bg-gray-700 text-gray-400 shrink-0"
                    >
                      <FolderOpenIcon className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {transfer.status === 'active' && (
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 flex-1 rounded bg-gray-700 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-[width]"
                        style={{ width: `${percent ?? 5}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
                      {formatSftpBytes(transfer.transferred)}
                      {transfer.size > 0 && ` / ${formatSftpBytes(transfer.size)}`}
                    </span>
                  </div>
                )}

                {transfer.status === 'failed' && transfer.error && (
                  <p className="mt-0.5 text-[10px] text-red-300">{transfer.error}</p>
                )}
                {transfer.status === 'done' && (
                  <p className="mt-0.5 text-[10px] text-gray-500 truncate" title={transfer.localPath}>
                    {transfer.localPath}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
