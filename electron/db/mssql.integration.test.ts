import sql from 'mssql'
import { Request as TediousRequest } from 'tedious'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionProfile, InspectColumn } from '../../src/electron'
import { buildAddConstraint, buildAddForeignKey, buildColumnAlter, buildCreateIndex, buildCreateTrigger } from '../../src/sql-write'

const inspectColumnFixture = (name: string): InspectColumn =>
  ({ name, dataType: 'int', nullable: true, default: null, primaryKey: false, comment: null })
import type { Driver } from './driver'
import { MAX_BUFFERED_ROWS } from './driver'
import { acquireConnection, createMssqlDriver, resetConnection, type AcquirablePool } from './mssql'
import { endpointFor, profileFromUrl, testMssqlUrl } from './test-db'

type PooledConn = Awaited<ReturnType<typeof acquireConnection>>
const runBatch = (conn: PooledConn, text: string): Promise<void> =>
  new Promise((resolve, reject) => conn.execSqlBatch(new TediousRequest(text, (err) => (err ? reject(err) : resolve()))))
const scalar = (conn: PooledConn, text: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let value: unknown = null
    const request = new TediousRequest(text, (err) => (err ? reject(err) : resolve(value)))
    ;(request as unknown as { on(event: 'row', listener: (cols: Array<{ value: unknown }>) => void): void }).on(
      'row',
      (cols) => { value = cols[0]?.value ?? null },
    )
    conn.execSqlBatch(request)
  })

const url = testMssqlUrl()
const describeDb = url ? describe : describe.skip

const TEST_DB = 'sqlkit_it_mssql'

const configFromUrl = (u: string, database?: string): sql.config => {
  const parsed = new URL(u)
  return {
    server: parsed.hostname,
    port: Number(parsed.port) || 1433,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: database ?? (parsed.pathname.replace(/^\//, '') || 'master'),
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 30000,
  }
}

// Exercises the real SQL Server driver against TEST_MSSQL_URL (sa — see
// .env.example). Skips entirely when no test server is configured.
describeDb('mssql driver (integration)', () => {
  const dbUrl = url ?? ''
  let admin: sql.ConnectionPool
  let fixtures: sql.ConnectionPool

  beforeAll(async () => {
    admin = await new sql.ConnectionPool(configFromUrl(dbUrl)).connect()
    await admin.request().batch(`drop database if exists ${TEST_DB}`)
    await admin.request().batch(`create database ${TEST_DB}`)
    // Views/functions must be created from inside the database, so a second
    // pool connects there for the fixtures.
    fixtures = await new sql.ConnectionPool(configFromUrl(dbUrl, TEST_DB)).connect()
    await fixtures.request().batch('create table authors (id int identity primary key, name nvarchar(120) not null, bio nvarchar(max))')
    await fixtures.request().batch(
      `create table books (
         id int identity primary key,
         author_id int not null,
         title nvarchar(200) not null,
         published bit default 0,
         constraint books_author_fk foreign key (author_id) references authors(id))`,
    )
    await fixtures.request().batch('create index books_author_idx on books(author_id)')
    await fixtures.request().batch('create view book_titles as select title from books')
    await fixtures.request().batch('create function sqlkit_add_one(@x int) returns int as begin return @x + 1 end')
    await fixtures.request().batch('create type amount_alias from decimal(19,4)')
    await fixtures.request().batch('create table type_shapes (id int, fixed binary(8), approximate float(24), amount amount_alias, calculated as id + 1)')
    await fixtures.request().batch("insert into authors (name, bio) values ('Ada', 'pioneer'), ('Alan', null)")
  }, 30000)

  afterAll(async () => {
    await fixtures?.close().catch(() => {})
    await admin.request().batch(`drop database if exists ${TEST_DB}`).catch(() => {})
    await admin.close().catch(() => {})
  })

  const connectDriver = async (overrides: Partial<ConnectionProfile> = {}): Promise<Driver> => {
    const profile = profileFromUrl(dbUrl, { engine: 'sqlserver', database: TEST_DB, ...overrides })
    const driver = createMssqlDriver(profile, endpointFor(profile), { onError: () => {} })
    await driver.connect()
    return driver
  }

  it('swaps two column names in one alter batch (sp_rename, temp-name cycle break)', async () => {
    const driver = await connectDriver()
    try {
      await fixtures.request().batch('drop table if exists swap_probe')
      await fixtures.request().batch('create table swap_probe (a int, b int)')
      await fixtures.request().batch('insert into swap_probe values (1, 2)')
      const statements = buildColumnAlter({ schema: 'dbo', name: 'swap_probe', kind: 'table' }, [
        { original: inspectColumnFixture('a'), name: 'b' },
        { original: inspectColumnFixture('b'), name: 'a' },
      ], 'sqlserver')
      const outcome = await driver.runDdl!(statements)
      expect(outcome.success).toBe(true)
      expect((await driver.query('select a, b from swap_probe')).rows).toEqual([[2, 1]])
    } finally {
      await fixtures.request().batch('drop table if exists swap_probe').catch(() => {})
      await driver.disconnect()
    }
  })

  it('streams a full result to a CSV file via exportQuery', async () => {
    const driver = await connectDriver()
    const file = join(mkdtempSync(join(tmpdir(), 'sqlkit-mssql-export-')), 'authors.csv')
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

  it('connects and reports the server version', async () => {
    const driver = await connectDriver()
    try {
      // connect() already returned; re-derive it for the assertion.
      await driver.disconnect()
      const profile = profileFromUrl(dbUrl, { engine: 'sqlserver', database: TEST_DB })
      const fresh = createMssqlDriver(profile, endpointFor(profile), { onError: () => {} })
      expect(await fresh.connect()).toMatch(/^Microsoft SQL Server \d{4}/)
      await fresh.disconnect()
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

  it('binds @pN parameters', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select @p1 as x, @p2 as y', [7, 'hi'])
      expect(result.columns).toEqual(['x', 'y'])
      expect(result.rows).toEqual([[7, 'hi']])
    } finally {
      await driver.disconnect()
    }
  })

  it('reports affected rows for writes', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table batch_w (id int primary key, v nvarchar(50))')
      const result = await driver.query("insert into batch_w (id, v) values (1, 'a'), (2, 'b')")
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
      await driver.query('create table batch (id int primary key, v nvarchar(50))')
      const ok = await driver.runBatch!([
        { sql: 'insert into batch (id, v) values (@p1, @p2)', params: [1, 'a'] },
        { sql: 'insert into batch (id, v) values (@p1, @p2)', params: [2, 'b'] },
      ])
      expect(ok).toEqual({ success: true })
      expect((await driver.query('select count(*) from batch')).rows).toEqual([[2]])

      const bad = await driver.runBatch!([
        { sql: 'insert into batch (id, v) values (@p1, @p2)', params: [3, 'c'] },
        { sql: 'insert into batch (id, v) values (@p1, @p2)', params: [1, 'dup'] },
      ])
      expect(bad.success).toBe(false)
      if (!bad.success) expect(bad.failedIndex).toBe(1)
      expect((await driver.query('select count(*) from batch')).rows).toEqual([[2]])
    } finally {
      await driver.query('drop table if exists batch').catch(() => {})
      await driver.disconnect()
    }
  })

  it('does not trip the zero-rows gate on a no-op update', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table noop (id int primary key, v nvarchar(50))')
      await driver.query("insert into noop values (1, 'same')")
      const result = await driver.runBatch!([{ sql: 'update noop set v = @p1 where id = @p2', params: ['same', 1] }])
      expect(result).toEqual({ success: true })
    } finally {
      await driver.query('drop table if exists noop').catch(() => {})
      await driver.disconnect()
    }
  })

  it('surfaces SQL errors', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.query('select * from sqlkit_no_such_table')).rejects.toThrow(/invalid object name/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('rejects a transaction left open after rollback to a savepoint', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.query(
        'BEGIN TRAN; SAVE TRAN sqlkit_save; SELECT 1; ROLLBACK TRAN sqlkit_save;',
      )).rejects.toThrow(/same query run/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('supports GO batches and exposes every result set', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select 1 as a\nGO\nselect 2 as b')
      expect(result.columns).toEqual(['b'])
      expect(result.rows).toEqual([[2]])
      expect(result.resultSets?.map((set) => ({ columns: set.columns, rows: set.rows }))).toEqual([
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
      const result = await driver.query(
        `select top (${count}) row_number() over (order by (select null)) as n
         from sys.all_objects a cross join sys.all_objects b`,
      )
      expect(result.rows).toHaveLength(MAX_BUFFERED_ROWS)
      expect(result.rowCount).toBe(count)
      expect(result.truncated).toBe(true)
      expect(result.rowCountExact).toBe(true)
    } finally {
      await driver.disconnect()
    }
  }, 30000)

  it('resets pooled TDS session state after each query', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table #sqlkit_leaked_state (id int)')
      expect((await driver.query("select object_id('tempdb..#sqlkit_leaked_state')")).rows).toEqual([[null]])
    } finally {
      await driver.disconnect()
    }
  })

  it('reset() scrubs session state on the very same reused connection', async () => {
    // Deterministic proof (no same-vs-different-connection ambiguity): create a
    // temp table on one connection, reset it, and see the table gone — that is
    // the isolation the query() reset path relies on to reuse pooled connections.
    const pool = await new sql.ConnectionPool(configFromUrl(dbUrl, TEST_DB)).connect()
    try {
      const acquirable = pool as unknown as AcquirablePool
      const conn = await acquireConnection(acquirable)
      await runBatch(conn, 'create table #reset_probe (x int)')
      expect(await scalar(conn, "select object_id('tempdb..#reset_probe')")).not.toBeNull()
      await resetConnection(conn)
      expect(await scalar(conn, "select object_id('tempdb..#reset_probe')")).toBeNull()
      acquirable.release(conn)
    } finally {
      await pool.close()
    }
  })

  it('does not leak a USE from user SQL into metadata reads on the shared pool', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('use master')
      const tables = await driver.listTables()
      expect(tables).toEqual(expect.arrayContaining([{ schema: 'dbo', name: 'authors', kind: 'table' }]))
    } finally {
      await driver.disconnect()
    }
  })

  it('rolls back a transaction left open by a failed script before the connection is pooled', async () => {
    const driver = await connectDriver()
    await fixtures.request().batch("drop table if exists lock_probe")
    await fixtures.request().batch("create table lock_probe (id int primary key, v nvarchar(10))")
    await fixtures.request().batch("insert into lock_probe values (1, 'a')")
    try {
      // Textually balanced so the guard admits it; THROW aborts the batch after
      // the UPDATE took its lock, so COMMIT never runs.
      await expect(
        driver.query("begin tran update lock_probe set v = 'dirty' where id = 1; throw 50000, 'boom', 1; commit"),
      ).rejects.toThrow('boom')
      // A second session must not find the row still locked by an abandoned txn.
      const probe = await new sql.ConnectionPool(configFromUrl(dbUrl, TEST_DB)).connect()
      try {
        await probe.request().batch("set lock_timeout 2000 update lock_probe set v = 'probe' where id = 1")
      } finally {
        await probe.close()
      }
      expect((await driver.query('select v from lock_probe')).rows).toEqual([['probe']])
    } finally {
      // Disconnect first: it rolls back any leaked transaction, so the drop
      // below can't hang on its locks if this test ever regresses.
      await driver.disconnect()
      await fixtures.request().batch('drop table if exists lock_probe').catch(() => {})
    }
  }, 20000)

  it('returns safe decimal and datetime2 values as exact text', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query("select cast(12.34 as decimal(8,2)), cast('2026-07-10T03:04:05.1234567' as datetime2(7))")
      expect(result.rows).toEqual([['12.34', '2026-07-10 03:04:05.1234567']])
    } finally {
      await driver.disconnect()
    }
  })

  it('returns high-precision decimal, money, and datetimeoffset values as exact text', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query(
        "select cast(123456789012345678.90 as decimal(38,2)), cast(12.34 as money), cast('2026-07-10T12:34:56.1234567+08:00' as datetimeoffset(7))",
      )
      expect(result.rows).toEqual([['123456789012345678.90', '12.3400', '2026-07-10 12:34:56.1234567 +08:00']])
    } finally {
      await driver.disconnect()
    }
  })

  it('cancels an in-flight query in-band', async () => {
    const driver = await connectDriver()
    try {
      const running = driver.query("waitfor delay '00:00:30'", [], null, null, 'slow-query')
      const cancelled = expect(running).rejects.toThrow('Query cancelled.')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await driver.cancel?.('other-query')).toEqual({ running: 0, cancelled: 0 })
      const outcome = await driver.cancel?.('slow-query')
      expect(outcome?.running).toBeGreaterThanOrEqual(1)
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      await cancelled
      expect((await driver.query('select 1')).rows).toEqual([[1]])
    } finally {
      await driver.disconnect()
    }
  }, 20000)

  it('cancels an in-flight streaming export', async () => {
    const driver = await connectDriver()
    const file = join(mkdtempSync(join(tmpdir(), 'sqlkit-mssql-export-')), 'slow.csv')
    try {
      const running = driver.exportQuery!({
        sql: "waitfor delay '00:00:30' select 1 as n",
        params: [],
        childDb: null,
        sort: null,
        filePath: file,
        format: 'csv',
        executionId: 'slow-export',
      })
      const cancelled = expect(running).rejects.toThrow('Query cancelled.')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const outcome = await driver.cancel?.('slow-export')
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      await cancelled
      expect((await driver.query('select 1')).rows).toEqual([[1]])
    } finally {
      await driver.disconnect()
    }
  }, 20000)

  it('cancels an in-flight transactional DDL batch', async () => {
    const driver = await connectDriver()
    try {
      const running = driver.runDdl!(["waitfor delay '00:00:30'", 'create table should_not_exist (id int)'])
      await new Promise((resolve) => setTimeout(resolve, 400))
      const outcome = await driver.cancel?.()
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      await expect(running).resolves.toMatchObject({ success: false, error: 'Save cancelled.' })
      expect((await driver.query("select object_id('dbo.should_not_exist')")).rows).toEqual([[null]])
    } finally {
      await driver.query('drop table if exists should_not_exist').catch(() => {})
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

  it('lists tables and views with their schema', async () => {
    const driver = await connectDriver()
    try {
      const tables = await driver.listTables()
      expect(tables).toEqual(
        expect.arrayContaining([
          { schema: 'dbo', name: 'authors', kind: 'table' },
          { schema: 'dbo', name: 'books', kind: 'table' },
          { schema: 'dbo', name: 'book_titles', kind: 'view' },
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
      const find = (table: string, name: string) =>
        columns.find((column) => column.schema === 'dbo' && column.table === table && column.name === name)
      expect(find('authors', 'id')).toMatchObject({ primaryKey: true, nullable: false })
      expect(find('authors', 'name')).toMatchObject({ dataType: 'nvarchar(120)' })
      expect(find('authors', 'bio')).toMatchObject({ nullable: true, primaryKey: false, foreignKey: false, dataType: 'nvarchar(max)' })
      expect(find('books', 'author_id')).toMatchObject({ foreignKey: true, nullable: false })
    } finally {
      await driver.disconnect()
    }
  })

  it('lists routines with their parameters via listObjects', async () => {
    const driver = await connectDriver()
    try {
      const objects = await driver.listObjects?.()
      expect(objects?.functions).toEqual(
        expect.arrayContaining([{ schema: 'dbo', name: 'sqlkit_add_one', detail: '@x int' }]),
      )
      expect(objects?.types).toEqual([])
    } finally {
      await driver.disconnect()
    }
  })

  it('inspects a table: columns, foreign keys and indexes', async () => {
    const driver = await connectDriver()
    try {
      const inspection = await driver.inspectTable({ schema: 'dbo', name: 'books', kind: 'table' })
      expect(inspection.columns.map((column) => column.name)).toEqual(['id', 'author_id', 'title', 'published'])
      expect(inspection.columns[0]).toMatchObject({ primaryKey: true, default: 'identity', identity: 'always' })
      expect(inspection.columns.find((column) => column.name === 'author_id')).toMatchObject({ foreignKey: true })
      const foreignKeys = inspection.sections.find((section) => section.title === 'Foreign Keys')
      expect(foreignKeys?.rows[0]?.definition).toMatch(/REFERENCES dbo\.authors/i)
      const indexes = inspection.sections.find((section) => section.title === 'Indexes')
      expect(indexes?.rows.some((row) => row.name === 'books_author_idx')).toBe(true)
      expect(indexes?.rows.every((row) => !/^PK_/.test(row.name))).toBe(true)
      const constraints = inspection.sections.find((section) => section.title === 'Constraints')
      expect(constraints?.rows.some((row) => /^PRIMARY KEY \(id\)/i.test(row.definition))).toBe(true)
    } finally {
      await driver.disconnect()
    }
  })

  it('reconstructs SQL Server column definitions without losing modifiers', async () => {
    const driver = await connectDriver()
    try {
      const inspection = await driver.inspectTable({ schema: 'dbo', name: 'type_shapes', kind: 'table' })
      const byName = new Map(inspection.columns.map((column) => [column.name, column]))
      expect(byName.get('fixed')?.dataType).toBe('binary(8)')
      // SQL Server canonicalizes float(1..24) to its exact `real` synonym.
      expect(byName.get('approximate')?.dataType).toBe('real')
      expect(byName.get('amount')?.dataType).toBe('[dbo].[amount_alias]')
      expect(byName.get('calculated')?.generated).toBe(true)
    } finally {
      await driver.disconnect()
    }
  })

  it('creates and drops a database', async () => {
    const driver = await connectDriver()
    const name = 'sqlkit_it_created'
    try {
      await admin.request().batch(`drop database if exists ${name}`)
      await driver.createDatabase?.(name)
      const made = await admin.request().query(`select 1 as x from sys.databases where name = '${name}'`)
      expect(made.recordset).toHaveLength(1)
      await driver.dropDatabase?.(name)
      const gone = await admin.request().query(`select 1 as x from sys.databases where name = '${name}'`)
      expect(gone.recordset).toHaveLength(0)
    } finally {
      await admin.request().batch(`drop database if exists ${name}`).catch(() => {})
      await driver.disconnect()
    }
  })

  it('executes generated schema-object DDL and exposes it through inspection', async () => {
    const driver = await connectDriver()
    const source = { schema: 'dbo', name: 'ddl_source', kind: 'table' as const }
    try {
      await driver.query('create table ddl_target (id int primary key)')
      await driver.query('create table ddl_source (id int, target_id int)')
      const result = await driver.runDdl!([
        buildCreateIndex(source, { name: 'ddl_source_idx', columns: ['target_id'], unique: false }, 'sqlserver'),
        buildAddConstraint(source, { name: 'ddl_source_check', type: 'CHECK', expression: 'id >= 0' }, 'sqlserver'),
        buildAddForeignKey(source, {
          name: 'ddl_source_fk', columns: ['target_id'], refTable: 'dbo.ddl_target', refColumns: ['id'],
        }, 'sqlserver'),
        buildCreateTrigger(source, {
          name: 'ddl_source_trigger', timing: 'AFTER', events: ['INSERT'], level: 'STATEMENT', body: 'SELECT 1',
        }, 'sqlserver'),
      ])
      expect(result).toEqual({ success: true })
      const inspection = await driver.inspectTable(source)
      expect(inspection.sections.find((section) => section.title === 'Indexes')?.rows.some((row) => row.name === 'ddl_source_idx')).toBe(true)
      expect(inspection.sections.find((section) => section.title === 'Foreign Keys')?.rows.some((row) => row.name === 'ddl_source_fk')).toBe(true)
      expect(inspection.sections.find((section) => section.title === 'Triggers')?.rows.some((row) => row.name === 'ddl_source_trigger')).toBe(true)
    } finally {
      await driver.query('drop table if exists ddl_source, ddl_target').catch(() => {})
      await driver.disconnect()
    }
  })

  it('refuses to drop the database currently in use', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.dropDatabase?.(TEST_DB)).rejects.toThrow(/currently in use/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('lists and switches child databases in all-databases mode, hiding system DBs', async () => {
    const driver = await connectDriver({ databaseMode: 'all' })
    try {
      const children = driver.children?.() ?? []
      const names = children.map((child) => child.name)
      expect(names).toContain(TEST_DB)
      expect(names).toContain('master')
      expect(names).not.toEqual(expect.arrayContaining(['tempdb', 'model', 'msdb']))
      expect(children.find((child) => child.name === TEST_DB)?.inUse).toBe(true)
      expect(driver.useChild?.('master')).toBe(true)
      expect(driver.children?.().find((child) => child.name === 'master')?.inUse).toBe(true)
      expect(driver.useChild?.('sqlkit_no_such_database')).toBe(false)
    } finally {
      await driver.disconnect()
    }
  })
})
