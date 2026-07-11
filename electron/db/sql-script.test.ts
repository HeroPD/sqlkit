import { describe, expect, it } from 'vitest'
import {
  assertSelfContainedTransaction,
  prepareSqlRun,
  preprocessMysqlDelimiters,
  splitSqlServerBatches,
  splitTopLevelStatements,
} from './sql-script'

describe('transaction safety', () => {
  it('rejects transaction state that would escape one pooled query run', () => {
    expect(() => assertSelfContainedTransaction('BEGIN', 'postgresql')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction('START TRANSACTION; update t set a=1', 'mysql')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction('BEGIN TRANSACTION', 'sqlserver')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction('COMMIT', 'postgresql')).toThrow(/No transaction is active/i)
  })

  it('allows a transaction completed inside one execution', () => {
    expect(() => assertSelfContainedTransaction('BEGIN; update t set a=1; COMMIT', 'postgresql')).not.toThrow()
    expect(() => assertSelfContainedTransaction('START TRANSACTION; update t set a=1; ROLLBACK', 'mysql')).not.toThrow()
    expect(() => assertSelfContainedTransaction('BEGIN TRAN; update t set a=1; COMMIT TRAN', 'sqlserver')).not.toThrow()
  })

  it('does not mistake strings, procedural bodies, or trigger END for transaction control', () => {
    expect(() => assertSelfContainedTransaction("select 'BEGIN; COMMIT'", 'postgresql')).not.toThrow()
    expect(() => assertSelfContainedTransaction('DO $$ BEGIN PERFORM 1; END $$;', 'postgresql')).not.toThrow()
    expect(() => assertSelfContainedTransaction('create trigger x after insert on t begin update t set a=1; end', 'sqlite')).not.toThrow()
  })

  it('recognizes transaction control around dialect-specific comments and escapes', () => {
    expect(() => assertSelfContainedTransaction('# heading\nSTART TRANSACTION; update t set a=1', 'mysql')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction('SELECT 3--2; START TRANSACTION; update t set a=1', 'mysql')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction('/*!40101 START TRANSACTION */; update t set a=1', 'mysql')).toThrow(/same query run/i)
    expect(() => assertSelfContainedTransaction("select E'quote\\'; BEGIN'; BEGIN", 'postgresql')).toThrow(/same query run/i)
  })

  it('supports PostgreSQL nested block comments', () => {
    expect(() => assertSelfContainedTransaction('/* outer /* BEGIN */ still comment */ select 1', 'postgresql')).not.toThrow()
  })

  it('accepts T-SQL scripts written without semicolons', () => {
    expect(() => assertSelfContainedTransaction('BEGIN TRAN\nupdate t set a=1\nCOMMIT', 'sqlserver')).not.toThrow()
    expect(() => assertSelfContainedTransaction('BEGIN TRANSACTION\nupdate t set a=1\nROLLBACK TRAN', 'sqlserver')).not.toThrow()
    expect(() => assertSelfContainedTransaction('BEGIN TRAN\nupdate t set a=1', 'sqlserver')).toThrow(/same query run/i)
    // BEGIN TRY / CASE END are control flow, not transaction tokens.
    expect(() => assertSelfContainedTransaction('BEGIN TRY\nselect case when 1=1 then 2 end\nEND TRY BEGIN CATCH END CATCH', 'sqlserver')).not.toThrow()
    expect(() => assertSelfContainedTransaction("select 'COMMIT' -- COMMIT", 'sqlserver')).not.toThrow()
  })

  it('accepts T-SQL closes in unexecuted branches (TRY/CATCH, @@TRANCOUNT guards)', () => {
    expect(() => assertSelfContainedTransaction(
      'BEGIN TRY\nBEGIN TRAN\nupdate t set a=1\nCOMMIT\nEND TRY\nBEGIN CATCH\nIF @@TRANCOUNT > 0 ROLLBACK\nEND CATCH',
      'sqlserver',
    )).not.toThrow()
    expect(() => assertSelfContainedTransaction('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION\nselect 1', 'sqlserver')).not.toThrow()
    // A begin that no branch closes is still a leaked transaction.
    expect(() => assertSelfContainedTransaction('BEGIN TRY\nBEGIN TRAN\nupdate t set a=1\nEND TRY\nBEGIN CATCH\nEND CATCH', 'sqlserver')).toThrow(/same query run/i)
  })

  it('accepts SQLite END as an alias for COMMIT', () => {
    expect(() => assertSelfContainedTransaction('BEGIN; update t set a=1; END', 'sqlite')).not.toThrow()
    expect(() => assertSelfContainedTransaction('BEGIN; update t set a=1; END TRANSACTION', 'sqlite')).not.toThrow()
    expect(() => assertSelfContainedTransaction('BEGIN; update t set a=1', 'sqlite')).toThrow(/same query run/i)
  })

  it('does not treat MariaDB BEGIN NOT ATOMIC blocks as transaction starts', () => {
    expect(() => assertSelfContainedTransaction('BEGIN NOT ATOMIC\n  SELECT 1;\nEND', 'mysql')).not.toThrow()
  })
})

describe('dialect script handling', () => {
  it('splits SQL Server GO only when it is a batch-separator line', () => {
    expect(splitSqlServerBatches("select 'GO' as x\nGO\ncreate view v as select 1 as n\ngo\nselect * from v")).toEqual([
      "select 'GO' as x",
      'create view v as select 1 as n',
      'select * from v',
    ])
  })

  it('ignores GO inside T-SQL nested block comments', () => {
    expect(splitSqlServerBatches('select 1\n/* outer /* inner */\nGO\nstill comment */\nselect 2')).toEqual([
      'select 1\n/* outer /* inner */\nGO\nstill comment */\nselect 2',
    ])
  })

  it('honors bounded SQL Server GO repeat counts', () => {
    expect(splitSqlServerBatches('select 1\nGO 2\nselect 2')).toEqual(['select 1', 'select 1', 'select 2'])
    expect(() => splitSqlServerBatches('select 1\nGO 1001')).toThrow(/between 1 and 1,000/i)
  })

  it('preprocesses mysql-client DELIMITER scripts without splitting routine bodies', () => {
    expect(preprocessMysqlDelimiters('DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\nEND$$\nDELIMITER ;')).toBe(
      'CREATE PROCEDURE p()\nBEGIN\n SELECT 1;\nEND;'
    )
  })

  it('only replaces custom delimiters outside MySQL strings and comments', () => {
    expect(preprocessMysqlDelimiters([
      'DELIMITER $$',
      "SELECT '$$' AS quoted$$ SELECT 2$$ -- $$",
      '/* $$',
      'DELIMITER ;',
      '$$ */',
      'DELIMITER ;',
    ].join('\n'))).toBe([
      "SELECT '$$' AS quoted; SELECT 2; -- $$",
      '/* $$',
      'DELIMITER ;',
      '$$ */',
    ].join('\n'))
  })

  it('handles escaped and doubled quotes while using a custom delimiter', () => {
    expect(preprocessMysqlDelimiters("DELIMITER //\nSELECT 'can\\'t //', \"a\"\"//b\"//\nDELIMITER ;"))
      .toBe("SELECT 'can\\'t //', \"a\"\"//b\";")
  })

  it('does not mistake MySQL subtraction for a -- comment', () => {
    expect(preprocessMysqlDelimiters('DELIMITER $$\nSELECT 3--2$$\nDELIMITER ;')).toBe('SELECT 3--2;')
  })

  it('splits only top-level semicolons', () => {
    expect(splitTopLevelStatements("select ';'; select (1 + 2);")).toEqual(["select ';'", 'select (1 + 2)'])
    expect(splitTopLevelStatements("select 'can\\'t; stop'; select 2", 'mysql')).toEqual(["select 'can\\'t; stop'", 'select 2'])
  })
})

describe('prepareSqlRun', () => {
  it('applies an engine-quoted sort only to a single SELECT', () => {
    expect(prepareSqlRun({
      engine: 'postgresql',
      sql: 'select id, name from users limit 10;',
      sort: { column: 'display name', direction: 'desc' },
    }).batches).toEqual(['select id, name from users\nORDER BY "display name" DESC\nlimit 10;'])

    expect(() => prepareSqlRun({
      engine: 'mysql',
      sql: 'select 1; select 2',
      sort: { column: 'value', direction: 'asc' },
    })).toThrow(/single SELECT/i)
    expect(() => prepareSqlRun({
      engine: 'sqlserver',
      sql: 'update users set active = 1',
      sort: { column: 'id', direction: 'asc' },
    })).toThrow(/single SELECT/i)
  })

  it('normalizes MySQL client delimiters before validation and execution', () => {
    expect(prepareSqlRun({
      engine: 'mysql',
      sql: 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\nEND$$\nDELIMITER ;',
    }).batches).toEqual(['CREATE PROCEDURE p()\nBEGIN\n SELECT 1;\nEND;'])
  })

  it('expands SQL Server GO batches and rejects ambiguous parameter binding', () => {
    expect(prepareSqlRun({ engine: 'sqlserver', sql: 'select 1\nGO 2\nselect 2' }).batches)
      .toEqual(['select 1', 'select 1', 'select 2'])
    expect(() => prepareSqlRun({
      engine: 'sqlserver',
      sql: 'select @p1\nGO\nselect @p1',
      params: [1],
    })).toThrow(/Parameters.*multi-batch/i)
  })

  it('enforces the stateless transaction contract for every caller', () => {
    expect(() => prepareSqlRun({ engine: 'postgresql', sql: 'BEGIN; select 1' })).toThrow(/same query run/i)
    expect(prepareSqlRun({ engine: 'postgresql', sql: 'BEGIN; select 1; COMMIT' }).batches)
      .toEqual(['BEGIN; select 1; COMMIT'])
  })
})
