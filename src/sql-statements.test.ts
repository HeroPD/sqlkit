import { describe, expect, it } from 'vitest'
import { isSingleStatement, splitTopLevelStatements } from './sql-statements'

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

describe('splitTopLevelStatements', () => {
  it('keeps a MySQL routine body whole, nested blocks included', () => {
    const proc = [
      'create procedure p(n int)',
      'begin',
      '  declare exit handler for sqlexception begin rollback; end;',
      '  drop temporary table if exists tmp;',
      '  if n > 0 then update t set a = if(a, 0, 1); end if;',
      '  case n when 1 then select 1; else select 2; end case;',
      "  l: loop leave l; end loop l;",
      '  while n > 0 do set n = n - 1; end while;',
      "  repeat set n = n + 1, @s = repeat('a', 2); until n > 3 end repeat;",
      'end',
    ].join('\n')
    expect(splitTopLevelStatements(`${proc};\ndelete from t;`, 'mysql')).toEqual([proc, 'delete from t'])
    expect(splitTopLevelStatements('begin not atomic select 1; select 2; end; select 3', 'mysql'))
      .toEqual(['begin not atomic select 1; select 2; end', 'select 3'])
    expect(splitTopLevelStatements('create trigger g before insert on t for each row set new.a = 1; delete from t', 'mysql'))
      .toEqual(['create trigger g before insert on t for each row set new.a = 1', 'delete from t'])
  })

  it('keeps a SQLite trigger body whole', () => {
    const trigger = 'create trigger g after insert on t begin update t set a = case when a then 0 end; delete from log; end'
    expect(splitTopLevelStatements(`${trigger}; select 1`, 'sqlite')).toEqual([trigger, 'select 1'])
    expect(splitTopLevelStatements('begin; delete from t; end;', 'sqlite')).toEqual(['begin', 'delete from t', 'end'])
  })

  it('keeps a T-SQL routine whole to the end of its batch', () => {
    const proc = 'create procedure p as\nbegin\n  delete from t where a = 1;\n  select 2;\nend'
    expect(splitTopLevelStatements(proc, 'sqlserver')).toEqual([proc])
    expect(isSingleStatement(`${proc}\ngo\nselect 1`, 'sqlserver')).toBe(false)
  })

  it('splits other engines and ordinary scripts as before', () => {
    expect(splitTopLevelStatements('begin; delete from t; commit;', 'mysql')).toEqual(['begin', 'delete from t', 'commit'])
    expect(splitTopLevelStatements('create table event (trigger int); select 1', 'mysql')).toEqual(['create table event (trigger int)', 'select 1'])
  })
})
