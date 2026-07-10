import { describe, expect, it } from 'vitest'
import {
  assertSelfContainedTransaction,
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
})

describe('dialect script handling', () => {
  it('splits SQL Server GO only when it is a batch-separator line', () => {
    expect(splitSqlServerBatches("select 'GO' as x\nGO\ncreate view v as select 1 as n\ngo\nselect * from v")).toEqual([
      "select 'GO' as x",
      'create view v as select 1 as n',
      'select * from v',
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

  it('splits only top-level semicolons', () => {
    expect(splitTopLevelStatements("select ';'; select (1 + 2);")).toEqual(["select ';'", 'select (1 + 2)'])
  })
})
