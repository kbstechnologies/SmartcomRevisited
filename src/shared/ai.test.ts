import { describe, expect, it } from 'vitest'
import {
  AiSettingsSchema,
  AI_DEFAULT_MODEL,
  collapseCarriageReturns,
  fitTerminalContext,
  redactSecrets,
  tailLines,
  trimConversation,
} from './ai'

describe('redactSecrets', () => {
  // Terminal output routinely contains credentials. Anything that leaves the
  // machine goes through here first, so these cases are the security contract.
  it('removes a private key block entirely', () => {
    const output = redactSecrets(
      'cat id_rsa\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nAAAAB\n-----END OPENSSH PRIVATE KEY-----\ndone'
    )
    expect(output).not.toContain('b3BlbnNzaC1rZXktdjEAAAA')
    expect(output).toContain('[REDACTED PRIVATE KEY]')
    expect(output).toContain('done')
  })

  it('removes assignments that name a secret', () => {
    const output = redactSecrets(
      [
        'password=hunter2',
        'API_KEY: abcd1234efgh',
        'db_secret = s3cr3t-value',
        'token=ghp_aaaaaaaaaaaaaaaaaaaa',
      ].join('\n')
    )
    expect(output).not.toMatch(/hunter2|abcd1234efgh|s3cr3t-value|ghp_aaaa/)
  })

  it('removes a password typed at a prompt', () => {
    const output = redactSecrets("Password: correcthorse\nuser@host:~$")
    expect(output).not.toContain('correcthorse')
    expect(output).toContain('user@host')
  })

  it('removes bearer tokens and API keys', () => {
    const output = redactSecrets(
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" api\nsk-abcdefghijklmnopqrstuvwxyz'
    )
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('removes SNMP community strings from device config dumps', () => {
    const output = redactSecrets('snmp-server community pr1vat3 RO')
    expect(output).not.toContain('pr1vat3')
  })

  it('leaves ordinary operational output intact', () => {
    const text = [
      '[root@pbx ~]# ip -br addr',
      'eth0  UP  10.0.0.5/24',
      'Filesystem  Size  Used Avail Use%',
      '/dev/mapper/centos-root 153G 37G 117G 24%',
    ].join('\n')
    expect(redactSecrets(text)).toBe(text)
  })

  it('is idempotent — redacting twice changes nothing further', () => {
    const once = redactSecrets('password=hunter2')
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('tailLines', () => {
  it('keeps the most recent lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd')
  })

  it('returns everything when the text is shorter than the limit', () => {
    expect(tailLines('a\nb', 10)).toBe('a\nb')
  })

  it('returns nothing when context sharing is turned off', () => {
    expect(tailLines('a\nb\nc', 0)).toBe('')
  })
})

describe('collapseCarriageReturns', () => {
  it('keeps only what a `\\r` sequence left on screen', () => {
    expect(collapseCarriageReturns('10%\r50%\r100% done\nnext')).toBe('100% done\nnext')
  })

  it('leaves output without carriage returns untouched', () => {
    expect(collapseCarriageReturns('a\nb\nc')).toBe('a\nb\nc')
  })
})

describe('fitTerminalContext', () => {
  // The failure this guards against is not degraded quality: Ollama drops a
  // prompt that exceeds its window entirely — measured at 19 of ~7700 tokens
  // evaluated — and the assistant then answers that it cannot see a terminal.
  const lines = (count: number, width = 40) =>
    Array.from({ length: count }, (_, i) => `line ${i} `.padEnd(width, 'x')).join('\n')

  it('never exceeds the character budget', () => {
    const fitted = fitTerminalContext(lines(500), { lines: 500, maxChars: 1000, redact: false })
    expect(fitted.chars).toBeLessThanOrEqual(1000)
    expect(fitted.truncated).toBe(true)
  })

  it('keeps the newest output when it has to cut', () => {
    const fitted = fitTerminalContext(lines(500), { lines: 500, maxChars: 1000, redact: false })
    expect(fitted.text).toContain('line 499')
    expect(fitted.text).not.toContain('line 0 ')
    expect(fitted.text).toContain('trimmed')
  })

  it('bounds a progress bar written with carriage returns and no newline', () => {
    // One "line" by `tailLines`' reckoning, but 200 KB of it — this is how a
    // 200-line context still overflowed the window.
    const bar = Array.from({ length: 20_000 }, (_, i) => `\rDownloading ${i}%`).join('')
    const fitted = fitTerminalContext(bar, { lines: 200, maxChars: 4000, redact: false })
    expect(fitted.chars).toBeLessThanOrEqual(4000)
    expect(fitted.text).toContain('Downloading 19999%')
  })

  it('reports not grounded when there is nothing to send', () => {
    expect(fitTerminalContext('   \n  ', { lines: 200, maxChars: 5000, redact: false }).chars).toBe(0)
    expect(fitTerminalContext(lines(10), { lines: 0, maxChars: 5000, redact: false }).chars).toBe(0)
    expect(fitTerminalContext(lines(10), { lines: 200, maxChars: 0, redact: false }).chars).toBe(0)
  })

  it('redacts before measuring, so the budget covers what is actually sent', () => {
    const fitted = fitTerminalContext('password=hunter2\nready', {
      lines: 200,
      maxChars: 5000,
      redact: true,
    })
    expect(fitted.text).not.toContain('hunter2')
    expect(fitted.chars).toBe(fitted.text.length)
  })
})

describe('trimConversation', () => {
  const turn = (role: 'user' | 'assistant', size: number) => ({ role, content: 'x'.repeat(size) })

  it('drops the oldest turns first', () => {
    const kept = trimConversation(
      [turn('user', 100), turn('assistant', 100), turn('user', 100)],
      250
    )
    expect(kept).toHaveLength(2)
    expect(kept[kept.length - 1].content).toHaveLength(100)
  })

  it('always keeps the newest turn, even if it alone is over budget', () => {
    // Dropping the question itself would be a worse failure than a tight fit.
    const kept = trimConversation([turn('user', 100), turn('user', 5000)], 250)
    expect(kept).toHaveLength(1)
    expect(kept[0].content).toHaveLength(5000)
  })

  it('leaves a short conversation alone', () => {
    const messages = [turn('user', 10), turn('assistant', 10)]
    expect(trimConversation(messages, 1000)).toEqual(messages)
  })
})

describe('AiSettingsSchema', () => {
  it('defaults to Claude Opus 5 with the safety net on', () => {
    const settings = AiSettingsSchema.parse({})
    expect(settings.provider).toBe('anthropic')
    expect(settings.model).toBe(AI_DEFAULT_MODEL.anthropic)
    expect(settings.model).toBe('claude-opus-5')
    // Networking questions sit near the cyber classifiers, so the fallback and
    // the redaction pass are both on unless the operator turns them off.
    expect(settings.refusalFallback).toBe(true)
    expect(settings.redactSecrets).toBe(true)
  })

  it('accepts each provider and rejects anything else', () => {
    for (const provider of ['anthropic', 'openai', 'ollama'] as const) {
      expect(AiSettingsSchema.parse({ provider }).provider).toBe(provider)
    }
    expect(() => AiSettingsSchema.parse({ provider: 'gemini' })).toThrow()
  })

  it('bounds the shared context so a busy console cannot be sent wholesale', () => {
    expect(() => AiSettingsSchema.parse({ contextLines: -1 })).toThrow()
    expect(() => AiSettingsSchema.parse({ contextLines: 99999 })).toThrow()
  })
})
