import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_INSERT_CHANNEL,
  ASSISTANT_IPC_CHANNELS,
  declaredAiChannels,
  findExecutionCapability,
} from '../../src/shared/assistant-contract'

/**
 * Tripwires for the one invariant the assistant panel is built on: it proposes
 * commands, it never runs them.
 *
 * These read the real source files rather than exercising behaviour, because
 * the failure mode being guarded is not a bug — it is someone adding a
 * capability on purpose, believing it to be a convenience. Behavioural tests
 * cannot catch a feature that does not exist yet; a source scan can.
 *
 * See src/shared/assistant-contract.ts before "fixing" any failure here.
 */

const root = path.resolve(__dirname, '../..')
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')

/** Explains the rule at the point of failure, where it will actually be read. */
const WHY = (file: string, found: string[]) =>
  `${file} can now execute something (${found.join(', ')}).\n\n` +
  'The assistant reads a live session on production equipment; the operator ' +
  'tolerates that because it cannot act. Route the action through something ' +
  'the operator triggers — a button, or the Insert path, which puts text on ' +
  'the command line and stops.\n\n' +
  'If the product decision really changed, change it deliberately in ' +
  'src/shared/assistant-contract.ts, the panel wording and the system prompt ' +
  'together. Do not silence this test.'

describe('the assistant cannot execute anything', () => {
  it.each([
    'electron/ai/assistant.ts',
    'electron/ai/providers.ts',
    'src/components/AssistantPanel.tsx',
  ])('%s has no way to run a command', (file) => {
    const found = findExecutionCapability(read(file))
    expect(found, WHY(file, found)).toEqual([])
  })

  it('the assistant is never handed the thing that drives sessions', () => {
    const source = read('electron/ai/assistant.ts')

    // It receives a context *provider* — a callback that returns text. Importing
    // the session manager would give it the ability to write to a shell, which
    // is the whole point of not doing it.
    expect(source).not.toMatch(/from ['"].*ssh-manager['"]/)
    expect(source).not.toMatch(/from ['"]child_process['"]/)
  })

  it('the main process wires the assistant with reads only', () => {
    const main = read('electron/main.ts')
    const start = main.indexOf('private setupAssistant()')
    expect(start, 'setupAssistant() has been renamed — update this test').toBeGreaterThan(-1)

    // Up to the next method: everything the assistant is handed at start-up.
    const wiring = main.slice(start, main.indexOf('\n  private ', start + 1))
    const found = findExecutionCapability(wiring)
    expect(found, WHY('setupAssistant() in electron/main.ts', found)).toEqual([])
  })

  it('the assistant owns no IPC channel that acts on a session', () => {
    const declared = declaredAiChannels(read('src/shared/ipc.ts'))

    expect(
      declared,
      'The ai:* IPC surface changed. A new channel here is how "propose, never ' +
        'execute" would be undone — an ai:run or ai:apply would be a different ' +
        'product. Add it to ASSISTANT_IPC_CHANNELS only if that is a decision ' +
        'someone made on purpose.'
    ).toEqual([...ASSISTANT_IPC_CHANNELS])
  })

  it('the panel inserts through the channel that refuses to submit', () => {
    const panel = read('src/components/AssistantPanel.tsx')

    // Not `pasteToSession`: a clipboard paste carries newlines through, and the
    // last line of a suggestion would submit itself.
    expect(panel).toContain('insertSuggestion')
    expect(panel).not.toContain('pasteToSession')
  })

  it('the insert channel exists and is the one the store calls', () => {
    expect(read('src/shared/ipc.ts')).toContain(ASSISTANT_INSERT_CHANNEL)
    expect(read('src/store/useStore.ts')).toContain(ASSISTANT_INSERT_CHANNEL)
  })

  it('the model is still told it is read-only', () => {
    // The prompt is the assistant's own understanding of the contract. Losing
    // it does not create a capability, but it removes the refusal that stops a
    // model from claiming it ran something.
    expect(read('electron/ai/assistant.ts')).toMatch(/never execute/i)
  })
})
