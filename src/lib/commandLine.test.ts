import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCommandLine,
  getCommandLine,
  noteKeystrokes,
  noteOutput,
  subscribeToCommandLine,
} from './commandLine'

const SESSION = 'test-session'

/** Types a string one character at a time, as a keyboard would. */
const type = (text: string) => {
  for (const char of text) noteKeystrokes(SESSION, char)
}

beforeEach(() => clearCommandLine(SESSION))

describe('the typed line', () => {
  it('accumulates printable characters', () => {
    type('tcpdump -i eth0')
    expect(getCommandLine(SESSION).line).toBe('tcpdump -i eth0')
  })

  it('handles backspace', () => {
    type('tcpdumq')
    noteKeystrokes(SESSION, '\x7f')
    type('p')
    expect(getCommandLine(SESSION).line).toBe('tcpdump')
  })

  it('remembers the line submitted with Enter, and starts a new one', () => {
    type('ip route show')
    noteKeystrokes(SESSION, '\r')

    const state = getCommandLine(SESSION)
    expect(state.line).toBe('')
    // The help should survive the keypress that ran the command.
    expect(state.lastSubmitted).toBe('ip route show')
  })

  it('abandons the line on Ctrl+C', () => {
    type('rm -rf /')
    noteKeystrokes(SESSION, '\x03')
    expect(getCommandLine(SESSION).line).toBe('')
    expect(getCommandLine(SESSION).lastSubmitted).toBe('')
  })

  it('clears the line on Ctrl+U', () => {
    type('some nonsense')
    noteKeystrokes(SESSION, '\x15')
    expect(getCommandLine(SESSION).line).toBe('')
  })

  it('deletes a word on Ctrl+W', () => {
    type('systemctl restart nginx')
    noteKeystrokes(SESSION, '\x17')
    expect(getCommandLine(SESSION).line).toBe('systemctl restart')
  })

  it('gives up on the line when history is recalled', () => {
    type('ls')
    noteKeystrokes(SESSION, '\x1b[A')
    const state = getCommandLine(SESSION)
    expect(state.line).toBe('')
    expect(state.reliable).toBe(false)
  })

  it('flags tab completion as something it cannot follow', () => {
    type('systemc')
    noteKeystrokes(SESSION, '\t')
    const state = getCommandLine(SESSION)
    // The buffer is kept — the command name is usually already there.
    expect(state.line).toBe('systemc')
    expect(state.reliable).toBe(false)
  })

  it('does not record a line it knows it lost track of', () => {
    type('ls')
    noteKeystrokes(SESSION, '\x1b[A')
    type('whatever')
    noteKeystrokes(SESSION, '\r')
    expect(getCommandLine(SESSION).lastSubmitted).toBe('')
  })

  it('trusts itself again after Enter', () => {
    noteKeystrokes(SESSION, '\t')
    noteKeystrokes(SESSION, '\r')
    expect(getCommandLine(SESSION).reliable).toBe(true)
  })

  it('ignores cursor and control keys that add no text', () => {
    type('ls')
    noteKeystrokes(SESSION, '\x0c') // Ctrl+L, redraw
    expect(getCommandLine(SESSION).line).toBe('ls')
  })

  it('does not grow without bound on a large paste', () => {
    noteKeystrokes(SESSION, 'x'.repeat(10_000))
    expect(getCommandLine(SESSION).line.length).toBeLessThanOrEqual(4096)
  })
})

describe('secret prompts', () => {
  it.each([
    'user@host: ssh admin@10.0.0.1\r\nadmin@10.0.0.1\'s password: ',
    '[sudo] password for ptc: ',
    'Enter passphrase for key /home/ptc/.ssh/id_ed25519: ',
    'Password: ',
  ])('stops capturing at %j', (output) => {
    noteOutput(SESSION, output)
    expect(getCommandLine(SESSION).sensitive).toBe(true)

    type('hunter2')
    // Never held, so it can never be shown in the indicator or sent anywhere.
    expect(getCommandLine(SESSION).line).toBe('')
  })

  it('does not record a secret as the last submitted command', () => {
    noteOutput(SESSION, 'Password: ')
    type('hunter2')
    noteKeystrokes(SESSION, '\r')
    expect(getCommandLine(SESSION).lastSubmitted).toBe('')
  })

  it('discards anything typed between the prompt and noticing it', () => {
    type('hunt')
    noteOutput(SESSION, 'Password: ')
    expect(getCommandLine(SESSION).line).toBe('')
  })

  it('resumes once the prompt is no longer the last thing on screen', () => {
    noteOutput(SESSION, 'Password: ')
    noteOutput(SESSION, '\r\nWelcome to Ubuntu 22.04\r\nptc@host:~$ ')
    expect(getCommandLine(SESSION).sensitive).toBe(false)

    type('uptime')
    expect(getCommandLine(SESSION).line).toBe('uptime')
  })

  it('is not fooled by the word appearing mid-line', () => {
    noteOutput(SESSION, 'ptc@host:~$ grep password /etc/shadow\r\n')
    expect(getCommandLine(SESSION).sensitive).toBe(false)
  })
})

describe('subscription', () => {
  it('publishes the current state immediately and on change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToCommandLine(SESSION, listener)

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ line: '' }))
    type('l')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ line: 'l' }))

    unsubscribe()
    type('s')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ line: 'l' }))
  })

  it('forgets everything for a closed session', () => {
    type('secret-ish')
    clearCommandLine(SESSION)
    expect(getCommandLine(SESSION)).toEqual({
      line: '',
      lastSubmitted: '',
      reliable: true,
      sensitive: false,
    })
  })
})

describe('sessions are independent', () => {
  it('does not leak one terminal\'s typing into another', () => {
    noteKeystrokes('a', 'ls')
    noteKeystrokes('b', 'df -h')
    expect(getCommandLine('a').line).toBe('ls')
    expect(getCommandLine('b').line).toBe('df -h')
    clearCommandLine('a')
    clearCommandLine('b')
  })
})
