import { describe, expect, it } from 'vitest'
import { describeTargets, macroTargets } from './macroTargets'
import type { Session } from '@shared/types'

const session = (id: string, status: Session['status'] = 'connected'): Session => ({
  id,
  profileId: `p-${id}`,
  profileName: id,
  status,
  createdAt: '2026-08-10T00:00:00.000Z',
})

describe('macroTargets', () => {
  it('runs on the focused session when broadcast is off', () => {
    const targets = macroTargets([session('a'), session('b')], 'b', false)
    expect(targets.map((t) => t.id)).toEqual(['b'])
  })

  it('runs on every connected session when broadcast is on', () => {
    const targets = macroTargets([session('a'), session('b')], 'a', true)
    expect(targets.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('skips sessions that are not connected', () => {
    // A script sent to a dead session only produces confusing failures.
    const sessions = [session('a'), session('b', 'disconnected'), session('c', 'error')]
    expect(macroTargets(sessions, 'a', true).map((t) => t.id)).toEqual(['a'])
  })

  it('targets nothing when the focused session is not connected', () => {
    expect(macroTargets([session('a', 'connecting')], 'a', false)).toEqual([])
  })

  it('targets nothing when there is no focused session and broadcast is off', () => {
    expect(macroTargets([session('a')], null, false)).toEqual([])
  })

  it('broadcasts even when the focused session belongs to another window', () => {
    // The focused pane can live in a popped-out window; broadcast is still
    // "everything that is connected".
    const targets = macroTargets([session('a'), session('b')], 'detached-1', true)
    expect(targets.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('describeTargets', () => {
  it('names a single session', () => {
    expect(describeTargets([session('router-1')])).toBe('router-1')
  })

  it('counts several', () => {
    expect(describeTargets([session('a'), session('b'), session('c')])).toBe('3 sessions')
  })

  it('says so when there is nothing to run on', () => {
    expect(describeTargets([])).toBe('no connected session')
  })
})
