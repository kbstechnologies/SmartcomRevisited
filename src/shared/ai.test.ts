import { describe, expect, it } from 'vitest'
import {
  AiSettingsSchema,
  AI_DEFAULT_MODEL,
  redactSecrets,
  tailLines,
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
