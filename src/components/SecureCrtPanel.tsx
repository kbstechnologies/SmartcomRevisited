import { useState } from 'react'
import { clsx } from 'clsx'
import { useStore } from '../store/useStore'

interface ScanResult {
  folder: string
  scanned: number
  candidates: Array<{ name: string; group?: string; transport: string; host?: string }>
  skipped: Array<{ name: string; reason: string }>
  unsupported: Array<{ name: string; reason: string }>
}

/**
 * SecureCRT interoperability, both directions.
 *
 * Lives under Settings → Advanced rather than beside the connection list: it is
 * a migration tool used once or twice, not part of the daily loop, and it was
 * cluttering the toolbar people actually use.
 *
 * The import is deliberately two steps. Reading someone's SecureCRT store can
 * turn up hundreds of sessions, and "import" is not a verb anyone wants to
 * discover the meaning of afterwards — so it scans, shows exactly what would be
 * created, and only writes when asked again.
 */
export default function SecureCrtPanel() {
  const profiles = useStore((state) => state.profiles)
  const scanSecureCrt = useStore((state) => state.scanSecureCrt)
  const importSecureCrt = useStore((state) => state.importSecureCrt)
  const exportForSecureCrt = useStore((state) => state.exportConnectionsForSecureCrt)
  const loadProfiles = useStore((state) => state.loadProfiles)
  const loadConnectionGroups = useStore((state) => state.loadConnectionGroups)

  const [busy, setBusy] = useState(false)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [includeUsernames, setIncludeUsernames] = useState(false)

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const message = await action()
      if (message) setNotice(message)
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : 'Operation failed'
      if (!message.toLowerCase().includes('cancelled')) setError(message)
    } finally {
      setBusy(false)
    }
  }

  const handleScan = () =>
    run(async () => {
      const result = await scanSecureCrt()
      setScan(result)
      return `Found ${result.scanned} session file(s) in ${result.folder}`
    })

  const handleImport = () =>
    run(async () => {
      if (!scan) return null
      const result = await importSecureCrt(scan.folder)
      setScan(null)
      await loadProfiles()
      await loadConnectionGroups()

      const parts = [`Imported ${result.imported} connection(s)`]
      if (result.renamed.length) {
        parts.push(`renamed ${result.renamed.length} to avoid a clash`)
      }
      return parts.join(' — ')
    })

  const handleExport = () =>
    run(async () => {
      const result = await exportForSecureCrt({ includeUsernames })
      const parts = [`Exported ${result.exported} connection(s) to ${result.filePath}`]
      if (result.unsupported.length) parts.push(`${result.unsupported.length} unsupported`)
      if (result.skipped.length) parts.push(`${result.skipped.length} skipped`)
      return parts.join(' — ')
    })

  const card = 'bg-gray-700 border border-gray-600 rounded-lg p-4'

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium text-white">SecureCRT</h3>

      {/* ---------------------------------------------------------- import */}
      <div className={card}>
        <h4 className="text-sm font-medium text-gray-300 mb-1">Import connections from SecureCRT</h4>
        <p className="text-xs text-gray-400 mb-3">
          Reads SecureCRT&rsquo;s own session folder and creates matching connections here. Session
          folders become connection folders. Nothing is written until you have seen what it found.
        </p>

        <p className="text-[11px] text-amber-400 mb-3">
          Passwords and passphrases are never read. SecureCRT keeps them encrypted in its own
          store, and they stay there — you will set up authentication again on this side.
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleScan}
            disabled={busy}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {busy ? 'Working…' : scan ? 'Choose another folder' : 'Choose folder and scan…'}
          </button>
          {scan && scan.candidates.length > 0 && (
            <button
              type="button"
              onClick={handleImport}
              disabled={busy}
              className="btn btn-primary text-sm disabled:opacity-50"
            >
              Import {scan.candidates.length} connection
              {scan.candidates.length === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {scan && (
          <div className="mt-3 space-y-2">
            {scan.candidates.length === 0 && (
              <p className="text-xs text-gray-400">
                Nothing here can be imported. Check this is the <code>Sessions</code> folder inside
                SecureCRT&rsquo;s <code>Config</code> directory.
              </p>
            )}

            {scan.candidates.length > 0 && (
              <div className="max-h-44 overflow-y-auto rounded border border-gray-600 divide-y divide-gray-700">
                {scan.candidates.map((candidate, index) => (
                  <div key={index} className="px-2.5 py-1.5 text-[11px] text-gray-200">
                    <span className="text-gray-100">{candidate.name}</span>
                    {candidate.group && <span className="text-gray-500"> in {candidate.group}</span>}
                    <span className="text-gray-500">
                      {' '}
                      — {candidate.transport === 'serial' ? 'serial' : candidate.host}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(scan.unsupported.length > 0 || scan.skipped.length > 0) && (
              <div className="rounded border border-gray-600 divide-y divide-gray-700">
                {[...scan.unsupported, ...scan.skipped].slice(0, 20).map((item, index) => (
                  <div key={index} className="px-2.5 py-1.5 text-[11px]">
                    <span className="text-amber-300">{item.name}</span>
                    <span className="text-gray-500"> — {item.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------- export */}
      <div className={card}>
        <h4 className="text-sm font-medium text-gray-300 mb-1">Export connections for SecureCRT</h4>
        <p className="text-xs text-gray-400 mb-3">
          Writes a CSV for SecureCRT 9.2+ (Tools → Import Settings from Text File), covering{' '}
          {profiles.length} saved connection{profiles.length === 1 ? '' : 's'}. A README with the
          import steps is saved beside it.
        </p>

        <p className="text-[11px] text-gray-500 mb-3">
          Saved connections only — buttons, audit history, session logs, global variables and
          assistant settings are not part of a SecureCRT session. No passwords, passphrases or
          private keys are written. Serial connections are reported rather than exported, because
          SecureCRT&rsquo;s text importer has no columns for baud rate or parity.
        </p>

        <label className="flex items-start gap-2 text-xs text-gray-300 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={includeUsernames}
            onChange={(event) => setIncludeUsernames(event.target.checked)}
            className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
          />
          <span>
            Include usernames
            <span className="block text-[11px] text-gray-500">
              Off by default. Not a credential, but an account name leaving this machine.
            </span>
          </span>
        </label>

        <button
          type="button"
          onClick={handleExport}
          disabled={busy || profiles.length === 0}
          className="btn btn-secondary text-sm disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Export CSV…'}
        </button>
      </div>

      {(error || notice) && (
        <p className={clsx('text-xs', error ? 'text-red-400' : 'text-green-400')}>
          {error ?? notice}
        </p>
      )}
    </div>
  )
}
