import { describe, expect, it } from 'vitest'
import { isReadOnlyScript } from './sql-readonly'

describe('isReadOnlyScript', () => {
  it('accepts plain reads and multi-statement read scripts', () => {
    expect(isReadOnlyScript('SELECT * FROM t', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('SELECT 1; SELECT 2;', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('WITH x AS (SELECT 1 AS n) SELECT * FROM x', 'sqlserver')).toBe(true)
  })

  it('accepts T-SQL read tails: FOR JSON/XML and OPTION hints', () => {
    expect(isReadOnlyScript('SELECT * FROM customers FOR JSON PATH', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript("SELECT * FROM t FOR XML PATH('row')", 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('SELECT * FROM orders OPTION (RECOMPILE)', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('WITH r AS (SELECT 1 AS n) SELECT * FROM r OPTION (MAXRECURSION 0)', 'sqlserver')).toBe(true)
  })

  it('rejects writes, DDL, and heads it cannot see into', () => {
    expect(isReadOnlyScript('UPDATE t SET a = 1', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('SELECT 1; DELETE FROM t;', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('EXEC sp_who2', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('SELECT * INTO #tmp FROM t', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgresql')).toBe(false)
  })

  it('catches a write hidden behind a read head without a separator', () => {
    // T-SQL statements need no semicolon between them, so the splitter sees
    // one statement where the server would run two.
    expect(isReadOnlyScript('SELECT 1 DELETE FROM t', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('SELECT 1\nGO\nDROP TABLE t', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('SELECT 1\nGO\nSELECT 2', 'sqlserver')).toBe(true)
  })

  it('does not mistake quoted names, strings, or word tails for write keywords', () => {
    expect(isReadOnlyScript('SELECT create_date, modify_date FROM sys.tables', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript("SELECT * FROM t WHERE note = 'please delete me'", 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('SELECT [delete] FROM t', 'sqlserver')).toBe(true)
    expect(isReadOnlyScript('SELECT * FROM sys.dm_exec_requests', 'sqlserver')).toBe(true)
  })

  it('treats a row-locking FOR as unsafe outside SQL Server', () => {
    expect(isReadOnlyScript('SELECT * FROM t FOR SHARE', 'postgresql')).toBe(false)
    expect(isReadOnlyScript('SELECT * FROM t FOR UPDATE', 'postgresql')).toBe(false)
  })

  it('rejects empty scripts', () => {
    expect(isReadOnlyScript('', 'sqlserver')).toBe(false)
    expect(isReadOnlyScript('   ', 'sqlserver')).toBe(false)
  })
})
