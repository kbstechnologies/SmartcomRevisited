import { describe, expect, it } from 'vitest'
import {
  defaultSessionPaths,
  describeImport,
  parseHexDword,
  parseSessionIni,
  planImport,
  type SecureCrtSession,
} from './securecrt-import'

/** A realistic SSH2 session file, in the shape SecureCRT actually writes. */
const SSH_INI = `
S:"Protocol Name"=SSH2
S:"Hostname"=10.0.0.1
D:"[SSH2] Port"=00000016
S:"Username"=admin
S:"Emulation"=Xterm
S:"Password V2"=02:1234567890abcdef
D:"Some Other Setting"=00000001
`

describe('parseHexDword', () => {
  it('reads SecureCRT DWORDs as hex, not decimal', () => {
    // The whole point: 00000016 is 22. Read as decimal it is 16, which produces
    // a session that looks correct and connects to the wrong port.
    expect(parseHexDword('00000016')).toBe(22)
    expect(parseHexDword('000001bb')).toBe(443)
    expect(parseHexDword('0000e1f5')).toBe(57845)
  })

  it('rejects anything that is not hex', () => {
    expect(parseHexDword('not-a-number')).toBeUndefined()
    expect(parseHexDword('')).toBeUndefined()
  })
})

describe('parseSessionIni', () => {
  it('reads the fields an import needs', () => {
    const session = parseSessionIni(SSH_INI, 'core-sw-01')

    expect(session.name).toBe('core-sw-01')
    expect(session.protocol).toBe('SSH2')
    expect(session.hostname).toBe('10.0.0.1')
    expect(session.port).toBe(22)
    expect(session.username).toBe('admin')
    expect(session.emulation).toBe('Xterm')
  })

  it('never reads a credential, whatever the key is called', () => {
    const withSecrets = `
S:"Hostname"=h
S:"Password V2"=02:deadbeef
S:"Passphrase V2"=02:cafebabe
S:"Private Key Filename"=/home/me/.ssh/id_rsa
`
    const parsed = parseSessionIni(withSecrets, 'secretive')

    // Importing credentials would move secrets between two credential stores
    // without anyone asking, so nothing here even looks at them.
    expect(JSON.stringify(parsed)).not.toContain('deadbeef')
    expect(JSON.stringify(parsed)).not.toContain('cafebabe')
    expect(JSON.stringify(parsed)).not.toContain('id_rsa')
  })

  it('strips the bracketed prefix so [SSH2] Port and Port are one key', () => {
    expect(parseSessionIni('D:"[SSH2] Port"=00000022', 'x').port).toBe(34)
    expect(parseSessionIni('D:"Port"=00000022', 'x').port).toBe(34)
  })

  it('survives a BOM on the first line', () => {
    // The files are UTF-16 or UTF-8 by version; a surviving BOM would otherwise
    // corrupt the first key name and silently drop the protocol.
    const session = parseSessionIni('\ufeffS:"Protocol Name"=SSH2', 'bom')
    expect(session.protocol).toBe('SSH2')
  })

  it('ignores comments, blanks and anything it does not recognise', () => {
    const messy = `
; a comment
S:"Hostname"=10.0.0.9

garbage line without the shape
Z:"Odd Type"=whatever
`
    expect(parseSessionIni(messy, 'messy').hostname).toBe('10.0.0.9')
  })

  it('keeps a value containing an equals sign intact', () => {
    // Base64 blobs are full of them; splitting on every `=` truncates the value.
    expect(parseSessionIni('S:"Hostname"=host=name', 'x').hostname).toBe('host=name')
  })

  it('reads a serial session, where Port is a string not a number', () => {
    const serial = `
S:"Protocol Name"=Serial
S:"Port"=COM3
D:"Baud Rate"=00002580
`
    const session = parseSessionIni(serial, 'console')
    expect(session.protocol).toBe('Serial')
    expect(session.serialPort).toBe('COM3')
    expect(session.baudRate).toBe(9600)
  })
})

const session = (overrides: Partial<SecureCrtSession>): SecureCrtSession => ({
  name: 'session',
  folders: [],
  ...overrides,
})

describe('planImport', () => {
  it('turns an SSH2 session into a connection', () => {
    const plan = planImport([
      session({ name: 'core-sw-01', protocol: 'SSH2', hostname: '10.0.0.1', port: 2222, username: 'admin' }),
    ])

    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]).toMatchObject({
      name: 'core-sw-01',
      transport: 'ssh',
      host: '10.0.0.1',
      port: 2222,
      username: 'admin',
    })
  })

  it('defaults the port when SecureCRT left it out', () => {
    const plan = planImport([session({ protocol: 'SSH2', hostname: 'h' })])
    expect(plan.candidates[0].port).toBe(22)
  })

  it('flattens nested folders into one readable group name', () => {
    // Smartcom's folders are a single level, so the alternative is losing
    // everything but the innermost name.
    const plan = planImport([
      session({ protocol: 'SSH2', hostname: 'h', folders: ['Customers', 'Acme', 'Core'] }),
    ])
    expect(plan.candidates[0].group).toBe('Customers / Acme / Core')
  })

  it('leaves an ungrouped session without a folder', () => {
    const plan = planImport([session({ protocol: 'SSH2', hostname: 'h' })])
    expect(plan.candidates[0].group).toBeUndefined()
  })

  it('imports a serial session', () => {
    const plan = planImport([
      session({ name: 'console', protocol: 'Serial', serialPort: 'COM3', baudRate: 9600 }),
    ])

    expect(plan.candidates[0]).toMatchObject({
      transport: 'serial',
      serialPath: 'COM3',
      baudRate: 9600,
    })
  })

  it('skips a serial session with no port', () => {
    const plan = planImport([session({ name: 'broken', protocol: 'Serial' })])
    expect(plan.candidates).toHaveLength(0)
    expect(plan.skipped[0].reason).toMatch(/no port/i)
  })

  it('reports Telnet as unsupported rather than importing it as SSH', () => {
    // Silently changing the protocol would produce a connection that fails in a
    // way the operator has no reason to expect.
    const plan = planImport([session({ name: 'old-box', protocol: 'Telnet', hostname: 'h' })])

    expect(plan.candidates).toHaveLength(0)
    expect(plan.unsupported[0].reason).toMatch(/Telnet/)
  })

  it('reports SSH1 rather than quietly upgrading it', () => {
    const plan = planImport([session({ name: 'ancient', protocol: 'SSH1', hostname: 'h' })])
    expect(plan.candidates).toHaveLength(0)
    expect(plan.unsupported[0].reason).toMatch(/SSH1/)
  })

  it('skips a session with no hostname and says why', () => {
    const plan = planImport([session({ name: 'empty', protocol: 'SSH2' })])
    expect(plan.skipped[0].reason).toMatch(/hostname/i)
  })

  it('handles a mixed store end to end', () => {
    const plan = planImport([
      session({ name: 'a', protocol: 'SSH2', hostname: 'h1' }),
      session({ name: 'b', protocol: 'SSH2', hostname: 'h2' }),
      session({ name: 'c', protocol: 'Telnet', hostname: 'h3' }),
      session({ name: 'd', protocol: 'Serial' }),
    ])

    expect(plan.candidates).toHaveLength(2)
    expect(plan.unsupported).toHaveLength(1)
    expect(plan.skipped).toHaveLength(1)
    expect(describeImport(plan)).toBe('2 connections, 1 skipped, 1 unsupported')
  })
})

describe('defaultSessionPaths', () => {
  it('points at the right place per platform', () => {
    expect(defaultSessionPaths('win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming')[0]).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\VanDyke\\Config\\Sessions'
    )
    expect(defaultSessionPaths('darwin', '/Users/me')[0]).toContain(
      'Library/Application Support/VanDyke'
    )
    expect(defaultSessionPaths('linux', '/home/me')[0]).toBe('/home/me/.vandyke/SecureCRT/Config/Sessions')
  })

  it('falls back to a sensible Windows path with no APPDATA', () => {
    expect(defaultSessionPaths('win32', 'C:\\Users\\me')[0]).toContain('AppData\\Roaming\\VanDyke')
  })
})
