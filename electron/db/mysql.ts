import mysql from 'mysql2/promise'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef } from '../../src/electron'
import { dialectFor, sqlOptionToken } from '../../src/dialect'
import { columnReference } from './column-reference'
import { APP_CONNECTION_NAME, BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS, MAX_POOL_CONNECTIONS, MAX_SESSIONS, POOL_IDLE_MS } from './limits'
import { formatUptime } from './server-stats'
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

type FieldMeta = { name: string; db?: string; schema?: string; orgTable?: string; orgName?: string; columnType?: number; type?: number }

// mysql2 emits `fields(undefined)` immediately before an INSERT/UPDATE/DELETE
// OK packet. That is protocol metadata, not a separate empty result set.
export const mysqlResultFields = (fields: unknown): FieldMeta[] | null =>
  Array.isArray(fields) ? fields as FieldMeta[] : null

// MYSQL_TYPE_JSON in the wire protocol's column definitions. MariaDB never
// sends it (its JSON is LONGTEXT on the wire), so MariaDB JSON exports keep
// their pre-detection quoting rather than guessing from cell contents.
const MYSQL_TYPE_JSON = 245

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

/** Whether connection attributes can identify sessions opened by SqlKit. */
export function mysqlSessionIdentificationAvailable(enabled: unknown, attrsSize: unknown): boolean {
  return Number(enabled) === 1 && Number(attrsSize) !== 0
}

/**
 * The column a MariaDB JSON alias guards: json_valid(`doc`) → doc. MariaDB has
 * no JSON type — declaring one makes a LONGTEXT plus exactly this check — so
 * the constraint is the only place the declaration survives. Strict on purpose:
 * MySQL wraps its check clauses in parens and never needs this (its columns say
 * `json` directly), and a looser expression is a user check, not a type.
 */
export function jsonValidColumn(clause: string): string | null {
  const match = /^json_valid\(`((?:``|[^`])+)`\)$/i.exec(clause.trim())
  return match ? match[1]!.replaceAll('``', '`') : null
}

// MySQL with all-databases support, mirroring the postgres driver: only the
// database in use holds a pool (a MySQL "database" and "schema" are the same
// thing), so the connection budget is spent on one database rather than every
// child. Queries and metadata target the active child via the pool's default
// schema; switching child retires the outgoing pool.
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
  let isMariaDb = false
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
      // Identifies the app in processlist / session_connect_attrs, so the Tasks
      // dashboard can tell its own sessions from everyone else's.
      connectAttributes: { program_name: APP_CONNECTION_NAME },
      connectionLimit: MAX_POOL_CONNECTIONS,
      idleTimeout: POOL_IDLE_MS,
      connectTimeout: 8000,
      // mysql2 queues checkouts without bound by default; cap the backlog so a
      // saturated pool errors instead of growing a queue nobody drains.
      queueLimit: 64,
      // RESET CONNECTION on release rolls back implicit transactions and
      // removes SET/session/temp-table state before another tab borrows it.
      resetOnRelease: true,
      multipleStatements: true,
      // Lossless values: temporals as strings, BIGINT past 2^53 as strings
      // (safe-range ones stay numbers), DECIMAL as strings (mysql2 default),
      // and JSON as wire text so numeric literals never pass through JSON.parse.
      dateStrings: true,
      supportBigNumbers: true,
      jsonStrings: true,
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

  // The pool for `database`, opening it on demand and retiring whichever other
  // one was live. end() drains rather than severs, so work already in flight on
  // the outgoing database finishes; the next call for it opens a fresh pool.
  const poolFor = (database: string) => {
    if (!pools) throw new Error(t('connection.notConnected'))
    const existing = pools.get(database)
    if (existing) return existing
    for (const [name, pool] of pools) {
      pools.delete(name)
      void pool.end().catch(() => {})
    }
    const pool = makePool(database)
    pools.set(database, pool)
    return pool
  }

  const activePool = () => poolFor(active)

  const poolForQuery = (childDb?: string | null) => {
    if (!childDb) return activePool()
    if (!childNames.includes(childDb)) throw new Error(t('connection.databaseUnavailable', { database: childDb }))
    return poolFor(childDb)
  }

  // mysql2's pool has no acquire timeout (pg bounds the wait with
  // connectionTimeoutMillis, node-mssql through tarn's acquireTimeoutMillis), so
  // four long user queries would queue every metadata read behind them forever —
  // the explorer, inspector and completions hang with nothing to report. Bound
  // the wait so they fail fast with a message instead.
  const ACQUIRE_TIMEOUT_MS = 8_000

  const acquire = (pool: mysql.Pool): Promise<mysql.PoolConnection> =>
    new Promise((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        reject(new Error(t('connection.poolBusy')))
      }, ACQUIRE_TIMEOUT_MS)
      pool.getConnection().then(
        (conn) => {
          clearTimeout(timer)
          // Checkout won the race after we gave up: hand it straight back rather
          // than leak a connection nobody will release.
          if (timedOut) conn.release()
          else resolve(conn)
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (!timedOut) reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })

  // Metadata helper: object rows, cast to the query's concrete shape. Checked out
  // explicitly (not pool.query) so the bounded acquire above applies.
  const metaRows = async <T>(sql: string, params: unknown[] = [], childDb?: string | null): Promise<T[]> => {
    const conn = await acquire(poolForQuery(childDb))
    try {
      const [rows] = await conn.query(sql, params)
      return rows as unknown as T[]
    } finally {
      conn.release()
    }
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
      isMariaDb = version.startsWith('MariaDB')

      const userSchemas = async () => (await metaRows<{ name: string }>(
        `select schema_name as name from information_schema.schemata
         where schema_name not in (${SYSTEM_SCHEMAS.map(() => '?').join(', ')}) order by schema_name`,
        SYSTEM_SCHEMAS,
      )).map((row) => row.name)

      if (profile.databaseMode === 'all') {
        childNames = await userSchemas()
        if (!childNames.length) childNames = discovery ? [discovery] : []
        if (!childNames.length) throw new Error(t('connection.mysqlNoDatabase'))
      } else if (discovery) {
        childNames = [discovery]
      } else {
        // MySQL has no universal default schema to fall back on the way Postgres
        // has `postgres` and SQL Server has `master`. Connecting schema-less
        // leaves every metadata query's database() NULL, so the app would report
        // "connected" over an empty explorer with nothing explaining why. Refuse
        // instead: picking a schema on the user's behalf would silently aim
        // their next DROP or UPDATE at a database they never chose.
        throw new Error(t('connection.mysqlDatabaseRequired'))
      }

      active = childNames.includes(discovery) ? discovery : childNames[0]!
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
        conn = await acquire(poolForQuery(childDb))
        const raw = rawOf(conn)
        entry.threadId = raw.threadId ?? null
        if (entry.cancelRequested) {
          releaseToPool()
          throw new Error(t('query.cancelled'))
        }
        const result = await streamQuery(raw, plan.batches[0]!, plan.params, started, childDb ?? active)
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
      const conn = await acquire(poolForQuery(childDb))
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
      const conn = await acquire(poolForQuery(childDb))
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

    async databaseCreateMeta() {
      const charsets = await metaRows<{ name: string; def: string }>(
        'select character_set_name as name, default_collate_name as def from information_schema.character_sets order by name',
      )
      const collations = await metaRows<{ name: string; cs: string }>(
        'select collation_name as name, character_set_name as cs from information_schema.collations order by cs, name',
      )
      const collationsByCharset: Record<string, string[]> = {}
      for (const row of collations) (collationsByCharset[row.cs] ??= []).push(row.name)
      const defaultCollationByCharset: Record<string, string> = {}
      for (const row of charsets) defaultCollationByCharset[row.name] = row.def
      const [server] = await metaRows<{ charset: string; collation: string }>(
        'select @@character_set_server as charset, @@collation_server as collation',
      )
      return {
        engine: profile.engine,
        charsets: charsets.map((row) => row.name),
        collations: collations.map((row) => row.name),
        collationsByCharset,
        defaultCollationByCharset,
        defaults: { charset: server?.charset, collation: server?.collation },
      }
    },

    async createDatabase(name, options) {
      let sql = `create database ${dialect.quoteIdent(name)}`
      // charset/collation are bare-word identifiers in MySQL; the strict guard
      // both validates and blocks injection, so no quoting is needed.
      if (options?.charset) sql += ` character set ${sqlOptionToken(options.charset)}`
      if (options?.collation) sql += ` collate ${sqlOptionToken(options.collation)}`
      await activePool().query(sql)
      // Browsable straight away; its pool opens when the user switches to it.
      if (profile.databaseMode === 'all' && pools && !childNames.includes(name)) {
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
      // A refused drop propagates: the database stays in childNames, so it
      // remains browsable and re-opens its pool on demand.
      await activePool().query(`drop database ${dialect.quoteIdent(name)}`)
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

    async exportQuery({ sql, params, childDb, sort, filter, filePath, format, sqlTarget, executionId }) {
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
      const writer = openExportWriter(filePath, format, sqlTarget)
      try {
        conn = await acquire(poolForQuery(childDb))
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
      const rows = await metaRows<{
        table_name: string
        name: string
        data_type: string
        nullable: number
        pk: number
        fk: number
        ref_constraint: string | null
        ref_schema: string | null
        ref_table: string | null
        ref_column: string | null
      }>(
        // The FK target rides along on the same key_column_usage row the fk flag
        // is derived from. A column can sit in several foreign keys, so the NOT
        // EXISTS keeps exactly one row per column — the first constraint by name,
        // matching the postgres driver's rule so the pick is stable either side.
        // referenced_table_schema collapses to null for the active database, like
        // listTables' TableRefs; a cross-database FK keeps its schema so it can
        // never bind to a same-named table in the active one.
        `select c.table_name as table_name, c.column_name as name, c.column_type as data_type,
                c.is_nullable = 'YES' as nullable, c.column_key = 'PRI' as pk,
                exists (select 1 from information_schema.key_column_usage k
                        where k.table_schema = c.table_schema and k.table_name = c.table_name
                          and k.column_name = c.column_name and k.referenced_table_name is not null) as fk,
                ref.constraint_name as ref_constraint,
                nullif(ref.referenced_table_schema, database()) as ref_schema,
                ref.referenced_table_name as ref_table,
                ref.referenced_column_name as ref_column
         from information_schema.columns c
         left join information_schema.key_column_usage ref
           on ref.table_schema = c.table_schema and ref.table_name = c.table_name
          and ref.column_name = c.column_name and ref.referenced_table_name is not null
          and not exists (select 1 from information_schema.key_column_usage earlier
                          where earlier.table_schema = ref.table_schema and earlier.table_name = ref.table_name
                            and earlier.column_name = ref.column_name
                            and earlier.referenced_table_name is not null
                            and earlier.constraint_name < ref.constraint_name)
         where c.table_schema = database()
         order by c.table_name, c.ordinal_position`,
        [],
        childDb,
      )
      // MariaDB's JSON columns are LONGTEXT under a json_valid check — the type
      // itself never says "json", so read the declaration back off the checks.
      // check_constraints carries table_name only on MariaDB, hence the gate.
      const jsonChecks = isMariaDb
        ? await metaRows<{ table_name: string; clause: string }>(
          `select table_name, check_clause as clause
           from information_schema.check_constraints where constraint_schema = database()`,
          [],
          childDb,
        ).catch(() => [])
        : []
      const jsonByTable = new Map<string, Set<string>>()
      for (const check of jsonChecks) {
        const column = jsonValidColumn(check.clause)
        if (!column) continue
        const set = jsonByTable.get(check.table_name) ?? new Set<string>()
        set.add(column)
        jsonByTable.set(check.table_name, set)
      }
      return rows.map(
        (row): ColumnRef => ({
          schema: null,
          table: row.table_name,
          name: row.name,
          dataType: row.data_type === 'longtext' && jsonByTable.get(row.table_name)?.has(row.name) ? 'json' : row.data_type,
          nullable: !!row.nullable,
          primaryKey: !!row.pk,
          foreignKey: !!row.fk,
          ...columnReference(row.ref_schema, row.ref_table, row.ref_column, row.ref_constraint),
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

    async serverActivity(childDb = null) {
      type SessionRow = {
        id: string
        user: string
        database: string | null
        state: string
        elapsed_ms: number | null
        sql: string | null
        self: number
      }
      type PerformanceSchemaRow = {
        enabled: number | string
        attrs_size: number | string
      }
      // Daemon threads (the event scheduler) are not sessions anyone can act on,
      // and the reader excludes itself so the polling query doesn't head its own
      // list on every refresh.
      const notDaemon = `coalesce(p.command, '') <> 'Daemon' and p.id <> connection_id()`
      const columns = `cast(p.id as char) as id,
                       coalesce(p.user, '') as user,
                       p.db as \`database\`,
                       lower(coalesce(p.command, '')) as state,
                       p.time * 1000 as elapsed_ms,
                       nullif(trim(coalesce(p.info, '')), '') as \`sql\``
      const order = `order by (coalesce(p.command, '') <> 'Sleep') desc, p.time desc limit ${MAX_SESSIONS}`
      const [performanceSchema] = await metaRows<PerformanceSchemaRow>(
        `select @@performance_schema as enabled,
                @@performance_schema_session_connect_attrs_size as attrs_size`,
        [],
        childDb,
      ).catch(() => [])
      let selfIdentificationAvailable = mysqlSessionIdentificationAvailable(
        performanceSchema?.enabled,
        performanceSchema?.attrs_size,
      )
      const sessionsWithoutSelf = () => metaRows<SessionRow>(
        `select ${columns}, 0 as self
         from information_schema.processlist p where ${notDaemon} ${order}`,
        [],
        childDb,
      )
      let sessions: SessionRow[]
      if (selfIdentificationAvailable) {
        // program_name comes from the connect attributes, which only populate
        // when Performance Schema and its attribute buffer are enabled.
        try {
          sessions = await metaRows<SessionRow>(
            `select ${columns},
                    coalesce(a.attr_value = ?, 0) as self
             from information_schema.processlist p
             left join performance_schema.session_connect_attrs a
               on a.processlist_id = p.id and a.attr_name = 'program_name'
             where ${notDaemon} ${order}`,
            [APP_CONNECTION_NAME],
            childDb,
          )
        } catch {
          selfIdentificationAvailable = false
          sessions = await sessionsWithoutSelf()
        }
      } else {
        sessions = await sessionsWithoutSelf()
      }

      const [counts] = await metaRows<{ used: number; max: number }>(
        `select (select count(*) from information_schema.processlist p where ${notDaemon}) as used,
                @@max_connections as max`,
        [],
        childDb,
      )
      // SHOW GLOBAL STATUS is available whether or not performance_schema is,
      // but names its columns Variable_name/Value — MariaDB included.
      const status = await metaRows<Record<string, string>>(
        `show global status where variable_name in
           ('Uptime', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')`,
        [],
        childDb,
      ).catch(() => [])
      const value = (name: string) => {
        const row = status.find((entry) => String(entry.Variable_name ?? '').toLowerCase() === name.toLowerCase())
        return Number(row?.Value ?? NaN)
      }
      const requests = value('Innodb_buffer_pool_read_requests')
      const reads = value('Innodb_buffer_pool_reads')
      const uptime = value('Uptime')

      return {
        connections: { used: counts?.used ?? 0, max: counts?.max ?? null },
        stats: [
          ...(Number.isFinite(uptime) ? [{ label: 'Uptime', value: formatUptime(uptime) }] : []),
          ...(Number.isFinite(requests) && requests > 0 && Number.isFinite(reads)
            ? [{ label: 'Buffer pool hit', value: `${(100 * (1 - reads / requests)).toFixed(1)}%` }]
            : []),
        ],
        selfIdentificationAvailable,
        sessions: sessions.map((row) => ({
          id: String(row.id),
          user: row.user,
          database: row.database,
          state: row.state,
          elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
          sql: row.sql,
          self: Number(row.self) === 1,
        })),
      }
    },

    async endSession(sessionId, mode) {
      // KILL takes a bare integer, so the id is validated rather than quoted.
      const id = Number(sessionId)
      if (!Number.isInteger(id) || id <= 0) throw new Error(t('server.sessionUnknown'))
      await metaRows(`KILL ${mode === 'terminate' ? 'CONNECTION' : 'QUERY'} ${id}`)
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
  activeDb: string,
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
      const list = mysqlResultFields(fields)
      if (!list) return
      pushCurrent()
      columns = list.map((field) => field.name)
      // Active-db columns get schema null to match listTables' TableRefs; cross-db
      // ones keep the db name so they never bind to a same-named active-db table.
      const sourceSchema = (field: FieldMeta) => {
        const db = field.db ?? field.schema ?? null
        return db && db.toLowerCase() === activeDb.toLowerCase() ? null : db
      }
      columnSources = list.some((field) => field.orgTable && field.orgName)
        ? list.map((field) =>
            field.orgTable && field.orgName
              ? { schema: sourceSchema(field), table: field.orgTable, column: field.orgName }
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
      // JSON columns by result position — spliced into a JSON export as raw
      // documents rather than quoted text.
      const jsonColumns = new Set(list.flatMap((field, index) =>
        (field.columnType ?? field.type) === MYSQL_TYPE_JSON ? [index] : []))
      writer.columns(list.map((field) => field.name), jsonColumns)
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
