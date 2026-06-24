import { describe, expect, it } from 'vitest'
import { dialectFor } from './dialect'

describe('dialectFor: identifier quoting', () => {
  it('quotes per engine and escapes the quote char', () => {
    expect(dialectFor('postgresql').quoteIdent('a"b')).toBe('"a""b"')
    expect(dialectFor('sqlite').quoteIdent('col')).toBe('"col"')
    expect(dialectFor('mysql').quoteIdent('a`b')).toBe('`a``b`')
    expect(dialectFor('sqlserver').quoteIdent('a]b')).toBe('[a]]b]')
  })
})

describe('dialectFor: placeholder', () => {
  it('numbers Postgres params and uses ? elsewhere', () => {
    expect(dialectFor('postgresql').placeholder(1)).toBe('$1')
    expect(dialectFor('postgresql').placeholder(7)).toBe('$7')
    expect(dialectFor('sqlite').placeholder(1)).toBe('?')
    expect(dialectFor('mysql').placeholder(3)).toBe('?')
  })
})

describe('dialectFor: applyOrderBy', () => {
  it('builds an engine-correct ORDER BY for a column sort', () => {
    expect(dialectFor('postgresql').applyOrderBy('SELECT * FROM t LIMIT 5', { column: 'name', direction: 'desc' })).toBe(
      'SELECT * FROM t\nORDER BY "name" DESC\nLIMIT 5',
    )
    expect(dialectFor('mysql').applyOrderBy('SELECT * FROM t', { column: 'name', direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY `name` ASC',
    )
    expect(dialectFor('sqlserver').applyOrderBy('SELECT * FROM t', { column: 'id', direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY [id] ASC',
    )
  })

  it('replaces an existing ORDER BY', () => {
    expect(dialectFor('postgresql').applyOrderBy('SELECT * FROM t ORDER BY id', { column: 'name', direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY "name" ASC',
    )
  })
})
