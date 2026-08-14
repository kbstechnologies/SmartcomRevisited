import { describe, expect, it } from 'vitest'
import { FAVOURITES_SET_ID } from '@shared/types'
import { orderSets, parseHiddenSets, resolveVisibleSets, toggleHiddenSet } from './setVisibility'

const ALL = ['cisco', 'linux', 'proxmox']

describe('parseHiddenSets', () => {
  it('drops ids of sets that no longer exist', () => {
    expect(parseHiddenSets(JSON.stringify(['cisco', 'gone']), ALL)).toEqual(['cisco'])
  })

  it('survives junk in storage', () => {
    expect(parseHiddenSets('not json', ALL)).toEqual([])
    expect(parseHiddenSets(JSON.stringify({ cisco: true }), ALL)).toEqual([])
    expect(parseHiddenSets(null, ALL)).toEqual([])
  })
})

describe('toggleHiddenSet', () => {
  it('flips a set in and out of the list', () => {
    expect(toggleHiddenSet([], 'cisco')).toEqual(['cisco'])
    expect(toggleHiddenSet(['cisco'], 'cisco')).toEqual([])
  })
})

describe('resolveVisibleSets', () => {
  it('shows everything when the connection names no sets', () => {
    const result = resolveVisibleSets({ setIds: ALL, assigned: [], hidden: [] })
    expect(result.visible).toEqual(ALL)
    expect(result.assignmentActive).toBe(false)
    expect(result.hiddenByAssignment).toBe(0)
  })

  it('treats a missing assignment the same as an empty one', () => {
    expect(resolveVisibleSets({ setIds: ALL, assigned: undefined, hidden: [] }).visible).toEqual(ALL)
  })

  it('narrows to the sets the connection names', () => {
    const result = resolveVisibleSets({ setIds: ALL, assigned: ['cisco'], hidden: [] })
    expect(result.visible).toEqual(['cisco'])
    expect(result.assignmentActive).toBe(true)
    expect(result.hiddenByAssignment).toBe(2)
  })

  it('applies both filters together', () => {
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: ['cisco', 'linux'],
      hidden: ['linux'],
    })
    expect(result.visible).toEqual(['cisco'])
    // The count describes the assignment alone, not the manual tick on top.
    expect(result.hiddenByAssignment).toBe(1)
  })

  it('lifts the assignment on request but keeps manual hiding', () => {
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: ['cisco'],
      hidden: ['proxmox'],
      ignoreAssignment: true,
    })
    expect(result.visible).toEqual(['cisco', 'linux'])
    expect(result.assignmentActive).toBe(false)
  })

  it('ignores assigned ids for sets this machine no longer has', () => {
    // Every assigned set was deleted, so the connection has no usable opinion
    // and must fall back to showing everything rather than to an empty panel.
    const result = resolveVisibleSets({ setIds: ALL, assigned: ['deleted'], hidden: [] })
    expect(result.visible).toEqual(ALL)
    expect(result.assignmentActive).toBe(false)
  })

  it('keeps favourites visible on a connection that does not name it', () => {
    const setIds = [...ALL, FAVOURITES_SET_ID]
    const result = resolveVisibleSets({ setIds, assigned: ['cisco'], hidden: [] })
    expect(result.visible).toEqual(['cisco', FAVOURITES_SET_ID])
  })

  it('still lets favourites be hidden by hand', () => {
    const setIds = [...ALL, FAVOURITES_SET_ID]
    const result = resolveVisibleSets({
      setIds,
      assigned: ['cisco'],
      hidden: [FAVOURITES_SET_ID],
    })
    expect(result.visible).toEqual(['cisco'])
  })
})

describe('orderSets', () => {
  it('puts favourites first and leaves the rest alone', () => {
    const sets = [{ id: 'cisco' }, { id: FAVOURITES_SET_ID }, { id: 'linux' }]
    expect(orderSets(sets).map((set) => set.id)).toEqual([FAVOURITES_SET_ID, 'cisco', 'linux'])
  })

  it('is a no-op when there are no favourites', () => {
    const sets = [{ id: 'cisco' }, { id: 'linux' }]
    expect(orderSets(sets)).toBe(sets)
  })
})
