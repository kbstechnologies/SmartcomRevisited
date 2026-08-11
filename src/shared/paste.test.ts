import { describe, expect, it } from 'vitest'
import { preparePaste, trackBracketedPaste } from './paste'

const ESC = String.fromCharCode(27)
const START = `${ESC}[200~`
const END = `${ESC}[201~`
const ON = `${ESC}[?2004h`
const OFF = `${ESC}[?2004l`

describe('preparePaste', () => {
  // Measured against a real sshd with nano 7.2: pasting a 64-line .env the old
  // way saved 117 lines, because CRLF is two Enters. With these two changes the
  // saved file was md5-identical to the source, up to a 21 KB paste.
  it('sends CRLF as a single Enter', () => {
    expect(preparePaste('a\r\nb\r\nc', false)).toBe('a\rb\rc')
  })

  it('sends a bare LF as Enter too', () => {
    expect(preparePaste('a\nb', false)).toBe('a\rb')
  })

  it('leaves a lone CR alone', () => {
    expect(preparePaste('a\rb', false)).toBe('a\rb')
  })

  it('wraps in paste markers when the remote has enabled bracketed paste', () => {
    expect(preparePaste('a\nb', true)).toBe(`${START}a\rb${END}`)
  })

  it('never sends the markers when the mode is off', () => {
    // An application that has not enabled DECSET 2004 does not consume them and
    // would take a literal "0~" before the text and "1~" after it.
    const output = preparePaste('echo hi', false)
    expect(output).not.toContain('[200~')
    expect(output).not.toContain('[201~')
    expect(output).toBe('echo hi')
  })

  it('preserves blank lines, which is where the corruption showed', () => {
    expect(preparePaste('a\n\n\nb', true)).toBe(`${START}a\r\r\rb${END}`)
  })

  it('keeps a trailing newline, matching every other terminal', () => {
    // Dropping it would silently change whether the last line is submitted.
    expect(preparePaste('one\r\n', false)).toBe('one\r')
  })

  it('passes text with no line breaks through untouched', () => {
    expect(preparePaste('hunter2', false)).toBe('hunter2')
  })
})

describe('trackBracketedPaste', () => {
  const feed = (chunks: string[]) => {
    let state = { enabled: false, carry: '' }
    for (const chunk of chunks) state = trackBracketedPaste(state, chunk)
    return state.enabled
  }

  it('starts off, because a plain shell may never ask for it', () => {
    expect(feed(['some output'])).toBe(false)
  })

  it('follows the remote turning it on', () => {
    expect(feed([`prompt${ON}more`])).toBe(true)
  })

  it('follows it back off when the application exits', () => {
    expect(feed([`${ON}editing`, `${OFF}back at the shell`])).toBe(false)
  })

  it('takes the last switch when a chunk contains both', () => {
    // An editor that exits and hands back to a shell which re-enables it.
    expect(feed([`${OFF}bye${ON}`])).toBe(true)
    expect(feed([`${ON}hi${OFF}`])).toBe(false)
  })

  it('sees a sequence split across two reads', () => {
    // The real reason this carries state: a 7-byte escape sequence lands in
    // whatever pieces the network gives it, and missing the switch would mean
    // pasting markers into an application that does not consume them.
    expect(feed([`output${ESC}[?20`, '04h rest'])).toBe(true)
    expect(feed([`${ON}x`, `${ESC}[?2004`, 'l done'])).toBe(false)
  })

  it('does not let the carry grow without bound', () => {
    let state = { enabled: false, carry: '' }
    for (let i = 0; i < 50; i++) state = trackBracketedPaste(state, 'x'.repeat(1000))
    expect(state.carry.length).toBeLessThan(ON.length)
  })
})
