import { describe, it, expect } from 'vitest'
import { ollamaContextWindow, promptBudgetChars } from './providers'

/**
 * Ollama silently truncates anything past num_ctx, oldest first — which is the
 * system prompt carrying the terminal output. Measured on llama3.1: left at the
 * default, a normal 200-line context evaluated 50 of ~5900 prompt tokens and
 * the model reported it could not see the terminal at all.
 */
describe('ollamaContextWindow', () => {
  const noMessages = [{ role: 'user' as const, content: '' }]

  it('never drops below a usable floor for a short prompt', () => {
    expect(ollamaContextWindow('hello', noMessages)).toBe(4096)
  })

  it('grows past the floor once the prompt would not fit', () => {
    // ~24k characters is what 200 lines of terminal output really costs.
    const system = 'x'.repeat(24_000)
    const window = ollamaContextWindow(system, noMessages)

    expect(window).toBeGreaterThan(24_000 / 3.5)
    expect(window % 1024).toBe(0)
  })

  it('leaves headroom for the answer on top of the prompt', () => {
    const system = 'x'.repeat(14_000)
    expect(ollamaContextWindow(system, noMessages)).toBeGreaterThan(14_000 / 3.5 + 1000)
  })

  it('counts the conversation, not just the system prompt', () => {
    const system = 'x'.repeat(14_000)
    const withHistory = ollamaContextWindow(system, [
      { role: 'user', content: 'y'.repeat(14_000) },
    ])

    expect(withHistory).toBeGreaterThan(ollamaContextWindow(system, noMessages))
  })

  it('caps the window so a huge transcript cannot exhaust memory', () => {
    expect(ollamaContextWindow('x'.repeat(5_000_000), noMessages)).toBe(16384)
  })

  it('sizes for the worst tokenising output, not for prose', () => {
    // A hexdump measured 1.53 chars/token on llama3.1. Sizing on an average of
    // 3.5 produced a window less than half what the prompt needed, and Ollama
    // then dropped the whole system prompt rather than part of it.
    const hexdumpChars = 9_000
    const realTokens = Math.ceil(hexdumpChars / 1.53)
    expect(ollamaContextWindow('x'.repeat(hexdumpChars), noMessages)).toBeGreaterThan(realTokens)
  })
})

/**
 * Sizing the window to the prompt is only half the fix: it is capped, and a
 * prompt past the cap is discarded exactly as it was before. The transcript is
 * kept to 120,000 characters — well past the cap — so the prompt has to be
 * trimmed to this budget before it is sent.
 */
describe('promptBudgetChars', () => {
  it('keeps the Ollama prompt inside the window the request will actually ask for', () => {
    const budget = promptBudgetChars('ollama')
    const cap = ollamaContextWindow('x'.repeat(5_000_000), [{ role: 'user', content: '' }])
    // A prompt that exactly fills the budget must still be servable by a window
    // the sizing function is willing to ask for — otherwise it is dropped.
    expect(ollamaContextWindow('x'.repeat(budget), [{ role: 'user', content: '' }])).toBe(cap)
  })

  it('is smaller than the transcript the session manager retains', () => {
    // MAX_TRANSCRIPT_CHARS in ssh-manager.ts. If this ever stops holding, a
    // full transcript could be sent whole and silently dropped.
    expect(promptBudgetChars('ollama')).toBeLessThan(120_000)
  })

  it('is generous for the hosted providers, which error rather than truncate', () => {
    expect(promptBudgetChars('anthropic')).toBeGreaterThan(promptBudgetChars('ollama'))
    expect(promptBudgetChars('openai')).toBeGreaterThan(promptBudgetChars('ollama'))
  })
})
