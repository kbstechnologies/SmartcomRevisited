import { describe, it, expect } from 'vitest'
import { ollamaContextWindow } from './providers'

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

  it('caps the window so a huge transcript cannot stall prefill forever', () => {
    expect(ollamaContextWindow('x'.repeat(5_000_000), noMessages)).toBe(32768)
  })
})
