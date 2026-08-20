import { EventEmitter } from 'events'
import { describe, expect, it, beforeEach } from 'vitest'
import { MacroSchema, type Macro } from '../src/shared/types'
import { SSHManager } from './ssh-manager'

/**
 * Capture groups and loops — the pieces that turn a button from a fixed list of
 * commands into something that can react to what the device says.
 *
 * Kept apart from macro-engine.test.ts because the interesting failures here
 * are different in kind: a loop that cannot terminate, or a value that silently
 * fails to bind, both look like success from the outside.
 */

function makeFakeSession(id = 'session-1') {
  const written: string[] = []
  const session: any = Object.assign(new EventEmitter(), {
    id,
    profile: { id: 'p1', name: 'test', host: 'h', port: 22, username: 'u', authMethod: 'password' },
    client: { end: () => undefined },
    status: 'connected',
    lastActivity: new Date(),
    createdAt: new Date(),
    shell: { write: (text: string) => written.push(text) },
  })
  return { session, written }
}

/**
 * Steps are typed loosely on purpose. `MacroSchema.parse` fills in every
 * default at runtime, so a test can write the two or three fields it cares
 * about — but a nested `thenSteps` entry is typed as a *complete* MacroStep,
 * which would force every literal here to spell out fields the test does not
 * care about and the schema is about to supply anyway.
 */
type StepLiteral = Record<string, unknown>

const macro = (name: string, steps: StepLiteral[], extra: Partial<Macro> = {}): Macro =>
  MacroSchema.parse({ id: name, setId: 'set-1', name, steps, ...extra })

function withSession(manager: SSHManager, session: any) {
  ;(manager as any).sessions.set(session.id, session)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('capture groups become variables', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  it('binds a named group from expect for later steps', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('collect', [
        { type: 'expect', pattern: 'saved to (?<CAPFILE>\\S+\\.pcap)', timeoutMs: 1000 },
        { type: 'send', text: 'ls -l {{CAPFILE}}', appendEnter: true },
      ]),
      {}
    )

    await tick()
    session.emit('output', 'saved to /tmp/cap-1786982730.pcap\n')

    const result = await run
    expect(result.success).toBe(true)
    // The device chose the filename; without capture a button could only ever
    // reference one it already knew.
    expect(written).toEqual(['ls -l /tmp/cap-1786982730.pcap\n'])
  })

  it('leaves an unmatched optional group unset rather than "undefined"', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('optional', [
        { type: 'expect', pattern: 'done(?<TAIL> extra)?', timeoutMs: 1000 },
        { type: 'send', text: 'echo [{{TAIL}}]', appendEnter: true },
      ]),
      {}
    )

    await tick()
    session.emit('output', 'done\n')
    await run

    // Unresolved placeholders pass through untouched. The word "undefined"
    // reaching a command line would be far worse than a visible placeholder.
    expect(written).toEqual(['echo [{{TAIL}}]\n'])
  })

  it('binds captures from an if that matched', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('branch', [
        {
          type: 'if',
          pattern: 'version (?<VER>\\d+\\.\\d+)',
          timeoutMs: 1000,
          thenSteps: [{ type: 'send', text: 'echo {{VER}}', appendEnter: true }],
        },
      ]),
      {}
    )

    await tick()
    session.emit('output', 'version 9.6 here\n')
    await run

    expect(written).toEqual(['echo 9.6\n'])
  })
})

describe('forEach', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  it('runs the body once per item, with an index', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('each', [
        {
          type: 'forEach',
          listVariable: 'IFACES',
          itemVariable: 'IFACE',
          listSeparator: 'lines',
          thenSteps: [
            { type: 'send', text: 'show int {{IFACE}} ({{IFACE_INDEX}})', appendEnter: true },
          ],
        },
      ]),
      { IFACES: 'Gi1/0/1\nGi1/0/2\nGi1/0/3' }
    )

    expect(written).toEqual([
      'show int Gi1/0/1 (1)\n',
      'show int Gi1/0/2 (2)\n',
      'show int Gi1/0/3 (3)\n',
    ])
  })

  it('drops blank entries rather than running the body on nothing', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('each', [
        {
          type: 'forEach',
          listVariable: 'ITEMS',
          listSeparator: 'comma',
          thenSteps: [{ type: 'send', text: 'echo {{ITEM}}', appendEnter: true }],
        },
      ]),
      // Trailing and doubled separators are what captured output really looks like.
      { ITEMS: 'a, ,b,,c,' }
    )

    expect(written).toEqual(['echo a\n', 'echo b\n', 'echo c\n'])
  })

  it('refuses a list longer than the limit instead of running part of it', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('each', [
        {
          type: 'forEach',
          listVariable: 'ITEMS',
          listSeparator: 'comma',
          maxIterations: 3,
          thenSteps: [{ type: 'send', text: 'echo {{ITEM}}', appendEnter: true }],
        },
      ]),
      { ITEMS: 'a,b,c,d,e' }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/limit is 3/)
    // Nothing ran at all: a half-finished sweep across production kit is worse
    // than one that never started, because it is not obvious where it stopped.
    expect(written).toEqual([])
  })

  it('caps the loop however large the step asks for', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    // Deliberately built without the schema. The schema caps this at 1000 and
    // rejects anything larger, so a value this big can only reach the engine
    // from a row written by an older build or edited by hand — which is exactly
    // why the engine keeps its own ceiling rather than trusting the input.
    const unvalidated = {
      id: 'each',
      setId: 'set-1',
      name: 'each',
      fields: [],
      placeholders: [],
      confirmBeforeRun: false,
      steps: [
        {
          type: 'forEach',
          listVariable: 'ITEMS',
          listSeparator: 'comma',
          maxIterations: 999999,
          thenSteps: [
            {
              type: 'send',
              text: 'echo {{ITEM}}',
              appendEnter: true,
              args: {},
              fields: [],
              thenSteps: [],
              elseSteps: [],
            },
          ],
          elseSteps: [],
          args: {},
          fields: [],
        },
      ],
    } as unknown as Macro

    const result = await manager.runMacro(session.id, unvalidated, {
      ITEMS: Array.from({ length: 1200 }, (_, i) => `i${i}`).join(','),
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/limit is 1000/)
    expect(written).toEqual([])
  })

  it('stops when the run is cancelled', async () => {
    const { session } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('each', [
        {
          type: 'forEach',
          listVariable: 'ITEMS',
          listSeparator: 'comma',
          maxIterations: 500,
          thenSteps: [{ type: 'delay', delayMs: 20 }],
        },
      ]),
      { ITEMS: Array.from({ length: 200 }, (_, i) => `i${i}`).join(',') }
    )

    await after(40)
    manager.cancelMacro(session.id)

    const result = await run
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cancelled/i)
  }, 15000)
})

describe('while', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  it('checks first, so an already-finished device runs the body zero times', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('poll', [
        {
          type: 'while',
          pattern: 'COMPLETE',
          timeoutMs: 200,
          maxIterations: 5,
          thenSteps: [{ type: 'send', text: 'show status', appendEnter: true }],
        },
      ]),
      {}
    )

    await tick()
    session.emit('output', 'job COMPLETE\n')

    const result = await run
    expect(result.success).toBe(true)
    // `while`, not `do while`: polling a device that is already done should
    // not issue a command.
    expect(written).toEqual([])
  }, 15000)

  it('runs the body between attempts until the pattern appears', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('poll', [
        {
          type: 'while',
          pattern: 'COMPLETE',
          timeoutMs: 20,
          maxIterations: 20,
          thenSteps: [{ type: 'send', text: 'show status', appendEnter: true }],
        },
      ]),
      {}
    )

    await after(70)
    session.emit('output', 'job COMPLETE\n')

    const result = await run
    expect(result.success).toBe(true)
    expect(written.length).toBeGreaterThan(0)
    expect(written.every((line) => line === 'show status\n')).toBe(true)
  }, 15000)

  it('binds captures from the pattern it finally matched', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('poll', [
        {
          type: 'while',
          pattern: 'saved (?<FILE>\\S+\\.pcap)',
          timeoutMs: 200,
          maxIterations: 5,
          thenSteps: [{ type: 'send', text: 'show status', appendEnter: true }],
        },
        { type: 'send', text: 'ls {{FILE}}', appendEnter: true },
      ]),
      {}
    )

    await tick()
    session.emit('output', 'saved /tmp/cap-9.pcap\n')
    await run

    expect(written).toEqual(['ls /tmp/cap-9.pcap\n'])
  }, 15000)

  it('gives up as a failure rather than pretending it succeeded', async () => {
    const { session } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('poll', [
        {
          type: 'while',
          pattern: 'NEVER_APPEARS',
          timeoutMs: 10,
          maxIterations: 3,
          thenSteps: [{ type: 'send', text: 'show status', appendEnter: true }],
        },
      ]),
      {}
    )

    // Carrying on quietly would leave later steps acting on a job that never
    // finished — collecting a capture file still being written, say.
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/gave up waiting/i)
  }, 15000)
})

describe('built-in variables reach a running macro', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  it('substitutes a built-in the button never declared', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('stamp', [{ type: 'send', text: 'echo {{EPOCH}}', appendEnter: true }]),
      {}
    )

    expect(written[0]).toMatch(/^echo \d{10}\n$/)
  })

  it('holds a built-in steady across steps, which the capture workflow needs', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('capture', [
        { type: 'send', text: 'tcpdump -w /tmp/cap-{{RANDOM_MIX}}.pcap', appendEnter: true },
        { type: 'send', text: 'ls -l /tmp/cap-{{RANDOM_MIX}}.pcap', appendEnter: true },
      ]),
      {}
    )

    const written1 = written[0].split('cap-')[1]
    const written2 = written[1].split('cap-')[1]
    // Recomputing per use would produce two different names and a button that
    // runs cleanly while collecting nothing.
    expect(written1).toBe(written2)
  })

  it('lets an explicit variable win over a built-in of the same name', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('override', [{ type: 'send', text: 'echo {{EPOCH}}', appendEnter: true }]),
      { EPOCH: 'mine' }
    )

    // Adding a built-in must never change what an existing button does.
    expect(written).toEqual(['echo mine\n'])
  })

  it('exposes the session it is running against', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('who', [{ type: 'send', text: 'echo {{SESSION_HOST}} {{SESSION_NAME}}', appendEnter: true }]),
      {}
    )

    expect(written).toEqual(['echo h test\n'])
  })
})
