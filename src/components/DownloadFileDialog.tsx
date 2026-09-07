import { useEffect, useState } from 'react'
import { ArrowDownTrayIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import type { Session } from '@shared/types'

/**
 * "Get a file off this device."
 *
 * Two steps, and the split matters: this dialog asks *which file on the host*,
 * and the operating system's own save dialog then asks *where to put it*. The
 * second is deliberately not reimplemented here — a native save dialog is the
 * one file picker everybody already knows, and it is what makes this a
 * deliberate download rather than something an app decided for them.
 *
 * The path is typed rather than browsed. A remote file browser is a different
 * feature: it needs directory listing, paging and a tree, and none of that
 * helps the actual case, which is that somebody has just run a command that
 * printed a filename and wants that file.
 */

interface Props {
  session: Session
  onClose: () => void
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DownloadFileDialog({ session, onClose }: Props) {
  const downloadFile = useStore((store) => store.downloadFile)

  const [remotePath, setRemotePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState<{ localPath: string; bytes: number } | null>(null)
  const [progress, setProgress] = useState<{ transferred: number; total: number } | null>(null)

  // A capture file is routinely hundreds of megabytes, so a transfer with no
  // feedback looks like a hung app. Only this session's transfers count.
  useEffect(() => {
    const onProgress = (payload: {
      sessionId: string
      transferred: number
      total: number
    }) => {
      if (payload.sessionId === session.id) {
        setProgress({ transferred: payload.transferred, total: payload.total })
      }
    }

    window.electronAPI.on('file-transfer-progress', onProgress)
    return () => window.electronAPI.off('file-transfer-progress', onProgress)
  }, [session.id])

  const start = async () => {
    setProblem('')
    setDone(null)
    setProgress(null)
    setBusy(true)

    try {
      setDone(await downloadFile(session.id, remotePath))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
      : null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="min-w-0">
            <h2 className="text-lg font-medium text-white">Download a file</h2>
            <p className="text-xs text-gray-400 truncate">from {session.profileName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <form
          className="p-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          {problem && <div className="bg-red-600 text-white p-3 rounded-md text-sm">{problem}</div>}

          {done ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-200">
                Saved {formatBytes(done.bytes)} to
              </p>
              <code className="block break-all rounded bg-gray-900 px-3 py-2 text-xs text-gray-300">
                {done.localPath}
              </code>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDone(null)
                    setRemotePath('')
                  }}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white text-sm"
                >
                  Get another
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="remote-path">
                  Path on {session.profileName}
                </label>
                <input
                  id="remote-path"
                  type="text"
                  required
                  autoFocus
                  spellCheck={false}
                  disabled={busy}
                  placeholder="/var/log/messages"
                  value={remotePath}
                  onChange={(event) => setRemotePath(event.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white font-mono text-sm disabled:opacity-60"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Absolute, or relative to the directory you log in to. One file at a time —
                  transfers do not recurse into folders.
                </p>
              </div>

              {busy && (
                <div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>{percent === null ? 'Starting…' : `${percent}%`}</span>
                    {progress && progress.total > 0 && (
                      <span>
                        {formatBytes(progress.transferred)} of {formatBytes(progress.total)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded bg-gray-700 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-[width]"
                      style={{ width: `${percent ?? 5}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy || remotePath.trim() === ''}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-sm inline-flex items-center gap-2"
                >
                  <ArrowDownTrayIcon className="w-4 h-4" />
                  {busy ? 'Downloading…' : 'Choose where to save…'}
                </button>
                <span className="text-xs text-gray-500">
                  You pick the destination next.
                </span>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
