import pg from 'pg'
import type { ColumnRef, ConnectionProfile, InspectSection, TableRef } from '../../src/electron'
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

  const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`

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

    async createDatabase(name) {
      // CREATE DATABASE refuses to run inside a transaction; a plain
      // single-statement pool query never opens one, so this is fine.
      await activePool().query(`create database ${quoteIdent(name)}`)
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
        await activePool().query(`drop database ${quoteIdent(name)}`)
      } catch (error) {
        // Drop refused (e.g. someone else is connected): keep it browsable.
        if (pool) pools.set(name, makePool(name))
        throw error
      }
      childNames = childNames.filter((child) => child !== name)
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
      // materialized views, foreign tables — information_schema.tables would
      // miss matviews entirely.
      const result = await activePool().query(
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

    async inspectTable(table) {
      const pool = activePool()
      const schema = table.schema ?? 'public'
      const args = [schema, table.name]
      type Row = { name: string; definition: string }
      const rows = async (sql: string): Promise<Row[]> => (await pool.query(sql, args)).rows

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

/** "PostgreSQL 17.2 on aarch64-apple-darwin…" → "PostgreSQL 17.2". */
function shortVersion(version: string) {
  return version.split(' on ')[0] ?? version
}
