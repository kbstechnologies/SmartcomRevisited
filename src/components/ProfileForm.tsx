import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
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
  const loadSshKeys = useStore((state) => state.loadSshKeys)
  const loadConnectionGroups = useStore((state) => state.loadConnectionGroups)
  const listSerialPorts = useStore((state) => state.listSerialPorts)

  const [form, setForm] = useState<FormState>(() =>
    profile ? { ...blankForm(), ...profile, password: '', passphrase: '' } : blankForm()
  )
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
            <select
              value={form.startupMacroId ?? ''}
              onChange={(event) => update('startupMacroId', event.target.value || undefined)}
              className={inputClass}
            >
              <option value="">— none —</option>
              {macros.map((macro) => (
                <option key={macro.id} value={macro.id}>
                  {macroSets.find((set) => set.id === macro.setId)?.name ?? '?'} › {macro.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-gray-500">
              Runs automatically once this connection is ready.
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
