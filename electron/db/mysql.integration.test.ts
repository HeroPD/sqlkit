import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../src/electron'
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

  it('connects and reports the server version', async () => {
    const profile = profileFromUrl(dbUrl, { engine: 'mysql' })
    const driver = createMysqlDriver(profile, endpointFor(profile), { onError: () => {} })
    try {
      expect(await driver.connect()).toMatch(/^(MySQL|MariaDB) \d+/)
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
    } finally {
      await driver.disconnect()
    }
  })

  it('buffers at most MAX_BUFFERED_ROWS but counts them all', async () => {
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
    } finally {
      await driver.disconnect()
    }
  }, 30000)

  it('reports the schema/table/column source of each result column', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select id, name, 1 as lit from authors order by id limit 1')
      expect(result.columnSources?.[0]).toEqual({ schema: dbName(), table: 'authors', column: 'id' })
      expect(result.columnSources?.[1]).toEqual({ schema: dbName(), table: 'authors', column: 'name' })
      expect(result.columnSources?.[2]).toEqual({ schema: null, table: null, column: null })
    } finally {
      await driver.disconnect()
    }
  })

  it('cancels an in-flight query from an out-of-band connection', async () => {
    const driver = await connectDriver()
    try {
      // A killed SLEEP() returns 1 rather than erroring, so assert on the
      // cancel outcome and that the statement ends promptly either way.
      const running = driver.query('select sleep(30) as s').catch(() => null)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const outcome = await driver.cancel?.()
      expect(outcome?.running).toBeGreaterThanOrEqual(1)
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      const started = performance.now()
      await running
      expect(performance.now() - started).toBeLessThan(5000)
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
      expect(inspection.columns[0]).toMatchObject({ primaryKey: true, default: 'auto_increment' })
      const foreignKeys = inspection.sections.find((section) => section.title === 'Foreign Keys')
      expect(foreignKeys?.rows[0]?.definition).toMatch(/REFERENCES authors/i)
      const indexes = inspection.sections.find((section) => section.title === 'Indexes')
      expect(indexes?.rows.some((row) => row.name === 'books_author_idx')).toBe(true)
      expect(indexes?.rows.some((row) => row.name === 'PRIMARY')).toBe(false)
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
})
