import { useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { Settings } from '@shared/types'
import { CLOUD_DEFAULT_BASE_URL } from '@shared/cloud'

/**
 * The Cloud tab in Settings.
 *
 * Three fields and one honest paragraph. The paragraph matters as much as the
 * fields: somebody opening this tab is deciding whether to let a terminal talk
 * to a server, and the truthful answers are that it is optional, that it is
 * unfinished, and that nothing about the terminal changes either way.
 *
 * Edits go through the same form state as every other settings tab, so Save is
 * the one at the bottom of the dialog rather than a second one here.
 */

interface CloudSettingsProps {
  values: Partial<Settings>
  onChange: (field: keyof Settings, value: unknown) => void
}

export default function CloudSettings({ values, onChange }: CloudSettingsProps) {
  const state = useStore((store) => store.cloudState)
  const loadCloudState = useStore((store) => store.loadCloudState)
  const setActiveDialog = useStore((store) => store.setActiveDialog)

  useEffect(() => {
    void loadCloudState()
  }, [loadCloudState])

  const enabled = values.cloudEnabled ?? false

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-white mb-2">SmartCom Cloud</h3>
        <p className="text-sm text-gray-400">
          An optional account for syncing between machines. It is not finished — sync itself is
          still being built — and nothing in Smartcom needs it. Your connections, buttons and
          scripts live on this machine and stay the real copy.
        </p>
      </div>

      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onChange('cloudEnabled', event.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="text-sm text-gray-200">Enable SmartCom Cloud</span>
            <span className="block text-xs text-gray-400 mt-1">
              Off by default. While it is off, Smartcom makes no request to any SmartCom server —
              no account check, no telemetry, nothing.
            </span>
          </span>
        </label>
      </div>

      <div className="form-group">
        <label className="block text-sm text-gray-300 mb-1" htmlFor="cloud-base-url">
          Server
        </label>
        <input
          id="cloud-base-url"
          type="text"
          spellCheck={false}
          placeholder={CLOUD_DEFAULT_BASE_URL}
          value={values.cloudBaseUrl ?? ''}
          onChange={(event) => onChange('cloudBaseUrl', event.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
        />
        <p className="text-xs text-gray-400 mt-1">
          Blank uses {CLOUD_DEFAULT_BASE_URL}. Point this at your own install to self-host. Your
          sign-in is remembered per server, so switching back and forth does not sign you out —
          and one server is never handed another&apos;s credentials.
        </p>
      </div>

      <div className="form-group">
        <label className="block text-sm text-gray-300 mb-1" htmlFor="cloud-device-name">
          This device&apos;s name
        </label>
        <input
          id="cloud-device-name"
          type="text"
          maxLength={100}
          placeholder={state?.deviceName ?? 'hostname'}
          value={values.cloudDeviceName ?? ''}
          onChange={(event) => onChange('cloudDeviceName', event.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
        />
        <p className="text-xs text-gray-400 mt-1">
          How this machine appears in your account&apos;s device list. Blank uses the hostname,
          which is usually what you will recognise.
        </p>
      </div>

      {enabled && (
        <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.cloudSyncEnabled ?? false}
              onChange={(event) => onChange('cloudSyncEnabled', event.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="text-sm text-gray-200">Sync this machine</span>
              <span className="block text-xs text-gray-400 mt-1">
                Connections, folders, button sets and buttons, kept in step across your machines.
                Signing in does not do this on its own — it is a separate decision, because an
                account for the device list is not the same as agreeing that this machine&apos;s
                connections should leave it.
              </span>
              <span className="block text-xs text-gray-400 mt-2">
                <strong className="text-gray-300">Never synced:</strong> passwords, key
                passphrases, your script library and your global variables. Scripts and globals are
                files you own on disk, and overwriting one you were editing would be worse than not
                syncing it at all.
              </span>
            </span>
          </label>

          {(values.cloudSyncEnabled ?? false) && (
            <div className="mt-4">
              <label className="block text-sm text-gray-300 mb-1" htmlFor="cloud-sync-interval">
                Sync every
              </label>
              <select
                id="cloud-sync-interval"
                value={values.cloudSyncIntervalMinutes ?? 15}
                onChange={(event) =>
                  onChange('cloudSyncIntervalMinutes', Number(event.target.value))
                }
                className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
              >
                <option value={0}>Only when I ask</option>
                <option value={5}>5 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={60}>Hour</option>
                <option value={240}>4 hours</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Sync runs in the background and never delays a connection. A shorter interval wakes
                the network more often without making anything more correct.
              </p>
            </div>
          )}
        </div>
      )}

      {enabled && (
        <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
          <p className="text-sm text-gray-300">
            {state?.signedIn
              ? `Signed in as ${state.account?.user.email ?? 'this account'}.`
              : 'Not signed in.'}
          </p>
          <button
            type="button"
            onClick={() => setActiveDialog('cloud')}
            className="mt-3 px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white text-sm"
          >
            Open the account panel
          </button>
          <p className="text-xs text-gray-500 mt-2">
            Save this page first if you have just changed the server.
          </p>
        </div>
      )}

      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
        <h4 className="text-sm font-medium text-gray-300 mb-2">What is stored where</h4>
        <ul className="text-xs text-gray-400 space-y-1 list-disc pl-4">
          <li>
            Your sign-in is kept in the operating system&apos;s credential store — the same place
            SSH key passphrases go — and never in a settings file or the database.
          </li>
          <li>Passwords are sent to the server and never written to this machine.</li>
          <li>
            Payment details never touch Smartcom. Subscribing opens your browser on the payment
            provider&apos;s own page.
          </li>
        </ul>
      </div>
    </div>
  )
}
