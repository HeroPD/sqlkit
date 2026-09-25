import { describe, expect, it } from 'vitest'
import { connectionErrorMessage, errorMessage } from './error-message'

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

// A raw errno says what failed, not what to do about it.
describe('connectionErrorMessage', () => {
  const target = { host: 'localhost', port: '5432' }
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code })

  it('leads a dual-stack refusal with what to check, keeping the driver text', () => {
    const refused = Object.assign(new AggregateError([
      coded('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED'),
      coded('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    ], ''), { code: 'ECONNREFUSED' })
    expect(connectionErrorMessage(refused, target)).toBe(
      'Nothing is accepting connections at localhost:5432. Is the server running, and is the port right?\n'
      + 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432',
    )
  })

  it('names unknown hosts, refused logins, missing databases and certificate failures', () => {
    expect(connectionErrorMessage(coded('getaddrinfo ENOTFOUND db.intranet', 'ENOTFOUND'), { host: 'db.intranet', port: '' }))
      .toMatch(/^The host “db\.intranet” could not be found/)
    expect(connectionErrorMessage(coded('password authentication failed for user "app"', '28P01'), target))
      .toMatch(/^The server refused this user name or password\.\npassword authentication failed/)
    expect(connectionErrorMessage(Object.assign(new Error("Access denied for user 'app'"), { errno: 1045 }), target))
      .toMatch(/^The server refused this user name or password/)
    expect(connectionErrorMessage(coded('database "nope" does not exist', '3D000'), target)).toMatch(/^The server has no database by that name/)
    expect(connectionErrorMessage(coded('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'), target)).toMatch(/^The server’s certificate could not be verified/)
  })

  it('passes anything it does not recognise through unchanged', () => {
    expect(connectionErrorMessage(new Error('something odd'), target)).toBe('something odd')
  })
})
