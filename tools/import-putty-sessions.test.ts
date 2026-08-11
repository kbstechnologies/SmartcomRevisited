import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConnectionBundleSchema } from '../src/shared/types'

/**
 * The importer is PowerShell, so this only runs on Windows. What it proves is
 * the part that would otherwise only be found by a user: that the file the
 * script writes actually satisfies the schema the app validates on import.
 *
 * Driven through -RegFile so it reads a fixture instead of the machine's own
 * registry, and touches nothing outside a temp directory.
 */
const onWindows = process.platform === 'win32'

/** A .reg export covering the cases that differ from each other. */
const FIXTURE = [
  'Windows Registry Editor Version 5.00',
  '',
  // Never imported: PuTTY's template, not a real host.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]',
  '"HostName"=""',
  '"Protocol"="ssh"',
  '',
  // Ordinary SSH session, name contains a space and a non-default port.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\edge%20router]',
  '"HostName"="10.1.2.3"',
  '"PortNumber"=dword:00000916',
  '"UserName"="netops"',
  '"Protocol"="ssh"',
  '',
  // No username saved — the common case, since PuTTY just asks at connect time.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\no-user-box]',
  '"HostName"="10.4.5.6"',
  '"PortNumber"=dword:00000016',
  '"UserName"=""',
  '"Protocol"="ssh"',
  '',
  // Key authentication, pointing at a .ppk.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\key-box]',
  '"HostName"="10.7.8.9"',
  '"PortNumber"=dword:00000016',
  '"UserName"="root"',
  '"Protocol"="ssh"',
  '"PublicKeyFile"="C:\\\\keys\\\\id_rsa.ppk"',
  '',
  // Serial: 9600 7E2 with RTS/CTS. Note it also carries a HostName, as real
  // PuTTY sessions do — the protocol is what decides the transport.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\console%20cable]',
  '"HostName"="leftover"',
  '"Protocol"="serial"',
  '"SerialLine"="COM7"',
  '"SerialSpeed"=dword:00002580',
  '"SerialDataBits"=dword:00000007',
  '"SerialStopHalfbits"=dword:00000004',
  '"SerialParity"=dword:00000002',
  '"SerialFlowControl"=dword:00000002',
  '',
  // Unsupported protocol: reported, not silently dropped.
  '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\old-telnet]',
  '"HostName"="10.9.9.9"',
  '"Protocol"="telnet"',
  '',
].join('\r\n')

function runImporter(): { bundle: any; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'putty-import-'))
  const regFile = join(dir, 'sessions.reg')
  const outFile = join(dir, 'out.connections.json')
  writeFileSync(regFile, FIXTURE, 'utf8')

  const script = join(__dirname, 'import-putty-sessions.ps1')
  const output = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
     '-RegFile', regFile, '-OutFile', outFile, '-DefaultUser', 'fallback-user'],
    { encoding: 'utf8' }
  )

  return { bundle: JSON.parse(readFileSync(outFile, 'utf8')), output }
}

describe.skipIf(!onWindows)('import-putty-sessions.ps1', () => {
  it('writes a bundle the app will accept', () => {
    const { bundle } = runImporter()

    // The real gate: the app parses imports with this schema, so anything it
    // rejects would land on the user as "Not a valid connections file".
    const parsed = ConnectionBundleSchema.parse(bundle)

    expect(parsed.profiles).toHaveLength(4)
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0].name).toBe('PuTTY import')
    // Everything lands in that folder rather than loose in the list.
    for (const profile of parsed.profiles) {
      expect(profile.groupId).toBe(parsed.groups[0].id)
    }
  })

  it('carries SSH details across, and decodes the session name', () => {
    const { bundle } = runImporter()
    const parsed = ConnectionBundleSchema.parse(bundle)
    const router = parsed.profiles.find((p) => p.name === 'edge router')

    expect(router, 'session name was not URL-decoded').toBeDefined()
    expect(router!.transport).toBe('ssh')
    expect(router!.host).toBe('10.1.2.3')
    expect(router!.port).toBe(2326) // dword:00000916
    expect(router!.username).toBe('netops')
    expect(router!.authMethod).toBe('password')
  })

  it('fills in a username where PuTTY had none', () => {
    // Smartcom Revisited stores the username on the connection; PuTTY asks at
    // connect time, so most saved sessions have none and would fail validation.
    const { bundle, output } = runImporter()
    const parsed = ConnectionBundleSchema.parse(bundle)

    expect(parsed.profiles.find((p) => p.name === 'no-user-box')!.username).toBe('fallback-user')
    expect(output).toMatch(/had no username saved/i)
  })

  it('marks key sessions and points at the .ppk it found', () => {
    const { bundle, output } = runImporter()
    const parsed = ConnectionBundleSchema.parse(bundle)
    const keyBox = parsed.profiles.find((p) => p.name === 'key-box')!

    expect(keyBox.authMethod).toBe('key')
    expect(keyBox.keyPath).toBe('C:\\keys\\id_rsa.ppk')
    // .ppk cannot be used as-is, so the script has to say so.
    expect(output).toMatch(/PuTTYgen/i)
  })

  it('translates serial framing, ignoring the leftover hostname', () => {
    const { bundle } = runImporter()
    const parsed = ConnectionBundleSchema.parse(bundle)
    const cable = parsed.profiles.find((p) => p.name === 'console cable')!

    expect(cable.transport).toBe('serial')
    expect(cable.serialPath).toBe('COM7')
    expect(cable.baudRate).toBe(9600)
    expect(cable.dataBits).toBe(7)
    expect(cable.stopBits).toBe(2) // SerialStopHalfbits 4 = two stop bits
    expect(cable.parity).toBe('even')
    expect(cable.flowControl).toBe('rtscts')
  })

  it('skips what it cannot represent, and says which', () => {
    const { bundle, output } = runImporter()
    const parsed = ConnectionBundleSchema.parse(bundle)

    expect(parsed.profiles.some((p) => p.name === 'old-telnet')).toBe(false)
    expect(output).toMatch(/old-telnet/)
    expect(parsed.profiles.some((p) => p.name === 'Default Settings')).toBe(false)
  })
})
