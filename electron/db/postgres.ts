import pg from 'pg'
import type { ColumnRef, ConnectionProfile, TableRef } from '../../src/electron'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'

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
  // Backend of the in-flight user query, so cancel() can target it. The UI
  // runs one query per connection at a time; a single slot is enough.
  let running: { pid: number | null; pool: pg.Pool } | null = null

  const makePool = (database: string) => {
    const pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database,
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

  return {
    async connect() {
      const discovery = profile.database.trim() || 'postgres'
      pools = new Map([[discovery, makePool(discovery)]])

      const result = await pools.get(discovery)!.query('select version()')
      const version = shortVersion(result.rows[0].version as string)

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
      active = childNames.includes(discovery) ? discovery : childNames[0]
      return version
    },

    async disconnect() {
      const closing = pools
      pools = null
      if (!closing) return
      await Promise.all([...closing.values()].map((pool) => pool.end().catch(() => {})))
    },

    async query(sql, params = []) {
      const started = performance.now()
      const pool = activePool()
      // Checked out manually (not pool.query) so the backend PID is known
      // while the statement runs and cancel() has a target.
      const client = await pool.connect()
      running = { pid: (client as unknown as { processID?: number }).processID ?? null, pool }
      try {
        // rowMode array keeps duplicate column names (select a.id, b.id) intact.
        const result = await client.query({ text: sql, values: params, rowMode: 'array' })
        client.release()
        return {
          columns: result.fields.map((field) => field.name),
          rows: result.rows,
          rowCount: result.rowCount ?? result.rows.length,
          durationMs: performance.now() - started,
        }
      } catch (error) {
        // Mirror pool.query: an errored client is destroyed, not reused.
        client.release(error as Error)
        throw (error as { code?: string }).code === '57014' ? new Error('Query cancelled.') : error
      } finally {
        running = null
      }
    },

    async cancel() {
      const target = running
      if (!target?.pid) return false
      // Issued from a second connection; the server interrupts the backend
      // and the in-flight query rejects with SQLSTATE 57014.
      await target.pool.query('select pg_cancel_backend($1)', [target.pid])
      return true
    },

    async listTables() {
      // pg_class instead of information_schema.tables so partition children
      // can be excluded — only the partitioned parent is listed (querying it
      // covers all partitions). relkinds: ordinary/partitioned tables, views,
      // foreign tables — what information_schema.tables exposed.
      const result = await activePool().query(
        `select n.nspname as table_schema, c.relname as table_name
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'f')
           and not c.relispartition
           and n.nspname !~ '^pg_'
           and n.nspname <> 'information_schema'
         order by table_schema, table_name`,
      )
      return result.rows.map(
        (row: { table_schema: string; table_name: string }): TableRef => ({ schema: row.table_schema, name: row.table_name }),
      )
    },

    async listColumns() {
      // Same relation filter as listTables, joined to attributes; primary-key
      // membership comes from the table's primary index.
      const result = await activePool().query(
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
         where c.relkind in ('r', 'p', 'v', 'f')
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

/** "PostgreSQL 17.2 on aarch64-apple-darwin…" → "PostgreSQL 17.2". */
function shortVersion(version: string) {
  return version.split(' on ')[0] ?? version
}
