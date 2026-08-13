import { describe, expect, it } from 'vitest'
import {
  declaredAiChannels,
  findExecutionCapability,
  stripComments,
  ASSISTANT_IPC_CHANNELS,
} from './assistant-contract'

/**
 * The scanner behind the tripwires. It is worth testing in its own right: a
 * guard that silently stops matching is worse than no guard, because the build
 * stays green while the invariant rots.
 */

describe('findExecutionCapability', () => {
  it('spots a write to a session', () => {
    expect(findExecutionCapability('await sendToSession(id, text)')).toEqual(['sendToSession'])
    expect(findExecutionCapability(`invoke('sessions:send', { id })`)).toEqual(['sessions:send'])
  })

  it('spots running a button, a script or a local process', () => {
    expect(findExecutionCapability('this.runMacro(id, macro, {})')).toContain('runMacro')
    expect(findExecutionCapability(`invoke('scripts:run', p)`)).toContain('scripts:run')
    expect(findExecutionCapability(`import { execSync } from 'child_process'`)).toEqual([
      'child_process',
      'execSync',
    ])
  })

  it('ignores the invariant being discussed in comments', () => {
    const source = [
      '// This panel must never call sendToSession — it proposes commands.',
      '/* macros:run is deliberately not reachable from here. */',
      'const answer = await ask(question)',
    ].join('\n')

    expect(findExecutionCapability(source)).toEqual([])
  })

  it('is not fooled by a comment that ends before the code', () => {
    expect(findExecutionCapability('// safe\nsendToSession(a, b)')).toEqual(['sendToSession'])
  })

  it('passes ordinary read-only assistant code', () => {
    const source = [
      'const context = this.contextProvider(sessionId)',
      'const answer = await chat(settings, messages)',
      'this.emit("stream", { type: "delta", text })',
    ].join('\n')

    expect(findExecutionCapability(source)).toEqual([])
  })
})

describe('stripComments', () => {
  it('leaves a URL in code alone', () => {
    expect(stripComments('const u = "https://example.com/x"')).toContain('https://example.com/x')
  })
})

describe('declaredAiChannels', () => {
  it('reads the channels out of the IPC schema', () => {
    const source = [
      `z.object({ channel: z.literal('ai:ask'), data: AiAskSchema }),`,
      `z.object({ channel: z.literal('sessions:send'), data: X }),`,
      `z.object({ channel: z.literal('ai:cancel'), data: Y }),`,
    ].join('\n')

    expect(declaredAiChannels(source)).toEqual(['ai:ask', 'ai:cancel'])
  })

  it('would notice a channel that lets the assistant act', () => {
    const source = [
      `z.literal('ai:ask')`,
      `z.literal('ai:run')`,
      ...ASSISTANT_IPC_CHANNELS.slice(1).map((c) => `z.literal('${c}')`),
    ].join('\n')

    expect(declaredAiChannels(source)).not.toEqual([...ASSISTANT_IPC_CHANNELS])
  })
})
