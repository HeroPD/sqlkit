import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../src/electron'
import type { Driver } from './driver'
import { MAX_BUFFERED_ROWS } from './driver'
import { createPostgresDriver } from './postgres'
import { adminPool, endpointFor, profileFromUrl, testDatabaseUrl } from './test-db'

const url = testDatabaseUrl()
const describeDb = url ? describe : describe.skip

// Exercises the real Postgres driver against TEST_DATABASE_URL. Skips entirely
// when no test database is configured (see .env.example).
describeDb('postgres driver (integration)', () => {
  const dbUrl = url ?? ''
  let admin: ReturnType<typeof adminPool>

  beforeAll(async () => {
    admin = adminPool(dbUrl)
    // A throwaway schema so assertions don't depend on whatever else lives in
    // the database; dropped wholesale afterwards.
    await admin.query('drop schema if exists sqlkit_it cascade')
    await admin.query('create schema sqlkit_it')
    await admin.query('create table sqlkit_it.authors (id serial primary key, name text not null, bio text)')
    await admin.query(
      `create table sqlkit_it.books (
         id serial primary key,
         author_id integer not null references sqlkit_it.authors(id),
         title text not null,
         published boolean default false)`,
    )
    await admin.query('create index books_author_idx on sqlkit_it.books(author_id)')
    await admin.query('create view sqlkit_it.book_titles as select title from sqlkit_it.books')
    await admin.query("create type sqlkit_it.mood as enum ('happy', 'sad')")
    await admin.query("insert into sqlkit_it.authors (name, bio) values ('Ada', 'pioneer'), ('Alan', null)")
  })

  afterAll(async () => {
    await admin.query('drop schema if exists sqlkit_it cascade').catch(() => {})
    await admin.end().catch(() => {})
  })

  const connectDriver = async (overrides: Partial<ConnectionProfile> = {}): Promise<Driver> => {
    const profile = profileFromUrl(dbUrl, overrides)
    const driver = createPostgresDriver(profile, endpointFor(profile), { onError: () => {} })
    await driver.connect()
    return driver
  }

  it('connects and reports the server version', async () => {
    const profile = profileFromUrl(dbUrl)
    const driver = createPostgresDriver(profile, endpointFor(profile), { onError: () => {} })
    try {
      expect(await driver.connect()).toMatch(/^PostgreSQL \d+/)
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

  it('binds positional parameters', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select $1::int as x, $2::text as y', [7, 'hi'])
      expect(result.columns).toEqual(['x', 'y'])
      expect(result.rows).toEqual([[7, 'hi']])
    } finally {
      await driver.disconnect()
    }
  })

  it('runs a write batch atomically: commits all, or rolls back all on failure', async () => {
    const driver = await connectDriver()
    try {
      await driver.query('create table sqlkit_it.batch (id integer primary key, v text)')
      // All statements succeed → both rows commit.
      const ok = await driver.runBatch!([
        { sql: 'insert into sqlkit_it.batch (id, v) values ($1, $2)', params: [1, 'a'] },
        { sql: 'insert into sqlkit_it.batch (id, v) values ($1, $2)', params: [2, 'b'] },
      ])
      expect(ok).toEqual({ success: true })
      expect((await driver.query('select count(*)::int from sqlkit_it.batch')).rows).toEqual([[2]])

      // Second insert violates the primary key → the first must roll back too.
      const bad = await driver.runBatch!([
        { sql: 'insert into sqlkit_it.batch (id, v) values ($1, $2)', params: [3, 'c'] },
        { sql: 'insert into sqlkit_it.batch (id, v) values ($1, $2)', params: [1, 'dup'] },
      ])
      expect(bad.success).toBe(false)
      if (!bad.success) expect(bad.failedIndex).toBe(1)
      expect((await driver.query('select count(*)::int from sqlkit_it.batch')).rows).toEqual([[2]])
    } finally {
      await driver.query('drop table if exists sqlkit_it.batch').catch(() => {})
      await driver.disconnect()
    }
  })

  it('surfaces SQL errors', async () => {
    const driver = await connectDriver()
    try {
      await expect(driver.query('select * from sqlkit_no_such_table')).rejects.toThrow(/sqlkit_no_such_table|does not exist/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('drains a capped read without cancelling statement semantics', async () => {
    const driver = await connectDriver()
    try {
      const count = MAX_BUFFERED_ROWS + 25
      const result = await driver.query('select generate_series(1, $1) as n', [count])
      expect(result.rows).toHaveLength(MAX_BUFFERED_ROWS)
      expect(result.rowCount).toBe(count)
      expect(result.truncated).toBe(true)
      expect(result.rowCountExact).toBe(true)
    } finally {
      await driver.disconnect()
    }
  }, 20000)

  it('does not leak session state between pooled query runs', async () => {
    const driver = await connectDriver()
    try {
      await driver.query("set application_name = 'sqlkit-leaked-state'")
      expect((await driver.query("select current_setting('application_name')")).rows[0]?.[0]).not.toBe('sqlkit-leaked-state')
    } finally {
      await driver.disconnect()
    }
  })

  it('preserves temporal and exact numeric values as text', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query(
        "select date '2026-07-10', timestamp '2026-07-10 03:04:05.123456', timestamptz '2026-07-10 03:04:05.123456+08', 12345678901234567890.1234::numeric",
      )
      expect(result.rows[0]).toEqual([
        '2026-07-10',
        '2026-07-10 03:04:05.123456',
        '2026-07-09 19:04:05.123456+00',
        '12345678901234567890.1234',
      ])
    } finally {
      await driver.disconnect()
    }
  })

  it('reports the schema/table/column source of each result column', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select id, name, 1 as lit from sqlkit_it.authors order by id limit 1')
      expect(result.columnSources?.[0]).toEqual({ schema: 'sqlkit_it', table: 'authors', column: 'id' })
      expect(result.columnSources?.[1]).toEqual({ schema: 'sqlkit_it', table: 'authors', column: 'name' })
      expect(result.columnSources?.[2]).toEqual({ schema: null, table: null, column: null })
    } finally {
      await driver.disconnect()
    }
  })

  it('keeps rows aligned with each result set in a multi-statement run', async () => {
    const driver = await connectDriver()
    try {
      const result = await driver.query('select 1 as a; select 2 as b')
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

  it('cancels an in-flight query from an out-of-band connection', async () => {
    const driver = await connectDriver()
    try {
      const running = driver.query('select pg_sleep(30)', [], null, null, 'slow-query')
      // Attach the rejection expectation before cancelling so the reject has a
      // handler the instant it fires (no transient unhandled rejection).
      const cancelled = expect(running).rejects.toThrow('Query cancelled.')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await driver.cancel?.('other-query')).toEqual({ running: 0, cancelled: 0 })
      const outcome = await driver.cancel?.('slow-query')
      expect(outcome?.running).toBeGreaterThanOrEqual(1)
      expect(outcome?.cancelled).toBeGreaterThanOrEqual(1)
      await cancelled
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

  it('lists tables, views and matviews with their schema', async () => {
    const driver = await connectDriver()
    try {
      const mine = (await driver.listTables()).filter((table) => table.schema === 'sqlkit_it')
      expect(mine).toEqual(
        expect.arrayContaining([
          { schema: 'sqlkit_it', name: 'authors', kind: 'table' },
          { schema: 'sqlkit_it', name: 'books', kind: 'table' },
          { schema: 'sqlkit_it', name: 'book_titles', kind: 'view' },
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
        columns.find((column) => column.schema === 'sqlkit_it' && column.table === table && column.name === name)
      expect(find('authors', 'id')).toMatchObject({ primaryKey: true, nullable: false })
      expect(find('authors', 'bio')).toMatchObject({ nullable: true, primaryKey: false, foreignKey: false })
      expect(find('books', 'author_id')).toMatchObject({ foreignKey: true, nullable: false })
    } finally {
      await driver.disconnect()
    }
  })

  it('lists user-defined types via listObjects', async () => {
    const driver = await connectDriver()
    try {
      const objects = await driver.listObjects?.()
      expect(objects?.types).toEqual(expect.arrayContaining([{ schema: 'sqlkit_it', name: 'mood', detail: 'enum' }]))
    } finally {
      await driver.disconnect()
    }
  })

  it('inspects a table: columns, foreign keys and indexes', async () => {
    const driver = await connectDriver()
    try {
      const inspection = await driver.inspectTable({ schema: 'sqlkit_it', name: 'books', kind: 'table' })
      expect(inspection.columns.map((column) => column.name)).toEqual(['id', 'author_id', 'title', 'published'])
      const foreignKeys = inspection.sections.find((section) => section.title === 'Foreign Keys')
      expect(foreignKeys?.rows[0]?.definition).toMatch(/REFERENCES sqlkit_it\.authors/i)
      const indexes = inspection.sections.find((section) => section.title === 'Indexes')
      expect(indexes?.rows.some((row) => row.name === 'books_author_idx')).toBe(true)
    } finally {
      await driver.disconnect()
    }
  })

  it('inspects an enum type: its values in order', async () => {
    const driver = await connectDriver()
    try {
      const inspection = await driver.inspectObject?.({ schema: 'sqlkit_it', name: 'mood', detail: 'enum' }, 'type')
      const values = inspection?.sections.find((section) => section.title === 'Values')
      expect(values?.rows.map((row) => row.name)).toEqual(['happy', 'sad'])
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
      expect((await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount).toBe(1)
      await driver.dropDatabase?.(name)
      expect((await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount).toBe(0)
    } finally {
      await admin.query(`drop database if exists ${name}`).catch(() => {})
      await driver.disconnect()
    }
  })

  it('refuses to drop the database currently in use', async () => {
    const driver = await connectDriver()
    try {
      const active = profileFromUrl(dbUrl).database
      await expect(driver.dropDatabase?.(active)).rejects.toThrow(/currently in use/i)
    } finally {
      await driver.disconnect()
    }
  })

  it('lists and switches child databases in all-databases mode', async () => {
    const driver = await connectDriver({ databaseMode: 'all' })
    try {
      const children = driver.children?.() ?? []
      expect(children.length).toBeGreaterThan(0)
      const active = profileFromUrl(dbUrl).database
      expect(children.find((child) => child.name === active)?.inUse).toBe(true)
      const other = children.find((child) => child.name !== active)
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
