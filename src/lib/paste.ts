/**
 * Turning clipboard text into what a terminal expects on the wire.
 *
 * Two things go wrong if you write the clipboard straight to the pty, and both
 * were measured against a real sshd with nano 7.2 saving the result:
 *
 *  - **Enter is CR, not CRLF.** The Windows clipboard hands back `\r\n`, and a
 *    full-screen editor reads that as *two* Enters — `\r` is Enter and `\n`
 *    (^J) is bound to Enter as well. A 64-line `.env` arrived as 117 lines; a
 *    600-line file arrived as 1098. Normalising to CR alone brought that to
 *    64 and 600 but still differed from the source, because of the second
 *    problem.
 *
 *  - **Without bracketed paste, the remote cannot tell typing from pasting.**
 *    nano applies auto-indent per line, a shell runs each line as it arrives,
 *    and readline may reflow. Wrapped in the paste markers, the remote takes
 *    the block literally: the saved file was md5-identical to the source at
 *    both sizes, including a 21 KB paste in a single write.
 *
 * Chunking and drain-awareness were measured too and changed nothing at these
 * sizes, so they are deliberately not done — ssh2 already handles windowing.
 */

/** DECSET 2004 paste markers. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * `bracketed` must come from the terminal's own tracking of DECSET 2004
 * (`xterm.modes.bracketedPasteMode`) — never assumed. An application that has
 * not enabled the mode does not consume the markers, so it would receive a
 * literal `0~` before the text and `1~` after it.
 */
export function preparePaste(text: string, bracketed: boolean): string {
  const body = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
  return bracketed ? `${PASTE_START}${body}${PASTE_END}` : body
}
