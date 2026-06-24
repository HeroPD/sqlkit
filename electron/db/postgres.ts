import pg from 'pg'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionOptions } from 'node:tls'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import { MAX_BUFFERED_ROWS } from './driver'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

// Shared across the batch paths: a save statement that matches no rows aborts
// the transaction, since the row it targeted is gone or changed.
const BATCH_ZERO_ROWS = 'A change affected no rows; the row may have been modified or removed.'

export function sslOptions(profile: ConnectionProfile): boolean | ConnectionOptions {
  const ssl = profile.ssl
  if (!ssl || ssl.mode === 'disable') return false
  if (ssl.mode === 'require') return { rejectUnauthorized: false }

  const options: ConnectionOptions = { rejectUnauthorized: true }
  const caPath = ssl.ca.trim()
  if (caPath) {
    try {
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
export function createPostgresDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pools: Map<string, pg.Pool> | null = null
  let childNames: string[] = []
  let active = ''
  // Backend PIDs of in-flight user queries so cancel() can interrupt them. Two
  // tabs can run on one connection at once, so this is a set rather than a
  // single slot — a single slot let a second run clobber the first's cancel
  // target, and the first's completion then cleared it.
  const running = new Set<{ pid: number | null }>()
  const ssl = sslOptions(profile)

  const makePool = (database: string) => {
    const pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database,
      ssl,
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

    async query(sql, params = [], childDb = null, sort = null) {
      const started = performance.now()
      const finalSql = sort ? dialect.applyOrderBy(sql, sort) : sql
      const pool = poolForQuery(childDb)
      // Checked out manually (not pool.query) so the backend PID is known
      // while the statement runs and cancel() has a target.
      const client = await pool.connect()
      const entry = { pid: (client as unknown as { processID?: number }).processID ?? null }
      running.add(entry)
      try {
        const result = await streamQuery(client, finalSql, params, started)
        client.release()
        return result
      } catch (error) {
        // Mirror pool.query: an errored client is destroyed, not reused.
        client.release(error as Error)
        throw (error as { code?: string }).code === '57014' ? new Error('Query cancelled.') : error
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
      const entry = { pid: (client as unknown as { processID?: number }).processID ?? null }
      running.add(entry)
      let index = -1
      try {
        await client.query('BEGIN')
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          const result = await client.query(statement.sql, statement.params)
          // A write that matched nothing means the row moved or vanished since
          // the user reviewed it — abort the whole batch rather than half-apply.
          if ((result.rowCount ?? 0) === 0) {
            await client.query('ROLLBACK')
            client.release()
            return { success: false, failedIndex: index, error: BATCH_ZERO_ROWS }
          }
        }
        await client.query('COMMIT')
        client.release()
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
    },

    async cancel() {
      // Interrupt every in-flight backend on this connection — the UI's Stop
      // is per-connection. Issue the cancels from a fresh out-of-band
      // connection, not the pool the running queries occupy: with max:4 busy
      // clients a pool-routed cancel would queue behind the very queries it is
      // trying to interrupt. A backend that already finished is a no-op.
      const entries = [...running]
      const pids = entries.map((entry) => entry.pid).filter((pid): pid is number => pid !== null)
      // Nothing running, or running but no PID captured yet (queued checkout):
      // either way there's nothing to target, so report it honestly.
      if (!pids.length) return { running: entries.length, cancelled: 0 }
      const client = new pg.Client({
        host: endpoint.host,
        port: endpoint.port,
        user: profile.username,
        password: profile.password,
        database: active,
        ssl,
        connectionTimeoutMillis: 8000,
      })
      try {
        await client.connect()
        // pg_cancel_backend returns false for a PID that's already gone or that
        // we lack permission to signal; count only the ones it actually hit.
        const sent = await Promise.all(
          pids.map((pid) =>
            client
              .query<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [pid])
              .then((result) => result.rows[0]?.ok === true)
              .catch(() => false),
          ),
        )
        return { running: entries.length, cancelled: sent.filter(Boolean).length }
      } finally {
        await client.end().catch(() => {})
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
           and not c.relispartition
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
           and not c.relispartition
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

      const [columns, constraints, indexes, partitions, triggers, rules, policies] = await Promise.all([
        pool.query(
          `select a.attname as name,
                  pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                  not a.attnotnull as nullable,
                  pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
                  coalesce(i.indisprimary, false) as primary_key
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
           where n.nspname = $1 and c.relname = $2
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
      ])

      const constraintRows = constraints.rows as Array<Row & { type: string }>
      const sections: InspectSection[] = [
        // FKs are constraints too, but they're what people look for most.
        { title: 'Foreign Keys', rows: constraintRows.filter((row) => row.type === 'f') },
        { title: 'Constraints', rows: constraintRows.filter((row) => row.type !== 'f') },
        { title: 'Indexes', rows: indexes },
        { title: 'Partitions', rows: partitions },
        { title: 'Triggers', rows: triggers },
        { title: 'Rules', rows: rules },
        { title: 'Policies', rows: policies },
      ]
      return {
        columns: columns.rows.map(
          (row: { name: string; data_type: string; nullable: boolean; default_expr: string | null; primary_key: boolean }) => ({
            name: row.name,
            dataType: row.data_type,
            nullable: row.nullable,
            default: row.default_expr,
            primaryKey: row.primary_key,
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
function streamQuery(client: pg.PoolClient, sql: string, params: unknown[], started: number): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const rows: unknown[][] = []
    let total = 0
    const config: pg.QueryArrayConfig = { text: sql, values: params, rowMode: 'array' }
    const query = new pg.Query(config)
    query.on('row', (row: unknown[]) => {
      total += 1
      if (rows.length < MAX_BUFFERED_ROWS) rows.push(row)
    })
    query.on('error', reject)
    query.on('end', (result) => {
      // Multi-statement queries resolve to an array; the last has the final columns.
      const final = (Array.isArray(result) ? result[result.length - 1] : result) as pg.QueryArrayResult
      void columnSourcesForFields(client, final.fields)
        .then((columnSources) =>
          resolve({
            columns: final.fields.map((field) => field.name),
            columnSources,
            rows,
            rowCount: final.rowCount ?? total,
            durationMs: performance.now() - started,
            truncated: total > MAX_BUFFERED_ROWS,
          }),
        )
        .catch(reject)
    })
    client.query(query)
  })
}

async function columnSourcesForFields(
  client: pg.PoolClient,
  fields: pg.FieldDef[],
): Promise<QueryResult['columnSources'] | undefined> {
  const keyed = new Map<string, { tableID: number; columnID: number }>()
  for (const field of fields) {
    if (field.tableID && field.columnID) keyed.set(`${field.tableID}:${field.columnID}`, { tableID: field.tableID, columnID: field.columnID })
  }
  if (!keyed.size) return undefined

  const params: number[] = []
  const where = [...keyed.values()]
    .map((ref) => {
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
  const byKey = new Map(found.rows.map((row) => [`${row.table_id}:${row.column_id}`, row]))
  return fields.map((field) => {
    const source = byKey.get(`${field.tableID}:${field.columnID}`)
    return source ? { schema: source.schema, table: source.table, column: source.column } : { schema: null, table: null, column: null }
  })
}

/** "PostgreSQL 17.2 on aarch64-apple-darwin…" → "PostgreSQL 17.2". */
export function shortVersion(version: string) {
  return version.split(' on ')[0] ?? version
}
