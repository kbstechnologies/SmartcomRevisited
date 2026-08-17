import { describe, expect, it } from 'vitest'
import { ConnectionGroupSchema, ProfileSchema, type ConnectionGroup, type Profile } from './types'
import {
  csvField,
  describeExport,
  folderPath,
  importInstructions,
  SECURECRT_COLUMNS,
  toSecureCrtCsv,
} from './securecrt'

const profile = (overrides: Record<string, unknown>): Profile =>
  ProfileSchema.parse({
    name: 'host',
    transport: 'ssh',
    host: '10.0.0.1',
    username: 'admin',
    ...overrides,
  })

const group = (overrides: Record<string, unknown>): ConnectionGroup =>
  ConnectionGroupSchema.parse({ name: 'Group', ...overrides })

/** Minimal RFC 4180 reader, so assertions are about parsed cells not substrings. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]

    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\r') {
      /* handled by \n */
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }

  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('core-sw-01')).toBe('core-sw-01')
  })

  it('quotes a value containing a comma', () => {
    expect(csvField('London, UK')).toBe('"London, UK"')
  })

  it('doubles inner quotes', () => {
    expect(csvField('the "prod" box')).toBe('"the ""prod"" box"')
  })

  it('quotes a value containing a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"')
  })

  it('quotes values whose surrounding spaces would be lost', () => {
    expect(csvField(' padded ')).toBe('" padded "')
  })
})

describe('folderPath', () => {
  it('is empty for an ungrouped connection', () => {
    expect(folderPath(undefined)).toBe('')
  })

  it('uses the group name as the folder', () => {
    expect(folderPath(group({ name: 'Datacentre' }))).toBe('Datacentre')
  })

  it('converts a slash-separated name into a SecureCRT path', () => {
    expect(folderPath(group({ name: 'Sites/London/Rack 4' }))).toBe('Sites\\London\\Rack 4')
  })

  it('collapses repeated and trailing separators', () => {
    expect(folderPath(group({ name: '/Sites//London/' }))).toBe('Sites\\London')
  })
})

describe('toSecureCrtCsv', () => {
  it('writes the header SecureCRT expects', () => {
    const { csv } = toSecureCrtCsv([], [])
    expect(parseCsv(csv)[0]).toEqual([...SECURECRT_COLUMNS])
  })

  it('maps an SSH connection to SSH2 with its port', () => {
    const { csv, summary } = toSecureCrtCsv([profile({ name: 'edge-1', port: 2222 })], [])
    const [, row] = parseCsv(csv)

    expect(row[0]).toBe('edge-1')
    expect(row[2]).toBe('10.0.0.1')
    expect(row[3]).toBe('2222')
    expect(row[4]).toBe('SSH2')
    expect(row[6]).toBe('Xterm')
    expect(summary.exported).toBe(1)
  })

  it('keeps a nonstandard port rather than assuming 22', () => {
    const { csv } = toSecureCrtCsv([profile({ port: 62222 })], [])
    expect(parseCsv(csv)[1][3]).toBe('62222')
  })

  it('omits usernames by default', () => {
    const { csv } = toSecureCrtCsv([profile({ username: 'root' })], [])
    expect(parseCsv(csv)[1][5]).toBe('')
  })

  it('includes usernames only when asked', () => {
    const { csv } = toSecureCrtCsv([profile({ username: 'root' })], [], { includeUsernames: true })
    expect(parseCsv(csv)[1][5]).toBe('root')
  })

  it('leaves the username cell empty when the connection has none', () => {
    // The schema requires a username for SSH, so this shape can only reach the
    // exporter from a row written before that rule — which is exactly the case
    // worth handling rather than crashing on.
    const legacy = { ...profile({}), username: '' } as Profile
    const { csv } = toSecureCrtCsv([legacy], [], { includeUsernames: true })
    expect(parseCsv(csv)[1][5]).toBe('')
  })

  it('places a connection in its folder', () => {
    const folder = group({ id: 'g1', name: 'Datacentre' })
    const { csv } = toSecureCrtCsv([profile({ groupId: 'g1' })], [folder])
    expect(parseCsv(csv)[1][1]).toBe('Datacentre')
  })

  it('preserves nested folders', () => {
    const folder = group({ id: 'g1', name: 'Customers/Acme/Core' })
    const { csv } = toSecureCrtCsv([profile({ groupId: 'g1' })], [folder])
    expect(parseCsv(csv)[1][1]).toBe('Customers\\Acme\\Core')
  })

  it('survives commas and quotes in names and folders', () => {
    const folder = group({ id: 'g1', name: 'Sites, EU' })
    const { csv } = toSecureCrtCsv(
      [profile({ name: 'the "prod", box', groupId: 'g1' })],
      [folder]
    )
    const [, row] = parseCsv(csv)

    expect(row[0]).toBe('the "prod", box')
    expect(row[1]).toBe('Sites, EU')
  })

  it('survives Unicode names', () => {
    const folder = group({ id: 'g1', name: 'Zürich' })
    const { csv } = toSecureCrtCsv(
      [profile({ name: 'коммутатор-01 🌐', groupId: 'g1' })],
      [folder]
    )
    const [, row] = parseCsv(csv)

    expect(row[0]).toBe('коммутатор-01 🌐')
    expect(row[1]).toBe('Zürich')
  })

  it('reports serial connections as unsupported instead of writing a wrong session', () => {
    const serial = ProfileSchema.parse({
      name: 'console cable',
      transport: 'serial',
      serialPath: 'COM3',
      baudRate: 9600,
    })

    const { csv, summary } = toSecureCrtCsv([serial], [])

    expect(parseCsv(csv)).toHaveLength(1) // header only
    expect(summary.exported).toBe(0)
    expect(summary.unsupported).toHaveLength(1)
    expect(summary.unsupported[0].name).toBe('console cable')
    expect(summary.unsupported[0].reason).toMatch(/baud rate/i)
  })

  it('skips a connection with no hostname and says why', () => {
    // Built without the schema: it enforces a host, and the point is to survive
    // a row that got past validation some other way.
    const broken = { ...profile({}), host: '   ' } as Profile
    const { summary } = toSecureCrtCsv([broken], [])

    expect(summary.exported).toBe(0)
    expect(summary.skipped).toHaveLength(1)
    expect(summary.skipped[0].reason).toMatch(/hostname/i)
  })

  it('never emits anything secret, whatever the profile carries', () => {
    const loaded = {
      ...profile({ username: 'root' }),
      keyId: 'key-1',
      keyPath: '/home/me/.ssh/id_ed25519',
      startupMacroId: 'macro-1',
      macroSetIds: ['set-1'],
      // Fields a future Profile might gain. The whitelist must ignore them.
      password: 'hunter2',
      passphrase: 'correct horse',
    } as unknown as Profile

    const { csv } = toSecureCrtCsv([loaded], [], { includeUsernames: true })

    for (const forbidden of ['hunter2', 'correct horse', 'key-1', 'id_ed25519', 'macro-1', 'set-1']) {
      expect(csv).not.toContain(forbidden)
    }
    // Seven columns and no more, so nothing can ride along unnoticed.
    expect(parseCsv(csv)[1]).toHaveLength(SECURECRT_COLUMNS.length)
  })

  it('uses CRLF line endings', () => {
    const { csv } = toSecureCrtCsv([profile({})], [])
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2)
  })

  it('handles a mixed export end to end', () => {
    const folder = group({ id: 'g1', name: 'Edge' })
    const { summary } = toSecureCrtCsv(
      [
        profile({ name: 'ok-1', groupId: 'g1' }),
        profile({ name: 'ok-2' }),
        ProfileSchema.parse({ name: 'serial-1', transport: 'serial', serialPath: '/dev/ttyUSB0' }),
      ],
      [folder]
    )

    expect(summary.exported).toBe(2)
    expect(summary.unsupported).toHaveLength(1)
    expect(describeExport(summary)).toBe('2 connections exported, 1 unsupported')
  })
})

describe('importInstructions', () => {
  it('names the file and the wizard, and lists what did not make it', () => {
    const { summary } = toSecureCrtCsv(
      [ProfileSchema.parse({ name: 'serial-1', transport: 'serial', serialPath: 'COM1' })],
      []
    )
    const text = importInstructions(summary, 'connections.csv')

    expect(text).toContain('Import Settings from Text File')
    expect(text).toContain('connections.csv')
    expect(text).toContain('serial-1')
    // It has to be explicit that this is not a full Smartcom export.
    expect(text).toMatch(/buttons.*audit history/i)
    expect(text).toMatch(/no passwords/i)
  })
})
