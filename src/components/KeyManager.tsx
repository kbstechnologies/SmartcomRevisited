import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import {
  XMarkIcon,
  KeyIcon,
  TrashIcon,
  ArrowUpTrayIcon,
  ClipboardDocumentIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import HostMultiSelect from './HostMultiSelect'
import type { SshKey, SshKeyType } from '@shared/types'

interface KeyManagerProps {
  onClose: () => void
}

type Panel = 'list' | 'generate' | 'import' | 'deploy'

/** Per-host outcome of a multi-host key install. */
interface DeployOutcome {
  name: string
  ok: boolean
  detail: string
}

export default function KeyManager({ onClose }: KeyManagerProps) {
  const sshKeys = useStore((state) => state.sshKeys)
  const profiles = useStore((state) => state.profiles)
  const sessions = useStore((state) => state.sessions)

  const loadSshKeys = useStore((state) => state.loadSshKeys)
  const generateSshKey = useStore((state) => state.generateSshKey)
  const importSshKey = useStore((state) => state.importSshKey)
  const deleteSshKey = useStore((state) => state.deleteSshKey)
  const exportSshKey = useStore((state) => state.exportSshKey)
  const deploySshKey = useStore((state) => state.deploySshKey)

  const [panel, setPanel] = useState<Panel>('list')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<SshKey | null>(null)

  // Generate form. ed25519 is the default: it is what ssh-keygen has defaulted
  // to for years, and RSA is now the deliberate compatibility choice.
  const [genName, setGenName] = useState('')
  const [genType, setGenType] = useState<SshKeyType>('ed25519')
  const [genBits, setGenBits] = useState(4096)
  const [genComment, setGenComment] = useState('')
  const [genPassphrase, setGenPassphrase] = useState('')

  // Import form
  const [impName, setImpName] = useState('')
  const [impKey, setImpKey] = useState('')
  const [impPassphrase, setImpPassphrase] = useState('')

  // Deploy form
  const [deployProfileIds, setDeployProfileIds] = useState<string[]>([])
  const [deployPassword, setDeployPassword] = useState('')
  const [deployResults, setDeployResults] = useState<DeployOutcome[]>([])

  useEffect(() => {
    void loadSshKeys()
  }, [loadSshKeys])

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  const run = async (action: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice(await action())
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  const handleGenerate = () =>
    run(async () => {
      if (!genName.trim()) throw new Error('Give the key a name')
      const key = await generateSshKey({
        name: genName.trim(),
        type: genType,
        // Only meaningful for RSA; ignored for ed25519, whose size is fixed.
        bits: genType === 'rsa' ? genBits : undefined,
        comment: genComment.trim(),
        passphrase: genPassphrase || undefined,
      })
      setGenName('')
      setGenComment('')
      setGenPassphrase('')
      setPanel('list')
      return `Generated ${key.name} (${key.fingerprint})`
    })

  const handleImport = () =>
    run(async () => {
      if (!impName.trim()) throw new Error('Give the key a name')
      if (!impKey.trim()) throw new Error('Paste the private key')
      const key = await importSshKey({
        name: impName.trim(),
        privateKey: impKey,
        passphrase: impPassphrase || undefined,
        comment: impName.trim(),
      })
      setImpName('')
      setImpKey('')
      setImpPassphrase('')
      setPanel('list')
      return `Imported ${key.name} (${key.fingerprint})`
    })

  /**
   * Installs the key on every selected host, one at a time.
   *
   * Sequential rather than parallel on purpose: each host may prompt the vault,
   * and a burst of simultaneous SSH logins from one workstation looks exactly
   * like an attack to anything watching auth logs.
   *
   * One host failing must not abandon the rest — the common case for a fleet is
   * that two boxes have a different password — so every result is collected and
   * shown per host rather than throwing on the first error.
   */
  const handleDeploy = () =>
    run(async () => {
      if (!selectedKey) throw new Error('Choose a key')
      if (deployProfileIds.length === 0) throw new Error('Choose at least one host')

      const results: DeployOutcome[] = []

      for (const profileId of deployProfileIds) {
        const profile = profiles.find((item) => item.id === profileId)
        const name = profile?.name ?? profileId

        // Reuse a live connection when there is one, so no password is needed.
        const liveSession = sessions.find(
          (session) => session.profileId === profileId && session.status === 'connected'
        )

        try {
          const result = await deploySshKey({
            keyId: selectedKey.id!,
            profileId,
            sessionId: liveSession?.id,
            password: liveSession ? undefined : deployPassword || undefined,
          })

          results.push({
            name,
            ok: true,
            detail:
              result.status === 'already-present'
                ? '— already present'
                : '— installed',
          })
        } catch (deployError) {
          results.push({
            name,
            ok: false,
            detail: `— ${deployError instanceof Error ? deployError.message : 'failed'}`,
          })
        }
      }

      setDeployResults(results)
      setDeployPassword('')

      const installed = results.filter((item) => item.ok).length
      const failed = results.length - installed

      // The panel stays open when anything failed, so the per-host list can be
      // read; closing it would hide exactly the information that is needed.
      if (failed === 0) setPanel('list')

      return failed === 0
        ? `Key installed on ${installed} host${installed === 1 ? '' : 's'}`
        : `${installed} of ${results.length} succeeded — ${failed} failed, see the list`
    })

  const handleDelete = async (key: SshKey) => {
    if (!window.confirm(`Delete key "${key.name}"? This removes the private key from the vault.`)) {
      return
    }
    await run(async () => {
      await deleteSshKey(key.id!)
      return `Deleted ${key.name}`
    })
  }

  /**
   * Selected hosts with no open session. These are the ones a password is
   * needed for, and the count decides whether the field is asked for at all.
   */
  const needPassword = deployProfileIds
    .filter(
      (id) => !sessions.some((session) => session.profileId === id && session.status === 'connected')
    )
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="flex items-center gap-2 text-sm font-medium text-gray-100">
            <KeyIcon className="w-4 h-4" />
            SSH keys
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1 px-3 py-2 border-b border-gray-700">
          {(
            [
              ['list', 'Keys'],
              ['generate', 'Generate'],
              ['import', 'Import'],
            ] as Array<[Panel, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPanel(id)}
              className={clsx(
                'px-2.5 py-1 text-xs rounded',
                panel === id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {panel === 'list' && (
            <>
              {sshKeys.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-8">
                  No keys yet. Generate one to get started.
                </p>
              )}

              {sshKeys.map((key) => (
                <div key={key.id} className="rounded border border-gray-700 bg-gray-900/50 p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-100">{key.name}</span>
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                          {key.type}
                          {key.bits ? ` ${key.bits}` : ''}
                        </span>
                        {key.hasPassphrase && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900 text-green-300">
                            passphrase
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] font-mono text-gray-500 break-all">
                        {key.fingerprint}
                      </p>
                    </div>

                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => {
                          setSelectedKey(key)
                          // Clear the previous run's outcome, or a fresh deploy
                          // opens showing results from an unrelated key.
                          setDeployResults([])
                          setDeployProfileIds([])
                          setPanel('deploy')
                        }}
                        title="Install on one or more hosts"
                        className="p-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                      >
                        <ArrowUpTrayIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(key.publicKey)
                            .then(() => setNotice('Public key copied'))
                        }
                        title="Copy public key"
                        className="p-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                      >
                        <ClipboardDocumentIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          void run(async () => `Exported to ${await exportSshKey(key.id!)}`)
                        }
                        title="Export private key to a file"
                        className="p-1.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                      >
                        <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(key)}
                        title="Delete"
                        className="p-1.5 rounded bg-gray-700 text-gray-300 hover:bg-red-900 hover:text-red-300"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <textarea
                    readOnly
                    value={key.publicKey}
                    rows={2}
                    onFocus={(event) => event.target.select()}
                    className="mt-2 w-full px-2 py-1 rounded bg-gray-950 border border-gray-700 text-[10px] font-mono text-gray-400 resize-none"
                  />
                </div>
              ))}
            </>
          )}

          {panel === 'generate' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                The private key is stored encrypted by your OS keystore and never written to disk
                unless you export it.
              </p>

              <input
                value={genName}
                onChange={(event) => setGenName(event.target.value)}
                placeholder="Key name, e.g. prod-admin"
                className={inputClass}
              />

              <div>
                <label className="block text-xs font-medium text-gray-300 mb-1">Key type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['ed25519', 'ED25519', 'Recommended'],
                      ['rsa', 'RSA', 'Legacy compatibility'],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setGenType(value)}
                      className={clsx(
                        'px-3 py-2 rounded border text-left transition-colors',
                        genType === value
                          ? 'border-blue-500 bg-blue-600/20 text-white'
                          : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700'
                      )}
                    >
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-[11px] text-gray-400">{hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* The size only means anything for RSA, so it only appears for RSA. */}
              {genType === 'rsa' && (
                <div>
                  <label className="block text-xs font-medium text-gray-300 mb-1">Key size</label>
                  <select
                    value={genBits}
                    onChange={(event) => setGenBits(Number(event.target.value))}
                    className={inputClass}
                  >
                    <option value={2048}>2048 bits</option>
                    <option value={3072}>3072 bits</option>
                    <option value={4096}>4096 bits (recommended)</option>
                  </select>
                </div>
              )}

              <input
                value={genComment}
                onChange={(event) => setGenComment(event.target.value)}
                placeholder="Comment, e.g. me@laptop (optional)"
                className={inputClass}
              />

              <input
                type="password"
                value={genPassphrase}
                onChange={(event) => setGenPassphrase(event.target.value)}
                placeholder="Passphrase (optional, encrypts the key file itself)"
                className={inputClass}
              />

              <p className="text-[11px] text-gray-500 leading-relaxed">
                {genType === 'ed25519' ? (
                  <>
                    ED25519 keys are smaller and faster than RSA and are the modern default. A few
                    older SSH servers and embedded devices — some switches, PDUs and out-of-band
                    cards — only understand RSA. Choose RSA for those.
                  </>
                ) : (
                  <>
                    RSA is here for equipment that predates ED25519. Prefer ED25519 unless you know
                    the far end needs RSA.
                  </>
                )}
              </p>

              <button
                onClick={handleGenerate}
                disabled={busy}
                className="w-full px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Generating...' : `Generate ${genType === 'rsa' ? 'RSA' : 'ED25519'} keypair`}
              </button>
            </div>
          )}

          {panel === 'import' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Paste an existing private key (PEM or OpenSSH). The public key and fingerprint are
                derived automatically.
              </p>
              <input
                value={impName}
                onChange={(event) => setImpName(event.target.value)}
                placeholder="Key name"
                className={inputClass}
              />
              <textarea
                value={impKey}
                onChange={(event) => setImpKey(event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={8}
                className={`${inputClass} font-mono text-xs`}
              />
              <input
                type="password"
                value={impPassphrase}
                onChange={(event) => setImpPassphrase(event.target.value)}
                placeholder="Passphrase (if the key is encrypted)"
                className={inputClass}
              />
              <button
                onClick={handleImport}
                disabled={busy}
                className="w-full px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Importing...' : 'Import key'}
              </button>
            </div>
          )}

          {panel === 'deploy' && selectedKey && (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Appends <span className="text-gray-200">{selectedKey.name}</span> to each
                host&apos;s <code className="text-gray-300">~/.ssh/authorized_keys</code>, creating
                it with the right permissions. Skipped where already present.
              </p>

              <HostMultiSelect
                profiles={profiles}
                selected={deployProfileIds}
                onChange={setDeployProfileIds}
                hasSession={(id) =>
                  sessions.some((s) => s.profileId === id && s.status === 'connected')
                }
              />

              {deployProfileIds.length > 0 && (
                <>
                  {needPassword.length === 0 ? (
                    <p className="text-xs text-green-400">
                      Every selected host has an open session — no password needed.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <input
                        type="password"
                        value={deployPassword}
                        onChange={(event) => setDeployPassword(event.target.value)}
                        placeholder={
                          needPassword.length === 1
                            ? `Password for ${needPassword[0].name} (used once, not stored)`
                            : `Password for the ${needPassword.length} hosts without a session`
                        }
                        className={inputClass}
                      />
                      {needPassword.length > 1 && (
                        // Being explicit beats a silent run of failures: one
                        // password across several hosts only works when they
                        // genuinely share it.
                        <p className="text-[11px] text-amber-400">
                          The same password is tried on {needPassword.length} hosts:{' '}
                          {needPassword.map((profile) => profile.name).join(', ')}. Hosts that
                          reject it are reported individually.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              {deployResults.length > 0 && (
                <div className="rounded border border-gray-700 divide-y divide-gray-800 max-h-40 overflow-y-auto">
                  {deployResults.map((result) => (
                    <div
                      key={result.name}
                      className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]"
                    >
                      <span
                        className={clsx(
                          'mt-0.5 w-1.5 h-1.5 rounded-full shrink-0',
                          result.ok ? 'bg-green-400' : 'bg-red-400'
                        )}
                      />
                      <span className="min-w-0">
                        <span className="text-gray-200">{result.name}</span>
                        <span className={clsx('ml-1', result.ok ? 'text-gray-400' : 'text-red-300')}>
                          {result.detail}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setDeployResults([])
                    setPanel('list')
                  }}
                  className="flex-1 px-3 py-2 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
                >
                  Back
                </button>
                <button
                  onClick={handleDeploy}
                  disabled={busy || deployProfileIds.length === 0}
                  className="flex-1 px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {busy
                    ? 'Installing...'
                    : `Install on ${deployProfileIds.length || 'no'} host${
                        deployProfileIds.length === 1 ? '' : 's'
                      }`}
                </button>
              </div>
            </div>
          )}
        </div>

        {(error || notice) && (
          <div
            className={clsx(
              'px-4 py-2 border-t text-xs',
              error
                ? 'border-red-900 bg-red-950/50 text-red-300'
                : 'border-green-900 bg-green-950/40 text-green-300'
            )}
          >
            {error ?? notice}
          </div>
        )}
      </div>
    </div>
  )
}
