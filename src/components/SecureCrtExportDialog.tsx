import { useState } from 'react'
import { XMarkIcon, TableCellsIcon } from '@heroicons/react/24/outline'

interface Props {
  /** How many connections the export will consider. */
  count: number
  /** True when only the ticked connections are being exported. */
  selectionOnly: boolean
  onCancel: () => void
  onExport: (options: { includeUsernames: boolean }) => Promise<void>
}

/**
 * Confirms a SecureCRT export and sets its one option.
 *
 * It exists mainly to be honest about scope before the file is written: this
 * exports *saved connections*, and someone who reads "export" as "move my
 * Smartcom setup to SecureCRT" will otherwise discover the difference after
 * they have switched.
 */
export default function SecureCrtExportDialog({
  count,
  selectionOnly,
  onCancel,
  onExport,
}: Props) {
  const [includeUsernames, setIncludeUsernames] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await onExport({ includeUsernames })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="flex items-center gap-2 text-sm font-medium text-gray-100">
            <TableCellsIcon className="w-4 h-4" />
            Export connections for SecureCRT
          </h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-gray-300">
            Writes a CSV for SecureCRT 9.2+ (<span className="text-gray-400">Tools → Import
            Settings from Text File</span>), covering{' '}
            <span className="text-gray-100">
              {count} {selectionOnly ? 'selected ' : ''}connection{count === 1 ? '' : 's'}
            </span>
            . A short README with the import steps is saved next to it.
          </p>

          <div className="rounded border border-gray-700 bg-gray-900/50 p-2.5 space-y-1.5">
            <p className="text-[11px] text-gray-400">
              <span className="text-gray-200">Saved connections only.</span> Buttons, audit
              history, session logs, global variables and assistant settings are not part of a
              SecureCRT session and are not exported.
            </p>
            <p className="text-[11px] text-gray-400">
              <span className="text-gray-200">No secrets.</span> Passwords, passphrases, private
              keys and vault references are never written. You will set up authentication again in
              SecureCRT.
            </p>
            <p className="text-[11px] text-gray-400">
              Serial connections are reported rather than exported — SecureCRT&rsquo;s text
              importer has no columns for baud rate, parity or flow control.
            </p>
          </div>

          <label className="flex items-start gap-2 text-xs text-gray-200 cursor-pointer">
            <input
              type="checkbox"
              checked={includeUsernames}
              onChange={(event) => setIncludeUsernames(event.target.checked)}
              className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
            />
            <span>
              Include usernames
              <span className="block text-[11px] text-gray-500">
                Off by default. A username is not a credential, but it is an account name leaving
                this machine.
              </span>
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
    </div>
  )
}
