import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message'

describe('errorMessage', () => {
  it('passes an ordinary error message through untouched', () => {
    expect(errorMessage(new Error('password authentication failed'))).toBe('password authentication failed')
  })

  it('flattens the empty-message AggregateError from a dual-stack connect', () => {
    const error = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      '',
    )
    expect(errorMessage(error)).toBe('connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432')
  })

  it('keeps an EPERM detail that only exists on the nested errors', () => {
    const inner = Object.assign(new Error('connect EPERM 10.0.0.4:5432'), { code: 'EPERM' })
    const error = Object.assign(new AggregateError([inner], ''), { code: 'EPERM' })
    expect(errorMessage(error)).toBe('connect EPERM 10.0.0.4:5432')
  })

  it('keeps an outer message that carries its own context', () => {
    const error = new AggregateError([new Error('connect ETIMEDOUT ::1:3306')], 'All attempts failed')
    expect(errorMessage(error)).toBe('All attempts failed; connect ETIMEDOUT ::1:3306')
  })

  it('recurses through nested aggregates', () => {
    const error = new AggregateError([new AggregateError([new Error('inner')], '')], '')
    expect(errorMessage(error)).toBe('inner')
  })

  it('collapses identical leaf messages', () => {
    const error = new AggregateError([new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED')], '')
    expect(errorMessage(error)).toBe('connect ECONNREFUSED')
  })

  it('falls back to the errno when nothing carries a message', () => {
    expect(errorMessage(Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED')
    expect(errorMessage(Object.assign(new Error(''), { code: 'EPERM' }))).toBe('EPERM')
  })

  it('falls back to the error name when there is no message and no errno', () => {
    expect(errorMessage(new AggregateError([], ''))).toBe('AggregateError')
  })

  it('caps a long address list and counts what it dropped', () => {
    const legs = Array.from({ length: 7 }, (_, i) => new Error(`connect ECONNREFUSED 10.0.0.${i}:5432`))
    expect(errorMessage(new AggregateError(legs, ''))).toBe(
      'connect ECONNREFUSED 10.0.0.0:5432; connect ECONNREFUSED 10.0.0.1:5432; ' +
        'connect ECONNREFUSED 10.0.0.2:5432; connect ECONNREFUSED 10.0.0.3:5432 (+3 more)',
    )
  })

  it('handles values that are not errors at all', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage({ message: 'duck-typed' })).toBe('duck-typed')
    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('names a message-less object generically rather than "[object Object]"', () => {
    expect(errorMessage({ detail: 'no message here' })).toBe('Unknown error')
    expect(errorMessage(null)).toBe('Unknown error')
  })

  it('terminates on a cyclic error graph', () => {
    const error = new AggregateError([], '')
    ;(error as { errors: unknown[] }).errors = [error, new Error('reachable')]
    expect(errorMessage(error)).toBe('reachable')
  })
})
