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

describe('dialectFor: bindBoolean', () => {
  it('binds 1/0 on sqlite and real booleans elsewhere', () => {
    expect(dialectFor('sqlite').bindBoolean(true)).toBe(1)
    expect(dialectFor('sqlite').bindBoolean(false)).toBe(0)
    expect(dialectFor('postgresql').bindBoolean(true)).toBe(true)
    expect(dialectFor('mysql').bindBoolean(false)).toBe(false)
  })
})

describe('dialectFor: column edit capabilities', () => {
  it('allows in-place alters only where the ALTER syntax matches', () => {
    expect(dialectFor('postgresql').supportsColumnAlter).toBe(true)
    expect(dialectFor('sqlite').supportsColumnAlter).toBe(false)
    expect(dialectFor('mysql').supportsColumnAlter).toBe(false)
  })

  it('allows renames on engines with standard RENAME COLUMN', () => {
    expect(dialectFor('postgresql').supportsColumnRename).toBe(true)
    expect(dialectFor('sqlite').supportsColumnRename).toBe(true)
    expect(dialectFor('sqlserver').supportsColumnRename).toBe(false)
  })

  it('lists common column types only for wired-up engines', () => {
    expect(dialectFor('postgresql').commonColumnTypes).toContain('timestamptz')
    expect(dialectFor('sqlite').commonColumnTypes).toContain('integer')
    expect(dialectFor('mysql').commonColumnTypes).toContain('datetime')
    expect(dialectFor('sqlserver').commonColumnTypes).toEqual([])
  })
})
