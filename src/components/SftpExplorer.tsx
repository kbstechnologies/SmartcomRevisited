import { useCallback, useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUturnUpIcon,
  DocumentIcon,
  FolderIcon,
  LinkIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import SftpQueuePanel from './SftpQueuePanel'
import { formatSftpBytes, type SftpEntry } from '@shared/sftp'
import type { Session } from '@shared/types'

/**
 * A file browser for one SSH session, rendered as a pane beside the terminals.
 *
 * It is a pane rather than a modal on purpose: browsing a device is something
 * you do *while* working on it, comparing what is on screen in the terminal
 * with what is on disk. A dialog would have to be dismissed to read the
 * scrollback behind it.
 *
 * ## What it deliberately does not do
 *
 * **No uploads, no renaming, no deleting.** This is a way to get things *off* a
 * device. Every one of those other operations writes to production network
 * equipment from a file manager, where a misclick is indistinguishable from an
 * intention, and none of them is what anybody opened this for.
 *
 * **No recursive folder download.** Queueing a directory tree means walking it
 * first, which on a device with a large filesystem is a long silent pause
 * followed by a queue nobody asked for. Folders are for navigating; files are
 * selected and downloaded.
 */

interface Props {
  session: Session
  isActive: boolean
}

export default function SftpExplorer({ session, isActive }: Props) {
  const list = useStore((store) => store.sftpList)
  const enqueue = useStore((store) => store.sftpEnqueue)

  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setProblem('')
      try {
        const listing = await list(session.id, target)
        setEntries(listing.entries)
        // The host resolves `.` and any `..` for us, so the bar always shows
        // where you actually are rather than what was typed to get there.
        setPath(listing.path)
        setSelected(new Set())
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
        setEntries(null)
      } finally {
        setLoading(false)
      }
    },
    [list, session.id]
  )

  // The first listing waits until the session is actually connected: opening
  // SFTP against a connecting session fails in a way that reads like the
  // feature is broken.
  useEffect(() => {
    if (session.status === 'connected' && entries === null && !problem) {
      void load('.')
    }
  }, [session.status, entries, problem, load])

  const visible = useMemo(() => {
    if (!entries) return []
    const needle = filter.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
  }, [entries, filter])

  const selectableNames = useMemo(
    () => visible.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
    [visible]
  )

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const download = async (names: string[]) => {
    if (names.length === 0) return

    setProblem('')
    setNote('')

    const files = names
      .map((name) => entries?.find((entry) => entry.name === name))
      .filter((entry): entry is SftpEntry => Boolean(entry) && !entry!.isDirectory)
      .map((entry) => ({
        remotePath: path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`,
        name: entry.name,
        size: entry.size,
      }))

    if (files.length === 0) return

    try {
      const result = await enqueue(session.id, files)
      setNote(
        `Queued ${result.queued} file${result.queued === 1 ? '' : 's'} to ${result.directory}`
      )
      setSelected(new Set())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Cancelling the folder picker is a decision, not a failure.
      if (!/cancel/i.test(message)) setProblem(message)
    }
  }

  const goUp = () => {
    const trimmed = path.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    void load(cut <= 0 ? '/' : trimmed.slice(0, cut))
  }

  if (session.status !== 'connected') {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-500 p-4 text-center">
        {session.status === 'connecting'
          ? 'Connecting…'
          : 'This session is not connected, so there is nothing to browse.'}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-gray-900 min-h-0">
      {/* Path bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-gray-800 border-b border-gray-700 shrink-0">
        <button
          onClick={goUp}
          disabled={loading || path === '/'}
          title="Up one folder"
          className="p-1 rounded hover:bg-gray-700 text-gray-300 disabled:opacity-30"
        >
          <ArrowUturnUpIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => void load(path)}
          disabled={loading}
          title="Refresh"
          className="p-1 rounded hover:bg-gray-700 text-gray-300 disabled:opacity-30"
        >
          <ArrowPathIcon className={clsx('w-4 h-4', loading && 'animate-spin')} />
        </button>

        <form
          className="flex-1 min-w-0"
          onSubmit={(event) => {
            event.preventDefault()
            const value = new FormData(event.currentTarget).get('path')
            if (typeof value === 'string' && value.trim()) void load(value.trim())
          }}
        >
          <label className="sr-only" htmlFor={`path-${session.id}`}>
            Path on {session.profileName}
          </label>
          <input
            id={`path-${session.id}`}
            name="path"
            key={path}
            defaultValue={path}
            spellCheck={false}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200"
          />
        </form>

        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          aria-label="Filter this folder"
          className="w-28 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
        />

        <button
          onClick={() => void download([...selected])}
          disabled={selected.size === 0}
          title={
            selected.size === 0
              ? 'Select one or more files'
              : `Download ${selected.size} file${selected.size === 1 ? '' : 's'}`
          }
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
          {selected.size > 0 ? `Download ${selected.size}` : 'Download'}
        </button>
      </div>

      {problem && (
        <div className="px-3 py-1.5 text-xs bg-red-950 border-b border-red-800 text-red-200">
          {problem}
        </div>
      )}
      {note && (
        <div className="flex items-start gap-2 px-3 py-1.5 text-xs bg-gray-800 border-b border-gray-700 text-gray-300">
          <span className="flex-1">{note}</span>
          <button onClick={() => setNote('')} className="text-gray-500 hover:text-gray-300">
            ×
          </button>
        </div>
      )}

      {/* Listing */}
      <div className="flex-1 min-h-0 overflow-auto">
        {entries === null && !problem ? (
          <div className="p-4 text-xs text-gray-500">Reading…</div>
        ) : visible.length === 0 ? (
          <div className="p-4 text-xs text-gray-500">
            {filter ? 'Nothing matches that filter.' : 'This folder is empty.'}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-800 text-gray-400">
              <tr>
                <th className="w-8 px-2 py-1">
                  <input
                    type="checkbox"
                    aria-label="Select every file here"
                    checked={
                      selectableNames.length > 0 && selected.size === selectableNames.length
                    }
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(selectableNames) : new Set())
                    }
                    disabled={selectableNames.length === 0}
                  />
                </th>
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="px-2 py-1 text-right font-medium w-24">Size</th>
                <th className="px-2 py-1 text-left font-medium w-36">Modified</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr
                  key={entry.name}
                  onDoubleClick={() =>
                    entry.isDirectory
                      ? void load(
                          path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`
                        )
                      : toggle(entry.name)
                  }
                  className={clsx(
                    'border-b border-gray-800 hover:bg-gray-800',
                    selected.has(entry.name) && 'bg-blue-950'
                  )}
                >
                  <td className="px-2 py-1">
                    {!entry.isDirectory && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.name}`}
                        checked={selected.has(entry.name)}
                        onChange={() => toggle(entry.name)}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <button
                      onClick={() =>
                        entry.isDirectory
                          ? void load(
                              path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`
                            )
                          : toggle(entry.name)
                      }
                      className="flex items-center gap-1.5 text-left w-full"
                    >
                      {entry.isDirectory ? (
                        <FolderIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      ) : (
                        <DocumentIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                      )}
                      <span
                        className={clsx(
                          'truncate',
                          entry.isDirectory ? 'text-blue-300' : 'text-gray-200'
                        )}
                      >
                        {entry.name}
                      </span>
                      {entry.isSymlink && (
                        <LinkIcon
                          className="w-3 h-3 text-gray-500 shrink-0"
                          title="Symbolic link"
                        />
                      )}
                    </button>
                  </td>
                  <td className="px-2 py-1 text-right text-gray-400 tabular-nums">
                    {entry.isDirectory ? '—' : formatSftpBytes(entry.size)}
                  </td>
                  <td className="px-2 py-1 text-gray-500">
                    {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* The queue is part of the pane rather than a separate window: what is
          downloading is the other half of what you are looking at. */}
      <SftpQueuePanel sessionId={session.id} expandedByDefault={isActive} />
    </div>
  )
}
