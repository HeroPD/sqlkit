import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionProfile } from '../../src/electron'
import { buildAddConstraint, buildAddForeignKey, buildAddPartition, buildCreateIndex, buildCreateTrigger } from '../../src/sql-write'
import type { Driver } from './driver'
import { MAX_BUFFERED_ROWS } from './driver'
import { createMysqlDriver } from './mysql'
import { endpointFor, profileFromUrl, testMysqlUrl } from './test-db'

const url = testMysqlUrl()
const describeDb = url ? describe : describe.skip

// Exercises the real MySQL driver against TEST_MYSQL_URL (root — see
// .env.example). Skips entirely when no test server is configured.
describeDb('mysql driver (integration)', () => {
  const dbUrl = url ?? ''
  const dbName = () => new URL(dbUrl).pathname.replace(/^\//, '')
  let admin: mysql.Connection

  beforeAll(async () => {
    admin = await mysql.createConnection({ uri: dbUrl, multipleStatements: true })
    // Throwaway fixtures in the test database; dropped wholesale afterwards.
    await admin.query('drop view if exists book_titles')
    await admin.query('drop table if exists books, authors')
    await admin.query('drop function if exists sqlkit_add_one')
    await admin.query('create table authors (id int auto_increment primary key, name varchar(120) not null, bio text)')
    await admin.query(
      `create table books (
         id int auto_increment primary key,
         author_id int not null,
         title varchar(200) not null,
         published bool default 0,
         constraint books_author_fk foreign key (author_id) references authors(id))`,
    )
    await admin.query('create index books_author_idx on books(author_id)')
    await admin.query('create view book_titles as select title from books')
    await admin.query('create function sqlkit_add_one(x int) returns int deterministic return x + 1')
    await admin.query("insert into authors (name, bio) values ('Ada', 'pioneer'), ('Alan', null)")
  })

  afterAll(async () => {
    await admin.query('drop view if exists book_titles').catch(() => {})
    await admin.query('drop table if exists books, authors').catch(() => {})
    await admin.query('drop function if exists sqlkit_add_one').catch(() => {})
    await admin.end().catch(() => {})
  })

  const connectDriver = async (overrides: Partial<ConnectionProfile> = {}): Promise<Driver> => {
    const profile = profileFromUrl(dbUrl, { engine: 'mysql', ...overrides })
    const driver = createMysqlDriver(profile, endpointFor(profile), { onError: () => {} })
    await driver.connect()
    return driver
  }

  it('flags a generated column in inspectTable', async () => {
    const driver = await connectDriver()
    try {
      await admin.query('drop table if exists gen_probe')
      await admin.query('create table gen_probe (a int, total int generated always as (a + 1) stored)')
      const inspection = await driver.inspectTable({ schema: null, name: 'gen_probe', kind: 'table' })
      const byName = new Map(inspection.columns.map((column) => [column.name, column]))
      expect(byName.get('total')?.generated).toBe(true)
      expect(byName.get('a')?.generated).toBe(false)
    } finally {
      await admin.query('drop table if exists gen_probe').catch(() => {})
      await driver.disconnect()
    }
  })

  it('streams a full result to a CSV file via exportQuery', async () => {
    const driver = await connectDriver()
    const file = join(mkdtempSync(join(tmpdir(), 'sqlkit-mysql-export-')), 'authors.csv')
    try {
      const result = await driver.exportQuery!({
        sql: 'select name from authors order by id',
        params: [],
        childDb: null,
        sort: null,
        filePath: file,
        format: 'csv',
      })
      expect(result.rowCount).toBe(2)
      expect(readFileSync(file, 'utf8')).toBe('name\nAda\nAlan\n')
    } finally {
      await driver.disconnect()
    }
  })

  // MySQL is the engine where a backslash escapes inside a string literal, so the
  // exported statements are loaded back into the server to prove the doubling in
  // result-sql holds against the real parser.
  it('exports INSERT statements that round-trip through the server', async () => {
    const driver = await connectDriver()
    const file = join(mkdtempSync(join(tmpdir(), 'sqlkit-mysql-export-')), 'rows.sql')
    try {
      await admin.query('drop table if exists trip_src, trip_dst')
      await admin.query(`create table trip_src (
        id bigint, note text, amount decimal(20,4), flag boolean, blob_col blob, doc json, missing text)`)
      await admin.query(`insert into trip_src values
        (9007199254740993, 'O''Brien said "hi"', 0.1000, 1, x'dead00beef', '{"a":[1,2]}', null),
        (-1, 'back\\\\slash and \\nnewline and trailing\\\\', -12345678901234.5678, 0, x'', '[]', 'x')`)
      await admin.query('create table trip_dst like trip_src')

      const result = await driver.exportQuery!({
        sql: 'select * from trip_src order by id',
        params: [],
        childDb: null,
        sort: null,
        filePath: file,
        format: 'sql',
        sqlTarget: { engine: 'mysql', table: { schema: null, name: 'trip_dst', kind: 'table' } },
      })
      expect(result.rowCount).toBe(2)
      // Each statement runs on its own: this connection is not multipleStatements.
      for (const statement of readFileSync(file, 'utf8').split(';\n').filter((part) => part.trim())) {
        await admin.query(statement)
      }
      const [rows] = await admin.query(`select
        (select count(*) from trip_src) = (select count(*) from trip_dst)
        and not exists (
          select 1 from trip_src s join trip_dst d using (id)
          where not (s.note <=> d.note and s.amount <=> d.amount and s.flag <=> d.flag
            and s.blob_col <=> d.blob_col and cast(s.doc as char) <=> cast(d.doc as char) and s.missing <=> d.missing)
        ) as same`)
      expect((rows as Array<{ same: unknown }>)[0]?.same).toBeTruthy()
    } finally {
      await admin.query('drop table if exists trip_src, trip_dst').catch(() => {})
      await driver.disconnect()
    }
  })

  it('connects and reports the server version', async () => {
    const profile = profileFromUrl(dbUrl, { engine: 'mysql' })
    const driver = createMysqlDriver(profile, endpointFor(profile), { onError: () => {} })
    try {
      expect(await driver.connect()).toMatch(/^(MySQL|MariaDB) \d+/)
    } finally {
      await driver.disconnect()
    }
  })

  it('refuses a single-database connection with no database instead of connecting blind', async () => {
    // MySQL has no universal default schema (no `postgres`, no `master`), so this
    // used to connect schema-less: database() was NULL, every metadata read came
    // back empty, and the UI reported "connected" over an empty explorer with no
    // error. Adopting some schema automatically would be worse — it would aim the
    // user's next DROP at a database they never picked.
    await expect(connectDriver({ database: '', databaseMode: 'single' })).rejects.toThrow(/needs a database/i)
  })

  it('browses every schema when all-databases mode has no database set', async () => {
    // The same blank field is legitimate in all-databases mode: the child list is
    // discovered, so there is a real schema to resolve database() against.
    const driver = await connectDriver({ database: '', databaseMode: 'all' })
    try {
      const children = driver.children?.() ?? []
      expect(children.length).toBeGreaterThan(0)
      expect(children.map((child) => child.name)).not.toContain('')
      const inUse = children.find((child) => child.inUse)!
      expect((await driver.query('select database()')).rows[0]?.[0]).toBe(inUse.name)
    } finally {
      await driver.disconnect()
    }
  })

  it('returns columns, rows, rowCount and a duration for a select', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select 1 as a, 2 as b')
      expect(result.columns).toEqual(['a', 'b'])
      expect(result.rows).toEqual([[1, 2]])
      expect(result.rowCount).toBe(1)
      expect(result.truncated).toBe(false)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      await driver.disconnect()
    }
  })

  it('binds ? parameters', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select ? as x, ? as y', [7, 'hi'])
      expect(result.columns).toEqual(['x', 'y'])
      expect(result.rows).toEqual([[7, 'hi']])
    } finally {
      await driver.disconnect()
    }
  })

  it('reports affected rows for writes', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table batch_w (id int primary key, v text)')
      const result = await driver.query('insert into batch_w (id, v) values (1, ?), (2, ?)', ['a', 'b'])
      expect(result.rowCount).toBe(2)
      expect(result.columns).toEqual([])
    } finally {
      await driver.query('drop table if exists batch_w').catch(() => {})
      await driver.disconnect()
    }
  })

  it('runs a write batch atomically: commits all, or rolls back all on failure', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table batch (id int primary key, v text)')
      const ok = await driver.runBatch!([
        { sql: 'insert into batch (id, v) values (?, ?)', params: [1, 'a'] },
        { sql: 'insert into batch (id, v) values (?, ?)', params: [2, 'b'] },
      ])
      expect(ok).toEqual({ success: true })
      expect((await driver.query('select count(*) from batch')).rows).toEqual([[2]])

      // Second insert violates the primary key → the first must roll back too.
      const bad = await driver.runBatch!([
        { sql: 'insert into batch (id, v) values (?, ?)', params: [3, 'c'] },
        { sql: 'insert into batch (id, v) values (?, ?)', params: [1, 'dup'] },
      ])
      expect(bad.success).toBe(false)
      if (!bad.success) expect(bad.failedIndex).toBe(1)
      expect((await driver.query('select count(*) from batch')).rows).toEqual([[2]])
    } finally {
      await driver.query('drop table if exists batch').catch(() => {})
      await driver.disconnect()
    }
  })

  it('refuses an atomic save on a non-transactional (MyISAM) table', async () => {
    const driver = await connectDriver()
    await admin.query('drop table if exists myisam_probe')
    await admin.query("create table myisam_probe (id int primary key, v varchar(20)) engine = MyISAM")
    await admin.query("insert into myisam_probe values (1, 'original')")
    try {
      const result = await driver.runBatch!([
        { sql: 'update `myisam_probe` set v = ? where id = ?', params: ['changed', 1] },
      ])
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error).toMatch(/non-transactional/)
      const [rows] = await admin.query('select v from myisam_probe where id = 1')
      expect(rows).toEqual([{ v: 'original' }])
    } finally {
      await admin.query('drop table if exists myisam_probe').catch(() => {})
      await driver.disconnect()
    }
  })

  it('refuses an atomic save on a schema-qualified non-transactional table', async () => {
    const driver = await connectDriver()
    await admin.query('drop table if exists myisam_probe')
    await admin.query("create table myisam_probe (id int primary key, v varchar(20)) engine = MyISAM")
    await admin.query("insert into myisam_probe values (1, 'original')")
    try {
      // MyISAM can't roll back, so the refusal must come before anything runs —
      // a qualified name must not slip past the storage-engine check.
      const result = await driver.runBatch!([
        { sql: `update \`${dbName()}\`.\`myisam_probe\` set v = ? where id = ?`, params: ['changed', 1] },
        // Matches nothing: trips the zero-rows gate, which "rolls back" the batch.
        { sql: `update \`${dbName()}\`.\`myisam_probe\` set v = ? where id = ?`, params: ['x', 999] },
      ])
      expect(result.success).toBe(false)
      const [rows] = await admin.query('select v from myisam_probe where id = 1')
      expect(rows).toEqual([{ v: 'original' }])
    } finally {
      await admin.query('drop table if exists myisam_probe').catch(() => {})
      await driver.disconnect()
    }
  }, 20000)

  it('does not trip the zero-rows gate on a no-op update (FOUND_ROWS)', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table noop (id int primary key, v text)')
      await driver.query("insert into noop values (1, 'same')")
      // Updating to the value a row already has must count as matched, not 0.
      const result = await driver.runBatch!([{ sql: 'update noop set v = ? where id = ?', params: ['same', 1] }])
      expect(result).toEqual({ success: true })
    } finally {
      await driver.query('drop table if exists noop').catch(() => {})
      await driver.disconnect()
    }
  })

  it('surfaces SQL errors', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.query('select * from sqlkit_no_such_table')).rejects.toThrow(/doesn't exist/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('displays the last result set of a multi-statement run', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('set @x = 1; select 1 as a; select 2 as b')
      expect(result.columns).toEqual(['b'])
      expect(result.rows).toEqual([[2]])
      expect(result.resultSets?.slice(-2).map((set) => ({ columns: set.columns, rows: set.rows }))).toEqual([
        { columns: ['a'], rows: [[1]] },
        { columns: ['b'], rows: [[2]] },
      ])
    } finally {
      await driver.disconnect()
    }
  })

  it('drains a capped read without cancelling statement semantics', async () => {
    const driver = await connectDriver()
    try {
      const count = MAX_BUFFERED_ROWS + 25
      // A cross join over information_schema generates rows without recursive
      // CTEs, whose depth cap is spelled differently on MySQL vs MariaDB.
      const result = await driver.query(
        `select a.table_name from information_schema.columns a cross join information_schema.columns b limit ${count}`,
      )
      expect(result.rows).toHaveLength(MAX_BUFFERED_ROWS)
      expect(result.rowCount).toBe(count)
      expect(result.truncated).toBe(true)
      expect(result.rowCountExact).toBe(true)
    } finally {
      await driver.disconnect()
    }
  }, 30000)

  it('does not leak user variables between pooled query runs', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('set @sqlkit_leaked_state = 7')
      expect((await driver.query('select @sqlkit_leaked_state')).rows).toEqual([[null]])
    } finally {
      await driver.disconnect()
    }
  })

  it('executes mysql-client DELIMITER routine scripts', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('drop procedure if exists sqlkit_delimiter_test')
      await driver.query(`DELIMITER $$
CREATE PROCEDURE sqlkit_delimiter_test()
BEGIN
  SELECT 'inside;body' AS value;
END$$
DELIMITER ;`)
      const called = await driver.query('call sqlkit_delimiter_test()')
      expect(called.resultSets?.find((set) => set.columns[0] === 'value')?.rows ?? called.rows).toEqual([['inside;body']])
    } finally {
      await driver.query('drop procedure if exists sqlkit_delimiter_test').catch(() => {})
      await driver.disconnect()
    }
  })

  it('reports the schema/table/column source of each result column', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select id, name, 1 as lit from authors order by id limit 1')
      // Active-db sources carry schema null so they match listTables' TableRefs.
      expect(result.columnSources?.[0]).toEqual({ schema: null, table: 'authors', column: 'id' })
      expect(result.columnSources?.[1]).toEqual({ schema: null, table: 'authors', column: 'name' })
      expect(result.columnSources?.[2]).toEqual({ schema: null, table: null, column: null })
    } finally {
      await driver.disconnect()
    }
  })

  it('keeps the database name on column sources from another database', async () => {
    const other = 'sqlkit_xdb_probe'
    const driver = await connectDriver()
    try {
      await admin.query(`drop database if exists ${other}`)
      await admin.query(`create database ${other}`)
      await admin.query(`create table ${other}.things (id int primary key)`)
      await admin.query(`insert into ${other}.things values (1)`)
      const result = await driver.query(`select id from ${other}.things`)
      expect(result.columnSources?.[0]).toEqual({ schema: other, table: 'things', column: 'id' })
    } finally {
      await admin.query(`drop database if exists ${other}`).catch(() => {})
      await driver.disconnect()
    }
  })

  it('cancels an in-flight query from an out-of-band connection', async () => {
    const driver = await connectDriver()
    try {
      // A killed SLEEP() returns 1 rather than erroring, so assert on the
      // cancel outcome and that the statement ends promptly either way.
      const running = driver.query('select sleep(30) as s', [], null, null, null, 'slow-query').catch(() => null)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await driver.cancel?.('other-query')).toEqual({ running: 0, cancelled: 0 })
      const outcome = await driver.cancel?.('slow-query')
      expect(outcome?.running).toBeGreaterThanOrEqual(1)
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      const started = performance.now()
      await running
      expect(performance.now() - started).toBeLessThan(5000)
      expect((await driver.query('select 1')).rows).toEqual([[1]])
    } finally {
      await driver.disconnect()
    }
  }, 20000)

  it('cancels an in-flight streaming export', async () => {
    const driver = await connectDriver()
    const file = join(mkdtempSync(join(tmpdir(), 'sqlkit-mysql-export-')), 'slow.csv')
    try {
      // A killed SLEEP() returns 1 rather than erroring, so assert on the
      // cancel outcome and that the export ends promptly either way.
      const running = driver.exportQuery!({
        sql: 'select sleep(30) as s',
        params: [],
        childDb: null,
        sort: null,
        filePath: file,
        format: 'csv',
        executionId: 'slow-export',
      }).catch(() => null)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const outcome = await driver.cancel?.('slow-export')
      expect(outcome?.running).toBeGreaterThanOrEqual(1)
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      const started = performance.now()
      await running
      expect(performance.now() - started).toBeLessThan(5000)
      expect((await driver.query('select 1')).rows).toEqual([[1]])
    } finally {
      await driver.disconnect()
    }
  }, 20000)

  it('reports nothing running when cancel finds no in-flight query', async () => {
    const driver = await connectDriver()
    try {
      expect(await driver.cancel?.()).toEqual({ running: 0, cancelled: 0 })
    } finally {
      await driver.disconnect()
    }
  })

  it('lists tables and views flat (no schema level)', async () => {
    const driver = await connectDriver()
    try {
      const tables = await driver.listTables()
      expect(tables).toEqual(
        expect.arrayContaining([
          { schema: null, name: 'authors', kind: 'table' },
          { schema: null, name: 'books', kind: 'table' },
          { schema: null, name: 'book_titles', kind: 'view' },
        ]),
      )
    } finally {
      await driver.disconnect()
    }
  })

  it('reports column type, nullability and key flags', async () => {
    const driver = await connectDriver()
    try {
      const columns = await driver.listColumns()
      const find = (table: string, name: string) => columns.find((column) => column.table === table && column.name === name)
      expect(find('authors', 'id')).toMatchObject({ primaryKey: true, nullable: false })
      expect(find('authors', 'bio')).toMatchObject({ nullable: true, primaryKey: false, foreignKey: false })
      expect(find('books', 'author_id')).toMatchObject({ foreignKey: true, nullable: false })
    } finally {
      await driver.disconnect()
    }
  })

  it('resolves the foreign-key target so a result cell can be followed', async () => {
    const driver = await connectDriver()
    try {
      const columns = await driver.listColumns()
      const find = (table: string, name: string) => columns.find((column) => column.table === table && column.name === name)
      // schema stays null for a target in the active database, matching the flat
      // TableRefs listTables returns; a cross-database FK would keep its schema.
      expect(find('books', 'author_id')?.references).toEqual({
        schema: null,
        table: 'authors',
        column: 'id',
        constraint: expect.any(String),
      })
      expect(find('books', 'title')?.references).toBeUndefined()
    } finally {
      await driver.disconnect()
    }
  })

  it('pairs a composite foreign key and groups it under one constraint', async () => {
    await admin.query('drop table if exists fk_child')
    await admin.query('drop table if exists fk_parent')
    await admin.query('create table fk_parent (a int, b int, primary key (a, b)) engine=InnoDB')
    await admin.query(
      `create table fk_child (id int auto_increment primary key, pa int, pb int,
         constraint fk_child_comp foreign key (pa, pb) references fk_parent(a, b)) engine=InnoDB`,
    )
    const driver = await connectDriver()
    try {
      const columns = await driver.listColumns()
      const find = (name: string) => columns.find((column) => column.table === 'fk_child' && column.name === name)
      expect(find('pa')?.references).toMatchObject({ table: 'fk_parent', column: 'a', constraint: 'fk_child_comp' })
      expect(find('pb')?.references).toMatchObject({ table: 'fk_parent', column: 'b', constraint: 'fk_child_comp' })
      expect(find('pa')?.references?.constraint).toBe(find('pb')?.references?.constraint)
    } finally {
      await driver.disconnect()
      await admin.query('drop table if exists fk_child')
      await admin.query('drop table if exists fk_parent')
    }
  })

  it('lists routines with their parameters via listObjects', async () => {
    const driver = await connectDriver()
    try {
      const objects = await driver.listObjects?.()
      expect(objects?.functions).toEqual(expect.arrayContaining([{ schema: null, name: 'sqlkit_add_one', detail: 'x int' }]))
      expect(objects?.types).toEqual([])
    } finally {
      await driver.disconnect()
    }
  })

  it('inspects a table: columns, foreign keys and indexes', async () => {
    const driver = await connectDriver()
    try {
      const inspection = await driver.inspectTable({ schema: null, name: 'books', kind: 'table' })
      expect(inspection.columns.map((column) => column.name)).toEqual(['id', 'author_id', 'title', 'published'])
      expect(inspection.columns[0]).toMatchObject({ primaryKey: true, default: 'auto_increment', identity: 'default' })
      expect(inspection.columns.find((column) => column.name === 'author_id')).toMatchObject({ foreignKey: true })
      const foreignKeys = inspection.sections.find((section) => section.title === 'Foreign Keys')
      expect(foreignKeys?.rows[0]?.definition).toMatch(/REFERENCES authors/i)
      const indexes = inspection.sections.find((section) => section.title === 'Indexes')
      expect(indexes?.rows.some((row) => row.name === 'books_author_idx')).toBe(true)
      expect(indexes?.rows.some((row) => row.name === 'PRIMARY')).toBe(false)
      const constraints = inspection.sections.find((section) => section.title === 'Constraints')
      expect(constraints?.rows.some((row) => /^PRIMARY KEY \(id\)/i.test(row.definition))).toBe(true)
    } finally {
      await driver.disconnect()
    }
  })

  it('creates and drops a database', async () => {
    const driver = await connectDriver()
    const name = 'sqlkit_it_created'
    try {
      await admin.query(`drop database if exists ${name}`)
      await driver.createDatabase?.(name)
      const [made] = await admin.query('select 1 from information_schema.schemata where schema_name = ?', [name])
      expect((made as unknown[]).length).toBe(1)
      await driver.dropDatabase?.(name)
      const [gone] = await admin.query('select 1 from information_schema.schemata where schema_name = ?', [name])
      expect((gone as unknown[]).length).toBe(0)
    } finally {
      await admin.query(`drop database if exists ${name}`).catch(() => {})
      await driver.disconnect()
    }
  })

  it('executes generated schema-object DDL and exposes it through inspection', async () => {
    const driver = await connectDriver()
    const source = { schema: null, name: 'ddl_source', kind: 'table' as const }
    try {
      await driver.query('drop table if exists ddl_source, ddl_target, ddl_partitioned')
      await driver.query('create table ddl_target (id int primary key) engine=InnoDB')
      await driver.query('create table ddl_source (id int, target_id int) engine=InnoDB')
      const result = await driver.runDdl!([
        buildCreateIndex(source, { name: 'ddl_source_idx', columns: ['target_id'], unique: false }, 'mysql'),
        buildAddConstraint(source, { name: 'ddl_source_check', type: 'CHECK', expression: 'id >= 0' }, 'mysql'),
        buildAddForeignKey(source, {
          name: 'ddl_source_fk', columns: ['target_id'], refTable: 'ddl_target', refColumns: ['id'],
        }, 'mysql'),
        buildCreateTrigger(source, {
          name: 'ddl_source_trigger', timing: 'BEFORE', events: ['INSERT'], level: 'ROW', body: 'SET NEW.id = COALESCE(NEW.id, 0)',
        }, 'mysql'),
      ])
      expect(result).toEqual({ success: true })
      const inspection = await driver.inspectTable(source)
      expect(inspection.sections.find((section) => section.title === 'Indexes')?.rows.some((row) => row.name === 'ddl_source_idx')).toBe(true)
      expect(inspection.sections.find((section) => section.title === 'Foreign Keys')?.rows.some((row) => row.name === 'ddl_source_fk')).toBe(true)
      expect(inspection.sections.find((section) => section.title === 'Triggers')?.rows.some((row) => row.name === 'ddl_source_trigger')).toBe(true)

      await driver.query('create table ddl_partitioned (id int) partition by range (id) (partition p0 values less than (10))')
      expect(await driver.runDdl!([
        buildAddPartition({ schema: null, name: 'ddl_partitioned', kind: 'table' }, { name: 'p1', bounds: 'VALUES LESS THAN (20)' }, 'mysql'),
      ])).toEqual({ success: true })
    } finally {
      await driver.query('drop table if exists ddl_source, ddl_target, ddl_partitioned').catch(() => {})
      await driver.disconnect()
    }
  })

  it('refuses to drop the database currently in use', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.dropDatabase?.(dbName())).rejects.toThrow(/currently in use/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('lists and switches child databases in all-databases mode, hiding system schemas', async () => {
    const driver = await connectDriver({ databaseMode: 'all' })
    try {
      const children = driver.children?.() ?? []
      expect(children.length).toBeGreaterThan(0)
      expect(children.map((child) => child.name)).not.toEqual(
        expect.arrayContaining(['mysql', 'information_schema', 'performance_schema', 'sys']),
      )
      expect(children.find((child) => child.name === dbName())?.inUse).toBe(true)
      const other = children.find((child) => child.name !== dbName())
      if (other) {
        expect(driver.useChild?.(other.name)).toBe(true)
        expect(driver.children?.().find((child) => child.name === other.name)?.inUse).toBe(true)
      }
      expect(driver.useChild?.('sqlkit_no_such_database')).toBe(false)
    } finally {
      await driver.disconnect()
    }
  })

  // Verifies the serverActivity SQL against the real catalogs — the shapes it
  // reads (bigint-as-text elapsed, unlimited connection caps, non-client
  // threads) differ enough per engine to be worth pinning.
  it('reports connection usage, uptime and its own session', async () => {
    const driver = await connectDriver()
    // A second connection from the app, so there is a self session to find: the
    // reader excludes itself from the list it produces.
    const other = await connectDriver()
    try {
      const activity = await driver.serverActivity!()
      expect(activity.selfIdentificationAvailable).toBe(true)
      expect(activity.sessions.some((session) => session.self)).toBe(true)

      expect(activity.connections.used).toBeGreaterThan(0)
      expect(activity.connections.max === null || activity.connections.max > 0).toBe(true)
      expect(activity.stats.some((stat) => stat.label === 'Uptime' && stat.value !== '')).toBe(true)

      for (const session of activity.sessions) {
        expect(typeof session.id).toBe('string')
        expect(session.id).not.toBe('')
        // elapsedMs must be a real number, never a bigint string.
        expect(session.elapsedMs === null || Number.isFinite(session.elapsedMs)).toBe(true)
        expect(typeof session.self).toBe('boolean')
      }
    } finally {
      await other.disconnect()
      await driver.disconnect()
    }
  })

  it('rejects an unusable session id rather than building bad SQL', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.endSession!('7; drop table x', 'terminate')).rejects.toThrow()
    } finally {
      await driver.disconnect()
    }
  })

})
