import { EventEmitter } from 'events'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MacroSchema, type Macro, type MacroStep } from '../src/shared/types'

// The engine pulls in Electron and ssh2 through these modules; neither is
// needed to exercise the macro flow itself.
vi.mock('./keychain', () => ({
  keytar: {
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
  getKeychainManager: vi.fn(),
}))
vi.mock('ssh2', () => ({ Client: class {}, ConnectConfig: {} }))

import { SSHManager, stripAnsi } from './ssh-manager'

/** Minimal stand-in for a connected session: records everything written. */
function makeFakeSession(id = 'session-1') {
  const written: string[] = []
  const session: any = Object.assign(new EventEmitter(), {
    id,
    profile: { id: 'p1', name: 'test', host: 'h', port: 22, username: 'u', authMethod: 'password' },
    client: {},
    status: 'connected',
    lastActivity: new Date(),
    createdAt: new Date(),
    shell: {
      write: (text: string) => written.push(text),
    },
  })
  return { session, written }
}

const macro = (name: string, steps: Partial<MacroStep>[], extra: Partial<Macro> = {}): Macro =>
  MacroSchema.parse({ id: name, setId: 'set-1', name, steps, ...extra })

/** Installs a fake session into the manager's private registry. */
function withSession(manager: SSHManager, session: any) {
  ;(manager as any).sessions.set(session.id, session)
}

describe('stripAnsi', () => {
  it('removes CSI, OSC, charset escapes and normalises newlines', () => {
    const E = ''
    expect(stripAnsi(`${E}[0;32muser@host${E}[0m:~$ ls\r\n`)).toBe('user@host:~$ ls\n')
    expect(stripAnsi(`${E}]0;titleprompt$ `)).toBe('prompt$ ')
    expect(stripAnsi(`${E}[1mBOLD${E}[m${E}(B done`)).toBe('BOLD done')
  })

  it('leaves ordinary text and tabs alone', () => {
    expect(stripAnsi('plain\ttext\r\n')).toBe('plain\ttext\n')
  })
})

describe('macro engine', () => {
  let manager: SSHManager

  beforeEach(() => {
    manager = new SSHManager('/tmp/logs')
  })

  it('sends interpolated text and honours appendEnter', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('ping', [{ type: 'send', text: 'ping -c {{COUNT}} {{HOST}}', appendEnter: true }]),
      { HOST: '10.0.0.1', COUNT: '4' }
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['ping -c 4 10.0.0.1\n'])
  })

  it('falls back to field defaults when a variable is not supplied', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro(
        'defaults',
        [{ type: 'send', text: 'echo {{GREETING}}', appendEnter: true }],
        {
          fields: [
            { name: 'GREETING', type: 'text', defaultValue: 'hello', options: [], required: false },
          ],
        }
      ),
      {}
    )

    expect(written).toEqual(['echo hello\n'])
  })

  it('leaves unknown placeholders untouched rather than blanking them', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(session.id, macro('unknown', [{ type: 'send', text: 'echo {{NOPE}}' }]), {})
    expect(written).toEqual(['echo {{NOPE}}'])
  })

  it('runs another macro via callMacro and passes args down', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const child = macro('child', [{ type: 'send', text: 'child sees {{VALUE}}', appendEnter: true }])
    const parent = macro('parent', [
      { type: 'callMacro', targetMacroId: 'child', args: { VALUE: '{{OUTER}}' } },
    ])

    manager.setMacroResolver({
      getMacro: (id) => (id === 'child' ? child : null),
      listMacrosInSet: () => [],
    })

    const result = await manager.runMacro(session.id, parent, { OUTER: 'from-parent' })

    expect(result.success).toBe(true)
    expect(written).toEqual(['child sees from-parent\n'])
  })

  it('runs every macro in a set via callSet, in order', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const members = [
      macro('a', [{ type: 'send', text: 'first {{H}}', appendEnter: true }]),
      macro('b', [{ type: 'send', text: 'second {{H}}', appendEnter: true }]),
    ]

    manager.setMacroResolver({
      getMacro: () => null,
      listMacrosInSet: (setId) => (setId === 'set-x' ? members : []),
    })

    const result = await manager.runMacro(
      session.id,
      macro('runner', [{ type: 'callSet', targetSetId: 'set-x', args: { H: 'host1' } }]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['first host1\n', 'second host1\n'])
  })

  it('detects recursion instead of looping forever', async () => {
    const { session } = makeFakeSession()
    withSession(manager, session)

    const selfCaller = macro('loop', [{ type: 'callMacro', targetMacroId: 'loop' }])
    manager.setMacroResolver({
      getMacro: () => selfCaller,
      listMacrosInSet: () => [],
    })

    const result = await manager.runMacro(session.id, selfCaller, {})

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Recursive macro call detected/)
  })

  it('takes the then branch when the pattern appears', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('branch', [
        {
          type: 'if',
          pattern: 'ready',
          timeoutMs: 500,
          thenSteps: [{ type: 'send', text: 'MATCHED', appendEnter: true }] as any,
          elseSteps: [{ type: 'send', text: 'MISSED', appendEnter: true }] as any,
        },
      ]),
      {}
    )

    // Emitted after the listener is attached.
    setTimeout(() => session.emit('output', 'system is ready\n'), 20)

    const result = await run
    expect(result.success).toBe(true)
    expect(written).toEqual(['MATCHED\n'])
  })

  it('treats an expect timeout inside `if` as the else branch', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('branch', [
        {
          type: 'if',
          pattern: 'never-appears',
          timeoutMs: 30,
          thenSteps: [{ type: 'send', text: 'MATCHED' }] as any,
          elseSteps: [{ type: 'send', text: 'MISSED' }] as any,
        },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['MISSED'])
  })

  it('fails the run when a bare expect times out', async () => {
    const { session } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('waiter', [{ type: 'expect', pattern: 'nope', timeoutMs: 30 }]),
      {}
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Timeout waiting for pattern/)
  })

  /**
   * "Do you want to reboot?" — yes carries on to the command, no stops before
   * it. The whole point is that the guarded step must not run on a no.
   */
  describe('confirm step', () => {
    /** Answers the next confirm request the engine raises. */
    const answerWith = (manager: SSHManager, confirmed: boolean) =>
      new Promise<any>((resolve) => {
        manager.once('macro-confirm-request', (_sessionId: string, payload: any) => {
          resolve(payload)
          manager.submitMacroConfirm(payload.requestId, confirmed)
        })
      })

    it('runs the guarded steps when the operator says yes', async () => {
      const { session, written } = makeFakeSession()
      withSession(manager, session)

      const asked = answerWith(manager, true)
      const result = await manager.runMacro(
        session.id,
        macro('reboot', [
          { type: 'confirm', message: 'Do you want to reboot?' },
          { type: 'send', text: 'reboot', appendEnter: true },
        ]),
        {}
      )

      await asked
      expect(result.success).toBe(true)
      expect(written).toEqual(['reboot\n'])
    })

    it('stops before the guarded step when the operator says no', async () => {
      const { session, written } = makeFakeSession()
      withSession(manager, session)

      const asked = answerWith(manager, false)
      const result = await manager.runMacro(
        session.id,
        macro('reboot', [
          { type: 'confirm', message: 'Do you want to reboot?' },
          { type: 'send', text: 'reboot', appendEnter: true },
        ]),
        {}
      )

      await asked
      // Declining is a decision, not a failure.
      expect(result.success).toBe(true)
      expect(written).toEqual([])
    })

    it('interpolates variables into the question and the labels', async () => {
      const { session } = makeFakeSession()
      withSession(manager, session)

      const asked = answerWith(manager, false)
      await manager.runMacro(
        session.id,
        macro('reboot', [
          {
            type: 'confirm',
            title: 'Confirm {{ACTION}}',
            message: 'Do you want to {{ACTION}} {{HOST}}?',
            confirmLabel: '{{ACTION}}',
          },
        ]),
        { ACTION: 'reboot', HOST: 'core-sw-1' }
      )

      const payload = await asked
      expect(payload.message).toBe('Do you want to reboot core-sw-1?')
      expect(payload.title).toBe('Confirm reboot')
      expect(payload.confirmLabel).toBe('reboot')
      expect(payload.cancelLabel).toBe('No')
    })

    it('a no returns to the caller, unless exitAll stops the whole run', async () => {
      const { session, written } = makeFakeSession()
      withSession(manager, session)

      const child = macro('child', [
        { type: 'confirm', message: 'go on?' },
        { type: 'send', text: 'guarded' },
      ])
      manager.setMacroResolver({
        getMacro: (id) => (id === 'child' ? child : null),
        listMacrosInSet: () => [],
      })

      const asked = answerWith(manager, false)
      await manager.runMacro(
        session.id,
        macro('parent', [
          { type: 'callMacro', targetMacroId: 'child' },
          { type: 'send', text: 'after-child' },
        ]),
        {}
      )

      await asked
      // The guarded step is skipped, but the caller carries on.
      expect(written).toEqual(['after-child'])
    })
  })

  it('stops at an exit step but still reports success', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('early', [
        { type: 'send', text: 'before' },
        { type: 'exit' },
        { type: 'send', text: 'after' },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['before'])
  })

  it('exit without exitAll returns to the caller, exit all unwinds everything', async () => {
    const child = macro('child', [{ type: 'send', text: 'c1' }, { type: 'exit' }])
    const childAll = macro('childAll', [{ type: 'send', text: 'c1' }, { type: 'exit', exitAll: true }])

    for (const [target, expected] of [
      [child, ['c1', 'parent-after']],
      [childAll, ['c1']],
    ] as const) {
      const manager2 = new SSHManager('/tmp/logs')
      const { session, written } = makeFakeSession()
      withSession(manager2, session)
      manager2.setMacroResolver({
        getMacro: () => target,
        listMacrosInSet: () => [],
      })

      const result = await manager2.runMacro(
        session.id,
        macro('parent', [
          { type: 'callMacro', targetMacroId: target.id },
          { type: 'send', text: 'parent-after' },
        ]),
        {}
      )

      expect(result.success).toBe(true)
      expect(written).toEqual([...expected])
    }
  })

  it('continueOnError lets the flow proceed past a failing step', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const result = await manager.runMacro(
      session.id,
      macro('resilient', [
        { type: 'expect', pattern: 'nope', timeoutMs: 20, continueOnError: true },
        { type: 'send', text: 'still ran' },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['still ran'])
  })

  it('collects inline form answers and uses them in later steps', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    manager.on('macro-form-request', (_sessionId: string, payload: any) => {
      // Stand in for the operator filling the popup.
      setTimeout(() => manager.submitMacroForm(payload.requestId, { TARGET: '10.9.9.9' }), 5)
    })

    const result = await manager.runMacro(
      session.id,
      macro('inline', [
        { type: 'form', title: 'Where to?', fields: [{ name: 'TARGET', type: 'text', defaultValue: '', options: [], required: true }] } as any,
        { type: 'send', text: 'ssh {{TARGET}}', appendEnter: true },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual(['ssh 10.9.9.9\n'])
  })

  it('dismissing an inline form stops the run without sending anything further', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    manager.on('macro-form-request', (_sessionId: string, payload: any) => {
      setTimeout(() => manager.submitMacroForm(payload.requestId, null), 5)
    })

    const result = await manager.runMacro(
      session.id,
      macro('inline', [
        { type: 'form', fields: [{ name: 'X', type: 'text', defaultValue: '', options: [], required: true }] } as any,
        { type: 'send', text: 'should not run' },
      ]),
      {}
    )

    expect(result.success).toBe(true)
    expect(written).toEqual([])
  })

  it('pause blocks until resumed', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    const run = manager.runMacro(
      session.id,
      macro('paused', [{ type: 'pause', message: 'hold' }, { type: 'send', text: 'go' }]),
      {}
    )

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(written).toEqual([]) // still parked

    expect(manager.resumeMacro(session.id)).toBe(true)
    const result = await run

    expect(result.success).toBe(true)
    expect(written).toEqual(['go'])
  })

  it('repeats a send the requested number of times', async () => {
    const { session, written } = makeFakeSession()
    withSession(manager, session)

    await manager.runMacro(
      session.id,
      macro('repeat', [{ type: 'send', text: 'x', repeat: 3 }]),
      {}
    )

    expect(written).toEqual(['x', 'x', 'x'])
  })

  it('refuses to run against a session that is not connected', async () => {
    const result = await manager.runMacro('missing', macro('n', [{ type: 'send', text: 'x' }]), {})
    expect(result.success).toBe(false)
    expect(result.error).toBe('Session not connected')
  })
})
