import { describe, expect, it } from 'vitest'
import { analyzeDestructive } from './sql-destructive'

describe('analyzeDestructive', () => {
  it('passes reads and additive statements', () => {
    expect(analyzeDestructive('select * from users')).toEqual([])
    expect(analyzeDestructive('insert into users (name) values (1)')).toEqual([])
    expect(analyzeDestructive('create table users (id int)')).toEqual([])
    expect(analyzeDestructive('alter table users add column email text')).toEqual([])
    expect(analyzeDestructive('')).toEqual([])
    expect(analyzeDestructive('   \n  ')).toEqual([])
  })

  it('flags DROP by what it removes', () => {
    expect(analyzeDestructive('drop table users')).toEqual(['drop'])
    expect(analyzeDestructive('DROP TABLE IF EXISTS public.users CASCADE')).toEqual(['drop'])
    expect(analyzeDestructive('drop materialized view sales_mv', 'postgresql')).toEqual(['drop'])
    expect(analyzeDestructive('drop index users_email_idx')).toEqual(['drop'])
    expect(analyzeDestructive('drop database analytics')).toEqual(['dropDatabase'])
    expect(analyzeDestructive('drop schema public cascade', 'postgresql')).toEqual(['dropDatabase'])
  })

  it('flags TRUNCATE with or without the TABLE keyword', () => {
    expect(analyzeDestructive('truncate table events')).toEqual(['truncate'])
    expect(analyzeDestructive('truncate events restart identity', 'postgresql')).toEqual(['truncate'])
  })

  it('flags writes that scope nothing', () => {
    expect(analyzeDestructive('delete from users')).toEqual(['deleteAll'])
    expect(analyzeDestructive('update users set active = false')).toEqual(['updateAll'])
    // MySQL's multi-table form names the target before FROM.
    expect(analyzeDestructive('delete t1 from t1 join t2 on t1.id = t2.id', 'mysql')).toEqual(['deleteAll'])
  })

  it('accepts writes the statement itself narrows', () => {
    expect(analyzeDestructive('delete from users where id = 1')).toEqual([])
    expect(analyzeDestructive('update users set active = false where id = 1')).toEqual([])
    expect(analyzeDestructive('delete from t where id in (select id from u)')).toEqual([])
    // A row cap is as deliberate a scope as a WHERE.
    expect(analyzeDestructive('delete from logs order by id limit 100', 'mysql')).toEqual([])
    expect(analyzeDestructive('update top (5) t set x = 1', 'sqlserver')).toEqual([])
  })

  it('does not let a subquery WHERE scope the write around it', () => {
    expect(analyzeDestructive('update t set x = (select max(y) from z where z.id = 1)')).toEqual(['updateAll'])
    expect(analyzeDestructive('delete from t using (select id from u where u.ok) s', 'postgresql')).toEqual(['deleteAll'])
  })

  it('separates ALTER … DROP of data from DROP of an attribute', () => {
    expect(analyzeDestructive('alter table users drop column email')).toEqual(['alterDrop'])
    expect(analyzeDestructive('alter table users drop constraint users_pkey')).toEqual(['alterDrop'])
    // MySQL and SQLite leave COLUMN implicit.
    expect(analyzeDestructive('alter table users drop email', 'mysql')).toEqual(['alterDrop'])
    expect(analyzeDestructive('alter table t alter column c drop not null', 'postgresql')).toEqual([])
    expect(analyzeDestructive('alter table t alter column c drop default', 'postgresql')).toEqual([])
  })

  it('reads nothing out of comments, strings or quoted identifiers', () => {
    expect(analyzeDestructive('-- drop table users\nselect 1')).toEqual([])
    expect(analyzeDestructive("select 'drop table users' as note")).toEqual([])
    expect(analyzeDestructive('select 1 # truncate table t', 'mysql')).toEqual([])
    expect(analyzeDestructive('select * from "drop table"')).toEqual([])
    expect(analyzeDestructive('/* delete from t */ select 1')).toEqual([])
  })

  it('reports every kind in a script once, worst first', () => {
    expect(analyzeDestructive('update t set a = 1; delete from b; drop table c;')).toEqual(['drop', 'deleteAll', 'updateAll'])
    expect(analyzeDestructive('drop table a; drop table b')).toEqual(['drop'])
  })

  it('follows a CTE to the write it drives', () => {
    expect(analyzeDestructive('with x as (select 1) delete from t', 'postgresql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('with d as (delete from t returning *) select * from d', 'postgresql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('with d as (delete from t where id = 1 returning *) select * from d', 'postgresql')).toEqual([])
    expect(analyzeDestructive('with x as (select 1 from t where t.ok) select * from x', 'postgresql')).toEqual([])
  })

  it('leaves routine bodies to the routine', () => {
    const fn = 'create function f() returns void as $$ delete from t; $$ language sql'
    expect(analyzeDestructive(fn, 'postgresql')).toEqual([])
    const trigger = 'create trigger prune after insert on t begin delete from log; end'
    expect(analyzeDestructive(trigger, 'sqlite')).toEqual([])
    expect(analyzeDestructive('create procedure p as begin delete from t end', 'sqlserver')).toEqual([])
  })

  // Regression: suppressing a routine body dropped the whole analyzed statement,
  // and a GO-separated script is one statement to the splitter — so the DELETE
  // the executor runs as its own batch went unseen.
  it('still sees a batch that follows a routine body', () => {
    expect(analyzeDestructive('CREATE PROCEDURE p AS SELECT 1\nGO\nDELETE FROM users', 'sqlserver')).toEqual(['deleteAll'])
    expect(analyzeDestructive('CREATE PROCEDURE p AS SELECT 1\nGO\nDROP TABLE users', 'sqlserver')).toEqual(['drop'])
    expect(analyzeDestructive('CREATE PROCEDURE p AS DELETE FROM t\nGO\nSELECT 1', 'sqlserver')).toEqual([])
  })

  // Regression: EXPLAIN ANALYZE executes the statement it wraps.
  it('judges the statement an EXPLAIN ANALYZE wraps', () => {
    expect(analyzeDestructive('EXPLAIN ANALYZE DELETE FROM users', 'postgresql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('EXPLAIN ANALYZE UPDATE users SET enabled = false', 'postgresql')).toEqual(['updateAll'])
    expect(analyzeDestructive('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users', 'postgresql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('explain analyze format=tree delete from users', 'mysql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('EXPLAIN ANALYZE WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgresql')).toEqual(['deleteAll'])
  })

  it('leaves plan-only EXPLAIN alone', () => {
    expect(analyzeDestructive('EXPLAIN DELETE FROM users', 'postgresql')).toEqual([])
    expect(analyzeDestructive('EXPLAIN VERBOSE UPDATE t SET a = 1', 'postgresql')).toEqual([])
    expect(analyzeDestructive('EXPLAIN QUERY PLAN DELETE FROM users', 'sqlite')).toEqual([])
    expect(analyzeDestructive('EXPLAIN ANALYZE SELECT * FROM users', 'postgresql')).toEqual([])
    // A column called "analyze" does not turn a plan into a run.
    expect(analyzeDestructive('EXPLAIN SELECT analyze FROM t', 'postgresql')).toEqual([])
  })

  // SQL Server's estimated plan is a session switch, not a wrapper keyword.
  it('leaves statements SET SHOWPLAN only compiles alone, and judges the rest', () => {
    expect(analyzeDestructive('set showplan_all on\nGO\ndelete from users', 'sqlserver')).toEqual([])
    expect(analyzeDestructive('SET SHOWPLAN_XML ON\nGO\ndrop table users\nGO\nSET SHOWPLAN_XML OFF', 'sqlserver')).toEqual([])
    // Past the OFF the server executes again, and a plan that really runs the
    // statement (STATISTICS PROFILE) never suppressed anything.
    expect(analyzeDestructive('set showplan_all on\nGO\nselect 1\nGO\nset showplan_all off\nGO\ndelete from users', 'sqlserver')).toEqual(['deleteAll'])
    expect(analyzeDestructive('set statistics profile on; delete from users; set statistics profile off', 'sqlserver')).toEqual(['deleteAll'])
  })

  it('sees past T-SQL batch separators and optional semicolons', () => {
    expect(analyzeDestructive('delete from a where id = 1\nGO\ndrop table b', 'sqlserver')).toEqual(['drop'])
    expect(analyzeDestructive('delete from a delete from b', 'sqlserver')).toEqual(['deleteAll'])
    expect(analyzeDestructive('if @stale = 1 delete from cache', 'sqlserver')).toEqual(['deleteAll'])
    // A WHERE belonging to the next statement does not scope the one before it.
    expect(analyzeDestructive('delete from a delete from b where id = 1', 'sqlserver')).toEqual(['deleteAll'])
  })

  it('treats a MERGE branch as scoped by its ON condition', () => {
    const merge =
      'merge into t using s on t.id = s.id when matched then update set x = s.x when not matched by source then delete'
    expect(analyzeDestructive(merge, 'sqlserver')).toEqual([])
  })

  it('judges the statement MariaDB ANALYZE runs, not the wrapper', () => {
    // MariaDB's ANALYZE really executes what it wraps, unlike plain EXPLAIN.
    expect(analyzeDestructive('analyze delete from users', 'mysql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('analyze format=json delete from users', 'mysql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('analyze update users set seen = 1', 'mysql')).toEqual(['updateAll'])
    expect(analyzeDestructive('explain delete from users', 'mysql')).toEqual([])
    // The statistics statements that merely share the keyword.
    expect(analyzeDestructive('analyze table users', 'mysql')).toEqual([])
    expect(analyzeDestructive('analyze users', 'postgresql')).toEqual([])
  })

  it('reads the SHOWPLAN switch only on the engine that has one', () => {
    // Elsewhere that SET spares nothing, so honouring it would disarm the preflight.
    expect(analyzeDestructive('set showplan_all on; delete from users', 'postgresql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('set showplan_all on; delete from users', 'mysql')).toEqual(['deleteAll'])
    expect(analyzeDestructive('set showplan_all on; delete from users', 'sqlite')).toEqual(['deleteAll'])
  })

  it('does not mistake an identifier or variable for a keyword', () => {
    expect(analyzeDestructive('select @delete from t', 'sqlserver')).toEqual([])
    expect(analyzeDestructive('select dropped from t')).toEqual([])
  })
})
