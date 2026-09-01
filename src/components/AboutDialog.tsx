import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon, FolderOpenIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import logoUrl from '../assets/logo.png'
import iconUrl from '../assets/icon.png'
import UpdatePanel from './UpdatePanel'

interface AboutDialogProps {
  onClose: () => void
}

interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  packaged: boolean
  userMachine: string
  dataDirectory: string
  databasePath: string
  logDirectory: string
  encryptionAvailable: boolean
  /** Which keyring is encrypting the secrets — the one that varies on Linux. */
  encryptionBackend: string
  /** Version that last wrote the database, when this start-up was an upgrade. */
  previousVersion: string | null
  /** Snapshot taken before migrating that data. */
  backupPath: string | null
}

const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false

    window.electronAPI
      .invoke<AppInfo>('app:get-info')
      .then((response) => {
        if (cancelled) return
        if (response.success && response.data) {
          setInfo(response.data)
        } else {
          setError(response.error ?? 'Could not read application info')
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))

    return () => {
      cancelled = true
    }
  }, [])

  // Esc closes, matching the other dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openPath = (path: string) => {
    void window.electronAPI.invoke('app:open-path', { path })
  }

  const copyDiagnostics = () => {
    if (!info) return
    const text = [
      `${info.name} ${info.version}${info.packaged ? '' : ' (development build)'}`,
      `Platform: ${PLATFORM_LABEL[info.platform] ?? info.platform} ${info.arch}`,
      `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`,
      `Credential encryption: ${info.encryptionBackend} (${info.encryptionAvailable ? 'available' : 'UNAVAILABLE'})`,
      `Data: ${info.dataDirectory}`,
      `Session logs: ${info.logDirectory}`,
    ].join('\n')

    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    })
  }

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-4 py-1">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className="text-gray-300 text-right break-all">{value}</span>
    </div>
  )

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">About</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* The wordmark is dark navy, so it sits on its own light panel. */}
          <div className="bg-white px-6 py-5 flex items-center justify-center">
            <img
              src={logoUrl}
              alt="Smartcom Revisited"
              className="w-full max-w-xs h-auto"
              draggable={false}
            />
          </div>

          <div className="px-4 py-4 space-y-4">
            <div className="flex items-center gap-3">
              <img src={iconUrl} alt="" className="w-12 h-12 rounded-lg" draggable={false} />
              <div className="min-w-0">
                <div className="text-base font-medium text-gray-100">
                  {info?.name ?? 'Smartcom Revisited'}
                </div>
                <div className="text-xs text-gray-400">
                  {info ? (
                    <>
                      Version {info.version}
                      {!info.packaged && <span className="ml-1 text-amber-400">(dev build)</span>}
                    </>
                  ) : (
                    'Loading…'
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs text-gray-400 leading-relaxed">
              An SSH terminal with programmable button sets — scripts built from blocks, popup
              forms that feed variables into them, session logging, and managed SSH keys.
            </p>

            {error && <p className="text-xs text-red-400">{error}</p>}

            {info && <UpdatePanel currentVersion={info.version} />}

            {info?.previousVersion && (
              <p className="text-xs text-gray-400 border-t border-gray-700 pt-3">
                Upgraded from {info.previousVersion}.
                {info.backupPath ? (
                  <>
                    {' '}
                    Your data was backed up first —{' '}
                    <button
                      onClick={() => openPath(info.backupPath!.replace(/[^\\/]+$/, ''))}
                      className="text-blue-400 hover:underline"
                    >
                      open the backups folder
                    </button>
                    .
                  </>
                ) : (
                  ' The pre-upgrade backup could not be written.'
                )}
              </p>
            )}

            {info && (
              <>
                <div className="text-xs border-t border-gray-700 pt-3">
                  <Row
                    label="Platform"
                    value={`${PLATFORM_LABEL[info.platform] ?? info.platform} · ${info.arch}`}
                  />
                  <Row label="Electron" value={info.electron} />
                  <Row label="Chromium" value={info.chrome} />
                  <Row label="Node" value={info.node} />
                  <Row label="Signed in as" value={info.userMachine} />
                  <div className="flex justify-between gap-4 py-1">
                    <span className="text-gray-500 shrink-0">Credential encryption</span>
                    <span
                      className={clsx(
                        'text-right',
                        info.encryptionAvailable ? 'text-green-400' : 'text-red-400'
                      )}
                    >
                      {info.encryptionBackend ??
                        (info.encryptionAvailable ? 'Available' : 'Unavailable')}
                    </span>
                  </div>
                </div>

                <div className="space-y-1 border-t border-gray-700 pt-3">
                  <button
                    onClick={() => openPath(info.dataDirectory)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-gray-300 hover:bg-gray-700"
                  >
                    <FolderOpenIcon className="w-4 h-4 shrink-0 text-gray-500" />
                    <span className="min-w-0">
                      <span className="block">Application data</span>
                      <span className="block text-gray-500 truncate">{info.dataDirectory}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => openPath(info.logDirectory)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-gray-300 hover:bg-gray-700"
                  >
                    <FolderOpenIcon className="w-4 h-4 shrink-0 text-gray-500" />
                    <span className="min-w-0">
                      <span className="block">Session logs</span>
                      <span className="block text-gray-500 truncate">{info.logDirectory}</span>
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Attribution the tldr-pages licence requires, wherever its content is
            shown. The pages ship with the app, so the notice does too. */}
        <div className="px-4 py-2 border-t border-gray-700 text-[10px] text-gray-500 leading-relaxed">
          Command documentation from the{' '}
          <button
            onClick={() =>
              void window.electronAPI.invoke('app:open-external', {
                url: 'https://github.com/tldr-pages/tldr',
              })
            }
            className="text-blue-400 hover:text-blue-300 underline"
          >
            tldr-pages
          </button>{' '}
          project, used under CC BY 4.0.
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
          <span className="text-[11px] text-gray-500">MIT licensed</span>
          <div className="flex gap-2">
            <button
              onClick={copyDiagnostics}
              disabled={!info}
              className="flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
            >
              <ClipboardDocumentIcon className="w-4 h-4" />
              {copied ? 'Copied' : 'Copy details'}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
