import { describe, expect, it } from 'vitest'
import {
  defaultValues,
  extractPlaceholders,
  fillTemplate,
  parsePlaceholderToken,
  parseTldrPage,
  platformForConnection,
  platformSearchOrder,
  unresolvedPlaceholders,
} from './tldr'

/** A real page, copied from the upstream archive rather than invented. */
const TCPDUMP = `# tcpdump

> Dump traffic on a network.
> More information: <https://www.tcpdump.org/manpages/tcpdump.1.html>.

- List available network interfaces:

\`tcpdump {{[-D|--list-interfaces]}}\`

- Capture the traffic of a specific interface:

\`sudo tcpdump {{[-i|--interface]}} {{eth0}}\`

- Capture all TCP traffic showing contents ([A]SCII) in console:

\`sudo tcpdump -A tcp\`
`

const RSYNC = `# rsync

> Transfer files either to or from a remote host.
> To specify a remote path, use \`user@host:path/to/file\`.
> More information: <https://download.samba.org/pub/rsync/rsync.1>.

- Transfer a file:

\`rsync {{path/to/source}} {{path/to/destination}}\`
`

describe('parseTldrPage', () => {
  const page = parseTldrPage(TCPDUMP, { command: 'tcpdump', platform: 'common' })

  it('reads the title, description and upstream link', () => {
    expect(page.command).toBe('tcpdump')
    expect(page.platform).toBe('common')
    expect(page.description).toEqual(['Dump traffic on a network.'])
    expect(page.moreInfo).toBe('https://www.tcpdump.org/manpages/tcpdump.1.html')
  })

  it('keeps every description paragraph', () => {
    const rsync = parseTldrPage(RSYNC, { command: 'rsync', platform: 'common' })
    expect(rsync.description).toHaveLength(2)
  })

  it('pairs each example with its command', () => {
    expect(page.examples).toHaveLength(3)
    expect(page.examples[1]).toMatchObject({
      description: 'Capture the traffic of a specific interface',
      template: 'sudo tcpdump {{[-i|--interface]}} {{eth0}}',
    })
  })

  it("unwraps upstream's single-letter option brackets in prose", () => {
    expect(page.examples[2].description).toBe(
      'Capture all TCP traffic showing contents (ASCII) in console'
    )
  })

  it('falls back to the filename when a page has no title', () => {
    const page = parseTldrPage('> Something.\n', { command: 'weird', platform: 'linux' })
    expect(page.command).toBe('weird')
    expect(page.examples).toEqual([])
  })

  it('survives an empty or malformed page instead of throwing', () => {
    expect(() => parseTldrPage('', { command: 'x', platform: 'common' })).not.toThrow()
    expect(parseTldrPage('garbage\n- dangling', { command: 'x', platform: 'common' }).examples).toEqual(
      []
    )
  })

  it('keeps a command line that lost its bullet', () => {
    const page = parseTldrPage('# x\n\n`x --now`\n', { command: 'x', platform: 'common' })
    expect(page.examples[0].template).toBe('x --now')
  })
})

describe('parsePlaceholderToken', () => {
  it('reads a short/long option pair as a choice, defaulting to the short form', () => {
    expect(parsePlaceholderToken('[-i|--interface]')).toMatchObject({
      kind: 'option',
      choices: ['-i', '--interface'],
      defaultValue: '-i',
      generic: false,
    })
  })

  it('reads a bare alternation as a choice', () => {
    expect(parsePlaceholderToken('table|list|csv')).toMatchObject({
      kind: 'choice',
      choices: ['table', 'list', 'csv'],
      defaultValue: 'table',
    })
  })

  it('treats a concrete example as a usable default', () => {
    expect(parsePlaceholderToken('eth0')).toMatchObject({
      kind: 'value',
      defaultValue: 'eth0',
      generic: false,
    })
  })

  it.each(['path/to/source', 'filename', 'path/to/file_or_directory', 'username'])(
    'marks %s as a description rather than a value',
    (token) => {
      expect(parsePlaceholderToken(token).generic).toBe(true)
    }
  )
})

describe('extractPlaceholders', () => {
  it('finds them in first-appearance order', () => {
    const found = extractPlaceholders('rsync {{path/to/source}} {{path/to/destination}}')
    expect(found.map((item) => item.token)).toEqual(['path/to/source', 'path/to/destination'])
  })

  it('de-duplicates a token used twice, so it is asked for once', () => {
    const found = extractPlaceholders('cp {{file}} {{dir}} && ls {{dir}}')
    expect(found.map((item) => item.token)).toEqual(['file', 'dir'])
  })

  it('finds none in a template that has none', () => {
    expect(extractPlaceholders('sudo tcpdump -A tcp')).toEqual([])
  })
})

describe('fillTemplate', () => {
  it('substitutes supplied values', () => {
    expect(fillTemplate('tcpdump {{[-i|--interface]}} {{eth0}}', { eth0: 'ens192' })).toBe(
      'tcpdump -i ens192'
    )
  })

  it('fills both occurrences of one token', () => {
    expect(fillTemplate('mkdir {{dir}} && cd {{dir}}', { dir: '/opt/app' })).toBe(
      'mkdir /opt/app && cd /opt/app'
    )
  })

  it('falls back to the token default when nothing was supplied', () => {
    expect(fillTemplate('rsync {{path/to/source}} {{path/to/destination}}', {})).toBe(
      'rsync path/to/source path/to/destination'
    )
  })

  it('produces the worked example from the brief', () => {
    expect(
      fillTemplate('rsync {{source}} {{destination}}', {
        source: '/home/user/files',
        destination: 'server:/backup',
      })
    ).toBe('rsync /home/user/files server:/backup')
  })
})

describe('unresolvedPlaceholders', () => {
  const example = {
    description: 'Transfer a file',
    template: 'rsync {{path/to/source}} {{path/to/destination}}',
    placeholders: extractPlaceholders('rsync {{path/to/source}} {{path/to/destination}}'),
  }

  it('holds Run back while a generic token still holds the example text', () => {
    expect(unresolvedPlaceholders(example, defaultValues(example))).toHaveLength(2)
  })

  it('releases each one as it is edited', () => {
    const values = { ...defaultValues(example), 'path/to/source': '/home/user/files' }
    expect(unresolvedPlaceholders(example, values).map((item) => item.token)).toEqual([
      'path/to/destination',
    ])
  })

  it('blocks on a token that was emptied', () => {
    const values = { 'path/to/source': '', 'path/to/destination': 'server:/backup' }
    expect(unresolvedPlaceholders(example, values)).toHaveLength(1)
  })

  it('never blocks on a concrete default like eth0', () => {
    const tcpdump = {
      description: 'Capture',
      template: 'tcpdump -i {{eth0}}',
      placeholders: extractPlaceholders('tcpdump -i {{eth0}}'),
    }
    expect(unresolvedPlaceholders(tcpdump, defaultValues(tcpdump))).toEqual([])
  })
})

describe('platformForConnection', () => {
  it('reads a Windows shell as Windows', () => {
    expect(platformForConnection({ transport: 'local', shellKind: 'powershell' })).toBe('windows')
    expect(platformForConnection({ transport: 'local', shellKind: 'cmd' })).toBe('windows')
  })

  it('reads WSL as Linux even on a Windows host', () => {
    expect(
      platformForConnection({ transport: 'local', shellKind: 'wsl', hostPlatform: 'win32' })
    ).toBe('linux')
  })

  it('reads a local shell as the host it is running on', () => {
    expect(
      platformForConnection({ transport: 'local', shellKind: 'bash', hostPlatform: 'darwin' })
    ).toBe('osx')
    expect(
      platformForConnection({ transport: 'local', shellKind: 'bash', hostPlatform: 'linux' })
    ).toBe('linux')
  })

  it('defaults SSH to Linux', () => {
    expect(platformForConnection({ transport: 'ssh' })).toBe('linux')
  })

  it('lets a tag override the transport', () => {
    expect(platformForConnection({ transport: 'ssh', tags: ['cisco'] })).toBe('cisco-ios')
    expect(platformForConnection({ transport: 'serial', tags: ['cisco-ios'] })).toBe('cisco-ios')
    expect(platformForConnection({ transport: 'ssh', tags: ['windows'] })).toBe('windows')
  })

  it('assumes nothing about a serial console', () => {
    expect(platformForConnection({ transport: 'serial' })).toBe('common')
  })
})

describe('platformSearchOrder', () => {
  it('always ends somewhere it can find a page', () => {
    expect(platformSearchOrder('linux')).toEqual(['linux', 'common'])
    expect(platformSearchOrder('windows')).toContain('common')
    expect(platformSearchOrder('osx')).toEqual(['osx', 'common', 'linux'])
  })

  it('does not let a switch fall through to Linux', () => {
    // `show`, `write` and `reload` all exist on Linux and mean something else.
    expect(platformSearchOrder('cisco-ios')).toEqual(['cisco-ios', 'common'])
  })

  it('treats an unknown platform as common only', () => {
    expect(platformSearchOrder('plan9')).toEqual(['common'])
  })
})
