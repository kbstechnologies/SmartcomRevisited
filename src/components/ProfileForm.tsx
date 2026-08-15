import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon, ArrowPathIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import SearchableSelect from './SearchableSelect'
import TagEditor from './TagEditor'
import { sharedTags } from '../lib/setVisibility'
import { VAULT_SERVICE } from '@shared/constants'
import {
  COMMON_BAUD_RATES,
  SERIAL_FLOW_CONTROL,
  SERIAL_PARITIES,
  type Profile,
  type SerialPortInfo,
  type Transport,
} from '@shared/types'

interface ProfileFormProps {
  profile?: Profile | null
  onClose: () => void
  onSave: () => void
}

/** Form state mirrors Profile plus the two write-only secret fields. */
type FormState = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> & {
  password: string
  passphrase: string
}

const blankForm = (): FormState => ({
  name: '',
  transport: 'ssh',
  groupId: undefined,
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  keyPath: undefined,
  keyId: undefined,
  serialPath: undefined,
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  startupMacroId: undefined,
  macroSetIds: [],
  tags: [],
  password: '',
  passphrase: '',
})

export default function ProfileForm({ profile, onClose, onSave }: ProfileFormProps) {
  const saveProfile = useStore((state) => state.saveProfile)
  const setSecret = useStore((state) => state.setSecret)
  const testProfile = useStore((state) => state.testProfile)
  const sshKeys = useStore((state) => state.sshKeys)
  const macros = useStore((state) => state.macros)
  const macroSets = useStore((state) => state.macroSets)
  const groups = useStore((state) => state.connectionGroups)
  const profiles = useStore((state) => state.profiles)
  const loadSshKeys = useStore((state) => state.loadSshKeys)
  const loadConnectionGroups = useStore((state) => state.loadConnectionGroups)
  const listSerialPorts = useStore((state) => state.listSerialPorts)

  const [form, setForm] = useState<FormState>(() =>
    profile ? { ...blankForm(), ...profile, password: '', passphrase: '' } : blankForm()
  )
  const [setSearch, setSetSearch] = useState('')
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  const [portsError, setPortsError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadSshKeys()
    void loadConnectionGroups()
  }, [loadSshKeys, loadConnectionGroups])

  const scanPorts = async () => {
    setScanning(true)
    setPortsError(null)
    try {
      setSerialPorts(await listSerialPorts())
    } catch (scanError) {
      setPortsError(scanError instanceof Error ? scanError.message : 'Could not list ports')
    } finally {
      setScanning(false)
    }
  }

  // Populate the port list as soon as serial is selected.
  useEffect(() => {
    if (form.transport === 'serial') void scanPorts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.transport])

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const { password, passphrase, ...profileFields } = form
      const saved = await saveProfile({ ...profileFields, id: profile?.id })

      // Secrets go to the OS-encrypted vault, never into the database.
      if (password) await setSecret(VAULT_SERVICE, `${saved.id}:password`, password)
      if (passphrase) await setSecret(VAULT_SERVICE, `${saved.id}:passphrase`, passphrase)

      onSave()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!profile?.id) {
      setTestResult('Save the connection first, then test.')
      return
    }
    setTestResult('Testing...')
    const result = await testProfile(profile.id)
    setTestResult(result.success ? 'Connection succeeded' : `Failed: ${result.error}`)
  }

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
  const labelClass = 'block text-xs font-medium text-gray-300 mb-1'

  const isSerial = form.transport === 'serial'

  const startupOptions = useMemo(() => {
    const setName = new Map(macroSets.map((set) => [set.id, set.name]))
    return macros
      .map((macro) => ({
        value: macro.id!,
        label: macro.name,
        group: setName.get(macro.setId) ?? 'Unknown set',
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  }, [macros, macroSets])

  /** Every tag already in use, so both sides can agree on spelling. */
  const knownTags = useMemo(
    () =>
      [
        ...new Set([
          ...macroSets.flatMap((set) => set.tags ?? []),
          ...profiles.flatMap((profile) => profile.tags ?? []),
        ]),
      ].sort(),
    [macroSets, profiles]
  )

  /**
   * Sets this connection's tags currently reach. Shown live while editing —
   * a tag that matches nothing is the most likely mistake, and finding out at
   * the moment you type it beats finding out when the panel looks empty.
   */
  const matchingSets = useMemo(
    () => macroSets.filter((set) => sharedTags(form.tags, set.tags).length > 0),
    [macroSets, form.tags]
  )

  const visibleSets = useMemo(() => {
    const term = setSearch.trim().toLowerCase()
    if (!term) return macroSets
    return macroSets.filter(
      (set) =>
        set.name.toLowerCase().includes(term) || set.description?.toLowerCase().includes(term)
    )
  }, [macroSets, setSearch])

  const toggleSet = (setId: string) =>
    update(
      'macroSetIds',
      form.macroSetIds.includes(setId)
        ? form.macroSetIds.filter((id) => id !== setId)
        : [...form.macroSetIds, setId]
    )

  return (
    <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">
            {profile?.id ? 'Edit connection' : 'New connection'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Transport picker */}
          <div className="flex rounded overflow-hidden border border-gray-600">
            {(['ssh', 'serial'] as Transport[]).map((transport) => (
              <button
                key={transport}
                onClick={() => update('transport', transport)}
                className={clsx(
                  'flex-1 px-3 py-1.5 text-xs transition-colors',
                  form.transport === transport
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                )}
              >
                {transport === 'ssh' ? 'SSH' : 'Serial / COM'}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelClass}>Name</label>
              <input
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder={isSerial ? 'Console cable' : 'Production web 01'}
                className={inputClass}
              />
            </div>
            <div className="w-44">
              <label className={labelClass}>Group</label>
              <select
                value={form.groupId ?? ''}
                onChange={(event) => update('groupId', event.target.value || undefined)}
                className={inputClass}
              >
                <option value="">— ungrouped —</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isSerial ? (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-300">Serial port</span>
                  <button
                    onClick={scanPorts}
                    disabled={scanning}
                    className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 disabled:opacity-50"
                  >
                    <ArrowPathIcon className={clsx('w-3 h-3', scanning && 'animate-spin')} />
                    Rescan
                  </button>
                </div>
                <select
                  value={
                    serialPorts.some((p) => p.path === form.serialPath) ? form.serialPath : ''
                  }
                  onChange={(event) => update('serialPath', event.target.value || undefined)}
                  className={inputClass}
                >
                  <option value="">
                    {serialPorts.length === 0 ? '— no ports detected —' : '— choose a port —'}
                  </option>
                  {serialPorts.map((port) => (
                    <option key={port.path} value={port.path}>
                      {port.path}
                      {port.friendlyName || port.manufacturer
                        ? ` — ${port.friendlyName ?? port.manufacturer}`
                        : ''}
                    </option>
                  ))}
                </select>
                {/* Typed entry too, for ports that do not enumerate. */}
                <input
                  value={form.serialPath ?? ''}
                  onChange={(event) => update('serialPath', event.target.value || undefined)}
                  placeholder="COM3 or /dev/ttyUSB0"
                  className={`${inputClass} mt-2 font-mono`}
                />
                {portsError && <p className="mt-1 text-[11px] text-amber-400">{portsError}</p>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Baud rate</label>
                  <input
                    list="baud-rates"
                    type="number"
                    value={form.baudRate}
                    onChange={(event) => update('baudRate', Number(event.target.value) || 115200)}
                    className={inputClass}
                  />
                  <datalist id="baud-rates">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <option key={rate} value={rate} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className={labelClass}>Data bits</label>
                  <select
                    value={form.dataBits}
                    onChange={(event) =>
                      update('dataBits', Number(event.target.value) as Profile['dataBits'])
                    }
                    className={inputClass}
                  >
                    {[8, 7, 6, 5].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Parity</label>
                  <select
                    value={form.parity}
                    onChange={(event) => update('parity', event.target.value as Profile['parity'])}
                    className={inputClass}
                  >
                    {SERIAL_PARITIES.map((parity) => (
                      <option key={parity} value={parity}>
                        {parity}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Stop bits</label>
                  <select
                    value={form.stopBits}
                    onChange={(event) =>
                      update('stopBits', Number(event.target.value) as Profile['stopBits'])
                    }
                    className={inputClass}
                  >
                    {[1, 2].map((bits) => (
                      <option key={bits} value={bits}>
                        {bits}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className={labelClass}>Flow control</label>
                <select
                  value={form.flowControl}
                  onChange={(event) =>
                    update('flowControl', event.target.value as Profile['flowControl'])
                  }
                  className={inputClass}
                >
                  {SERIAL_FLOW_CONTROL.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'none' ? 'none' : mode === 'rtscts' ? 'RTS/CTS' : 'XON/XOFF'}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-gray-500">
                  {form.baudRate} {form.dataBits}
                  {form.parity[0].toUpperCase()}
                  {form.stopBits}
                  {form.flowControl !== 'none' && ` · ${form.flowControl}`}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className={labelClass}>Host</label>
                  <input
                    value={form.host}
                    onChange={(event) => update('host', event.target.value)}
                    placeholder="10.0.0.1"
                    className={inputClass}
                  />
                </div>
                <div className="w-24">
                  <label className={labelClass}>Port</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(event) => update('port', Number(event.target.value) || 22)}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>Username</label>
                <input
                  value={form.username}
                  onChange={(event) => update('username', event.target.value)}
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>Authentication</label>
                <select
                  value={form.authMethod}
                  onChange={(event) =>
                    update('authMethod', event.target.value as Profile['authMethod'])
                  }
                  className={inputClass}
                >
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                  <option value="agent">SSH agent</option>
                </select>
              </div>

              {form.authMethod === 'password' && (
                <div>
                  <label className={labelClass}>
                    Password{' '}
                    {profile?.id && <span className="text-gray-500">(blank keeps current)</span>}
                  </label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => update('password', event.target.value)}
                    className={inputClass}
                  />
                </div>
              )}

              {form.authMethod === 'key' && (
                <>
                  <div>
                    <label className={labelClass}>Managed key</label>
                    <select
                      value={form.keyId ?? ''}
                      onChange={(event) => update('keyId', event.target.value || undefined)}
                      className={inputClass}
                    >
                      <option value="">— use a key file instead —</option>
                      {sshKeys.map((key) => (
                        <option key={key.id} value={key.id}>
                          {key.name} ({key.type}
                          {key.bits ? ` ${key.bits}` : ''})
                        </option>
                      ))}
                    </select>
                  </div>

                  {!form.keyId && (
                    <>
                      <div>
                        <label className={labelClass}>Private key file</label>
                        <input
                          value={form.keyPath ?? ''}
                          onChange={(event) => update('keyPath', event.target.value || undefined)}
                          placeholder="C:\\Users\\me\\.ssh\\id_rsa"
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>
                          Key passphrase{' '}
                          {profile?.id && (
                            <span className="text-gray-500">(blank keeps current)</span>
                          )}
                        </label>
                        <input
                          type="password"
                          value={form.passphrase}
                          onChange={(event) => update('passphrase', event.target.value)}
                          className={inputClass}
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}

          <div className="pt-2 border-t border-gray-700">
            <label className={labelClass}>Startup script</label>
            <SearchableSelect
              value={form.startupMacroId}
              onChange={(id) => update('startupMacroId', id || undefined)}
              options={startupOptions}
              placeholder="— none —"
              countNoun="buttons"
              clearable
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Runs automatically once this connection is ready.
            </p>
          </div>

          <div className="pt-2 border-t border-gray-700">
            <label className={labelClass}>Tags</label>
            <p className="mb-2 text-[11px] text-gray-500">
              What this host is — <span className="text-gray-400">cisco</span>,{' '}
              <span className="text-gray-400">switch</span>,{' '}
              <span className="text-gray-400">customer-acme</span>. Any button set sharing a tag
              shows up here automatically, including sets installed later.
            </p>
            <TagEditor
              value={form.tags}
              onChange={(tags) => update('tags', tags)}
              suggestions={knownTags}
              placeholder="e.g. cisco, switch, production"
            />
            {matchingSets.length > 0 && (
              <p className="mt-1.5 text-[11px] text-green-400">
                Matches {matchingSets.length} button set{matchingSets.length === 1 ? '' : 's'}:{' '}
                {matchingSets
                  .slice(0, 4)
                  .map((set) => set.name)
                  .join(', ')}
                {matchingSets.length > 4 && ` and ${matchingSets.length - 4} more`}
              </p>
            )}
            {form.tags.length > 0 && matchingSets.length === 0 && (
              <p className="mt-1.5 text-[11px] text-amber-400">
                No button set carries any of these tags yet. Tag a set to match, or use the list
                below to pick sets directly.
              </p>
            )}
          </div>

          <div className="pt-2 border-t border-gray-700">
            <label className={labelClass}>Button sets</label>
            <p className="mb-2 text-[11px] text-gray-500">
              Which sets the button panel shows while this connection is in front. Leave every box
              clear to show all of them — nothing is deleted either way, and the panel&rsquo;s
              right-click menu can still bring the rest back for one session.
            </p>

            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                <input
                  value={setSearch}
                  onChange={(event) => setSetSearch(event.target.value)}
                  placeholder={`Search ${macroSets.length} set${macroSets.length === 1 ? '' : 's'}…`}
                  className={`${inputClass} pl-7`}
                />
              </div>
              <button
                type="button"
                onClick={() => update('macroSetIds', [])}
                disabled={form.macroSetIds.length === 0}
                className="shrink-0 px-2 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Clear
              </button>
            </div>

            <div className="max-h-44 overflow-y-auto rounded border border-gray-700 divide-y divide-gray-800">
              {macroSets.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-500">No button sets yet.</p>
              )}
              {visibleSets.length === 0 && macroSets.length > 0 && (
                <p className="px-3 py-2 text-xs text-gray-500">Nothing matches that search.</p>
              )}
              {visibleSets.map((set) => {
                const checked = form.macroSetIds.includes(set.id!)
                return (
                  <label
                    key={set.id}
                    className="flex items-start gap-2 px-2.5 py-1.5 text-xs text-gray-200 hover:bg-gray-800/60 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSet(set.id!)}
                      className="mt-0.5 rounded border-gray-600 bg-gray-700 text-blue-500"
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{set.name}</span>
                      {set.description && (
                        <span className="block truncate text-[10px] text-gray-500">
                          {set.description}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>

            <p className="mt-1 text-[11px] text-gray-500">
              {form.macroSetIds.length === 0
                ? 'All button sets will be shown.'
                : `${form.macroSetIds.length} of ${macroSets.length} sets selected.`}
            </p>
          </div>

          {testResult && <p className="text-xs text-gray-400">{testResult}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
          <button
            onClick={handleTest}
            disabled={isSerial}
            title={isSerial ? 'A serial port is tested by opening it' : undefined}
            className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            Test connection
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
