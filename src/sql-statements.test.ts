import { describe, expect, it } from 'vitest'
import { isSingleStatement } from './sql-statements'

describe('isSingleStatement', () => {
  it('accepts one statement, with or without its terminator', () => {
    expect(isSingleStatement('select 1')).toBe(true)
    expect(isSingleStatement('select 1;')).toBe(true)
    expect(isSingleStatement('  select 1 ;  ')).toBe(true)
  })

  it('rejects a script, so an EXPLAIN can never run the statements past the first', () => {
    expect(isSingleStatement('select 1; select 2')).toBe(false)
    expect(isSingleStatement('select 1; delete from users')).toBe(false)
    expect(isSingleStatement('insert into t values (1); update t set a = 2')).toBe(false)
  })

  it('rejects an empty or commented-out script, which has no statement to plan', () => {
    expect(isSingleStatement('')).toBe(false)
    expect(isSingleStatement('   \n  ')).toBe(false)
    expect(isSingleStatement('-- select 1')).toBe(false)
  })

  it('counts T-SQL GO batches, which the splitter does not see as separators', () => {
    expect(isSingleStatement('select 1\ngo\nselect 2', 'sqlserver')).toBe(false)
    expect(isSingleStatement('select 1\ngo', 'sqlserver')).toBe(true)
    expect(isSingleStatement('select 1', 'sqlserver')).toBe(true)
  })

  it('keeps a routine body whole rather than splitting at its inner semicolons', () => {
    const fn =
      'create function f() returns int as $$ begin return 1; end $$ language plpgsql'
    expect(isSingleStatement(fn, 'postgresql')).toBe(true)
  })

  it('does not split at a semicolon inside a literal or comment', () => {
    expect(isSingleStatement("select ';'")).toBe(true)
    expect(isSingleStatement('select 1 -- ; not a split\n')).toBe(true)
  })
})
