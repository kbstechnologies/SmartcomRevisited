import { describe, expect, it } from 'vitest'
import { describeCheckFailure } from './updater'

describe('describeCheckFailure', () => {
  it('reads a missing feed as "no releases yet", not as a fault', () => {
    // What every tester sees before the first release is published.
    const error = new Error(
      'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/latest): HttpError: 404'
    )
    expect(describeCheckFailure(error)).toBe('No releases published yet')
  })

  it('names a network problem as a network problem', () => {
    expect(describeCheckFailure(new Error('getaddrinfo ENOTFOUND github.com'))).toBe(
      'Could not reach the update server'
    )
  })

  it('passes anything else through so real faults are not hidden', () => {
    expect(describeCheckFailure(new Error('signature verification failed'))).toBe(
      'signature verification failed'
    )
  })

  it('copes with a thrown non-Error', () => {
    expect(describeCheckFailure('something odd')).toBe('something odd')
  })
})
