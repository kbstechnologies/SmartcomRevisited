import { describe, expect, it } from 'vitest'
import { FAVOURITES_SET_ID, normaliseTags } from '@shared/types'
import {
  orderSets,
  parseHiddenSets,
  resolveVisibleSets,
  sharedTags,
  toggleHiddenSet,
} from './setVisibility'

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

describe('tag matching', () => {
  const TAGGED = { cisco: ['cisco', 'switching'], linux: ['linux'], proxmox: ['virtualisation'] }

  it('surfaces a set that shares a tag with the connection', () => {
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: [],
      hidden: [],
      profileTags: ['cisco'],
      setTags: TAGGED,
    })

    expect(result.visible).toEqual(['cisco'])
    expect(result.matchedByTag).toEqual(['cisco'])
    expect(result.assignmentActive).toBe(true)
  })

  it('matches regardless of case and spacing on either side', () => {
    const result = resolveVisibleSets({
      setIds: ['edge'],
      assigned: [],
      hidden: [],
      profileTags: ['  Customer Acme '],
      setTags: { edge: ['CUSTOMER-ACME'] },
    })

    expect(result.visible).toEqual(['edge'])
  })

  it('adds to the named sets rather than replacing them', () => {
    // Naming a set means "this one specifically"; a tag means "anything of this
    // kind". A connection can want both, and one must not silence the other.
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: ['proxmox'],
      hidden: [],
      profileTags: ['cisco'],
      setTags: TAGGED,
    })

    expect(result.visible.sort()).toEqual(['cisco', 'proxmox'])
    // Only the tag-found one is reported as such; the named one was explicit.
    expect(result.matchedByTag).toEqual(['cisco'])
  })

  it('shows everything when the connection tags match nothing', () => {
    // Same rule as an assignment that resolves to nothing: an empty panel looks
    // broken, so no usable opinion means no filtering.
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: [],
      hidden: [],
      profileTags: ['nothing-has-this'],
      setTags: TAGGED,
    })

    expect(result.visible).toEqual(ALL)
    expect(result.assignmentActive).toBe(false)
    expect(result.matchedByTag).toEqual([])
  })

  it('ignores tags on the sets when the connection has none', () => {
    const result = resolveVisibleSets({ setIds: ALL, assigned: [], hidden: [], setTags: TAGGED })
    expect(result.visible).toEqual(ALL)
    expect(result.assignmentActive).toBe(false)
  })

  it('matches on any shared tag, not all of them', () => {
    const result = resolveVisibleSets({
      setIds: ['cisco'],
      assigned: [],
      hidden: [],
      profileTags: ['switching', 'production', 'eu-west'],
      setTags: TAGGED,
    })

    expect(result.visible).toEqual(['cisco'])
  })

  it('still lets a tag-matched set be hidden by hand', () => {
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: [],
      hidden: ['cisco'],
      profileTags: ['cisco'],
      setTags: TAGGED,
    })

    expect(result.visible).toEqual([])
  })

  it('is lifted along with the assignment by show-everything', () => {
    const result = resolveVisibleSets({
      setIds: ALL,
      assigned: [],
      hidden: [],
      profileTags: ['cisco'],
      setTags: TAGGED,
      ignoreAssignment: true,
    })

    expect(result.visible).toEqual(ALL)
    expect(result.matchedByTag).toEqual([])
  })

  it('keeps favourites visible alongside a tag match', () => {
    const setIds = [...ALL, FAVOURITES_SET_ID]
    const result = resolveVisibleSets({
      setIds,
      assigned: [],
      hidden: [],
      profileTags: ['linux'],
      setTags: TAGGED,
    })

    expect(result.visible.sort()).toEqual([FAVOURITES_SET_ID, 'linux'].sort())
  })
})

describe('sharedTags', () => {
  it('reports the overlap, normalised', () => {
    expect(sharedTags(['Cisco', 'Prod'], ['cisco', 'switching'])).toEqual(['cisco'])
  })

  it('is empty when either side has none', () => {
    expect(sharedTags([], ['cisco'])).toEqual([])
    expect(sharedTags(['cisco'], [])).toEqual([])
    expect(sharedTags(['cisco'], undefined)).toEqual([])
  })
})

describe('normaliseTags', () => {
  it('lower-cases, trims, hyphenates spaces and de-duplicates', () => {
    expect(normaliseTags([' Cisco ', 'CISCO', 'Customer Acme', ''])).toEqual([
      'cisco',
      'customer-acme',
    ])
  })

  it('sorts, so two equal tag sets compare equal', () => {
    expect(normaliseTags(['zebra', 'alpha'])).toEqual(normaliseTags(['alpha', 'zebra']))
  })

  it('survives an absent list', () => {
    expect(normaliseTags(undefined)).toEqual([])
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
