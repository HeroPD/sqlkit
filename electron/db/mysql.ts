import mysql from 'mysql2/promise'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import { BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS } from './limits'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { openExportWriter, type ExportWriter } from './export'
import { sslOptions } from './postgres'
import { prepareSqlRun } from './sql-script'
import { isReadOnlyQuery } from '../../src/sql-order'
import type { SqlModeFlags } from '../../src/sql-mask'
import { t } from '../../src/i18n'

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
type RawConnection = {
  threadId: number
  query(options: { sql: string; values: unknown[]; rowsAsArray: boolean }): StreamableQuery
  pause(): void
  resume(): void
}

type FieldMeta = { name: string; db?: string; schema?: string; orgTable?: string; orgName?: string }

const rawOf = (conn: mysql.PoolConnection): RawConnection => (conn as unknown as { connection: RawConnection }).connection

// ER_QUERY_INTERRUPTED — the server killed the statement (our cancel()).
const isInterrupted = (error: unknown) => (error as { errno?: number }).errno === 1317

// The target of one write statement: bare or backtick-quoted, optionally
// schema-qualified. Null for any other shape, so the storage-engine guard
// fails closed on statements it can't read instead of silently skipping them.
const TARGET_PART = String.raw`(?:\`((?:\`\`|[^\`])+)\`|([0-9A-Za-z$_\u0080-\uffff]+))`
const WRITE_TARGET = new RegExp(String.raw`^\s*(?:update|insert\s+into|delete\s+from)\s+${TARGET_PART}(?:\s*\.\s*${TARGET_PART})?`, 'i')

export function writeTargetTable(sql: string): { schema: string | null; name: string } | null {
  const match = WRITE_TARGET.exec(sql)
  if (!match) return null
  const unescape = (part: string) => part.replaceAll('``', '`')
  const first = match[1] !== undefined ? unescape(match[1]) : match[2]!
  const second = match[3] !== undefined ? unescape(match[3]) : match[4]
  return second === undefined ? { schema: null, name: first } : { schema: first, name: second }
}

/** "9.3.0" → "MySQL 9.3.0"; "11.4.2-MariaDB-…" → "MariaDB 11.4.2". */
export function mysqlVersion(raw: string): string {
  const maria = /^(.+?)-MariaDB/i.exec(raw)
  return maria ? `MariaDB ${maria[1]}` : `MySQL ${raw}`
}

/** The masking-relevant flags of an @@sql_mode value (composite modes like ANSI
 * arrive pre-expanded by the server, so a plain token test suffices). */
export function sqlModeFlags(mode: string): SqlModeFlags {
  return {
    noBackslashEscapes: /\bNO_BACKSLASH_ESCAPES\b/i.test(mode),
    ansiQuotes: /\bANSI_QUOTES\b/i.test(mode),
  }
}

// MySQL with all-databases support, mirroring the postgres driver: one pool per
// child database (a MySQL "database" and "schema" are the same thing), queries
// and metadata always target the active child via the pool's default schema.
// Dials the endpoint — the transport layer may have rewritten host/port to an
// SSH tunnel's local end.
type RunningEntry = { executionId?: string; threadId: number | null; cancelRequested: boolean }

export function createMysqlDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pools: Map<string, mysql.Pool> | null = null
  let childNames: string[] = []
  let active = ''
  // sql_mode flags that change how scripts must be masked (NO_BACKSLASH_ESCAPES,
  // ANSI_QUOTES); read once at connect — pooled sessions inherit the same value.
  let sqlMode: SqlModeFlags = {}
  // Thread ids of in-flight user statements, so cancel() can KILL QUERY them.
  const running = new Set<RunningEntry>()
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
      // RESET CONNECTION on release rolls back implicit transactions and
      // removes SET/session/temp-table state before another tab borrows it.
      resetOnRelease: true,
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
    if (!pool) throw new Error(t('connection.notConnected'))
    return pool
  }

  const poolForQuery = (childDb?: string | null) => {
    if (!childDb) return activePool()
    const pool = pools?.get(childDb)
    if (!pool) throw new Error(t('connection.databaseUnavailable', { database: childDb ?? '' }))
    return pool
  }

  // Metadata helper: object rows, cast to the query's concrete shape.
  const metaRows = async <T>(sql: string, params: unknown[] = [], childDb?: string | null): Promise<T[]> => {
    const [rows] = await poolForQuery(childDb).query(sql, params)
    return rows as unknown as T[]
  }

  const dialect = dialectFor(profile.engine)

  const killQueries = async (entries: RunningEntry[], database: string) => {
    const conn = await mysql.createConnection({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database: database || undefined,
      ssl,
      connectTimeout: 8000,
    })
    try {
      // The dial takes real time; a finished query's connection (same thread id)
      // may now serve another query — re-check so a late KILL can't hit it.
      const live = entries.filter((entry) => running.has(entry) && entry.threadId !== null)
      return await Promise.all(live.map((entry) => conn.query(`kill query ${entry.threadId}`).then(() => true).catch(() => false)))
    } finally {
      await conn.end().catch(() => {})
    }
  }

  return {
    async connect() {
      const discovery = profile.database.trim()
      pools = new Map([[discovery, makePool(discovery)]])
      // Point metaRows at the discovery pool; re-resolved after children load.
      active = discovery

      const banner = (await metaRows<{ version: string; mode: string }>('select version() as version, @@sql_mode as mode'))[0]
      const version = mysqlVersion(banner?.version ?? '')
      sqlMode = sqlModeFlags(banner?.mode ?? '')

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

    async query(sql, params = [], childDb = null, sort = null, filter = null, executionId) {
      const started = performance.now()
      const plan = prepareSqlRun({ engine: 'mysql', sql, params, sort, filter, sqlMode })
      // Checked out manually so the thread id is known while the statement
      // runs and cancel() has a KILL QUERY target.
      const entry = { executionId, threadId: null as number | null, cancelRequested: false }
      running.add(entry)
      let conn: mysql.PoolConnection | null = null
      // Leaves `running` before the connection re-enters the pool, so a late
      // KILL QUERY can never target this thread once another query has it.
      const releaseToPool = () => {
        running.delete(entry)
        conn?.release()
        conn = null
      }
      try {
        conn = await poolForQuery(childDb).getConnection()
        const raw = rawOf(conn)
        entry.threadId = raw.threadId ?? null
        if (entry.cancelRequested) {
          releaseToPool()
          throw new Error(t('query.cancelled'))
        }
        const result = await streamQuery(raw, plan.batches[0]!, plan.params, started)
        releaseToPool()
        return result
      } catch (error) {
        // The connection may hold half-read results; drop it rather than reuse.
        conn?.destroy()
        throw isInterrupted(error) || (error as Error).message === t('query.cancelled') ? new Error(t('query.cancelled')) : error
      } finally {
        running.delete(entry)
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // One checked-out connection for the whole batch so the transaction binds
      // every statement.
      const conn = await poolForQuery(childDb).getConnection()
      const entry = { threadId: rawOf(conn).threadId ?? null, cancelRequested: false }
      running.add(entry)
      // Leaves `running` before the connection re-enters the pool (see query()).
      const releaseToPool = () => {
        running.delete(entry)
        conn.release()
      }
      let index = -1
      try {
        // BEGIN/COMMIT are silent no-ops on MyISAM-style engines, so a mid-batch
        // failure would half-apply: refuse before anything runs. A statement
        // whose target can't be parsed fails closed rather than skipping the check.
        const targets = statements.map((statement) => writeTargetTable(statement.sql))
        if (targets.some((target) => target === null)) {
          releaseToPool()
          return { success: false, error: t('connection.mysqlTransactionUnknown') }
        }
        const unique = [...new Map(targets.map((target) => [`${target!.schema ?? ''}/${target!.name}`, target!])).values()]
        const conditions = unique
          .map((target) => (target.schema === null
            ? '(table_schema = database() and table_name = ?)'
            : '(table_schema = ? and table_name = ?)'))
          .join(' or ')
        // Aliased like every other metadata query: MySQL 8 returns
        // information_schema columns uppercase unless forced.
        const [rows] = await conn.query(
          `select table_name as table_name, engine as engine from information_schema.tables where ${conditions}`,
          unique.flatMap((target) => (target.schema === null ? [target.name] : [target.schema, target.name])),
        )
        const unsafe = (rows as Array<{ table_name: string; engine: string | null }>).filter(
          (row) => row.engine !== null && !['InnoDB', 'NDBCLUSTER'].includes(row.engine),
        )
        if (unsafe.length) {
          releaseToPool()
          return {
            success: false,
            error: `Atomic saves are unavailable for non-transactional table(s): ${unsafe.map((row) => row.table_name).join(', ')}`,
          }
        }
        await conn.beginTransaction()
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          const [result] = await conn.query(statement.sql, statement.params)
          // A write that matched nothing means the row moved or vanished since
          // the user reviewed it — abort the whole batch rather than half-apply.
          const affected = (result as { affectedRows?: number }).affectedRows ?? 0
          if (statement.expectedRows !== undefined ? affected !== statement.expectedRows : affected === 0) {
            await conn.rollback()
            releaseToPool()
            return {
              success: false,
              failedIndex: index,
              error: statement.expectedRows !== undefined
                ? `Expected ${statement.expectedRows} affected row(s), but ${affected} matched. Refresh and try again.`
                : BATCH_ZERO_ROWS,
            }
          }
        }
        await conn.commit()
        releaseToPool()
        return { success: true }
      } catch (error) {
        // Uncertain transaction state: closing the connection aborts it.
        conn.destroy()
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isInterrupted(error) ? t('query.saveCancelled') : (error as Error).message,
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
      const entry = { threadId: rawOf(conn).threadId ?? null, cancelRequested: false }
      running.add(entry)
      // Leaves `running` before the connection re-enters the pool (see query()).
      const releaseToPool = () => {
        running.delete(entry)
        conn.release()
      }
      let index = -1
      try {
        for (index = 0; index < statements.length; index += 1) {
          await conn.query(statements[index]!)
        }
        releaseToPool()
        return { success: true }
      } catch (error) {
        conn.destroy()
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          partial: index > 0,
          appliedCount: Math.max(0, index),
          error: isInterrupted(error) ? t('query.saveCancelled') : (error as Error).message,
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
      if (!pools) throw new Error(t('connection.notConnected'))
      if (name === active) {
        throw new Error(t('database.cannotDropCurrent'))
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

    async cancel(executionId) {
      // KILL QUERY from a fresh out-of-band connection — the pool's clients are
      // occupied by the very statements being cancelled. A thread that already
      // finished is a no-op error, counted as not cancelled.
      const entries = [...running].filter((entry) => executionId === undefined || entry.executionId === executionId)
      const queued = entries.filter((entry) => entry.threadId === null)
      for (const entry of queued) entry.cancelRequested = true
      const targets = entries.filter((entry) => entry.threadId !== null)
      if (!targets.length) return { running: entries.length, cancelled: queued.length }
      const sent = await killQueries(targets, active)
      return { running: entries.length, cancelled: queued.length + sent.filter(Boolean).length }
    },

    async exportQuery({ sql, params, childDb, sort, filter, filePath, format, executionId }) {
      const plan = prepareSqlRun({ engine: 'mysql', sql, params, sort, filter, sqlMode })
      // The manager's read-only gate masks with default flags; recheck with the
      // session's real sql_mode — NO_BACKSLASH_ESCAPES can hide a second
      // statement that this multipleStatements connection would execute.
      if (!isReadOnlyQuery(plan.batches[0]!, 'mysql', sqlMode)) throw new Error(t('export.readOnlyOnly'))
      // Registered like query() so Stop (and disconnect) can KILL QUERY a
      // runaway export instead of it streaming to completion unstoppably.
      const entry = { executionId, threadId: null as number | null, cancelRequested: false }
      running.add(entry)
      let conn: mysql.PoolConnection | null = null
      const writer = openExportWriter(filePath, format)
      try {
        conn = await poolForQuery(childDb).getConnection()
        entry.threadId = rawOf(conn).threadId ?? null
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
        await streamMysqlExport(rawOf(conn), plan.batches[0]!, plan.params, writer)
        const result = await writer.close()
        // Leaves `running` before the connection re-enters the pool (see query()).
        running.delete(entry)
        conn.release()
        conn = null
        return result
      } catch (error) {
        await writer.close().catch(() => {})
        // May hold half-read results; drop it rather than reuse.
        conn?.destroy()
        throw isInterrupted(error) || (error as Error).message === t('query.cancelled') ? new Error(t('query.cancelled')) : error
      } finally {
        running.delete(entry)
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

    async objectDdl(ref, childDb = null) {
      // SHOW CREATE can't be parameterized, so the identifier is quoted inline.
      const target = ref.schema
        ? `${dialect.quoteIdent(ref.schema)}.${dialect.quoteIdent(ref.name)}`
        : dialect.quoteIdent(ref.name)
      const objectType = ref.kind === 'function' ? 'FUNCTION' : 'VIEW'
      const column = ref.kind === 'function' ? 'Create Function' : 'Create View'
      const rows = await metaRows<Record<string, string | null>>(`SHOW CREATE ${objectType} ${target}`, [], childDb)
      const create = rows[0]?.[column]
      if (!create) throw new Error(`${objectType === 'FUNCTION' ? 'Function' : 'View'} ${ref.name} was not found.`)
      // MySQL has no CREATE OR REPLACE for functions (and SHOW CREATE VIEW omits
      // it), so drop-then-create makes the statement re-runnable.
      return `DROP ${objectType} IF EXISTS ${target};\n\n${create}`
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

      const [columns, primaryKey, foreignKeys, checks, indexes, partitions, triggers] = await Promise.all([
        metaRows<{ name: string; data_type: string; nullable: number; default_expr: string | null; pk: number; fk: number; comment: string | null; extra: string }>(
          `select c.column_name as name, c.column_type as data_type, c.is_nullable = 'YES' as nullable,
                  c.column_default as default_expr, c.column_key = 'PRI' as pk,
                  exists (select 1 from information_schema.key_column_usage k
                          where k.table_schema = c.table_schema and k.table_name = c.table_name
                            and k.column_name = c.column_name and k.referenced_table_name is not null) as fk,
                  nullif(c.column_comment, '') as comment, c.extra as extra
           from information_schema.columns c
           where c.table_schema = database() and c.table_name = ? order by c.ordinal_position`,
          args,
          childDb,
        ),
        // The primary key (constraint name is always PRIMARY); one row or none.
        metaRows<Row>(
          `select 'PRIMARY' as name,
                  concat('PRIMARY KEY (', group_concat(column_name order by seq_in_index separator ', '), ')') as definition
           from information_schema.statistics
           where table_schema = database() and table_name = ? and index_name = 'PRIMARY'
           group by index_name`,
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
        // PK is shown read-only in the UI (also the columns table's key marker), like FKs.
        { title: 'Constraints', rows: [...primaryKey, ...checks] },
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
          foreignKey: !!row.fk,
          // extra reads "STORED GENERATED" / "VIRTUAL GENERATED" for a generated column.
          generated: /generated/i.test(row.extra),
          identity: row.extra.includes('auto_increment') ? 'default' as const : undefined,
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

// Streams rows so a huge or multi-result query can't OOM the main process.
// The byte budget is shared by every result set in this execution. Rows beyond
// the caps are drained without being kept: killing the statement instead could
// sever a SELECT with side effects partway through.
function streamQuery(
  raw: RawConnection,
  sql: string,
  params: unknown[],
  started: number,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let columns: string[] = []
    let columnSources: QueryResult['columnSources']
    let rows: unknown[][] = []
    let total = 0
    let bufferedBytes = 0
    let limited = false
    let active = false
    const resultSets: QueryResultSet[] = []
    const pushCurrent = () => {
      if (!active) return
      resultSets.push({
        columns,
        columnSources,
        rows,
        rowCount: total,
        truncated: limited || total > rows.length,
        rowCountExact: true,
      })
      active = false
    }
    const query = raw.query({ sql, values: params, rowsAsArray: true })
    query.on('fields', (fields) => {
      pushCurrent()
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
      limited = false
      active = true
    })
    query.on('result', (row) => {
      if (Array.isArray(row)) {
        total += 1
        if (rows.length < MAX_BUFFERED_ROWS) {
          const bounded = boundedRow(row as unknown[], bufferedBytes)
          if (bounded) {
            rows.push(bounded.row)
            bufferedBytes += bounded.bytes
            limited ||= bounded.truncated
          } else {
            limited = true
          }
        } else {
          limited = true
        }
      } else {
        // An OK packet (INSERT/UPDATE/…): rowCount is the affected count.
        pushCurrent()
        columns = []
        columnSources = undefined
        rows = []
        total = (row as { affectedRows?: number }).affectedRows ?? 0
        limited = false
        active = true
      }
    })
    const finish = () => {
      pushCurrent()
      const selected = resultSets[resultSets.length - 1] ?? { columns: [], rows: [], rowCount: 0 }
      resolve({
        ...selected,
        durationMs: performance.now() - started,
        ...(resultSets.length > 1 ? { resultSets } : {}),
      })
    }
    query.on('error', reject)
    query.on('end', finish)
  })
}

// Streams every row of a read-only query into `writer` with backpressure: while
// a chunk is written to disk the connection is paused so the server can't
// outrun the file. No row cap — the whole result reaches the file.
function streamMysqlExport(
  raw: RawConnection,
  sql: string,
  params: unknown[],
  writer: ExportWriter,
  chunkSize = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let columnsSet = false
    let chunk: unknown[][] = []
    let draining = false
    let ended = false
    let failed = false
    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const flush = () => {
      if (draining || failed) return
      if (chunk.length === 0) {
        if (ended) resolve()
        return
      }
      const batch = chunk
      chunk = []
      draining = true
      raw.pause()
      writer.rows(batch).then(() => {
        draining = false
        raw.resume()
        flush()
      }, fail)
    }
    const query = raw.query({ sql, values: params, rowsAsArray: true })
    query.on('fields', (fields) => {
      if (columnsSet) return
      const list = Array.isArray(fields) ? (fields as FieldMeta[]) : []
      writer.columns(list.map((field) => field.name))
      columnsSet = true
    })
    query.on('result', (row) => {
      // Read-only single result set, so only data rows arrive (no OK packets).
      if (Array.isArray(row)) {
        chunk.push(row as unknown[])
        if (chunk.length >= chunkSize) flush()
      }
    })
    query.on('error', fail)
    query.on('end', () => {
      ended = true
      flush()
    })
  })
}
