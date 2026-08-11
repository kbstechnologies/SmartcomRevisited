import { useEffect, useState } from 'react'
import { ArrowPathIcon, ArrowDownTrayIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import type { UpdateStatus } from '@shared/updates'

/**
 * Update control, shown inside About.
 *
 * Deliberately quiet: it never interrupts a session with a modal, and it never
 * restarts the app on its own — a terminal that vanishes mid-command would be
 * worse than an out-of-date one.
 */
export default function UpdatePanel({ currentVersion }: { currentVersion: string }) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    void window.electronAPI.invoke<UpdateStatus>('updates:status').then((response) => {
      if (!cancelled && response.success && response.data) setStatus(response.data)
    })

    const onStatus = (next: UpdateStatus) => setStatus(next)
    window.electronAPI.on('update-status', onStatus)
    return () => {
      cancelled = true
      window.electronAPI.off('update-status', onStatus)
    }
  }, [])

  const run = async (channel: 'updates:check' | 'updates:download' | 'updates:install') => {
    setBusy(true)
    try {
      const response = await window.electronAPI.invoke<UpdateStatus>(channel)
      if (response.success && response.data) setStatus(response.data)
    } finally {
      setBusy(false)
    }
  }

  const openReleases = () => void window.electronAPI.invoke('updates:open-releases')

  const line = (() => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…'
      case 'current':
        return `Up to date — version ${currentVersion}`
      case 'available':
        return `Version ${status.version} is available`
      case 'downloading':
        return `Downloading ${status.version}… ${status.percent}%`
      case 'ready':
        return `Version ${status.version} is ready — restart to finish`
      case 'unsupported':
        return status.reason
      case 'error':
        return `Update check failed: ${status.message}`
      default:
        return `Version ${currentVersion}`
    }
  })()

  const tone =
    status.state === 'error'
      ? 'text-amber-400'
      : status.state === 'ready' || status.state === 'available'
        ? 'text-blue-400'
        : 'text-gray-400'

  return (
    <div className="border-t border-gray-700 pt-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <span className={`text-xs ${tone} min-w-0 break-words`}>{line}</span>
        <button
          onClick={() => void run('updates:check')}
          disabled={busy || status.state === 'checking'}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40 shrink-0"
        >
          <ArrowPathIcon className="w-3.5 h-3.5" />
          Check
        </button>
      </div>

      {status.state === 'downloading' && (
        <div className="h-1 rounded bg-gray-700 overflow-hidden">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${status.percent}%` }} />
        </div>
      )}

      <div className="flex gap-2">
        {status.state === 'available' && status.canInstall && (
          <button
            onClick={() => void run('updates:download')}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
          >
            <ArrowDownTrayIcon className="w-3.5 h-3.5" />
            Download
          </button>
        )}

        {status.state === 'ready' && (
          <button
            onClick={() => void run('updates:install')}
            className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500"
          >
            Restart and install
          </button>
        )}

        {(status.state === 'unsupported' ||
          status.state === 'error' ||
          (status.state === 'available' && !status.canInstall)) && (
          <button
            onClick={openReleases}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
            Downloads
          </button>
        )}
      </div>
    </div>
  )
}
