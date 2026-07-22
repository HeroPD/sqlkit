import { describe, expect, it } from 'vitest'
import { applyFilterCondition, isFilterableQuery } from './sql-filter'

describe('applyFilterCondition', () => {
  it('adds an outer WHERE condition', () => {
    expect(applyFilterCondition('SELECT id, name FROM users', "active = true")).toBe(
      "SELECT id, name FROM users\nWHERE (active = true)",
    )
  })

  it('extends an existing WHERE before grouping and ordering', () => {
    expect(applyFilterCondition(
      'SELECT team, count(*) FROM users WHERE active = true GROUP BY team ORDER BY team LIMIT 10',
      'team_id > 4',
    )).toBe(
      'SELECT team, count(*) FROM users WHERE active = true\nAND (team_id > 4)\nGROUP BY team ORDER BY team LIMIT 10',
    )
  })

  it('ignores nested and quoted WHERE text', () => {
    expect(applyFilterCondition(
      "SELECT 'where order', (SELECT max(id) FROM log WHERE ok) AS latest FROM users ORDER BY id;",
      'id > 10',
    )).toBe(
      "SELECT 'where order', (SELECT max(id) FROM log WHERE ok) AS latest FROM users\nWHERE (id > 10)\nORDER BY id;",
    )
  })

  it('preserves trailing comments and semicolons', () => {
    expect(applyFilterCondition('SELECT * FROM users -- source\n;', 'id = 1')).toBe(
      'SELECT * FROM users -- source\nWHERE (id = 1);',
    )
  })

  it('rejects WHERE keywords, statement separators, and comment-only input', () => {
    expect(() => applyFilterCondition('SELECT * FROM users', 'WHERE id = 1')).toThrow(/without WHERE/)
    expect(() => applyFilterCondition('SELECT * FROM users', 'id = 1; DELETE FROM users')).toThrow(/semicolon/)
    expect(() => applyFilterCondition('SELECT * FROM users', '/* later */')).toThrow(/only comments/)
  })
})

describe('isFilterableQuery', () => {
  it('accepts one SELECT and rejects unsafe statement shapes', () => {
    expect(isFilterableQuery('SELECT 1')).toBe(true)
    expect(isFilterableQuery('SELECT * INTO backup FROM users')).toBe(false)
    expect(isFilterableQuery('SELECT 1 UNION SELECT 2')).toBe(false)
    expect(isFilterableQuery('SELECT 1; SELECT 2')).toBe(false)
    expect(isFilterableQuery('SELECT 1\nGO\nSELECT 2', 'sqlserver')).toBe(false)
    expect(isFilterableQuery('WITH users AS (SELECT 1) SELECT * FROM users')).toBe(false)
    expect(isFilterableQuery('UPDATE users SET active = true')).toBe(false)
  })
})
