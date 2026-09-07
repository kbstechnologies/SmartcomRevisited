import { useEffect, useState } from 'react'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ComputerDesktopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import type { CloudDevice } from '@shared/cloud'

/**
 * The SmartCom Cloud account panel.
 *
 * What it is careful about, in order of how badly getting it wrong would hurt:
 *
 * 1. **It never asks for a card.** Both money buttons hand a plan name to the
 *    main process, which opens a page hosted by the payment provider in the
 *    system browser. There is no payment form in this application, and an
 *    Electron renderer collecting card details would put a card number in a
 *    desktop app's memory for no benefit whatsoever.
 *
 * 2. **It says what an account does and does not affect.** Everything in the
 *    terminal keeps working with no account, an expired one, or no network.
 *    Revoking a device is not a remote wipe. Both are stated on the panel
 *    rather than left for somebody to find out.
 *
 * 3. **It distinguishes "cannot reach the server" from "signed out".** They
 *    look the same to a panel that only checks whether data arrived, and
 *    telling somebody they have been signed out because their train went into
 *    a tunnel is how trust in a sync product is lost. The main process reports
 *    which it was; this only renders it.
 */

interface CloudAccountPanelProps {
  onClose: () => void
}

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return 'never'
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 'unknown' : new Date(parsed).toLocaleString()
}

export default function CloudAccountPanel({ onClose }: CloudAccountPanelProps) {
  const state = useStore((store) => store.cloudState)
  const loadCloudState = useStore((store) => store.loadCloudState)
  const signIn = useStore((store) => store.cloudSignIn)
  const signOut = useStore((store) => store.cloudSignOut)
  const refresh = useStore((store) => store.cloudRefresh)
  const listDevices = useStore((store) => store.cloudDevices)
  const revokeDevice = useStore((store) => store.cloudRevokeDevice)
  const checkout = useStore((store) => store.cloudCheckout)
  const portal = useStore((store) => store.cloudPortal)
  const openSignup = useStore((store) => store.cloudOpenSignup)
  const syncStatus = useStore((store) => store.cloudSyncStatus)
  const loadSyncStatus = useStore((store) => store.loadCloudSyncStatus)
  const syncNow = useStore((store) => store.cloudSyncNow)
  const syncEverything = useStore((store) => store.cloudSyncEverything)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState('')
  const [devices, setDevices] = useState<CloudDevice[] | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  useEffect(() => {
    void loadCloudState()
    void loadSyncStatus()
  }, [loadCloudState, loadSyncStatus])

  // Devices are a second round trip, so they are fetched only once the panel
  // is open and only when there is an account to fetch them for.
  useEffect(() => {
    if (!state?.signedIn) {
      setDevices(null)
      return
    }

    let cancelled = false
    void listDevices()
      .then((found) => {
        if (!cancelled) setDevices(found)
      })
      .catch(() => {
        if (!cancelled) setDevices([])
      })

    return () => {
      cancelled = true
    }
  }, [state?.signedIn, state?.fetchedAt, listDevices])

  const run = async (work: () => Promise<void>) => {
    setProblem('')
    setWorking(true)
    try {
      await work()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  const busy = working || Boolean(state?.busy)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-medium text-white">SmartCom Cloud</h2>
            <p className="text-xs text-gray-400">
              Optional. Everything in Smartcom works without it.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {problem && (
            <div className="bg-red-600 text-white p-3 rounded-md text-sm">{problem}</div>
          )}

          {/* The main process could not construct a cloud service at all. */}
          {!state && (
            <p className="text-sm text-gray-400">
              The account service is unavailable in this build.
            </p>
          )}

          {state && !state.enabled && (
            <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-200">SmartCom Cloud is switched off</h3>
              <p className="text-xs text-gray-400 mt-2">
                Turn it on in <span className="text-gray-300">Settings → Cloud</span>. Until you do,
                Smartcom contacts no SmartCom server at all.
              </p>
            </div>
          )}

          {/* ------------------------------------------------------ signed out */}
          {state?.enabled && !state.signedIn && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void run(() => signIn(email.trim(), password))
              }}
            >
              <div>
                <h3 className="text-sm font-medium text-gray-200">Sign in</h3>
                <p className="text-xs text-gray-400 mt-1">
                  Signing in adds this machine to your account&apos;s device list. It does not
                  change, upload or delete anything you already have here.
                </p>
              </div>

              <div className="form-group">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="cloud-email">
                  Email
                </label>
                <input
                  id="cloud-email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
                />
              </div>

              <div className="form-group">
                <label className="block text-sm text-gray-300 mb-1" htmlFor="cloud-password">
                  Password
                </label>
                <input
                  id="cloud-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-sm"
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
                {/* Registration is never proxied through the API: the terms,
                    the price and the email verification live on the website,
                    and a second copy of a consent flow is a second copy to
                    keep correct. */}
                <button
                  type="button"
                  onClick={() => void run(() => openSignup())}
                  className="text-sm text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                >
                  Create an account
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                </button>
              </div>

              <p className="text-xs text-gray-500">
                Signing in to <span className="text-gray-400">{state.baseUrl}</span>
              </p>
            </form>
          )}

          {/* ------------------------------------------------------- signed in */}
          {state?.enabled && state.signedIn && (
            <>
              <section className="bg-gray-700 border border-gray-600 rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-200">
                      {state.account?.user.name ?? 'Signed in'}
                    </h3>
                    <p className="text-xs text-gray-400">{state.account?.user.email ?? ''}</p>
                  </div>
                  <button
                    onClick={() => void run(() => refresh())}
                    disabled={busy}
                    title="Re-read the account from the server"
                    className="text-gray-400 hover:text-white p-1 disabled:opacity-50"
                  >
                    <ArrowPathIcon className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-400">Plan</dt>
                    <dd className="text-gray-200">
                      {state.account?.entitlements.plan_label ?? '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-400">Status</dt>
                    <dd className="text-gray-200">
                      {(state.account?.subscription.status ?? 'none').replace(/_/g, ' ')}
                      {state.account?.subscription.cancel_at_period_end && (
                        <span className="text-amber-400"> — ends at the current period</span>
                      )}
                    </dd>
                  </div>
                  {state.account?.subscription.current_period_end && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-gray-400">
                        {state.account.subscription.cancel_at_period_end ? 'Access until' : 'Renews'}
                      </dt>
                      <dd className="text-gray-200">
                        {formatDate(state.account.subscription.current_period_end)}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-400">Last checked</dt>
                    <dd className="text-gray-400">{formatDate(state.fetchedAt)}</dd>
                  </div>
                </dl>

                {state.account && !state.account.user.email_verified && (
                  <p className="mt-3 text-xs text-amber-400">
                    Confirm your email address on the website — cloud features stay switched off
                    until you do.
                  </p>
                )}
              </section>

              {/* Sync. The copy is careful about two things people reasonably
                  worry about: what leaves the machine, and what happens to the
                  local copy. Both answers are stated rather than implied. */}
              <section className="bg-gray-700 border border-gray-600 rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <h3 className="text-sm font-medium text-gray-200">Sync</h3>
                  {syncStatus?.running && (
                    <span className="text-xs text-blue-400">Syncing…</span>
                  )}
                </div>

                {!syncStatus?.enabled ? (
                  <p className="text-xs text-gray-400 mt-2">
                    Off. Turn it on in <span className="text-gray-300">Settings → Cloud</span>.
                    Nothing on this machine is uploaded while it is off.
                  </p>
                ) : (
                  <>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-4">
                        <dt className="text-gray-400">Workspace</dt>
                        <dd className="text-gray-200">{syncStatus.workspaceName ?? 'Personal'}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-gray-400">Waiting to upload</dt>
                        <dd className="text-gray-200">{syncStatus.pending}</dd>
                      </div>
                      <div className="flex justify-between gap-4">
                        <dt className="text-gray-400">Last sync</dt>
                        <dd className="text-gray-400">{formatDate(syncStatus.lastSyncAt)}</dd>
                      </div>
                    </dl>

                    <p className="text-xs text-gray-400 mt-3">
                      Connections, folders, button sets and buttons. Scripts, global variables and
                      every password or key passphrase stay on this machine and are never uploaded.
                    </p>

                    {syncStatus.lastError && (
                      <p className="text-xs text-amber-400 mt-2">{syncStatus.lastError}</p>
                    )}

                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={() => void run(() => syncNow())}
                        disabled={busy}
                        className="px-3 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 rounded text-white text-sm"
                      >
                        Sync now
                      </button>
                      {/* Queues everything for upload. Named for what it does
                          rather than "reset", which reads like it might delete
                          something — it does not touch any data. */}
                      <button
                        onClick={() => void run(() => syncEverything())}
                        disabled={busy}
                        className="text-sm text-gray-400 hover:text-white"
                      >
                        Upload everything
                      </button>
                    </div>
                  </>
                )}
              </section>

              {/* ------------------------------------------------- subscription */}
              {state.billing?.available && (
                <section className="space-y-3">
                  <h3 className="text-sm font-medium text-gray-200">Subscription</h3>

                  {state.billing.portal_available ? (
                    <>
                      <p className="text-xs text-gray-400">
                        Change your card, download invoices, switch plan or cancel. This opens our
                        payment provider&apos;s secure portal in your browser — Smartcom never sees
                        your card details.
                      </p>
                      <button
                        onClick={() => void run(() => portal())}
                        disabled={busy}
                        className="px-3 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 rounded text-white text-sm inline-flex items-center gap-2"
                      >
                        Open the billing portal
                        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {state.billing.plans.map((plan) => (
                        <div
                          key={plan.plan}
                          className="bg-gray-700 border border-gray-600 rounded-lg p-4 flex flex-col"
                        >
                          <h4 className="text-sm font-medium text-gray-200">{plan.label}</h4>
                          <p className="mt-1">
                            <span className="text-xl font-semibold text-white">
                              {plan.display_price}
                            </span>{' '}
                            <span className="text-xs text-gray-400">{plan.display_period}</span>
                          </p>
                          <p className="mt-2 flex-1 text-xs text-gray-400">{plan.blurb}</p>
                          <button
                            onClick={() => void run(() => checkout(plan.plan))}
                            disabled={busy}
                            className="mt-3 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-sm inline-flex items-center justify-center gap-2"
                          >
                            Subscribe
                            <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {state.billing && !state.billing.available && (
                <p className="text-xs text-gray-500">
                  Subscriptions are not open on this server yet.
                </p>
              )}

              {/* ------------------------------------------------------ devices */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-200">Devices</h3>
                <p className="text-xs text-gray-400">
                  Revoking a device ends its access to this account. It is <em>not</em> a remote
                  wipe: that machine keeps every host, button and script it already has, and goes
                  on working offline.
                </p>

                {devices === null && <p className="text-xs text-gray-500">Loading…</p>}

                {devices?.length === 0 && (
                  <p className="text-xs text-gray-500">No devices on this account.</p>
                )}

                <ul className="space-y-2">
                  {devices?.map((device) => {
                    const isThisMachine = device.id === state.deviceId

                    return (
                      <li
                        key={device.id}
                        className="bg-gray-700 border border-gray-600 rounded-lg p-3 flex items-center gap-3"
                      >
                        <ComputerDesktopIcon className="w-5 h-5 text-gray-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-gray-200 truncate">
                            {device.name}
                            {isThisMachine && (
                              <span className="ml-2 text-xs text-blue-400">this machine</span>
                            )}
                            {device.revoked && (
                              <span className="ml-2 text-xs text-amber-400">revoked</span>
                            )}
                          </p>
                          <p className="text-xs text-gray-500 truncate">
                            {device.platform} · {device.app_version} · last seen{' '}
                            {formatDate(device.last_seen_at)}
                          </p>
                        </div>

                        {!device.revoked &&
                          (confirmRevoke === device.id ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                onClick={() =>
                                  void run(async () => {
                                    await revokeDevice(device.id)
                                    setConfirmRevoke(null)
                                    setDevices(await listDevices().catch(() => []))
                                  })
                                }
                                disabled={busy}
                                className="px-2 py-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded text-white text-xs"
                              >
                                {isThisMachine ? 'Revoke and sign out' : 'Revoke'}
                              </button>
                              <button
                                onClick={() => setConfirmRevoke(null)}
                                className="text-xs text-gray-400 hover:text-white"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmRevoke(device.id)}
                              className="text-xs text-gray-400 hover:text-white shrink-0"
                            >
                              Revoke
                            </button>
                          ))}
                      </li>
                    )
                  })}
                </ul>
              </section>

              {/* ----------------------------------------------------- sign out */}
              <section className="flex items-center gap-3 pt-2 border-t border-gray-700">
                <button
                  onClick={() => void run(() => signOut(false))}
                  disabled={busy}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 rounded text-white text-sm"
                >
                  Sign out
                </button>
                <button
                  onClick={() => void run(() => signOut(true))}
                  disabled={busy}
                  className="text-sm text-gray-400 hover:text-white"
                >
                  Sign out everywhere
                </button>
              </section>
            </>
          )}

          {/* The service's own diagnosis, which distinguishes the failures a
              panel cannot tell apart on its own. `auth` is already covered by
              the sign-in form appearing, so it is not repeated here. */}
          {state && state.error.kind !== 'none' && state.error.kind !== 'disabled' && (
            <p
              className={`text-xs ${
                state.error.kind === 'offline' ? 'text-gray-400' : 'text-amber-400'
              }`}
            >
              {state.error.kind === 'offline'
                ? `${state.error.message} You are still signed in; everything local is unaffected.`
                : state.error.message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
