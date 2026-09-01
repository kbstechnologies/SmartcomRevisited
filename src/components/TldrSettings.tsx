import { useEffect, useState } from 'react'
import { ArrowPathIcon, FolderOpenIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import type { Settings } from '@shared/types'

/**
 * The tldr tab in Settings: what is cached, and the three things you can do
 * about it.
 *
 * Cache controls are here rather than buried because the failure modes are all
 * ones an operator has to be able to act on: a machine that was offline on
 * first run, a network that only reaches an internal mirror, a cache that went
 * stale on a laptop that lives in a locked cabinet.
 */

interface TldrSettingsProps {
  /** Edits go through the same form state as every other settings tab. */
  values: Partial<Settings>
  onChange: (field: keyof Settings, value: unknown) => void
}

const formatBytes = (bytes: number): string => {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatDate = (iso: string | null): string => {
  if (!iso) return 'never'
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 'unknown' : new Date(parsed).toLocaleString()
}

export default function TldrSettings({ values, onChange }: TldrSettingsProps) {
  const status = useStore((store) => store.tldrStatus)
  const loadStatus = useStore((store) => store.loadTldrStatus)
  const update = useStore((store) => store.tldrUpdate)
  const rebuild = useStore((store) => store.tldrRebuild)
  const clear = useStore((store) => store.tldrClear)

  const [working, setWorking] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setWorking(label)
    setMessage(null)
    try {
      await action()
      setMessage(`${label} finished.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label} failed.`)
    } finally {
      setWorking(null)
    }
  }

  const busy = working !== null || status?.busy === true

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-4">tldr command intelligence</h3>

        <div className="form-group">
          <label className="flex items-start gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={values.tldrEnabled !== false}
              onChange={(event) => onChange('tldrEnabled', event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Detect commands as they are typed
              <span className="block text-xs text-gray-500">
                Watches the keystrokes going to the terminal so the TLDR chip can offer the right
                page. Turning this off stops the detection entirely; the panel and the Command
                Center (Ctrl+Shift+T) still work when opened deliberately. Nothing is captured
                while the far end is asking for a password.
              </span>
            </span>
          </label>
        </div>

        <div className="form-group">
          <label className="flex items-start gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={values.tldrAutoUpdate !== false}
              onChange={(event) => onChange('tldrAutoUpdate', event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Refresh the page set in the background
              <span className="block text-xs text-gray-500">
                Checked well after start-up, never on the path to a lookup. A stale cache is used
                as-is while a refresh runs behind it.
              </span>
            </span>
          </label>
        </div>

        <div className="form-group">
          <label className="form-label text-sm">Refresh after (days)</label>
          <input
            type="number"
            min={1}
            max={90}
            value={values.tldrUpdateIntervalDays ?? 7}
            onChange={(event) => onChange('tldrUpdateIntervalDays', Number(event.target.value))}
            disabled={values.tldrAutoUpdate === false}
            className="form-input max-w-32 disabled:opacity-50"
          />
        </div>
      </div>

      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-300">Local page cache</h4>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-gray-400">Status</dt>
          <dd className="text-right text-gray-200">
            {status?.busy
              ? 'Updating…'
              : status?.ready
                ? 'Ready — works offline'
                : 'Not downloaded'}
          </dd>

          <dt className="text-gray-400">Last updated</dt>
          <dd className="text-right text-gray-200">{formatDate(status?.lastUpdated ?? null)}</dd>

          <dt className="text-gray-400">Dataset version</dt>
          <dd className="text-right text-gray-200">{status?.datasetVersion ?? '—'}</dd>

          <dt className="text-gray-400">Pages</dt>
          <dd className="text-right text-gray-200">
            {status?.pageCount ? status.pageCount.toLocaleString() : '—'}
          </dd>

          <dt className="text-gray-400">Platforms</dt>
          <dd className="text-right text-gray-200 truncate">
            {status?.platforms.length ? status.platforms.join(', ') : '—'}
          </dd>

          <dt className="text-gray-400">Languages</dt>
          <dd className="text-right text-gray-200">
            {status?.languages.length ? status.languages.join(', ') : '—'}
          </dd>

          <dt className="text-gray-400">Index version</dt>
          <dd className="text-right text-gray-200">{status?.indexVersion ?? '—'}</dd>

          <dt className="text-gray-400">On disk</dt>
          <dd className="text-right text-gray-200">{formatBytes(status?.cacheBytes ?? 0)}</dd>
        </dl>

        {status?.cacheDir && (
          <button
            type="button"
            onClick={() =>
              void window.electronAPI.invoke('app:open-path', { path: status.cacheDir })
            }
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-gray-300 hover:bg-gray-600"
          >
            <FolderOpenIcon className="w-4 h-4 shrink-0 text-gray-500" />
            <span className="min-w-0 truncate">{status.cacheDir}</span>
          </button>
        )}

        {status?.error && (
          <p className="text-xs text-amber-400">
            Last update failed: {status.error}. The terminal is unaffected.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('Update', update)}
            className="btn btn-sm btn-primary flex items-center gap-1 disabled:opacity-50"
          >
            <ArrowPathIcon className="w-3.5 h-3.5" />
            {working === 'Update' ? 'Updating…' : 'Update now'}
          </button>

          <button
            type="button"
            disabled={busy || !status?.ready}
            onClick={() => void run('Rebuild', rebuild)}
            className="btn btn-sm btn-secondary flex items-center gap-1 disabled:opacity-50"
            title="Re-index the pages already on disk. No network needed."
          >
            <ArrowPathIcon className="w-3.5 h-3.5" />
            {working === 'Rebuild' ? 'Rebuilding…' : 'Rebuild index'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void run('Clear', clear)}
            className="btn btn-sm btn-danger flex items-center gap-1 disabled:opacity-50"
            title="Delete the cache. It is downloaded again on the next start."
          >
            <TrashIcon className="w-3.5 h-3.5" />
            Clear cache
          </button>
        </div>

        {message && <p className="text-xs text-gray-300">{message}</p>}
      </div>

      <p className="text-xs text-gray-500 leading-relaxed">
        Pages come from the tldr-pages project&apos;s own release archive and are licensed CC BY
        4.0. Smartcom bundles the integration, not the data — nothing needs a <code>tldr</code>{' '}
        client installed. Documentation describes what a command does; it is not a judgement about
        whether it is safe to run on the box in front of you.
      </p>
    </div>
  )
}
