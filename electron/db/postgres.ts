import pg from 'pg'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionOptions } from 'node:tls'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import { isReadOnlyQuery } from '../../src/sql-order'
import { BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS } from './limits'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { openExportWriter, type ExportWriter } from './export'
import { prepareSqlRun } from './sql-script'

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

export function sslOptions(profile: ConnectionProfile): boolean | ConnectionOptions {
  const ssl = profile.ssl
  if (!ssl || ssl.mode === 'disable') return false
  if (ssl.mode === 'require') return { rejectUnauthorized: false }

  const options: ConnectionOptions = { rejectUnauthorized: true }
  const caPath = ssl.ca.trim()
  if (caPath) {
    try {
      if (statSync(expandHome(caPath)).size > 5 * 1024 * 1024) throw new Error('certificate file exceeds 5 MB')
      options.ca = readFileSync(expandHome(caPath), 'utf8')
    } catch (error) {
      throw new Error(`Failed to read SSL CA certificate at ${caPath}: ${(error as Error).message}`, { cause: error })
    }
  }
  if (ssl.mode === 'verify-ca') options.checkServerIdentity = () => undefined
  return options
}

// PostgreSQL with all-databases support (reference behavior): connect to a
// discovery database, optionally list every database on the server, and keep
// one pg.Pool per child — pools open connections lazily, so unused children
// cost nothing. Queries and table listings always target the active child.
// Dials the endpoint, not the profile — the transport layer may have
// rewritten host/port to an SSH tunnel's local end.
type RunningEntry = { executionId?: string; pid: number | null; cancelRequested: boolean }

// node-postgres exposes the backend PID at runtime but omits it from the public
// PoolClient type. Keep that upgrade-sensitive assertion at one boundary.
const backendPid = (client: pg.PoolClient): number | null =>
  (client as pg.PoolClient & { processID?: number }).processID ?? null

// The client's underlying socket, for pausing reads to backpressure a streamed
// export. node-postgres doesn't expose it publicly, so reach it at one boundary.
const clientSocket = (client: pg.PoolClient): { pause(): void; resume(): void } | null =>
  (client as pg.PoolClient & { connection?: { stream?: { pause(): void; resume(): void } } }).connection?.stream ?? null

// The connection's transaction status from its last ReadyForQuery ('I' idle,
// 'T' in transaction, 'E' failed). node-postgres records it but doesn't type it.
const txStatus = (client: pg.PoolClient): string | null =>
  (client as pg.PoolClient & { _txStatus?: string | null })._txStatus ?? null

export function createPostgresDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pools: Map<string, pg.Pool> | null = null
  let childNames: string[] = []
  let active = ''
  // Backend PIDs of in-flight user queries so cancel() can interrupt them. Two
  // tabs can run on one connection at once, so this is a set rather than a
  // single slot — a single slot let a second run clobber the first's cancel
  // target, and the first's completion then cleared it.
  const running = new Set<RunningEntry>()
  const ssl = sslOptions(profile)
  const losslessTypes = new pg.TypeOverrides()

  // node-postgres otherwise turns timestamp/date values into JavaScript Date
  // objects, losing the original timezone/precision (and interpreting a
  // timestamp-without-zone in the workstation timezone). Keep temporal wire
  // values as text. Array forms remain PostgreSQL array literals for the same
  // reason; callers can inspect them without a lossy intermediate conversion.
  // numeric[] (1231) is included: pg-types runs its elements through parseFloat,
  // silently rounding past 2^53, while scalar numeric already arrives as text.
  for (const oid of [1082, 1083, 1114, 1184, 1186, 1266, 1115, 1182, 1183, 1185, 1187, 1270, 1231]) {
    losslessTypes.setTypeParser(oid, (value) => value)
  }

  const makePool = (database: string) => {
    const pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database,
      ssl,
      types: losslessTypes,
      max: 4,
      connectionTimeoutMillis: 8000,
    })
    // Idle clients emit 'error' when the server closes them (restart,
    // timeout); without a handler that exception takes down the main
    // process. The pool discards the client; surface it as a status update.
    pool.on('error', (error) => events.onError(error.message))
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

  const dialect = dialectFor(profile.engine)

  // Cached result-column → source-column lookups, per child database (attrelid
  // OIDs are database-local, so children must not share keys). A child's cache
  // is cleared whenever its session runs anything that could change the catalog.
  const sourceCaches = new Map<string, Map<string, ColumnSource>>()
  const sourceCacheFor = (childDb?: string | null) => {
    const database = childDb ?? active
    let cache = sourceCaches.get(database)
    if (!cache) {
      cache = new Map()
      sourceCaches.set(database, cache)
    }
    return cache
  }

  const resetUserSession = async (client: pg.PoolClient) => {
    // User SQL runs on pooled physical sessions. Always leave the session at
    // its connection defaults before another tab can borrow it: DISCARD removes
    // SET state, temp objects, prepared statements and LISTEN registrations.
    // ROLLBACK only when the wire status reports an open/failed transaction
    // (unknown counts as open) — the overwhelmingly common idle case skips a
    // round trip and the "no transaction in progress" warning in server logs.
    if (txStatus(client) !== 'I') await client.query('ROLLBACK')
    await client.query('DISCARD ALL')
  }

  const cancelBackends = async (entries: RunningEntry[], database: string) => {
    const client = new pg.Client({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database,
      ssl,
      connectionTimeoutMillis: 8000,
    })
    try {
      await client.connect()
      // The dial takes real time; a finished query's client (same PID) may now
      // serve another query — re-check membership so a late cancel can't hit it.
      const live = entries.filter((entry) => running.has(entry) && entry.pid !== null)
      return await Promise.all(live.map((entry) => client
        .query<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [entry.pid])
        .then((result) => result.rows[0]?.ok === true)
        .catch(() => false)))
    } finally {
      await client.end().catch(() => {})
    }
  }

  return {
    async connect() {
      const discovery = profile.database.trim() || 'postgres'
      pools = new Map([[discovery, makePool(discovery)]])

      const result = await pools.get(discovery)!.query<{ version: string }>('select version()')
      const version = shortVersion(result.rows[0]?.version ?? '')

      if (profile.databaseMode === 'all') {
        const listed = await pools.get(discovery)!.query(
          'select datname from pg_database where datistemplate = false and datallowconn = true order by datname',
        )
        childNames = listed.rows.map((row: { datname: string }) => row.datname)
        if (!childNames.length) childNames = [discovery]
        for (const name of childNames) {
          if (!pools.has(name)) pools.set(name, makePool(name))
        }
      } else {
        childNames = [discovery]
      }

      // Prefer the configured database, otherwise the first discovered one.
      active = childNames.includes(discovery) ? discovery : (childNames[0] ?? discovery)
      return version
    },

    async disconnect() {
      const closing = pools
      pools = null
      if (!closing) return
      await Promise.all([...closing.values()].map((pool) => pool.end().catch(() => {})))
    },

    async query(sql, params = [], childDb = null, sort = null, executionId) {
      const started = performance.now()
      const plan = prepareSqlRun({ engine: 'postgresql', sql, params, sort })
      const pool = poolForQuery(childDb)
      // Checked out manually (not pool.query) so the backend PID is known
      // while the statement runs and cancel() has a target.
      const entry = { executionId, pid: null as number | null, cancelRequested: false }
      running.add(entry)
      let client: pg.PoolClient | null = null
      let released = false
      // Leaves `running` before the client re-enters the pool, so a late cancel
      // can never target this backend once another query has it.
      const releaseToPool = () => {
        running.delete(entry)
        client?.release()
        released = true
      }
      try {
        client = await pool.connect()
        entry.pid = backendPid(client)
        if (entry.cancelRequested) {
          releaseToPool()
          throw new Error('Query cancelled.')
        }
        const result = await streamQuery(client, plan.batches[0]!, plan.params, started, sourceCacheFor(childDb))
        // Anything that could have changed the catalog invalidates the cached
        // column-source lookups (a rename would otherwise map to stale names).
        if (!isReadOnlyQuery(sql, 'postgresql')) sourceCacheFor(childDb).clear()
        try {
          await resetUserSession(client)
          releaseToPool()
        } catch (resetError) {
          // The query itself succeeded; a failed reset (e.g. a pooler that
          // refuses DISCARD ALL) condemns only this client, not the result.
          running.delete(entry)
          client.release(resetError as Error)
          released = true
        }
        return result
      } catch (error) {
        // Mirror pool.query: an errored client is destroyed, not reused.
        if (client && !released) client.release(error as Error)
        throw (error as { code?: string }).code === '57014' || (error as Error).message === 'Query cancelled.'
          ? new Error('Query cancelled.')
          : error
      } finally {
        running.delete(entry)
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      const pool = poolForQuery(childDb)
      // One checked-out client for the whole batch: a pool-routed sequence would
      // spread the statements across backends, so BEGIN/COMMIT couldn't bind them.
      const client = await pool.connect()
      const entry = { pid: backendPid(client), cancelRequested: false }
      running.add(entry)
      // Leaves `running` before the client re-enters the pool (see query()).
      const releaseToPool = () => {
        running.delete(entry)
        client.release()
      }
      let index = -1
      try {
        await client.query('BEGIN')
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          const result = await client.query(statement.sql, statement.params)
          // A write that matched nothing means the row moved or vanished since
          // the user reviewed it — abort the whole batch rather than half-apply.
          const affected = result.rowCount ?? 0
          if (statement.expectedRows !== undefined ? affected !== statement.expectedRows : affected === 0) {
            await client.query('ROLLBACK')
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
        await client.query('COMMIT')
        releaseToPool()
        return { success: true }
      } catch (error) {
        // A statement (or COMMIT) threw: drop the client so its uncertain
        // transaction state is discarded — closing the connection aborts the txn.
        client.release(error as Error)
        const cancelled = (error as { code?: string }).code === '57014'
        return { success: false, failedIndex: index >= 0 ? index : undefined, error: cancelled ? 'Save cancelled.' : (error as Error).message }
      } finally {
        running.delete(entry)
      }
    },

    async runDdl(statements, childDb = null) {
      if (!statements.length) return { success: true }
      const pool = poolForQuery(childDb)
      const client = await pool.connect()
      const entry = { pid: backendPid(client), cancelRequested: false }
      running.add(entry)
      // Leaves `running` before the client re-enters the pool (see query()).
      const releaseToPool = () => {
        running.delete(entry)
        client.release()
      }
      let index = -1
      try {
        await client.query('BEGIN')
        for (index = 0; index < statements.length; index += 1) {
          // No params array: DDL runs over the simple-query protocol, and unlike
          // runBatch there's no rows-affected gate (ALTER/COMMENT affect 0 rows).
          await client.query(statements[index]!)
        }
        await client.query('COMMIT')
        // Schema changed: cached column-source lookups for this child are stale.
        sourceCacheFor(childDb).clear()
        releaseToPool()
        return { success: true }
      } catch (error) {
        client.release(error as Error)
        const cancelled = (error as { code?: string }).code === '57014'
        return { success: false, failedIndex: index >= 0 ? index : undefined, error: cancelled ? 'Save cancelled.' : (error as Error).message }
      } finally {
        running.delete(entry)
      }
    },

    async createDatabase(name) {
      // CREATE DATABASE refuses to run inside a transaction; a plain
      // single-statement pool query never opens one, so this is fine.
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
      // The server refuses while connections exist; ours must go first.
      const pool = pools.get(name)
      if (pool) {
        pools.delete(name)
        await pool.end().catch(() => {})
      }
      try {
        await activePool().query(`drop database ${dialect.quoteIdent(name)}`)
      } catch (error) {
        // Drop refused (e.g. someone else is connected): keep it browsable.
        if (pool) pools.set(name, makePool(name))
        throw error
      }
      childNames = childNames.filter((child) => child !== name)
      sourceCaches.delete(name)
    },

    async cancel(executionId) {
      // Interrupt every in-flight backend on this connection — the UI's Stop
      // is per-connection. Issue the cancels from a fresh out-of-band
      // connection, not the pool the running queries occupy: with max:4 busy
      // clients a pool-routed cancel would queue behind the very queries it is
      // trying to interrupt. A backend that already finished is a no-op.
      const entries = [...running].filter((entry) => executionId === undefined || entry.executionId === executionId)
      const queued = entries.filter((entry) => entry.pid === null)
      for (const entry of queued) entry.cancelRequested = true
      const targets = entries.filter((entry) => entry.pid !== null)
      // Nothing running, or running but no PID captured yet (queued checkout):
      // either way there's nothing to target, so report it honestly.
      if (!targets.length) return { running: entries.length, cancelled: queued.length }
      // pg_cancel_backend returns false for a PID that's already gone or that
      // we lack permission to signal; count only the ones it actually hit.
      const sent = await cancelBackends(targets, active)
      return { running: entries.length, cancelled: queued.length + sent.filter(Boolean).length }
    },

    async exportQuery({ sql, params, childDb, sort, filePath, format, executionId }) {
      const plan = prepareSqlRun({ engine: 'postgresql', sql, params, sort })
      // Registered like query() so Stop (and disconnect) can interrupt a
      // runaway export instead of it streaming to completion unstoppably.
      const entry = { executionId, pid: null as number | null, cancelRequested: false }
      running.add(entry)
      let client: pg.PoolClient | null = null
      const writer = openExportWriter(filePath, format)
      try {
        client = await poolForQuery(childDb).connect()
        entry.pid = backendPid(client)
        if (entry.cancelRequested) throw new Error('Query cancelled.')
        await streamPgExport(client, plan.batches[0]!, plan.params, writer)
        const result = await writer.close()
        // Reset like query() before the connection re-enters the pool; a failed
        // reset condemns only this client — the finished export still counts.
        try {
          await resetUserSession(client)
          // Leaves `running` before the client re-enters the pool (see query()).
          running.delete(entry)
          client.release()
        } catch (resetError) {
          running.delete(entry)
          client.release(resetError as Error)
        }
        client = null
        return result
      } catch (error) {
        await writer.close().catch(() => {})
        // Uncertain session state — drop the client rather than reuse it.
        client?.release(error as Error)
        throw (error as { code?: string }).code === '57014' || (error as Error).message === 'Query cancelled.'
          ? new Error('Query cancelled.')
          : error
      } finally {
        running.delete(entry)
      }
    },

    async listTables(childDb = null) {
      // pg_class instead of information_schema.tables so partition children
      // can be excluded — only the partitioned parent is listed (querying it
      // covers all partitions). relkinds: ordinary/partitioned tables, views,
      // materialized views, foreign tables — information_schema.tables would
      // miss matviews entirely.
      const result = await poolForQuery(childDb).query(
        `select n.nspname as table_schema, c.relname as table_name, c.relkind as relkind
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f')
           and not coalesce(c.relispartition, false)
           and n.nspname !~ '^pg_'
           and n.nspname <> 'information_schema'
         order by table_schema, table_name`,
      )
      const kinds: Record<string, TableRef['kind']> = { r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign' }
      return result.rows.map(
        (row: { table_schema: string; table_name: string; relkind: string }): TableRef => ({
          schema: row.table_schema,
          name: row.table_name,
          kind: kinds[row.relkind] ?? 'table',
        }),
      )
    },

    async listColumns(childDb = null) {
      // Same relation filter as listTables, joined to attributes; primary-key
      // membership comes from the table's primary index.
      const result = await poolForQuery(childDb).query(
        `select n.nspname as table_schema, c.relname as table_name, a.attname as column_name,
                pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                not a.attnotnull as nullable,
                coalesce(i.indisprimary, false) as primary_key,
                exists (select 1 from pg_catalog.pg_constraint fk
                        where fk.contype = 'f' and fk.conrelid = a.attrelid and a.attnum = any(fk.conkey)) as foreign_key
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         left join pg_catalog.pg_index i
           on i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)
         where c.relkind in ('r', 'p', 'v', 'm', 'f')
           and not coalesce(c.relispartition, false)
           and n.nspname !~ '^pg_'
           and n.nspname <> 'information_schema'
           and a.attnum > 0
           and not a.attisdropped
         order by table_schema, table_name, a.attnum`,
      )
      return result.rows.map(
        (row: {
          table_schema: string
          table_name: string
          column_name: string
          data_type: string
          nullable: boolean
          primary_key: boolean
          foreign_key: boolean
        }): ColumnRef => ({
          schema: row.table_schema,
          table: row.table_name,
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.nullable,
          primaryKey: row.primary_key,
          foreignKey: row.foreign_key,
        }),
      )
    },

    async listObjects(childDb = null) {
      const pool = poolForQuery(childDb)
      const [functions, types] = await Promise.all([
        // Plain functions and procedures; aggregates/window functions are
        // rarely user-authored and would mostly be noise.
        pool.query<DbObject>(
          `select n.nspname as schema, p.proname as name,
                  pg_catalog.pg_get_function_identity_arguments(p.oid) as detail
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
             and p.prokind in ('f', 'p')
           order by schema, name`,
        ),
        // Standalone user types: enums, domains, ranges, and CREATE TYPE AS
        // composites — every table also has an implicit composite type, so
        // 'c' is restricted to relkind 'c'.
        pool.query<DbObject>(
          `select n.nspname as schema, t.typname as name,
                  case t.typtype
                    when 'e' then 'enum' when 'd' then 'domain'
                    when 'r' then 'range' else 'composite' end as detail
           from pg_catalog.pg_type t
           join pg_catalog.pg_namespace n on n.oid = t.typnamespace
           where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
             and (t.typtype in ('e', 'd', 'r')
                  or (t.typtype = 'c' and exists (
                        select 1 from pg_catalog.pg_class c
                        where c.oid = t.typrelid and c.relkind = 'c')))
           order by schema, name`,
        ),
      ])
      return { functions: functions.rows, types: types.rows }
    },

    async inspectServer(childDb = null) {
      const pool = poolForQuery(childDb)
      const [extensions, roles, tablespaces, settings] = await Promise.all([
        pool.query(
          `select e.extname as name,
                  e.extversion || coalesce(' — ' || pg_catalog.obj_description(e.oid, 'pg_extension'), '') as definition
           from pg_catalog.pg_extension e order by e.extname`,
        ),
        pool.query(
          `select rolname as name,
                  concat_ws(', ',
                    case when rolsuper then 'superuser' end,
                    case when rolcreatedb then 'createdb' end,
                    case when rolcreaterole then 'createrole' end,
                    case when rolreplication then 'replication' end,
                    case when not rolcanlogin then 'nologin' end) as definition
           from pg_catalog.pg_roles where rolname !~ '^pg_' order by rolname`,
        ),
        pool.query(
          `select spcname as name, pg_catalog.pg_tablespace_location(oid) as definition
           from pg_catalog.pg_tablespace order by spcname`,
        ),
        // The full pg_settings catalog is ~350 rows of noise in a sidebar;
        // what was changed from the defaults is the interesting part.
        pool.query(
          `select name, setting || coalesce(' ' || unit, '') as definition
           from pg_catalog.pg_settings where source not in ('default', 'override') order by name`,
        ),
      ])
      return [
        { title: 'Extensions', rows: extensions.rows },
        { title: 'Roles', rows: roles.rows },
        { title: 'Tablespaces', rows: tablespaces.rows },
        { title: 'Settings (non-default)', rows: settings.rows },
      ].filter((section) => section.rows.length)
    },

    async inspectObject(object, objectKind, childDb = null) {
      const pool = poolForQuery(childDb)
      const schema = object.schema ?? 'public'

      if (objectKind === 'function') {
        // detail carries the identity arguments, which is what distinguishes
        // overloads sharing a name.
        const result = await pool.query<{ definition: string }>(
          `select pg_catalog.pg_get_functiondef(p.oid) as definition
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2
             and pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`,
          [schema, object.name, object.detail],
        )
        const definition: string = result.rows[0]?.definition ?? ''
        if (!definition) throw new Error(`Function ${object.name}(${object.detail}) was not found.`)
        return { columns: [], sections: [{ title: 'Definition', rows: [{ name: object.name, definition }] }] }
      }

      const typeRow = (
        await pool.query(
          `select t.oid, t.typtype, t.typrelid,
                  pg_catalog.format_type(t.typbasetype, t.typtypmod) as base_type,
                  t.typnotnull, t.typdefault
           from pg_catalog.pg_type t
           join pg_catalog.pg_namespace n on n.oid = t.typnamespace
           where n.nspname = $1 and t.typname = $2`,
          [schema, object.name],
        )
      ).rows[0] as
        | { oid: string; typtype: string; typrelid: string; base_type: string; typnotnull: boolean; typdefault: string | null }
        | undefined
      if (!typeRow) throw new Error(`Type ${object.name} was not found.`)

      if (typeRow.typtype === 'e') {
        const values = await pool.query(
          'select enumlabel from pg_catalog.pg_enum where enumtypid = $1 order by enumsortorder',
          [typeRow.oid],
        )
        return {
          columns: [],
          sections: [
            { title: 'Values', rows: values.rows.map((row: { enumlabel: string }) => ({ name: row.enumlabel, definition: '' })) },
          ],
        }
      }

      if (typeRow.typtype === 'c') {
        // CREATE TYPE AS composites reuse the column table for attributes.
        const attrs = await pool.query(
          `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type
           from pg_catalog.pg_attribute a
           where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
           order by a.attnum`,
          [typeRow.typrelid],
        )
        return {
          columns: attrs.rows.map((row: { name: string; data_type: string }) => ({
            name: row.name,
            dataType: row.data_type,
            nullable: true,
            default: null,
            primaryKey: false,
            comment: null,
          })),
          sections: [],
        }
      }

      if (typeRow.typtype === 'r') {
        const range = await pool.query<{ subtype: string }>(
          'select pg_catalog.format_type(rngsubtype, null) as subtype from pg_catalog.pg_range where rngtypid = $1',
          [typeRow.oid],
        )
        return {
          columns: [],
          sections: [
            { title: 'Definition', rows: [{ name: 'subtype', definition: range.rows[0]?.subtype ?? '' }] },
          ],
        }
      }

      // Domain: base type, nullability, default, then its CHECK constraints.
      const checks = await pool.query<{ name: string; definition: string }>(
        `select conname as name, pg_catalog.pg_get_constraintdef(oid, true) as definition
         from pg_catalog.pg_constraint where contypid = $1 order by conname`,
        [typeRow.oid],
      )
      const rows = [
        { name: 'base type', definition: typeRow.base_type },
        ...(typeRow.typnotnull ? [{ name: 'not null', definition: 'NOT NULL' }] : []),
        ...(typeRow.typdefault ? [{ name: 'default', definition: typeRow.typdefault }] : []),
        ...checks.rows,
      ]
      return { columns: [], sections: [{ title: 'Definition', rows }] }
    },

    async inspectTable(table, childDb = null) {
      const pool = poolForQuery(childDb)
      const schema = table.schema ?? 'public'
      const args = [schema, table.name]
      type Row = { name: string; definition: string }
      const rows = async (sql: string): Promise<Row[]> => (await pool.query<Row>(sql, args)).rows

      const [columns, constraints, indexes, partitions, triggers, rules, policies, storage] = await Promise.all([
        pool.query(
          `select a.attname as name,
                  pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                  not a.attnotnull as nullable,
                  pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
                  coalesce(i.indisprimary, false) as primary_key,
                  exists (select 1 from pg_catalog.pg_constraint fk
                          where fk.contype = 'f' and fk.conrelid = a.attrelid
                            and a.attnum = any(fk.conkey)) as foreign_key,
                  a.attgenerated as generated,
                  pg_catalog.col_description(a.attrelid, a.attnum) as comment
           from pg_catalog.pg_attribute a
           join pg_catalog.pg_class c on c.oid = a.attrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           left join pg_catalog.pg_index i
             on i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)
           where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
           order by a.attnum`,
          args,
        ),
        pool.query(
          `select con.conname as name, pg_catalog.pg_get_constraintdef(con.oid, true) as definition,
                  con.contype as type
           from pg_catalog.pg_constraint con
           join pg_catalog.pg_class c on c.oid = con.conrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = $1 and c.relname = $2 and con.conparentid = 0
           order by con.contype, con.conname`,
          args,
        ),
        rows(`select indexname as name, indexdef as definition
              from pg_catalog.pg_indexes where schemaname = $1 and tablename = $2 order by indexname`),
        rows(`select child.relname as name,
                     coalesce(pg_catalog.pg_get_expr(child.relpartbound, child.oid, true), '') as definition
              from pg_catalog.pg_inherits
              join pg_catalog.pg_class child on child.oid = inhrelid
              join pg_catalog.pg_class parent on parent.oid = inhparent
              join pg_catalog.pg_namespace n on n.oid = parent.relnamespace
              where n.nspname = $1 and parent.relname = $2 order by child.relname`),
        rows(`select t.tgname as name, pg_catalog.pg_get_triggerdef(t.oid, true) as definition
              from pg_catalog.pg_trigger t
              join pg_catalog.pg_class c on c.oid = t.tgrelid
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = $1 and c.relname = $2 and not t.tgisinternal order by t.tgname`),
        rows(`select rulename as name, definition
              from pg_catalog.pg_rules where schemaname = $1 and tablename = $2 order by rulename`),
        rows(`select policyname as name,
                     concat_ws(' ', 'FOR', cmd, 'TO', array_to_string(roles, ', '),
                               case when qual is not null then 'USING (' || qual || ')' end,
                               case when with_check is not null then 'WITH CHECK (' || with_check || ')' end
                     ) as definition
              from pg_catalog.pg_policies where schemaname = $1 and tablename = $2 order by policyname`),
        // Only relkinds with storage; views/foreign tables have no tablespace.
        rows(`select 'tablespace' as name, coalesce(t.spcname, '(database default)') as definition
              from pg_catalog.pg_class c
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              left join pg_catalog.pg_tablespace t on t.oid = c.reltablespace
              where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'm')`),
      ])

      const constraintRows = constraints.rows as Array<Row & { type: string }>
      const sections: InspectSection[] = [
        // FKs are constraints too, but they're what people look for most.
        { title: 'Foreign Keys', rows: constraintRows.filter((row) => row.type === 'f') },
        // Skip NOT NULL (contype 'n', PG 17+); the PRIMARY KEY ('p') stays, shown
        // read-only in the UI (it's also the columns table's key marker), like FKs.
        { title: 'Constraints', rows: constraintRows.filter((row) => row.type !== 'f' && row.type !== 'n') },
        { title: 'Indexes', rows: indexes },
        { title: 'Partitions', rows: partitions },
        { title: 'Triggers', rows: triggers },
        { title: 'Rules', rows: rules },
        { title: 'Policies', rows: policies },
        { title: 'Storage', rows: storage },
      ]
      return {
        columns: columns.rows.map(
          (row: {
            name: string
            data_type: string
            nullable: boolean
            default_expr: string | null
            primary_key: boolean
            foreign_key: boolean
            generated: string | null
            comment: string | null
          }) => ({
            name: row.name,
            dataType: row.data_type,
            nullable: row.nullable,
            default: row.default_expr,
            primaryKey: row.primary_key,
            foreignKey: row.foreign_key,
            // attgenerated is '' for a normal column, 's'/'v' for a generated one.
            generated: !!row.generated,
            comment: row.comment,
          }),
        ),
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

// Streams rows so a huge result can't OOM the main process: pg only buffers
// when nothing listens for 'row'. rowMode array keeps duplicate column names.
// Rows beyond the buffer caps are drained without being kept: cancelling the
// statement instead could sever a SELECT with side effects (nextval(), volatile
// functions) partway through, and the drain keeps the reported count exact.
function streamQuery(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
  started: number,
  sourceCache: Map<string, ColumnSource>,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const buffers = new Map<object, { rows: unknown[][]; total: number; bytes: number; limited: boolean }>()
    let bufferedBytes = 0
    const config: pg.QueryArrayConfig = { text: sql, values: params, rowMode: 'array' }
    const query = new pg.Query(config)
    query.on('row', (row: unknown[], result?: object) => {
      const key = result ?? query
      const buffer = buffers.get(key) ?? { rows: [], total: 0, bytes: 0, limited: false }
      buffer.total += 1
      if (buffer.rows.length < MAX_BUFFERED_ROWS) {
        const bounded = boundedRow(row, bufferedBytes)
        if (bounded) {
          buffer.rows.push(bounded.row)
          buffer.bytes += bounded.bytes
          bufferedBytes += bounded.bytes
          buffer.limited ||= bounded.truncated
        } else {
          buffer.limited = true
        }
      } else {
        buffer.limited = true
      }
      buffers.set(key, buffer)
    })
    const finish = (result?: pg.QueryArrayResult | pg.QueryArrayResult[]) => {
      const results = result
        ? (Array.isArray(result) ? result : [result])
        : [...buffers.keys()].filter((entry): entry is pg.QueryArrayResult => 'fields' in entry)
      if (!results.length) {
        reject(new Error('Query result metadata was unavailable after cancellation.'))
        return
      }
      void Promise.all(
        results.map(async (entry): Promise<QueryResultSet> => {
          const buffer = buffers.get(entry as object) ?? { rows: [], total: 0, bytes: 0, limited: false }
          return {
            columns: entry.fields.map((field) => field.name),
            columnSources: await columnSourcesForFields(client, entry.fields, sourceCache),
            rows: buffer.rows,
            rowCount: entry.rowCount ?? buffer.total,
            truncated: buffer.limited || buffer.total > buffer.rows.length,
            rowCountExact: true,
          }
        }),
      )
        .then((resultSets) => {
          const selected = resultSets[resultSets.length - 1]!
          resolve({
            ...selected,
            durationMs: performance.now() - started,
            ...(resultSets.length > 1 ? { resultSets } : {}),
          })
        })
        .catch(reject)
    }
    query.on('error', reject)
    query.on('end', finish)
    client.query(query)
  })
}

// Streams every row of a read-only query into `writer` with backpressure: rows
// batch into chunks, and while a chunk is being written to disk the client
// socket is paused so the server can't outrun the file. No MAX_BUFFERED_ROWS
// cap — the whole result reaches the file.
function streamPgExport(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
  writer: ExportWriter,
  chunkSize = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = clientSocket(client)
    let columnsSet = false
    let chunk: unknown[][] = []
    let draining = false
    let ended = false
    let failed = false
    const setColumns = (fields?: pg.FieldDef[]) => {
      if (columnsSet) return
      writer.columns((fields ?? []).map((field) => field.name))
      columnsSet = true
    }
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
      socket?.pause()
      writer.rows(batch).then(() => {
        draining = false
        socket?.resume()
        flush()
      }, fail)
    }
    const query = new pg.Query({ text: sql, values: params, rowMode: 'array' } as pg.QueryArrayConfig)
    query.on('row', (row: unknown[], result?: pg.QueryArrayResult) => {
      setColumns(result?.fields)
      chunk.push(row)
      if (chunk.length >= chunkSize) flush()
    })
    query.on('error', fail)
    // 'end' carries the result metadata, so a zero-row query still writes a header.
    query.on('end', (result?: pg.QueryArrayResult) => {
      setColumns(result?.fields)
      ended = true
      flush()
    })
    client.query(query)
  })
}

type ColumnSource = { schema: string | null; table: string | null; column: string | null }

// Entries are tiny; the cap only guards a pathological session (generated
// schemas, thousands of distinct relations) from growing without bound.
const MAX_SOURCE_CACHE = 20_000

// Resolves (tableID, columnID) field origins through `cache`, querying the
// catalog only for keys not seen before — a re-run of the same query costs no
// extra round trip. Unresolvable refs are cached too (as all-null sources),
// or a dropped relation would re-query on every run. The caller clears the
// cache whenever the session runs anything that could change the catalog.
export async function columnSourcesForFields(
  client: pg.PoolClient,
  fields: pg.FieldDef[],
  cache: Map<string, ColumnSource>,
): Promise<QueryResult['columnSources'] | undefined> {
  const keyed = new Map<string, { tableID: number; columnID: number }>()
  for (const field of fields) {
    if (field.tableID && field.columnID) keyed.set(`${field.tableID}:${field.columnID}`, { tableID: field.tableID, columnID: field.columnID })
  }
  if (!keyed.size) return undefined

  const missing = [...keyed].filter(([key]) => !cache.has(key))
  if (missing.length) {
    if (cache.size + missing.length > MAX_SOURCE_CACHE) cache.clear()
    const params: number[] = []
    const where = missing
      .map(([, ref]) => {
        params.push(ref.tableID, ref.columnID)
        return `(a.attrelid = $${params.length - 1}::oid AND a.attnum = $${params.length}::int)`
      })
      .join(' OR ')
    const found = await client.query<{ table_id: string; column_id: number; schema: string; table: string; column: string }>(
      `select a.attrelid::text as table_id, a.attnum::int as column_id, n.nspname as schema, c.relname as table, a.attname as column
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where ${where}`,
      params,
    )
    for (const row of found.rows) cache.set(`${row.table_id}:${row.column_id}`, { schema: row.schema, table: row.table, column: row.column })
    for (const [key] of missing) {
      if (!cache.has(key)) cache.set(key, { schema: null, table: null, column: null })
    }
  }
  return fields.map((field) => cache.get(`${field.tableID}:${field.columnID}`) ?? { schema: null, table: null, column: null })
}

/** "PostgreSQL 17.2 on aarch64-apple-darwin…" → "PostgreSQL 17.2"; also trims
 *  PG-compatible banners like "CockroachDB CCL v26.2.3 (aarch64-…, built …)". */
export function shortVersion(version: string) {
  const beforeOn = version.split(' on ')[0] ?? version
  return beforeOn.split(' (')[0]?.trim() || beforeOn
}
