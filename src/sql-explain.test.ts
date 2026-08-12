import { describe, expect, it } from 'vitest'
import { explainFlavors, explainStatement, stripExplain } from './sql-explain'

const explain = (engine: Parameters<typeof explainFlavors>[0], flavor: 'plan' | 'analyze', sql: string, serverVersion: string | null = null) =>
  explainStatement({ engine, serverVersion, flavor, sql })

describe('explainFlavors', () => {
  it('offers both flavors on postgres and sql server', () => {
    expect(explainFlavors('postgresql', 'PostgreSQL 17.2')).toEqual(['plan', 'analyze'])
    expect(explainFlavors('sqlserver', 'Microsoft SQL Server 2022')).toEqual(['plan', 'analyze'])
  })

  it('offers only the query plan on sqlite', () => {
    expect(explainFlavors('sqlite', '3.46.0')).toEqual(['plan'])
  })

  it('gates the analyze flavor on the MySQL and MariaDB versions that have one', () => {
    expect(explainFlavors('mysql', 'MySQL 8.0.18')).toEqual(['plan', 'analyze'])
    expect(explainFlavors('mysql', 'MySQL 9.3.0')).toEqual(['plan', 'analyze'])
    expect(explainFlavors('mysql', 'MySQL 8.0.17')).toEqual(['plan'])
    expect(explainFlavors('mysql', 'MySQL 5.7.44')).toEqual(['plan'])
    expect(explainFlavors('mysql', 'MariaDB 11.4.2')).toEqual(['plan', 'analyze'])
    expect(explainFlavors('mysql', 'MariaDB 10.1.0')).toEqual(['plan', 'analyze'])
    expect(explainFlavors('mysql', 'MariaDB 10.0.38')).toEqual(['plan'])
  })

  it('withholds analyze when the server version is unknown', () => {
    expect(explainFlavors('mysql', null)).toEqual(['plan'])
    expect(explainFlavors('mysql', 'MySQL unreleased')).toEqual(['plan'])
  })
})

describe('explainStatement', () => {
  it('prefixes the postgres and sqlite forms', () => {
    expect(explain('postgresql', 'plan', 'select 1')).toBe('explain select 1')
    expect(explain('postgresql', 'analyze', 'select 1')).toBe('explain analyze select 1')
    expect(explain('sqlite', 'plan', 'select 1')).toBe('explain query plan select 1')
  })

  it('spells the analyze flavor the way each MySQL flavor does', () => {
    expect(explain('mysql', 'plan', 'select 1', 'MySQL 9.3.0')).toBe('explain select 1')
    expect(explain('mysql', 'analyze', 'select 1', 'MySQL 9.3.0')).toBe('explain analyze select 1')
    expect(explain('mysql', 'analyze', 'select 1', 'MariaDB 11.4.2')).toBe('analyze select 1')
  })

  it('scripts SQL Server plans around a session SET', () => {
    // SHOWPLAN_ALL has to own its batch, so the query follows a GO — and the
    // plan stays the last result set, which is the one the panel opens on.
    expect(explain('sqlserver', 'plan', 'select 1')).toBe('set showplan_all on\ngo\nselect 1')
    expect(explain('sqlserver', 'analyze', 'select 1')).toBe('set statistics profile on; select 1; set statistics profile off')
    expect(explain('sqlserver', 'analyze', 'select 1;')).toBe('set statistics profile on; select 1; set statistics profile off')
  })

  it('restores the SQL Server session inside a manual transaction', () => {
    // A pinned connection is never reset, so the switch cannot be left on:
    // every later statement in the transaction would compile without running.
    const statement = explainStatement({ engine: 'sqlserver', serverVersion: null, flavor: 'plan', sql: 'select 1', inTransaction: true })
    expect(statement).toBe('set showplan_all on\ngo\nselect 1\ngo\nset showplan_all off')
  })

  it('re-explains the original statement rather than stacking wrappers', () => {
    expect(explain('postgresql', 'plan', 'explain analyze select 1')).toBe('explain select 1')
    expect(explain('mysql', 'plan', 'analyze select 1')).toBe('explain select 1')
    expect(explain('sqlserver', 'plan', 'set showplan_all on\ngo\nselect 1')).toBe('set showplan_all on\ngo\nselect 1')
    expect(explain('sqlserver', 'analyze', 'set statistics profile on; select 1; set statistics profile off')).toBe(
      'set statistics profile on; select 1; set statistics profile off',
    )
  })
})

describe('stripExplain', () => {
  it('strips plain and modified explains', () => {
    expect(stripExplain('explain select 1')).toBe('select 1')
    expect(stripExplain('EXPLAIN ANALYZE select 1')).toBe('select 1')
    expect(stripExplain('explain analyze verbose select 1')).toBe('select 1')
    expect(stripExplain('explain (analyze, buffers) select 1')).toBe('select 1')
    expect(stripExplain('explain query plan select 1')).toBe('select 1')
    expect(stripExplain('explain format=json select 1')).toBe('select 1')
    expect(stripExplain('  EXPLAIN  select 1')).toBe('select 1')
  })

  it('strips MariaDB ANALYZE, but never the statistics statement it shares a name with', () => {
    expect(stripExplain('analyze select 1')).toBe('select 1')
    expect(stripExplain('ANALYZE FORMAT=JSON select 1')).toBe('select 1')
    expect(stripExplain('analyze table books')).toBe('analyze table books')
    expect(stripExplain('analyze')).toBe('analyze')
  })

  it('strips the SQL Server plan SETs, with their GO or semicolon', () => {
    expect(stripExplain('set showplan_all on\ngo\nselect 1')).toBe('select 1')
    expect(stripExplain('set showplan_all on\ngo\nselect 1\ngo\nset showplan_all off')).toBe('select 1')
    expect(stripExplain('set statistics profile on; select 1; set statistics profile off')).toBe('select 1')
    expect(stripExplain('SET STATISTICS XML ON; select 1; SET STATISTICS XML OFF')).toBe('select 1')
  })

  it('leaves non-explain queries untouched', () => {
    expect(stripExplain('select 1')).toBe('select 1')
    expect(stripExplain('select explain from t')).toBe('select explain from t')
    expect(stripExplain('-- explain\nselect 1')).toBe('-- explain\nselect 1')
    expect(stripExplain('set statistics profile on')).toBe('set statistics profile on')
  })
})
