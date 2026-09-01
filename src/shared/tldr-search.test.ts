import { describe, expect, it } from 'vitest'
import {
  fuzzyMatch,
  platformsFor,
  resolvePlatform,
  searchIndex,
  type TldrIndexEntry,
} from './tldr-search'

const entry = (
  c: string,
  p: TldrIndexEntry['p'],
  d: string,
  k = '',
  n = 1
): TldrIndexEntry => ({ c, p, d, k: k.toLowerCase(), n })

const INDEX: TldrIndexEntry[] = [
  entry('tcpdump', 'common', 'Dump traffic on a network.', 'capture packets on an interface tcpdump -i eth0'),
  entry('tshark', 'common', 'Terminal version of Wireshark.', 'capture packets tshark -i eth0'),
  entry('dumpcap', 'common', 'Network traffic capture tool.', 'capture network traffic to a file'),
  entry('ip', 'linux', 'Show / manipulate routing, devices and tunnels.', 'ip route show'),
  entry('ipcalc', 'linux', 'Calculate IP information for a host.', 'ipcalc 10.0.0.1'),
  entry('systemctl', 'linux', 'Control the systemd system and service manager.', 'restart a service systemctl restart nginx'),
  entry('docker', 'common', 'Manage Docker containers and images.', 'list docker containers docker ps -a'),
  entry('find', 'common', 'Find files under a directory.', 'find large files find . -size +100M'),
  entry('show', 'cisco-ios', 'Show various system information.', 'show running-config'),
  entry('systeminfo', 'windows', 'Display operating system configuration.', 'systeminfo /fo table'),
  entry('ls', 'common', 'List directory contents.', 'ls -la'),
  entry('ls', 'windows', 'List directory contents.', 'ls'),
]

describe('fuzzyMatch', () => {
  it('matches an in-order subsequence', () => {
    expect(fuzzyMatch('dkr', 'docker')).toBe(true)
    expect(fuzzyMatch('sysctl', 'systemctl')).toBe(true)
  })

  it('rejects letters out of order', () => {
    expect(fuzzyMatch('rekcod', 'docker')).toBe(false)
  })
})

describe('searchIndex', () => {
  it('puts an exact command name first', () => {
    expect(searchIndex(INDEX, 'tcpdump')[0].command).toBe('tcpdump')
  })

  it('matches a partial command', () => {
    expect(searchIndex(INDEX, 'tcp').map((r) => r.command)).toContain('tcpdump')
  })

  it('prefers the shorter command on a prefix, so ip beats ipcalc', () => {
    const results = searchIndex(INDEX, 'ip')
    expect(results[0].command).toBe('ip')
  })

  it('searches descriptions, not just names', () => {
    const results = searchIndex(INDEX, 'routing')
    expect(results.map((r) => r.command)).toContain('ip')
    expect(results[0].matched).toBe('description')
  })

  it('searches example text, which is what makes intent queries work', () => {
    const results = searchIndex(INDEX, 'capture packets').map((r) => r.command)
    expect(results).toEqual(expect.arrayContaining(['tcpdump', 'tshark']))
  })

  it('answers "find large files"', () => {
    expect(searchIndex(INDEX, 'find large files')[0].command).toBe('find')
  })

  it('answers "restart service"', () => {
    expect(searchIndex(INDEX, 'restart service')[0].command).toBe('systemctl')
  })

  it('answers "docker containers"', () => {
    expect(searchIndex(INDEX, 'docker containers')[0].command).toBe('docker')
  })

  it('prefers pages matching every term while there are enough of them', () => {
    // Five entries mention both words; the one that mentions only "capture"
    // must not be mixed in with them.
    const index = [
      ...Array.from({ length: 5 }, (_, i) =>
        entry(`sniffer${i}`, 'common', 'Capture packets from a network.', '', 3)
      ),
      entry('halfmatch', 'common', 'Capture nothing in particular.', '', 9),
    ]
    const results = searchIndex(index, 'capture packets')
    expect(results).toHaveLength(5)
    expect(results.map((item) => item.command)).not.toContain('halfmatch')
  })

  it('relaxes to a partial match only when the strict pass finds almost nothing', () => {
    // "find large files": `find` is plainly the answer, and its page never
    // says "large".
    const index = [
      entry('find', 'common', 'Find files under a directory.', 'find files by size', 9),
      entry('rdfind', 'common', 'Find duplicate files.', '', 3),
    ]
    const results = searchIndex(index, 'find large files')
    expect(results[0].command).toBe('find')
  })

  it('still scores a partial match below a full one', () => {
    const index = [
      entry('alpha', 'common', 'capture packets here', '', 1),
      entry('beta', 'common', 'capture only', '', 1),
    ]
    const results = searchIndex(index, 'capture packets')
    expect(results[0].command).toBe('alpha')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('falls back to fuzzy for an abbreviation', () => {
    const results = searchIndex(INDEX, 'dkr')
    expect(results[0]).toMatchObject({ command: 'docker', matched: 'fuzzy' })
  })

  it('shows one row per command, not one per platform', () => {
    const results = searchIndex(INDEX, 'ls')
    expect(results.filter((r) => r.command === 'ls')).toHaveLength(1)
  })

  it('lets the session platform break a tie', () => {
    expect(searchIndex(INDEX, 'ls', { platform: 'windows' })[0].platform).toBe('windows')
    expect(searchIndex(INDEX, 'ls', { platform: 'linux' })[0].platform).toBe('common')
  })

  it('pushes a platform the session could never use right down', () => {
    // `systeminfo` is Windows-only; for a Linux session it is not an answer,
    // even though the name matches exactly.
    const results = searchIndex(INDEX, 'system', { platform: 'linux' })
    expect(results[0].command).toBe('systemctl')
    expect(results.map((item) => item.command)).toContain('systeminfo')
    expect(results.findIndex((item) => item.command === 'systeminfo')).toBeGreaterThan(0)
  })

  it('does not let a specific platform outrank a common page that matches better', () => {
    // The bug this covers: `common` pages apply to a Linux session exactly as
    // much as `linux` ones, so rewarding `linux` for being specific buried
    // `docker` (common) under longer linux-only names.
    expect(searchIndex(INDEX, 'docker', { platform: 'linux' })[0].command).toBe('docker')
  })

  it('prefers a more thoroughly documented page on an otherwise equal prefix', () => {
    const index = [
      entry('tcpick', 'linux', 'A TCP stream sniffer.', 'tcpick -i eth0', 2),
      entry('tcpdump', 'common', 'Dump traffic on a network.', 'tcpdump -i eth0', 8),
    ]
    expect(searchIndex(index, 'tcp', { platform: 'linux' })[0].command).toBe('tcpdump')
  })

  it('returns nothing for an empty query', () => {
    expect(searchIndex(INDEX, '   ')).toEqual([])
  })

  it('honours the limit', () => {
    expect(searchIndex(INDEX, 'a', { limit: 2 }).length).toBeLessThanOrEqual(2)
  })
})

describe('resolvePlatform', () => {
  it('picks the session platform when it has a page', () => {
    expect(resolvePlatform(INDEX, 'ls', 'windows')).toBe('windows')
  })

  it('falls back through the preference order', () => {
    expect(resolvePlatform(INDEX, 'ls', 'linux')).toBe('common')
    expect(resolvePlatform(INDEX, 'tcpdump', 'linux')).toBe('common')
  })

  it('finds the Cisco page for a switch', () => {
    expect(resolvePlatform(INDEX, 'show', 'cisco-ios')).toBe('cisco-ios')
  })

  it('does not hand a Linux-only page to a switch through the fallback', () => {
    // `systemctl` is linux-only; a cisco-ios session should not fall into it.
    expect(resolvePlatform(INDEX, 'systemctl', 'cisco-ios')).toBe('linux')
    expect(resolvePlatform(INDEX, 'systemctl', 'windows')).toBe('linux')
  })

  it('is null for a command nothing documents', () => {
    expect(resolvePlatform(INDEX, 'not-a-real-command', 'linux')).toBeNull()
  })

  it('ignores case', () => {
    expect(resolvePlatform(INDEX, 'TCPDump', 'linux')).toBe('common')
  })
})

describe('platformsFor', () => {
  it('lists every platform documenting a command', () => {
    expect(platformsFor(INDEX, 'ls').sort()).toEqual(['common', 'windows'])
  })

  it('is empty for an unknown command', () => {
    expect(platformsFor(INDEX, 'nope')).toEqual([])
  })
})
