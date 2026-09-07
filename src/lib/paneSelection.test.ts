import { describe, expect, it } from 'vitest'
import { selectVisibleSession } from './paneSelection'

describe('selectVisibleSession', () => {
  it('shows the globally focused session when this window owns it', () => {
    expect(selectVisibleSession(['a', 'b'], 'b', null)).toBe('b')
  })

  it('keeps showing its own pane when focus moves to another window', () => {
    // The reported bug: opening a connection in the main window focused that
    // session globally, which blanked the popped-out window's only pane.
    expect(selectVisibleSession(['detached-1'], 'main-session', 'detached-1')).toBe('detached-1')
  })

  it('falls back to the first owned session before anything is focused here', () => {
    expect(selectVisibleSession(['a', 'b'], 'elsewhere', null)).toBe('a')
  })

  it('ignores a remembered pane that has since closed', () => {
    expect(selectVisibleSession(['b'], null, 'a-closed')).toBe('b')
  })

  it('returns null when the window owns nothing', () => {
    expect(selectVisibleSession([], 'a', 'b')).toBeNull()
  })

  it('lets the main window keep its own pane while buttons target a detached one', () => {
    // Both windows stay usable at once: main shows main-1, and the global
    // focus (detached-1) is what the button panel acts on.
    const main = selectVisibleSession(['main-1', 'main-2'], 'detached-1', 'main-1')
    const detached = selectVisibleSession(['detached-1'], 'detached-1', 'detached-1')
    expect(main).toBe('main-1')
    expect(detached).toBe('detached-1')
  })

  it('follows focus within a single window', () => {
    expect(selectVisibleSession(['a', 'b'], 'a', 'b')).toBe('a')
  })

  it('shows a file browser the user clicked, not its terminal', () => {
    // Both panes belong to the same session, so the global focus (which names
    // a session, never a pane) cannot break the tie. Before this, clicking the
    // browser tab did nothing: the terminal matched first and won every render.
    expect(selectVisibleSession(['a', 'sftp:a'], 'a', 'sftp:a')).toBe('sftp:a')
  })

  it('leaves a file browser when focus moves to another session here', () => {
    expect(selectVisibleSession(['a', 'sftp:a', 'b'], 'b', 'sftp:a')).toBe('b')
  })

  it('keeps a detached file browser visible when the main window takes focus', () => {
    expect(selectVisibleSession(['sftp:a'], 'main-session', 'sftp:a')).toBe('sftp:a')
  })
})
