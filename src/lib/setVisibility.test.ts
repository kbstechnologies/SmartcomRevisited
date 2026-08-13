import { describe, expect, it } from 'vitest'
import { isSetVisible, parseHiddenSets, toggleHiddenSet } from './setVisibility'

describe('parseHiddenSets', () => {
  const existing = ['a', 'b', 'c']

  it('reads the stored ids', () => {
    expect(parseHiddenSets(JSON.stringify(['a', 'c']), existing)).toEqual(['a', 'c'])
  })

  it('drops ids of sets that no longer exist', () => {
    expect(parseHiddenSets(JSON.stringify(['a', 'deleted']), existing)).toEqual(['a'])
  })

  it('shows everything when nothing is stored or the value is unusable', () => {
    expect(parseHiddenSets(null, existing)).toEqual([])
    expect(parseHiddenSets('not json', existing)).toEqual([])
    expect(parseHiddenSets(JSON.stringify({ a: true }), existing)).toEqual([])
    expect(parseHiddenSets(JSON.stringify(['a', 7, null]), existing)).toEqual(['a'])
  })

  it('de-duplicates', () => {
    expect(parseHiddenSets(JSON.stringify(['a', 'a']), existing)).toEqual(['a'])
  })
})

describe('toggleHiddenSet', () => {
  it('hides then shows again', () => {
    expect(toggleHiddenSet([], 'a')).toEqual(['a'])
    expect(toggleHiddenSet(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('isSetVisible', () => {
  it('hides only what was ticked off', () => {
    expect(isSetVisible(['a'], 'a')).toBe(false)
    expect(isSetVisible(['a'], 'b')).toBe(true)
  })

  it('never hides a set that has no id yet', () => {
    expect(isSetVisible(['a'], undefined)).toBe(true)
  })
})
