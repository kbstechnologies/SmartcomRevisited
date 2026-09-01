import { describe, expect, it } from 'vitest'
import { buildTldrAiPrompt, tldrAiPayload } from './tldr-ai'

const base = {
  command: 'tcpdump -i eth0 port 5060',
  baseCommand: 'tcpdump',
  platform: 'linux',
  sessionType: 'ssh',
  targetName: 'router-okc-01',
  tldrPage: 'tcpdump',
  tldrExample: 'Capture the traffic of a specific interface',
}

describe('tldrAiPayload', () => {
  it('carries the command, the executable, the platform and the target', () => {
    expect(tldrAiPayload(base)).toEqual({
      source: 'tldr',
      command: 'tcpdump -i eth0 port 5060',
      base_command: 'tcpdump',
      platform: 'linux',
      session_type: 'ssh',
      target: 'router-okc-01',
      tldr_page: 'tcpdump',
      tldr_example: 'Capture the traffic of a specific interface',
    })
  })

  it('omits what it does not know rather than sending empty fields', () => {
    const payload = tldrAiPayload({ command: 'ls', baseCommand: 'ls', platform: 'common' })
    expect(payload).not.toHaveProperty('target')
    expect(payload).not.toHaveProperty('tldr_page')
  })
})

describe('buildTldrAiPrompt', () => {
  const prompt = buildTldrAiPrompt(base)

  it('asks about the command that was actually built', () => {
    expect(prompt).toContain('tcpdump -i eth0 port 5060')
  })

  it('carries the platform and the target so the answer is about this box', () => {
    expect(prompt).toContain('Platform: linux')
    expect(prompt).toContain('router-okc-01')
    expect(prompt).toContain('(ssh)')
  })

  it('names the page and example it came from', () => {
    expect(prompt).toContain('tldr page: tcpdump')
    expect(prompt).toContain('Capture the traffic of a specific interface')
  })

  it('asks the questions the operator actually has', () => {
    for (const topic of ['each option', 'risks', 'variations', 'output']) {
      expect(prompt).toContain(topic)
    }
  })

  it('sends the filled command, not the unresolved template', () => {
    const built = buildTldrAiPrompt({
      command: 'rsync /home/user/files server:/backup',
      baseCommand: 'rsync',
      platform: 'linux',
    })
    expect(built).toContain('rsync /home/user/files server:/backup')
    expect(built).not.toContain('{{')
  })
})

describe('secrets never leave in the question', () => {
  // A command line is one of the places a password most often ends up, and Ask
  // AI sends it to a third party. The same redaction the assistant applies to
  // terminal output applies here.
  it.each([
    ['mysql -u root --password=Hunter2 mydb', 'Hunter2'],
    ['curl -H "Authorization: Bearer abcdefghijklmnop1234" https://api.example.com', 'abcdefghijkl'],
    ['export API_KEY=sk-abcdefghijklmnopqrst', 'sk-abcdefghijklmnopqrst'],
    ['snmpwalk -c s3cr3tc0mmunity 10.0.0.1', 's3cr3tc0mmunity'],
  ])('redacts %j', (command, secret) => {
    const prompt = buildTldrAiPrompt({ command, baseCommand: 'x', platform: 'linux' })
    expect(prompt).not.toContain(secret)
    expect(prompt).toContain('[REDACTED')

    expect(tldrAiPayload({ command, baseCommand: 'x', platform: 'linux' }).command).not.toContain(
      secret
    )
  })
})
