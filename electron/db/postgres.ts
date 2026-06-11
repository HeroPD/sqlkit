import pg from 'pg'
import type { ConnectionProfile, TableRef } from '../../src/electron'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'

// PostgreSQL via a small pg.Pool: queries grab whatever client is free, a
// dropped connection is replaced on the next query instead of poisoning the
// session, and concurrent queries from future editor tabs don't queue behind
// each other. Dials the endpoint, not the profile — the transport layer may
// have rewritten host/port to an SSH tunnel's local end.
export function createPostgresDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pool: pg.Pool | null = null

  const open = () => {
    if (!pool) throw new Error('Not connected')
    return pool
  }

  return {
    async connect() {
      pool = new pg.Pool({
        host: endpoint.host,
        port: endpoint.port,
        user: profile.username,
        password: profile.password,
        database: profile.database || undefined,
        max: 4,
        connectionTimeoutMillis: 8000,
      })
      // Idle clients emit 'error' when the server closes them (restart,
      // timeout); without a handler that exception takes down the main
      // process. The pool discards the client; surface it as a status update.
      pool.on('error', (error) => events.onError(error.message))

      const result = await pool.query('select version()')
      return shortVersion(result.rows[0].version as string)
    },

    async disconnect() {
      const closing = pool
      pool = null
      await closing?.end()
    },

    async query(sql, params = []) {
      const started = performance.now()
      // rowMode array keeps duplicate column names (select a.id, b.id) intact.
      const result = await open().query({ text: sql, values: params, rowMode: 'array' })
      return {
        columns: result.fields.map((field) => field.name),
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        durationMs: performance.now() - started,
      }
    },

    async listTables() {
      const result = await open().query(
        `select table_schema, table_name from information_schema.tables
         where table_schema not in ('pg_catalog', 'information_schema')
         order by table_schema, table_name`,
      )
      return result.rows.map(
        (row: { table_schema: string; table_name: string }): TableRef => ({ schema: row.table_schema, name: row.table_name }),
      )
    },
  }
}

/** "PostgreSQL 17.2 on aarch64-apple-darwin…" → "PostgreSQL 17.2". */
function shortVersion(version: string) {
  return version.split(' on ')[0] ?? version
}
