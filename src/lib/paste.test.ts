import { describe, expect, it } from 'vitest'
import { preparePaste } from './paste'

const START = '\x1b[200~'
const END = '\x1b[201~'

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
