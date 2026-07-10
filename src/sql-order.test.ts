import { describe, expect, it } from 'vitest'
import { activeSort, applyOrderBy, isReorderableQuery, type OrderByTerm } from './sql-order'

const asc = (column: string): OrderByTerm => ({ column, dir: 'asc' })
const desc = (column: string): OrderByTerm => ({ column, dir: 'desc' })

describe('isReorderableQuery', () => {
  it('accepts a single read statement', () => {
    expect(isReorderableQuery('SELECT * FROM users')).toBe(true)
    expect(isReorderableQuery('SELECT * FROM users;')).toBe(true)
    expect(isReorderableQuery('SELECT * FROM users;  \n')).toBe(true)
  })

  it('rejects non-reads, empty, and multi-statement SQL', () => {
    expect(isReorderableQuery('')).toBe(false)
    expect(isReorderableQuery('UPDATE users SET name = 1')).toBe(false)
    expect(isReorderableQuery('SELECT 1; SELECT 2')).toBe(false)
    expect(isReorderableQuery('-- a comment\nDELETE FROM users')).toBe(false)
    expect(isReorderableQuery('WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed')).toBe(false)
    expect(isReorderableQuery('SELECT * INTO archived_users FROM users')).toBe(false)
    expect(isReorderableQuery('SELECT * FROM users FOR UPDATE')).toBe(false)
    expect(isReorderableQuery('SELECT * FROM users OPTION (RECOMPILE)')).toBe(false)
  })

  it('ignores semicolons inside strings', () => {
    expect(isReorderableQuery("SELECT ';' AS c FROM users")).toBe(true)
  })
})

describe('applyOrderBy', () => {
  it('inserts an ORDER BY when none exists', () => {
    expect(applyOrderBy('SELECT * FROM users', asc('"name"'))).toBe('SELECT * FROM users\nORDER BY "name" ASC')
  })

  it('keeps the ORDER BY ahead of LIMIT/OFFSET', () => {
    expect(applyOrderBy('SELECT * FROM users LIMIT 200', desc('"id"'))).toBe('SELECT * FROM users\nORDER BY "id" DESC\nLIMIT 200')
    expect(applyOrderBy('SELECT * FROM t LIMIT 10 OFFSET 5', asc('"a"'))).toBe('SELECT * FROM t\nORDER BY "a" ASC\nLIMIT 10 OFFSET 5')
  })

  it('replaces an existing ORDER BY', () => {
    expect(applyOrderBy('SELECT * FROM users ORDER BY name', desc('"id"'))).toBe('SELECT * FROM users\nORDER BY "id" DESC')
    expect(applyOrderBy('SELECT * FROM users ORDER BY a ASC, b DESC LIMIT 5', asc('"c"'))).toBe(
      'SELECT * FROM users\nORDER BY "c" ASC\nLIMIT 5',
    )
  })

  it('removes the ORDER BY when the term is null, keeping the tail', () => {
    expect(applyOrderBy('SELECT * FROM users\nORDER BY "id" DESC\nLIMIT 5', null)).toBe('SELECT * FROM users\nLIMIT 5')
    expect(applyOrderBy('SELECT * FROM users ORDER BY id', null)).toBe('SELECT * FROM users')
  })

  it('preserves a trailing semicolon', () => {
    expect(applyOrderBy('SELECT * FROM users;', asc('"name"'))).toBe('SELECT * FROM users\nORDER BY "name" ASC;')
    expect(applyOrderBy('SELECT * FROM users ORDER BY id;', desc('"id"'))).toBe('SELECT * FROM users\nORDER BY "id" DESC;')
  })

  it('does not treat LIMIT inside a subquery as the outer tail', () => {
    expect(applyOrderBy('SELECT * FROM (SELECT * FROM t LIMIT 3) s', asc('"x"'))).toBe(
      'SELECT * FROM (SELECT * FROM t LIMIT 3) s\nORDER BY "x" ASC',
    )
  })
})

describe('activeSort', () => {
  const columns = ['id', 'name', 'created_at']

  it('finds the sorted column and direction', () => {
    expect(activeSort('SELECT * FROM t ORDER BY name', columns)).toEqual({ index: 1, dir: 'asc' })
    expect(activeSort('SELECT * FROM t ORDER BY "created_at" DESC', columns)).toEqual({ index: 2, dir: 'desc' })
    expect(activeSort('SELECT * FROM t ORDER BY id DESC LIMIT 5', columns)).toEqual({ index: 0, dir: 'desc' })
  })

  it('matches by ordinal and is case-insensitive', () => {
    expect(activeSort('SELECT * FROM t ORDER BY 2 DESC', columns)).toEqual({ index: 1, dir: 'desc' })
    expect(activeSort('SELECT * FROM t ORDER BY NAME', columns)).toEqual({ index: 1, dir: 'asc' })
  })

  it('reads only the first term, ignoring NULLS FIRST/LAST', () => {
    expect(activeSort('SELECT * FROM t ORDER BY name DESC NULLS LAST, id', columns)).toEqual({ index: 1, dir: 'desc' })
  })

  it('returns null when there is no ORDER BY or it maps to no column', () => {
    expect(activeSort('SELECT * FROM t', columns)).toBeNull()
    expect(activeSort('SELECT * FROM t ORDER BY lower(name)', columns)).toBeNull()
    expect(activeSort('SELECT * FROM t ORDER BY other', columns)).toBeNull()
  })
})
