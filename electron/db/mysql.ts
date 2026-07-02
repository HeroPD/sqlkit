import mysql from 'mysql2/promise'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import { BATCH_ZERO_ROWS, MAX_BUFFERED_ROWS } from './limits'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { sslOptions } from './postgres'

// Schemas MySQL ships with; never listed as children or browsable databases.
const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys']

// The callback-API connection under mysql2's promise wrapper; its query() is
// the event-emitter form, used so huge results stream instead of buffering.
type StreamableQuery = {
  on(event: 'fields', listener: (fields: unknown) => void): StreamableQuery
  on(event: 'result', listener: (row: unknown) => void): StreamableQuery
  on(event: 'error', listener: (error: Error) => void): StreamableQuery
  on(event: 'end', listener: () => void): StreamableQuery
}
type RawConnection = { threadId: number; query(options: { sql: string; values: unknown[]; rowsAsArray: boolean }): StreamableQuery }

type FieldMeta = { name: string; db?: string; schema?: string; orgTable?: string; orgName?: string }

const rawOf = (conn: mysql.PoolConnection): RawConnection => (conn as unknown as { connection: RawConnection }).connection

// ER_QUERY_INTERRUPTED — the server killed the statement (our cancel()).
const isInterrupted = (error: unknown) => (error as { errno?: number }).errno === 1317

/** "9.3.0" → "MySQL 9.3.0"; "11.4.2-MariaDB-…" → "MariaDB 11.4.2". */
export function mysqlVersion(raw: string): string {
  const maria = /^(.+?)-MariaDB/i.exec(raw)
  return maria ? `MariaDB ${maria[1]}` : `MySQL ${raw}`
}

// MySQL with all-databases support, mirroring the postgres driver: one pool per
// child database (a MySQL "database" and "schema" are the same thing), queries
// and metadata always target the active child via the pool's default schema.
// Dials the endpoint — the transport layer may have rewritten host/port to an
// SSH tunnel's local end.
export function createMysqlDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pools: Map<string, mysql.Pool> | null = null
  let childNames: string[] = []
  let active = ''
  // Thread ids of in-flight user statements, so cancel() can KILL QUERY them.
  const running = new Set<{ threadId: number | null }>()
  // The tls ConnectionOptions shape is what mysql2 forwards to tls.connect;
  // its own SslOptions type is just narrower.
  const tls = sslOptions(profile)
  const ssl = typeof tls === 'boolean' ? undefined : (tls as unknown as mysql.PoolOptions['ssl'])

  const makePool = (database: string) => {
    const pool = mysql.createPool({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database: database || undefined,
      ssl,
      connectionLimit: 4,
      connectTimeout: 8000,
      multipleStatements: true,
      // Lossless values: temporals as strings, BIGINT past 2^53 as strings
      // (safe-range ones stay numbers), DECIMAL as strings (mysql2 default).
      dateStrings: true,
      supportBigNumbers: true,
      // affectedRows counts matched rows (like Postgres), not changed rows —
      // otherwise a no-op cell edit would trip runBatch's zero-rows gate.
      flags: ['FOUND_ROWS'],
    })
    // Idle-connection errors surface on the underlying callback pool; without
    // a handler they'd be unhandled 'error' events.
    ;(pool.pool as unknown as { on(event: string, listener: (error: Error) => void): void }).on('error', (error) =>
      events.onError(error.message),
    )
    return pool
  }

  const activePool = () => {
    const pool = pools?.get(active)
    if (!pool) throw new Error('Not connected')
    return pool
  }

  const poolForQuery = (childDb?: string | null) => {
    if (!childDb) return activePool()
    const pool = pools?.get(childDb)
    if (!pool) throw new Error(`Database "${childDb}" is not available on this connection`)
    return pool
  }

  // Metadata helper: object rows, cast to the query's concrete shape.
  const metaRows = async <T>(sql: string, params: unknown[] = [], childDb?: string | null): Promise<T[]> => {
    const [rows] = await poolForQuery(childDb).query(sql, params)
    return rows as unknown as T[]
  }

  const dialect = dialectFor(profile.engine)

  return {
    async connect() {
      const discovery = profile.database.trim()
      pools = new Map([[discovery, makePool(discovery)]])
      // Point metaRows at the discovery pool; re-resolved after children load.
      active = discovery

      const version = mysqlVersion((await metaRows<{ version: string }>('select version() as version'))[0]?.version ?? '')

      if (profile.databaseMode === 'all') {
        const listed = await metaRows<{ name: string }>(
          `select schema_name as name from information_schema.schemata
           where schema_name not in (${SYSTEM_SCHEMAS.map(() => '?').join(', ')}) order by schema_name`,
          SYSTEM_SCHEMAS,
        )
        childNames = listed.map((row) => row.name)
        if (!childNames.length) childNames = [discovery]
        for (const name of childNames) {
          if (!pools.has(name)) pools.set(name, makePool(name))
        }
      } else {
        childNames = [discovery]
      }

      active = childNames.includes(discovery) ? discovery : (childNames[0] ?? discovery)
      return version
    },

    async disconnect() {
      const closing = pools
      pools = null
      if (!closing) return
      await Promise.all([...closing.values()].map((pool) => pool.end().catch(() => {})))
    },

    async query(sql, params = [], childDb = null, sort = null) {
      const started = performance.now()
      const finalSql = sort ? dialect.applyOrderBy(sql, sort) : sql
      // Checked out manually so the thread id is known while the statement
      // runs and cancel() has a KILL QUERY target.
      const conn = await poolForQuery(childDb).getConnection()
      const raw = rawOf(conn)
      const entry = { threadId: raw.threadId ?? null }
      running.add(entry)
      try {
        const result = await streamQuery(raw, finalSql, params, started)
        conn.release()
        return result
      } catch (error) {
        // The connection may hold half-read results; drop it rather than reuse.
        conn.destroy()
        throw isInterrupted(error) ? new Error('Query cancelled.') : error
      } finally {
        running.delete(entry)
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // One checked-out connection for the whole batch so the transaction binds
      // every statement.
      const conn = await poolForQuery(childDb).getConnection()
      const entry = { threadId: rawOf(conn).threadId ?? null }
      running.add(entry)
      let index = -1
      try {
        await conn.beginTransaction()
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          const [result] = await conn.query(statement.sql, statement.params)
          // A write that matched nothing means the row moved or vanished since
          // the user reviewed it — abort the whole batch rather than half-apply.
          if (((result as { affectedRows?: number }).affectedRows ?? 0) === 0) {
            await conn.rollback()
            conn.release()
            return { success: false, failedIndex: index, error: BATCH_ZERO_ROWS }
          }
        }
        await conn.commit()
        conn.release()
        return { success: true }
      } catch (error) {
        // Uncertain transaction state: closing the connection aborts it.
        conn.destroy()
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isInterrupted(error) ? 'Save cancelled.' : (error as Error).message,
        }
      } finally {
        running.delete(entry)
      }
    },

    async runDdl(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // No transaction: MySQL DDL commits implicitly, so statements run one by
      // one and a failure reports how far it got rather than rolling back.
      const conn = await poolForQuery(childDb).getConnection()
      const entry = { threadId: rawOf(conn).threadId ?? null }
      running.add(entry)
      let index = -1
      try {
        for (index = 0; index < statements.length; index += 1) {
          await conn.query(statements[index]!)
        }
        conn.release()
        return { success: true }
      } catch (error) {
        conn.destroy()
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isInterrupted(error) ? 'Save cancelled.' : (error as Error).message,
        }
      } finally {
        running.delete(entry)
      }
    },

    async createDatabase(name) {
      await activePool().query(`create database ${dialect.quoteIdent(name)}`)
      if (profile.databaseMode === 'all' && pools && !pools.has(name)) {
        pools.set(name, makePool(name))
        childNames = [...childNames, name].sort()
      }
    },

    async dropDatabase(name) {
      if (!pools) throw new Error('Not connected')
      if (name === active) {
        throw new Error('Cannot drop the database currently in use — switch to another one first.')
      }
      const pool = pools.get(name)
      if (pool) {
        pools.delete(name)
        await pool.end().catch(() => {})
      }
      try {
        await activePool().query(`drop database ${dialect.quoteIdent(name)}`)
      } catch (error) {
        // Drop refused: keep it browsable.
        if (pool) pools.set(name, makePool(name))
        throw error
      }
      childNames = childNames.filter((child) => child !== name)
    },

    async cancel() {
      // KILL QUERY from a fresh out-of-band connection — the pool's clients are
      // occupied by the very statements being cancelled. A thread that already
      // finished is a no-op error, counted as not cancelled.
      const entries = [...running]
      const ids = entries.map((entry) => entry.threadId).filter((id): id is number => id !== null)
      if (!ids.length) return { running: entries.length, cancelled: 0 }
      const conn = await mysql.createConnection({
        host: endpoint.host,
        port: endpoint.port,
        user: profile.username,
        password: profile.password,
        database: active || undefined,
        ssl,
        connectTimeout: 8000,
      })
      try {
        const sent = await Promise.all(
          ids.map((id) =>
            conn
              .query(`kill query ${id}`)
              .then(() => true)
              .catch(() => false),
          ),
        )
        return { running: entries.length, cancelled: sent.filter(Boolean).length }
      } finally {
        await conn.end().catch(() => {})
      }
    },

    async listTables(childDb = null) {
      // schema stays null: a MySQL database (= the child) has no sub-schemas,
      // so the explorer shows a flat list like SQLite.
      const rows = await metaRows<{ name: string; type: string }>(
        `select table_name as name, table_type as type from information_schema.tables
         where table_schema = database() and table_type in ('BASE TABLE', 'VIEW') order by table_name`,
        [],
        childDb,
      )
      return rows.map((row): TableRef => ({ schema: null, name: row.name, kind: row.type === 'VIEW' ? 'view' : 'table' }))
    },

    async listColumns(childDb = null) {
      const rows = await metaRows<{ table_name: string; name: string; data_type: string; nullable: number; pk: number; fk: number }>(
        `select c.table_name as table_name, c.column_name as name, c.column_type as data_type,
                c.is_nullable = 'YES' as nullable, c.column_key = 'PRI' as pk,
                exists (select 1 from information_schema.key_column_usage k
                        where k.table_schema = c.table_schema and k.table_name = c.table_name
                          and k.column_name = c.column_name and k.referenced_table_name is not null) as fk
         from information_schema.columns c
         where c.table_schema = database()
         order by c.table_name, c.ordinal_position`,
        [],
        childDb,
      )
      return rows.map(
        (row): ColumnRef => ({
          schema: null,
          table: row.table_name,
          name: row.name,
          dataType: row.data_type,
          nullable: !!row.nullable,
          primaryKey: !!row.pk,
          foreignKey: !!row.fk,
        }),
      )
    },

    async listObjects(childDb = null) {
      // Functions and procedures with their parameter list; MySQL has no
      // standalone user types, so that group stays empty.
      const functions = await metaRows<DbObject>(
        `select null as \`schema\`, r.routine_name as name,
                coalesce((select group_concat(concat(p.parameter_name, ' ', p.data_type)
                                              order by p.ordinal_position separator ', ')
                          from information_schema.parameters p
                          where p.specific_schema = r.routine_schema and p.specific_name = r.specific_name
                            and p.ordinal_position > 0), '') as detail
         from information_schema.routines r
         where r.routine_schema = database()
         order by r.routine_name`,
        [],
        childDb,
      )
      return { functions, types: [] }
    },

    async inspectObject(object, _objectKind, childDb = null) {
      const rows = await metaRows<{ definition: string | null }>(
        'select routine_definition as definition from information_schema.routines where routine_schema = database() and routine_name = ?',
        [object.name],
        childDb,
      )
      if (!rows.length) throw new Error(`Routine ${object.name} was not found.`)
      const definition = rows[0]?.definition ?? '(definition not accessible with this user)'
      return { columns: [], sections: [{ title: 'Definition', rows: [{ name: object.name, definition }] }] }
    },

    async inspectServer(childDb = null) {
      type Row = { name: string; definition: string }
      const engines = await metaRows<Row>(
        `select engine as name, concat(support, coalesce(concat(' — ', comment), '')) as definition
         from information_schema.engines order by engine`,
        [],
        childDb,
      )
      // mysql.user needs privileges most app users lack; absent, skip the section.
      const users = await metaRows<Row>(
        "select concat(user, '@', host) as name, '' as definition from mysql.user order by user, host",
        [],
        childDb,
      ).catch(() => [])
      return [
        { title: 'Storage Engines', rows: engines },
        { title: 'Users', rows: users },
      ].filter((section) => section.rows.length)
    },

    async inspectTable(table, childDb = null) {
      type Row = { name: string; definition: string }
      const args = [table.name]

      const [columns, foreignKeys, checks, indexes, partitions, triggers] = await Promise.all([
        metaRows<{ name: string; data_type: string; nullable: number; default_expr: string | null; pk: number; comment: string | null; extra: string }>(
          `select column_name as name, column_type as data_type, is_nullable = 'YES' as nullable,
                  column_default as default_expr, column_key = 'PRI' as pk,
                  nullif(column_comment, '') as comment, extra as extra
           from information_schema.columns
           where table_schema = database() and table_name = ? order by ordinal_position`,
          args,
          childDb,
        ),
        metaRows<Row>(
          `select k.constraint_name as name,
                  concat('FOREIGN KEY (', group_concat(k.column_name order by k.ordinal_position separator ', '),
                         ') REFERENCES ', min(k.referenced_table_name),
                         ' (', group_concat(k.referenced_column_name order by k.ordinal_position separator ', '), ')',
                         ' ON UPDATE ', min(rc.update_rule), ' ON DELETE ', min(rc.delete_rule)) as definition
           from information_schema.key_column_usage k
           join information_schema.referential_constraints rc
             on rc.constraint_schema = k.constraint_schema and rc.constraint_name = k.constraint_name and rc.table_name = k.table_name
           where k.table_schema = database() and k.table_name = ? and k.referenced_table_name is not null
           group by k.constraint_name order by k.constraint_name`,
          args,
          childDb,
        ),
        // information_schema.check_constraints needs MySQL 8.0.16+; absent, none.
        metaRows<Row>(
          `select cc.constraint_name as name, cc.check_clause as definition
           from information_schema.check_constraints cc
           join information_schema.table_constraints tc
             on tc.constraint_schema = cc.constraint_schema and tc.constraint_name = cc.constraint_name
           where tc.table_schema = database() and tc.table_name = ? and tc.constraint_type = 'CHECK'
           order by cc.constraint_name`,
          args,
          childDb,
        ).catch(() => []),
        metaRows<Row>(
          `select index_name as name,
                  concat(case when non_unique = 0 then 'UNIQUE ' else '' end,
                         '(', group_concat(column_name order by seq_in_index separator ', '), ') USING ', min(index_type)) as definition
           from information_schema.statistics
           where table_schema = database() and table_name = ?
           group by index_name, non_unique order by index_name`,
          args,
          childDb,
        ),
        metaRows<Row>(
          `select partition_name as name,
                  concat(partition_method, coalesce(concat(' (', partition_expression, ')'), ''),
                         coalesce(concat(' — ', partition_description), '')) as definition
           from information_schema.partitions
           where table_schema = database() and table_name = ? and partition_name is not null
           order by partition_ordinal_position`,
          args,
          childDb,
        ),
        metaRows<Row>(
          `select trigger_name as name, concat(action_timing, ' ', event_manipulation, ' — ', action_statement) as definition
           from information_schema.triggers
           where event_object_schema = database() and event_object_table = ? order by trigger_name`,
          args,
          childDb,
        ),
      ])

      const sections: InspectSection[] = [
        { title: 'Foreign Keys', rows: foreignKeys },
        { title: 'Constraints', rows: checks },
        // PRIMARY is already the columns table's key marker.
        { title: 'Indexes', rows: indexes.filter((row) => row.name !== 'PRIMARY') },
        { title: 'Partitions', rows: partitions },
        { title: 'Triggers', rows: triggers },
      ]
      return {
        columns: columns.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: !!row.nullable,
          // auto_increment lives in `extra`, but it plays the role of a default.
          default: row.default_expr ?? (row.extra.includes('auto_increment') ? 'auto_increment' : null),
          primaryKey: !!row.pk,
          comment: row.comment,
        })),
        sections: sections.filter((section) => section.rows.length),
      }
    },

    children() {
      return childNames.map((name) => ({ name, inUse: name === active }))
    },

    useChild(database) {
      if (!childNames.includes(database)) return false
      active = database
      return true
    },
  }
}

// Streams rows so a huge result can't OOM the main process. Each result set of
// a multi-statement run resets the buffer — the last statement's result is the
// one displayed, matching how a user reads "run whole editor".
function streamQuery(raw: RawConnection, sql: string, params: unknown[], started: number): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let columns: string[] = []
    let columnSources: QueryResult['columnSources']
    let rows: unknown[][] = []
    let total = 0
    const query = raw.query({ sql, values: params, rowsAsArray: true })
    query.on('fields', (fields) => {
      const list = Array.isArray(fields) ? (fields as FieldMeta[]) : []
      columns = list.map((field) => field.name)
      columnSources = list.some((field) => field.orgTable && field.orgName)
        ? list.map((field) =>
            field.orgTable && field.orgName
              ? { schema: field.db ?? field.schema ?? null, table: field.orgTable, column: field.orgName }
              : { schema: null, table: null, column: null },
          )
        : undefined
      rows = []
      total = 0
    })
    query.on('result', (row) => {
      if (Array.isArray(row)) {
        total += 1
        if (rows.length < MAX_BUFFERED_ROWS) rows.push(row as unknown[])
      } else {
        // An OK packet (INSERT/UPDATE/…): rowCount is the affected count.
        columns = []
        columnSources = undefined
        rows = []
        total = (row as { affectedRows?: number }).affectedRows ?? 0
      }
    })
    query.on('error', reject)
    query.on('end', () =>
      resolve({
        columns,
        columnSources,
        rows,
        rowCount: total,
        durationMs: performance.now() - started,
        truncated: total > MAX_BUFFERED_ROWS,
      }),
    )
  })
}
