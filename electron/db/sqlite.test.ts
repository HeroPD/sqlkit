import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { ConnectionProfile } from '../../src/electron'
import { MAX_BUFFERED_ROWS } from './driver'
import { createSqliteDriver, type SqliteChannel, type SqliteSpawner } from './sqlite'
import { inspectTable, listColumns, listTables, openDatabase, queryDatabase, runBatch, serverVersion } from './sqlite-engine'
import type { SqliteRequest, SqliteResponse } from './sqlite-protocol'

// Fields the sqlite driver reads; the rest of the profile is filler so the type compiles.
const sqliteProfile = (file: string): ConnectionProfile => ({
  id: 'test',
  name: 'test',
  engine: 'sqlite',
  host: '',
  port: '',
  username: '',
  password: '',
  database: '',
  file,
  folder: '',
})

// Mirrors sqlite.worker.ts but runs the engine in-process, so the proxy's
// orchestration and the engine itself are exercised without spawning a real
// utilityProcess. Each spawn() is a fresh "worker" with its own handle; replies
// are deferred a microtask to mirror the asynchrony of real IPC.
function inProcessSpawner() {
  const spawned: Array<{ killed: boolean }> = []
  const spawn: SqliteSpawner = () => {
    let db: DatabaseSync | null = null
    let onMessage: (message: SqliteResponse) => void = () => {}
    let onExit: () => void = () => {}
    const record = { killed: false }
    spawned.push(record)

    const requireDb = (): DatabaseSync => {
      if (!db) throw new Error('Not connected')
      return db
    }
    const handle = (request: SqliteRequest): unknown => {
      switch (request.type) {
        case 'open':
          db?.close()
          db = openDatabase(request.file)
          return serverVersion(db)
        case 'query':
          return queryDatabase(requireDb(), request.sql, request.params)
        case 'runBatch':
          return runBatch(requireDb(), request.statements)
        case 'listTables':
          return listTables(requireDb())
        case 'listColumns':
          return listColumns(requireDb())
        case 'inspectTable':
          return inspectTable(requireDb(), request.table)
      }
    }

    const channel: SqliteChannel = {
      post: (request) =>
        queueMicrotask(() => {
          if (record.killed) return
          try {
            onMessage({ id: request.id, ok: true, value: handle(request) })
          } catch (error) {
            onMessage({ id: request.id, ok: false, error: (error as Error).message })
          }
        }),
      kill: () => {
        if (record.killed) return
        record.killed = true
        db?.close()
        db = null
        queueMicrotask(onExit)
      },
      onMessage: (listener) => {
        onMessage = listener
      },
      onExit: (listener) => {
        onExit = listener
      },
    }
    return channel
  }
  return { spawn, spawned }
}

// A worker that answers `open` but never a query — for exercising cancel/timeout.
function hangingSpawner() {
  const spawned: Array<{ killed: boolean }> = []
  const spawn: SqliteSpawner = () => {
    let onMessage: (message: SqliteResponse) => void = () => {}
    let onExit: () => void = () => {}
    const record = { killed: false }
    spawned.push(record)
    return {
      post: (request) => {
        if (request.type === 'open') {
          queueMicrotask(() => {
            if (!record.killed) onMessage({ id: request.id, ok: true, value: 'SQLite 3.0.0' })
          })
        }
      },
      kill: () => {
        if (record.killed) return
        record.killed = true
        queueMicrotask(onExit)
      },
      onMessage: (listener) => {
        onMessage = listener
      },
      onExit: (listener) => {
        onExit = listener
      },
    }
  }
  return { spawn, spawned }
}

const memoryDriver = async () => {
  const { spawn } = inProcessSpawner()
  const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
  await driver.connect()
  return driver
}

describe('sqlite driver: connect / disconnect', () => {
  it('refuses an empty file path', async () => {
    const { spawn } = inProcessSpawner()
    await expect(createSqliteDriver(sqliteProfile(''), spawn).connect()).rejects.toThrow('Choose a database file first.')
  })

  it('refuses a whitespace-only file path', async () => {
    const { spawn } = inProcessSpawner()
    await expect(createSqliteDriver(sqliteProfile('   '), spawn).connect()).rejects.toThrow('Choose a database file first.')
  })

  it('fails eagerly when the file cannot be opened', async () => {
    const { spawn } = inProcessSpawner()
    await expect(createSqliteDriver(sqliteProfile('/no/such/dir/x.db'), spawn).connect()).rejects.toThrow()
  })

  it('connects in-memory and reports the engine version', async () => {
    const { spawn } = inProcessSpawner()
    const version = await createSqliteDriver(sqliteProfile(':memory:'), spawn).connect()
    expect(version).toMatch(/^SQLite \d+\.\d+/)
  })

  it('rejects work after disconnect', async () => {
    const driver = await memoryDriver()
    await driver.disconnect()
    await expect(driver.query('select 1')).rejects.toThrow('Not connected')
    await expect(driver.listTables()).rejects.toThrow('Not connected')
    await expect(driver.listColumns()).rejects.toThrow('Not connected')
    await expect(driver.inspectTable({ schema: null, name: 't', kind: 'table' })).rejects.toThrow('Not connected')
  })

  it('closes the prior handle and reopens on reconnect', async () => {
    const { spawn, spawned } = inProcessSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    await driver.connect()
    await driver.query('create table t(a)')
    // A fresh :memory: database — the reconnect killed the old worker (and its
    // handle) and brought up a new one, so the earlier table is gone.
    await driver.connect()
    expect(await driver.listTables()).toEqual([])
    expect(spawned[0]?.killed).toBe(true)
    expect(spawned).toHaveLength(2)
  })

  it('disconnect is a no-op before connect', async () => {
    const { spawn } = inProcessSpawner()
    await expect(createSqliteDriver(sqliteProfile(':memory:'), spawn).disconnect()).resolves.toBeUndefined()
  })

  it('advertises cancel but no server-oriented capabilities', () => {
    const { spawn } = inProcessSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    expect(driver.cancel).toBeTypeOf('function')
    expect(driver.listObjects).toBeUndefined()
    expect(driver.inspectObject).toBeUndefined()
    expect(driver.inspectServer).toBeUndefined()
    expect(driver.children).toBeUndefined()
    expect(driver.createDatabase).toBeUndefined()
    expect(driver.dropDatabase).toBeUndefined()
    expect(driver.useChild).toBeUndefined()
  })
})

describe('sqlite driver: cancel', () => {
  it('cancels an in-flight query by killing and restarting the worker', async () => {
    const { spawn, spawned } = hangingSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    expect(await driver.connect()).toBe('SQLite 3.0.0')

    const running = driver.query('select 1', [], null, null, 'slow-query')
    running.catch(() => {}) // asserted below; keep the rejection from going unhandled mid-cancel
    expect(await driver.cancel?.('other-query')).toEqual({ running: 0, cancelled: 0 })
    expect(spawned[0]?.killed).toBe(false)
    const outcome = await driver.cancel?.('slow-query')
    expect(outcome).toEqual({ running: 1, cancelled: 1 })
    await expect(running).rejects.toThrow('Query cancelled.')
    expect(spawned[0]?.killed).toBe(true)
    // A fresh worker is brought up on the same file so later queries still run.
    expect(spawned).toHaveLength(2)
  })

  it('cancels the active query while preserving unrelated queued work', async () => {
    const { spawn, spawned } = hangingSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    await driver.connect()

    const first = driver.query('select 1', [], null, null, 'first')
    const queued = driver.query('select 2', [], null, null, 'queued')
    first.catch(() => {})
    queued.catch(() => {})

    expect(await driver.cancel?.('first')).toEqual({ running: 1, cancelled: 1 })
    await expect(first).rejects.toThrow('Query cancelled.')
    expect(spawned).toHaveLength(2)
    expect(spawned[0]?.killed).toBe(true)

    // The queued request moved onto the replacement worker and can be
    // cancelled independently instead of making the first Stop a no-op.
    expect(await driver.cancel?.('queued')).toEqual({ running: 1, cancelled: 1 })
    await expect(queued).rejects.toThrow('Query cancelled.')
  })

  it('removes a queued query without disturbing the active one', async () => {
    const { spawn, spawned } = hangingSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    await driver.connect()

    const active = driver.query('select 1', [], null, null, 'active')
    const queued = driver.query('select 2', [], null, null, 'queued')
    active.catch(() => {})

    expect(await driver.cancel?.('queued')).toEqual({ running: 1, cancelled: 1 })
    await expect(queued).rejects.toThrow('Query cancelled.')
    // The running query and its worker were left alone.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.killed).toBe(false)
  })

  it('reports nothing to cancel when no query is in flight', async () => {
    const { spawn } = hangingSpawner()
    const driver = createSqliteDriver(sqliteProfile(':memory:'), spawn)
    await driver.connect()
    expect(await driver.cancel?.()).toEqual({ running: 0, cancelled: 0 })
  })
})

describe('sqlite driver: query', () => {
  it('returns columns, rows, rowCount and a duration for a select', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a, b)')
    await driver.query('insert into t values (1, 2), (3, 4)')

    const result = await driver.query('select a, b from t order by a')
    expect(result.columns).toEqual(['a', 'b'])
    expect(result.rows).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(result.rowCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('binds positional parameters', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select ? as x, ? as y', [7, 'hi'])
    expect(result.columns).toEqual(['x', 'y'])
    expect(result.rows).toEqual([[7, 'hi']])
  })

  it('injects a column sort as an ORDER BY (descending)', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a, b)')
    await driver.query('insert into t values (1, 2), (3, 4), (2, 9)')

    const result = await driver.query('select a, b from t', [], null, { column: 'a', direction: 'desc' })
    expect(result.rows).toEqual([
      [3, 4],
      [2, 9],
      [1, 2],
    ])
  })

  it('replaces an existing ORDER BY when sorting, keeping the LIMIT after it', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    await driver.query('insert into t values (3), (1), (4), (1), (5)')

    const result = await driver.query('select a from t order by a desc limit 2', [], null, { column: 'a', direction: 'asc' })
    expect(result.rows).toEqual([[1], [1]])
  })

  it('quotes the sort column so reserved/odd names are safe', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t("order")')
    await driver.query('insert into t values (2), (1), (3)')

    const result = await driver.query('select "order" from t', [], null, { column: 'order', direction: 'asc' })
    expect(result.rows).toEqual([[1], [2], [3]])
  })

  it('returns an empty row set when a select matches nothing', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    const result = await driver.query('select a from t')
    expect(result.columns).toEqual(['a'])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('reports affected-row count for writes (no result columns)', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    await driver.query('insert into t values (1), (2), (3)')
    const result = await driver.query('delete from t where a > 1')
    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(2)
  })

  it('preserves duplicate column values via setReturnArrays', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select 1 as id, 2 as id')
    expect(result.columns).toEqual(['id', 'id'])
    expect(result.rows).toEqual([[1, 2]])
  })

  it('returns 64-bit integers without throwing or losing precision', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select 9007199254740993 as n, 42 as safe')
    expect(result.rows).toEqual([[9007199254740993n, 42]])
  })

  it('caps retained rows at MAX_BUFFERED_ROWS and stops scanning once over', async () => {
    const driver = await memoryDriver()
    await driver.query('create table nums(n)')
    await driver.query(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${MAX_BUFFERED_ROWS + 25})
       insert into nums select n from seq`,
    )

    const result = await driver.query('select n from nums')
    expect(result.rows).toHaveLength(MAX_BUFFERED_ROWS)
    expect(result.rowCount).toBe(MAX_BUFFERED_ROWS)
    expect(result.truncated).toBe(true)
    expect(result.rowCountExact).toBe(false)
  })

  it('does not flag exactly MAX_BUFFERED_ROWS as truncated', async () => {
    const driver = await memoryDriver()
    await driver.query('create table nums(n)')
    await driver.query(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ${MAX_BUFFERED_ROWS})
       insert into nums select n from seq`,
    )

    const result = await driver.query('select n from nums')
    expect(result.rows).toHaveLength(MAX_BUFFERED_ROWS)
    expect(result.rowCount).toBe(MAX_BUFFERED_ROWS)
    expect(result.truncated).toBe(false)
    expect(result.rowCountExact).toBe(true)
  })

  it('surfaces SQL errors', async () => {
    const driver = await memoryDriver()
    await expect(driver.query('select * from missing')).rejects.toThrow(/no such table|missing/i)
  })
})

describe('sqlite driver: multi-statement', () => {
  it('runs every statement of a script, not just the first', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    await driver.query('insert into t values (1); insert into t values (2); insert into t values (3)')
    expect((await driver.query('select count(*) c from t')).rows).toEqual([[3]])
  })

  it('returns the last statement’s result and applies earlier schema changes', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('create table m(a); insert into m values (5); insert into m values (6); select a from m order by a')
    expect(result.columns).toEqual(['a'])
    expect(result.rows).toEqual([[5], [6]])
    expect(result.resultSets).toHaveLength(4)
    expect(result.resultSets?.at(-1)?.rows).toEqual([[5], [6]])
  })

  it('refuses params on multi-statement scripts instead of binding NULLs silently', () => {
    const db = openDatabase(':memory:')
    db.exec('create table p(a)')
    expect(() => queryDatabase(db, 'insert into p values (?); insert into p values (?)', [1, 2]))
      .toThrow(/single-statement/i)
    expect(queryDatabase(db, 'insert into p values (?)', [7]).rowCount).toBe(1)
  })

  it('does not split on a semicolon inside a string literal', async () => {
    const driver = await memoryDriver()
    await driver.query('create table notes(body)')
    await driver.query("insert into notes values ('a; b; c')")
    expect((await driver.query('select body from notes')).rows).toEqual([['a; b; c']])
  })

  it('ignores trailing comments after a statement terminator', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('select 1 as n; -- trailing note')
    expect(result.columns).toEqual(['n'])
    expect(result.rows).toEqual([[1]])
  })

  it('treats comment-only scripts as a no-op', async () => {
    const driver = await memoryDriver()
    const result = await driver.query('-- just a note\n/* and a block */')
    expect(result.columns).toEqual([])
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
  })

  it('runs a CREATE TRIGGER script (semicolons in the body) via exec', async () => {
    const driver = await memoryDriver()
    const result = await driver.query(
      `create table t(a);
       create table log(n);
       create trigger trg after insert on t begin insert into log values (1); end;
       insert into t values (10);
       insert into t values (20)`,
    )
    // Script ends with a write, so no rows — but every statement ran and the trigger fired.
    expect(result.rows).toEqual([])
    expect((await driver.query('select count(*) c from log')).rows).toEqual([[2]])
    expect((await driver.query('select count(*) c from t')).rows).toEqual([[2]])
  })

  it('shows the trailing verification SELECT of a CREATE TRIGGER script', async () => {
    const driver = await memoryDriver()
    const result = await driver.query(
      `create table t(a);
       create table log(n);
       create trigger trg after insert on t begin insert into log values (1); end;
       insert into t values (10);
       insert into t values (20);
       select count(*) as logged from log`,
    )
    // Trigger fired on both inserts; the trailing SELECT is re-run to show rows.
    expect(result.columns).toEqual(['logged'])
    expect(result.rows).toEqual([[2]])
  })

  it('creates a standalone trigger and fires it on later inserts', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(a)')
    await driver.query('create table log(n)')
    await driver.query('create trigger trg after insert on t begin insert into log values (1); end')
    await driver.query('insert into t values (1)')
    expect((await driver.query('select count(*) c from log')).rows).toEqual([[1]])
  })
})

describe('sqlite driver: runBatch', () => {
  const seeded = async () => {
    const driver = await memoryDriver()
    await driver.query('create table t (id integer primary key, name text)')
    await driver.query("insert into t (id, name) values (1, 'a'), (2, 'b')")
    return driver
  }

  it('commits every statement in one transaction', async () => {
    const driver = await seeded()
    const result = await driver.runBatch!([
      { sql: 'update t set name = ? where id = ?', params: ['x', 1] },
      { sql: 'insert into t (id, name) values (?, ?)', params: [3, 'c'] },
    ])
    expect(result).toEqual({ success: true })
    expect((await driver.query('select name from t order by id')).rows).toEqual([['x'], ['b'], ['c']])
  })

  it('rolls the whole batch back when a statement errors', async () => {
    const driver = await seeded()
    const result = await driver.runBatch!([
      { sql: 'update t set name = ? where id = ?', params: ['x', 1] },
      { sql: 'insert into t (id, name) values (?, ?)', params: [1, 'dup'] }, // PK conflict
    ])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.failedIndex).toBe(1)
    // The earlier UPDATE must not have survived.
    expect((await driver.query('select name from t order by id')).rows).toEqual([['a'], ['b']])
  })

  it('rolls back when a statement affects no rows', async () => {
    const driver = await seeded()
    const result = await driver.runBatch!([
      { sql: 'update t set name = ? where id = ?', params: ['x', 1] },
      { sql: 'update t set name = ? where id = ?', params: ['y', 999] }, // matches nothing
    ])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.failedIndex).toBe(1)
      expect(result.error).toContain('affected no rows')
    }
    expect((await driver.query('select name from t order by id')).rows).toEqual([['a'], ['b']])
  })
})

describe('sqlite driver: listTables', () => {
  it('is empty for a fresh database', async () => {
    const driver = await memoryDriver()
    expect(await driver.listTables()).toEqual([])
  })

  it('lists tables and views sorted by name with a null schema', async () => {
    const driver = await memoryDriver()
    await driver.query('create table beta(a)')
    await driver.query('create table alpha(a)')
    await driver.query('create view gamma as select a from alpha')

    expect(await driver.listTables()).toEqual([
      { schema: null, name: 'alpha', kind: 'table' },
      { schema: null, name: 'beta', kind: 'table' },
      { schema: null, name: 'gamma', kind: 'view' },
    ])
  })

  it('excludes internal sqlite_* tables', async () => {
    const driver = await memoryDriver()
    // AUTOINCREMENT spawns the internal sqlite_sequence table.
    await driver.query('create table t(id integer primary key autoincrement, v)')
    await driver.query('insert into t(v) values (1)')

    expect((await driver.listTables()).map((table) => table.name)).toEqual(['t'])
  })
})

describe('sqlite driver: listColumns', () => {
  it('reports type, nullability and key flags across every table, ordered', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text not null)')
    await driver.query('create table child(id integer primary key, parent_id integer references parent(id), note text)')

    expect(await driver.listColumns()).toEqual([
      { schema: null, table: 'child', name: 'id', dataType: 'INTEGER', nullable: true, primaryKey: true, foreignKey: false },
      { schema: null, table: 'child', name: 'parent_id', dataType: 'INTEGER', nullable: true, primaryKey: false, foreignKey: true },
      { schema: null, table: 'child', name: 'note', dataType: 'TEXT', nullable: true, primaryKey: false, foreignKey: false },
      { schema: null, table: 'parent', name: 'id', dataType: 'INTEGER', nullable: true, primaryKey: true, foreignKey: false },
      { schema: null, table: 'parent', name: 'name', dataType: 'TEXT', nullable: false, primaryKey: false, foreignKey: false },
    ])
  })

  it('defaults a missing column type to "any" and includes view columns', async () => {
    const driver = await memoryDriver()
    await driver.query('create table untyped(x)')
    await driver.query('create view v as select x as y from untyped')

    const columns = await driver.listColumns()
    expect(columns.find((c) => c.table === 'untyped' && c.name === 'x')?.dataType).toBe('any')
    expect(columns.some((c) => c.table === 'v' && c.name === 'y')).toBe(true)
  })
})

describe('sqlite driver: inspectTable', () => {
  it('returns columns with type, nullability, default and primary key; no sections when there are none', async () => {
    const driver = await memoryDriver()
    await driver.query('create table t(id integer primary key, a integer default 5, b text not null)')

    const inspection = await driver.inspectTable({ schema: null, name: 't', kind: 'table' })
    expect(inspection.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: true, comment: null },
      { name: 'a', dataType: 'INTEGER', nullable: true, default: '5', primaryKey: false, comment: null },
      { name: 'b', dataType: 'TEXT', nullable: false, default: null, primaryKey: false, comment: null },
    ])
    expect(inspection.sections).toEqual([])
  })

  it('groups foreign keys, indexes and triggers into non-empty sections', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text not null)')
    await driver.query('create table child(id integer primary key, parent_id integer references parent(id), note text)')
    await driver.query('create index idx_note on child(note)')
    await driver.query("create trigger trg after insert on child begin update parent set name='x'; end")

    const inspection = await driver.inspectTable({ schema: null, name: 'child', kind: 'table' })
    expect(inspection.columns).toEqual([
      { name: 'id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: true, comment: null },
      { name: 'parent_id', dataType: 'INTEGER', nullable: true, default: null, primaryKey: false, comment: null },
      { name: 'note', dataType: 'TEXT', nullable: true, default: null, primaryKey: false, comment: null },
    ])
    expect(inspection.sections).toEqual([
      {
        title: 'Foreign Keys',
        rows: [{ name: 'parent_id', definition: 'REFERENCES parent(id) ON UPDATE NO ACTION ON DELETE NO ACTION' }],
      },
      { title: 'Indexes', rows: [{ name: 'idx_note', definition: 'CREATE INDEX idx_note on child(note)' }] },
      {
        title: 'Triggers',
        rows: [{ name: 'trg', definition: "CREATE TRIGGER trg after insert on child begin update parent set name='x'; end" }],
      },
    ])
  })

  it('falls back to rowid for an implicit foreign-key target', async () => {
    const driver = await memoryDriver()
    await driver.query('create table parent(id integer primary key, name text)')
    await driver.query('create table c2(pid references parent)')

    const inspection = await driver.inspectTable({ schema: null, name: 'c2', kind: 'table' })
    expect(inspection.sections).toEqual([
      {
        title: 'Foreign Keys',
        rows: [{ name: 'pid', definition: 'REFERENCES parent(rowid) ON UPDATE NO ACTION ON DELETE NO ACTION' }],
      },
    ])
  })

  it('labels auto-created indexes behind UNIQUE/PK constraints', async () => {
    const driver = await memoryDriver()
    await driver.query('create table uq(a unique)')

    const inspection = await driver.inspectTable({ schema: null, name: 'uq', kind: 'table' })
    expect(inspection.sections).toEqual([
      { title: 'Indexes', rows: [{ name: 'sqlite_autoindex_uq_1', definition: '(auto: unique/primary key)' }] },
    ])
  })
})
