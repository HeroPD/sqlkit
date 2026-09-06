import sql from 'mssql'
import { Request as TediousRequest, TYPES as TediousTypes } from 'tedious'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef, TableStat } from '../../src/electron'
import { dialectFor, sqlOptionToken } from '../../src/dialect'
import { errorMessage } from './error-message'
import { columnReference } from './column-reference'
import { APP_CONNECTION_NAME, BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS, MAX_POOL_CONNECTIONS, MAX_SESSIONS, POOL_IDLE_MS } from './limits'
import { byteCount, sizedRow } from './table-stats'
import { formatUptime } from './server-stats'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { openExportWriter, type ExportWriter } from './export'
import { prepareSqlRun } from './sql-script'
import { installLosslessTediousParsers } from './tedious-lossless'
import { t } from '../../src/i18n'
import { sqlLiteral } from '../../src/result-sql'

// Always-present databases; hidden from all-databases children except master,
// which is a legitimate browsing target (it's the default sa database).
const SYSTEM_DBS = ['tempdb', 'model', 'msdb']

const isCancelled = (error: unknown) => (error as { code?: string }).code === 'ECANCEL'

// Binary values cross Electron IPC as Uint8Array, which node-mssql binds as
// NVarChar (only Buffer maps to VarBinary), breaking varbinary writes/guards.
export const toBindable = (value: unknown): unknown =>
  value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value

// Value-based TDS type inference for the tedious-level parameter path,
// mirroring what node-mssql's Request.input does on the pooled path.
const tediousTypeFor = (value: unknown) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && Math.abs(value) <= 2147483647 ? TediousTypes.Int : TediousTypes.Float
  }
  if (typeof value === 'boolean') return TediousTypes.Bit
  if (value instanceof Date) return TediousTypes.DateTime
  if (Buffer.isBuffer(value)) return TediousTypes.VarBinary
  return TediousTypes.NVarChar
}

function parameterizedBatch(text: string, params: unknown[]): string {
  const declarations = params.map((input, index) => {
    const bindable = toBindable(typeof input === 'bigint' ? input.toString() : input)
    const type = tediousTypeFor(bindable)
    const value: unknown = type.validate(bindable, undefined)
    const name = `p${index + 1}`
    const declaration = type.declaration({ name, type, value, output: false })
    // UTF-16 hex keeps Unicode and newlines exact without shifting SQL error lines.
    const literal = typeof value === 'string'
      ? `CONVERT(nvarchar(max), 0x${Buffer.from(value, 'utf16le').toString('hex')})`
      : sqlLiteral(value instanceof Date ? value.toISOString().slice(0, -1) : value, 'sqlserver')
    return `@${name} ${declaration} = ${literal}`
  })
  return `DECLARE ${declarations.join(', ')}; ${text}`
}

const mssqlTypeExpression = `concat(
  case when ty.is_user_defined = 1
       then concat(quotename(schema_name(ty.schema_id)), '.', quotename(ty.name))
       else ty.name end,
  case when ty.is_user_defined = 1 then ''
       when ty.name in ('varchar','nvarchar','char','nchar','varbinary','binary') then
         concat('(', iif(c.max_length = -1, 'max',
           cast(iif(ty.name like 'n%', c.max_length / 2, c.max_length) as varchar(10))), ')')
       when ty.name in ('decimal','numeric') then concat('(', c.precision, ',', c.scale, ')')
       when ty.name = 'float' then concat('(', c.precision, ')')
       when ty.name in ('time','datetime2','datetimeoffset') then concat('(', c.scale, ')')
       else '' end)`

type MssqlColumn = {
  name: string
  type?: unknown
  precision?: number
  scale?: number
}

type PreciseDate = Date & { nanosecondsDelta?: number }

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

const temporalText = (value: PreciseDate, type: unknown, scale = 7): string => {
  const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  if (type === sql.Date) return date
  const fractionTicks = (value.getUTCMilliseconds() * 10_000) + Math.round((value.nanosecondsDelta ?? 0) * 10_000_000)
  const fraction = scale ? `.${pad(fractionTicks, 7).slice(0, scale)}` : ''
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}${fraction}`
  if (type === sql.Time) return time
  return `${date} ${time}`
}

const exactFixed = (value: number, precision: number, scale: number, column: string): string => {
  // Safety net: the lossless tedious adapter normally delivers these as exact
  // strings before node-mssql sees them. A number here means the adapter did
  // not cover this value; refuse lossy floats past 15 significant digits.
  if (precision > 15 || !Number.isFinite(value)) {
    throw new Error(`SQL Server column "${column}" has precision ${precision}, which its JavaScript driver cannot return losslessly. CAST it to varchar in the query.`)
  }
  return value.toFixed(scale)
}

export function normalizeMssqlRow(row: unknown[], columns: MssqlColumn[]): unknown[] {
  return row.map((value, index) => {
    if (value === null || value === undefined) return value
    const column = columns[index]
    const type = column?.type
    if ((type === sql.Decimal || type === sql.Numeric) && typeof value === 'number') {
      return exactFixed(value, column?.precision ?? 38, column?.scale ?? 0, column?.name ?? `#${index + 1}`)
    }
    if (type === sql.Money && typeof value === 'number') {
      return exactFixed(value, 19, 4, column?.name ?? `#${index + 1}`)
    }
    if (type === sql.SmallMoney && typeof value === 'number') {
      return exactFixed(value, 10, 4, column?.name ?? `#${index + 1}`)
    }
    if (type === sql.DateTimeOffset && value instanceof Date) {
      // Tedious currently discards the original offset while decoding this
      // TDS type. Returning its UTC Date would silently change the value.
      throw new Error(`SQL Server column "${column?.name ?? `#${index + 1}`}" is datetimeoffset, whose original offset is discarded by the driver. CAST it to varchar in the query.`)
    }
    if (value instanceof Date && [sql.Date, sql.Time, sql.DateTime, sql.SmallDateTime, sql.DateTime2].includes(type as never)) {
      const defaultScale = type === sql.SmallDateTime ? 0 : type === sql.DateTime ? 3 : 7
      return temporalText(value, type, column?.scale ?? defaultScale)
    }
    return value
  })
}

/** "Microsoft SQL Server 2022 (RTM-CU14) (KB…) - 16.0.x …" → "Microsoft SQL Server 2022". */
export function mssqlVersion(raw: string): string {
  const firstLine = raw.split('\n')[0] ?? raw
  return firstLine.split(' (')[0]?.trim() || firstLine.trim()
}

// TLS mapping: tedious defaults to encrypt-with-verification, which self-signed
// dev servers (the common case) fail. disable → cleartext; require → encrypt
// but trust any cert; verify-* → encrypt and verify, with an optional custom CA.
const expandHome = (value: string) => (value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value)

export function mssqlTls(profile: ConnectionProfile): { encrypt: boolean; trustServerCertificate: boolean; ca?: string } {
  const mode = profile.ssl?.mode ?? 'disable'
  if (mode === 'disable') return { encrypt: false, trustServerCertificate: true }
  if (mode === 'require') return { encrypt: true, trustServerCertificate: true }
  if (mode === 'verify-ca') {
    throw new Error(t('connection.sqlServerCaUnsupported'))
  }
  const caPath = profile.ssl?.ca.trim()
  if (!caPath) return { encrypt: true, trustServerCertificate: false }
  try {
    if (statSync(expandHome(caPath)).size > 5 * 1024 * 1024) throw new Error(t('connection.caTooLarge'))
    return { encrypt: true, trustServerCertificate: false, ca: readFileSync(expandHome(caPath), 'utf8') }
  } catch (error) {
    throw new Error(`Failed to read SSL CA certificate at ${caPath}: ${(error as Error).message}`, { cause: error })
  }
}

/** A SHOWPLAN switch anywhere in a run: while one is on, statements are
 * compiled and reported rather than executed. */
const SHOWPLAN_SWITCH = /\bset\s+showplan_(?:all|xml|text)\s+(?:on|off)\b/i

// SQL Server with all-databases support, mirroring the postgres driver: one
// connection pool per child database. Unlike MySQL, SQL Server has real
// schemas (dbo, …) inside each database, so TableRef.schema is populated.
// Dials the endpoint — the transport layer may have rewritten host/port to an
// SSH tunnel's local end.
export function createMssqlDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  // Patch tedious's value parser lazily (idempotent) rather than at module load,
  // so an incompatible tedious version fails only this connection — surfaced
  // through connect()'s error path — instead of crashing app startup.
  installLosslessTediousParsers()
  let pools: Map<string, sql.ConnectionPool> | null = null
  let childNames: string[] = []
  let active = ''
  // In-flight requests; tedious cancels in-band, so no out-of-band connection.
  // `tediousCancel` is set by the reset-connection read path (which runs at the
  // tedious level, below node-mssql's Request), so cancel() can interrupt it.
  const running = new Set<{
    executionId?: string
    request: sql.Request | null
    tediousCancel?: (() => void) | null
    cancelRequested: boolean
  }>()
  const tls = mssqlTls(profile)

  // Metadata pool size. User SQL runs on its own throwaway connection (see
  // openUserPool), so this leaves one of the budget free for a running query.
  const METADATA_POOL_MAX = Math.max(1, MAX_POOL_CONNECTIONS - 1)

  const makePool = (database: string, max = METADATA_POOL_MAX) => {
    const pool = new sql.ConnectionPool({
      server: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database: database || undefined,
      connectionTimeout: 8000,
      // No statement timeout: user queries legitimately run long; Stop cancels.
      requestTimeout: 0,
      pool: { max, idleTimeoutMillis: POOL_IDLE_MS },
      options: {
        // program_name in sys.dm_exec_sessions, so the Tasks dashboard can tell
        // the app's own sessions from everyone else's.
        appName: APP_CONNECTION_NAME,
        encrypt: tls.encrypt,
        trustServerCertificate: tls.trustServerCertificate,
        ...(tls.ca ? { cryptoCredentialsDetails: { ca: tls.ca } } : {}),
      },
    })
    pool.on('error', (error: Error) => events.onError(error.message))
    return pool
  }

  // A manual transaction (the user ran BEGIN TRAN) pins its borrowed tedious
  // connection so later runs join it instead of drawing a fresh one.
  type Pin = { conn: TediousConnection; pool: AcquirablePool; database: string; chain: Promise<unknown>; onDrop: () => void }
  let pin: Pin | null = null

  const adoptPin = (conn: TediousConnection, pool: AcquirablePool, database: string) => {
    // A dying socket must drop the pin (and clear the indicator) instead of
    // leaving a stale one; close-before-release makes the pool discard it.
    const onDrop = () => {
      if (pin?.conn !== conn) return
      pin = null
      try { conn.close() } catch { /* already closed */ }
      pool.release(conn)
      events.onTransactionChange?.()
    }
    conn.on('error', onDrop)
    conn.on('end', onDrop)
    pin = { conn, pool, database, chain: Promise.resolve(), onDrop }
  }

  const dropPin = async (release: boolean) => {
    if (!pin) return
    const { conn, pool, onDrop } = pin
    pin = null
    conn.removeListener('error', onDrop)
    conn.removeListener('end', onDrop)
    if (release) {
      await releaseClean(pool, conn)
    } else {
      try { conn.close() } catch { /* already closed */ }
      pool.release(conn)
    }
  }

  // The pool for `database`, opening it on demand and retiring whichever other
  // one was live, so only the database in use spends the connection budget.
  const connectedPool = async (database: string) => {
    if (!pools) throw new Error(t('connection.notConnected'))
    if (!database) throw new Error(t('connection.notConnected'))
    // A pinned transaction holds a connection of its database; resolving
    // another database would retire that pool while it can never drain.
    if (pin && database !== pin.database) {
      throw new Error(t('query.transactionOtherDatabase', { database: pin.database }))
    }
    let pool = pools.get(database)
    if (!pool) {
      if (!childNames.includes(database)) throw new Error(t('connection.databaseUnavailable', { database }))
      for (const [name, live] of pools) {
        pools.delete(name)
        void live.close().catch(() => {})
      }
      pool = makePool(database)
      pools.set(database, pool)
    }
    // connect() is a no-op when already connected; pools open lazily.
    return pool.connected ? pool : pool.connect()
  }

  const poolForQuery = (childDb?: string | null) => connectedPool(childDb ?? active)

  const databaseForQuery = (childDb?: string | null) => {
    const database = childDb ?? active
    if (!pools) throw new Error(t('connection.notConnected'))
    if (!database || !childNames.includes(database)) {
      throw new Error(database ? t('connection.databaseUnavailable', { database }) : t('connection.notConnected'))
    }
    return database
  }

  // node-mssql's pool has no supported reset-on-release hook, so pooled
  // connections would leak transaction/SET/temp state between query tabs. User
  // SQL therefore runs on a throwaway one-connection pool closed after the
  // operation; its single session is also what every GO batch of one script
  // shares. Metadata reads keep using the long-lived pools.
  const openUserPool = async (childDb?: string | null) => makePool(databaseForQuery(childDb), 1).connect()

  /**
   * Resolving a long-lived pool retires the others, so a caller that resolved
   * one and had not yet issued against it would find it closed the moment
   * anyone resolved a different child — failing having done nothing wrong.
   * These two run the resolve and the first use as one indivisible step, which
   * makes a switch atomic with respect to everyone about to use a pool; once a
   * connection is out or a request is issued, close() drains rather than severs.
   *
   * The throwaway pools behind openUserPool need none of this: they are never
   * in `pools`, so a switch neither retires them nor is delayed by them.
   */
  let poolGate: Promise<unknown> = Promise.resolve()
  const gated = <T>(run: () => Promise<T>): Promise<T> => {
    const next = poolGate.then(run)
    poolGate = next.then(() => undefined, () => undefined)
    return next
  }

  // Returns the pool alongside the connection: releasing and adopting a pin
  // both need the pool it actually came from, which a later resolve might no
  // longer be.
  const checkoutFor = (childDb?: string | null): Promise<{ pool: AcquirablePool; conn: TediousConnection }> =>
    gated(async () => {
      const pool = (await poolForQuery(childDb)) as AcquirablePool
      return { pool, conn: await acquireConnection(pool) }
    })

  const requestOn = <T>(childDb: string | null | undefined, run: (request: sql.Request) => Promise<T>): Promise<T> =>
    gated(async () => run((await poolForQuery(childDb)).request()))

  const bind = (request: sql.Request, params: unknown[]) => {
    params.forEach((value, index) => request.input(`p${index + 1}`, toBindable(value)))
    return request
  }

  // QueryResult (array rows) → the object rows metadata callers expect.
  const rowsAsObjects = <T>(result: QueryResult): T[] =>
    result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])) as T)

  const metaRows = async <T>(sqlText: string, params: unknown[] = [], childDb?: string | null): Promise<T[]> => {
    // While a transaction is pinned, same-database metadata must run on the
    // pinned connection: any other connection would block behind the
    // transaction's own Sch-M locks with no cancel target (requestTimeout 0).
    const pinned = pin
    if (pinned && databaseForQuery(childDb) === pinned.database) {
      const run = pinned.chain.then(async () => {
        if (pin !== pinned) return null
        return rowsAsObjects<T>(await streamTediousBatch(pinned.conn, sqlText, performance.now(), { bytes: 0 }, params))
      })
      pinned.chain = run.catch(() => {})
      const rows = await run
      if (rows) return rows
    }
    const result = await requestOn(childDb, (request) => bind(request, params).query<T>(sqlText))
    return result.recordset
  }

  const dialect = dialectFor(profile.engine)

  // TDS carries a column's source table only for the deprecated text/ntext/image
  // types (tedious reads it when `hasTableName`), so unlike MySQL's field packets
  // there is nothing on the wire to map an ordinary result column back to its
  // origin. This DMV is the server-side equivalent: with browse information on it
  // reports source schema/table/column per column, for one extra round trip.
  //
  // Browse mode appends hidden key columns that are not in the real result, so
  // is_hidden must be filtered or every source would be shifted onto the wrong
  // column. A statement the DMV cannot describe (temp tables, dynamic SQL) comes
  // back as a single row with column_ordinal 0 rather than an error, so ordinals
  // are filtered too; either way the caller degrades to no sources, as before.
  const describeColumnSources = async (
    sqlText: string,
    paramCount: number,
    childDb: string | null,
  ): Promise<QueryResult['columnSources']> => {
    try {
      // A parameterized statement only describes alongside a declaration of its
      // parameters. Their real types are unknown here, but sql_variant accepts an
      // implicit conversion from every type the driver binds, so the equality
      // predicates this app generates (follow-FK, grid filters) compile; a usage
      // sql_variant cannot satisfy (LIKE, TOP) fails the describe and degrades.
      const declaration = Array.from({ length: paramCount }, (_, i) => `@p${i + 1} sql_variant`).join(', ')
      const rows = await metaRows<{ source_schema: string | null; source_table: string | null; source_column: string | null }>(
        `select source_schema, source_table, source_column
         from sys.dm_exec_describe_first_result_set(@p1, @p2, 1)
         where is_hidden = 0 and column_ordinal > 0
         order by column_ordinal`,
        [sqlText, paramCount ? declaration : null],
        childDb,
      )
      return rows.length
        ? rows.map((row) => ({ schema: row.source_schema, table: row.source_table, column: row.source_column }))
        : undefined
    } catch {
      // Undescribable statement, or the metadata pool was saturated. Sources are
      // an enhancement; losing them only costs grid editing, never correctness.
      return undefined
    }
  }

  // Attaches column sources to a result, but only when they provably line up.
  // The DMV describes the FIRST result set of a single statement, so a GO-split
  // script or a multi-statement batch is left alone, and a count mismatch is
  // discarded outright: mapping a column to the wrong origin is worse than
  // having no origin, because the grid would build writes against that table.
  const withColumnSources = async (
    selected: QueryResultSet,
    batches: string[],
    resultSetCount: number,
    paramCount: number,
    childDb: string | null,
  ): Promise<QueryResultSet> => {
    if (batches.length !== 1 || resultSetCount !== 1 || !selected.columns.length) return selected
    const sources = await describeColumnSources(batches[0]!, paramCount, childDb)
    return sources && sources.length === selected.columns.length ? { ...selected, columnSources: sources } : selected
  }

  return {
    async connect() {
      const discovery = profile.database.trim() || 'master'
      pools = new Map([[discovery, makePool(discovery)]])
      active = discovery

      const version = mssqlVersion((await metaRows<{ v: string }>('select @@version as v'))[0]?.v ?? '')

      if (profile.databaseMode === 'all') {
        const listed = await metaRows<{ name: string }>(
          `select name from sys.databases
           where state = 0 and name not in (${SYSTEM_DBS.map((_, i) => `@p${i + 1}`).join(', ')}) order by name`,
          SYSTEM_DBS,
        )
        childNames = listed.map((row) => row.name)
        if (!childNames.length) childNames = [discovery]
      } else {
        childNames = [discovery]
      }

      active = childNames.includes(discovery) ? discovery : (childNames[0] ?? discovery)
      return version
    },

    async disconnect() {
      // Discard the pinned connection first so the pool close can't wait on it.
      await dropPin(false)
      const closing = pools
      pools = null
      if (!closing) return
      await Promise.all([...closing.values()].map((pool) => pool.close().catch(() => {})))
    },

    async query(sqlText, params = [], childDb = null, sort = null, filter = null, executionId) {
      const started = performance.now()
      const plan = prepareSqlRun({ engine: 'sqlserver', sql: sqlText, params, sort, filter })
      // SET SHOWPLAN_x must own its batch, so an estimated-plan run is always
      // `SET … ON / GO / statement`, and a pinned transaction adds `GO / SET …
      // OFF` to restore the session it would otherwise strand. Each of those
      // SET batches returns nothing, which still counts as a result set — and
      // the trailing one would make the run's last result an empty grid. Under
      // SHOWPLAN no statement executes, so a columnless set can only be one of
      // those SETs: dropping them leaves the plan as the run's only result.
      const shown = (resultSets: QueryResultSet[]) => {
        if (!SHOWPLAN_SWITCH.test(sqlText)) return resultSets
        const plans = resultSets.filter((set) => set.columns.length > 0)
        return plans.length ? plans : resultSets
      }
      const collect = (result: QueryResult, resultSets: QueryResultSet[]) =>
        resultSets.push(...(result.resultSets ?? [{
          columns: result.columns,
          columnSources: result.columnSources,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          rowCountExact: result.rowCountExact,
        }]))

      // Transaction-control scripts need a retainable connection, including bound runs.
      const mapCancelled = (error: unknown) =>
        isCancelled(error) || (error as Error).message === t('query.cancelled') ? new Error(t('query.cancelled')) : error

      if (plan.params.length === 0 || plan.transaction.sawControl) {
        const entry = { executionId, request: null as sql.Request | null, tediousCancel: null as (() => void) | null, cancelRequested: false }
        running.add(entry)

        // A pinned transaction's connection can't multiplex: queue this run
        // behind whatever the transaction is already doing and route it there.
        // The unpin decision happens INSIDE the chain, so a queued run can
        // never execute on a connection an earlier COMMIT already released —
        // it observes the cleared pin at its own turn and reroutes below.
        const pinned = pin
        if (pinned) {
          const database = databaseForQuery(childDb)
          if (database !== pinned.database) {
            running.delete(entry)
            throw new Error(t('query.transactionOtherDatabase', { database: pinned.database }))
          }
          const run = pinned.chain.then(async () => {
            if (pin !== pinned) return null
            entry.tediousCancel = () => pinned.conn.cancel()
            if (entry.cancelRequested) throw new Error(t('query.cancelled'))
            const resultSets: QueryResultSet[] = []
            let result: QueryResult = { columns: [], rows: [], rowCount: 0, durationMs: 0 }
            const budget = { bytes: 0 }
            try {
              for (const batch of plan.batches) {
                if (entry.cancelRequested) throw new Error(t('query.cancelled'))
                result = await streamTediousBatch(pinned.conn, batch, started, budget, plan.params, true)
                collect(result, resultSets)
              }
              // COMMIT at @@TRANCOUNT > 1 sends no ENVCHANGE, so inTransaction
              // stays truthful for nested transactions too.
              if (pin === pinned && !pinned.conn.inTransaction) await dropPin(true)
              return { result, resultSets }
            } catch (error) {
              if (pin === pinned) {
                // A dead socket leaves inTransaction stale — never keep a
                // corpse pinned; otherwise XACT_ABORT (or an ATTENTION-
                // cancelled batch) may have rolled back server-side, and
                // ENVCHANGE keeps the flag truthful.
                if (pinned.conn.closed) await dropPin(false)
                else if (!pinned.conn.inTransaction) await dropPin(true)
              }
              throw error
            }
          })
          pinned.chain = run.catch(() => {})
          try {
            const outcome = await run
            if (outcome) {
              // No withColumnSources here: its catalog reads run on other
              // connections and block on the transaction's own schema locks.
              const sets = shown(outcome.resultSets)
              const selected = sets[sets.length - 1] ?? outcome.result
              return {
                ...selected,
                durationMs: outcome.result.durationMs,
                ...(sets.length > 1 ? { resultSets: sets } : {}),
              }
            }
            // The transaction ended before this run's turn: fall through to a
            // fresh pooled connection, as any run after COMMIT would get.
          } catch (error) {
            throw mapCancelled(error)
          } finally {
            running.delete(entry)
          }
          running.add(entry)
        }

        const database = databaseForQuery(childDb)
        let conn: TediousConnection | null = null
        // Null until the checkout lands, so a failure there still runs the
        // catch and finally below rather than escaping them.
        let pool: AcquirablePool | null = null
        try {
          const checkout = await checkoutFor(childDb)
          pool = checkout.pool
          conn = checkout.conn
          const active = conn
          entry.tediousCancel = () => active.cancel()
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          const resultSets: QueryResultSet[] = []
          let result: QueryResult = { columns: [], rows: [], rowCount: 0, durationMs: 0 }
          const budget = { bytes: 0 }
          for (const batch of plan.batches) {
            if (entry.cancelRequested) throw new Error(t('query.cancelled'))
            result = await streamTediousBatch(conn, batch, started, budget, plan.params, true)
            collect(result, resultSets)
          }
          // The run left a transaction open (manual BEGIN TRAN): pin the
          // connection for later runs instead of resetting it. Column sources
          // are skipped for the same lock reason as above. One pin per
          // connection: when a concurrent run adopted one meanwhile, the
          // finally's releaseClean rolls this transaction back and the run
          // reports it explicitly.
          if (conn.inTransaction) {
            if (pin) throw new Error(t('query.transactionAlreadyOpen'))
            const adopted = conn
            conn = null
            adoptPin(adopted, pool, database)
            const pinnedSets = shown(resultSets)
            const selected = pinnedSets[pinnedSets.length - 1] ?? result
            return { ...selected, durationMs: result.durationMs, ...(pinnedSets.length > 1 ? { resultSets: pinnedSets } : {}) }
          }
          const sets = shown(resultSets)
          const selected = await withColumnSources(
            sets[sets.length - 1] ?? result,
            plan.batches,
            sets.length,
            plan.params.length,
            childDb,
          )
          return { ...selected, durationMs: result.durationMs, ...(sets.length > 1 ? { resultSets: sets } : {}) }
        } catch (error) {
          // `BEGIN TRAN; bad-statement` can leave the transaction open (no
          // XACT_ABORT): pin it so the user can roll it back — but never a
          // dead connection (inTransaction goes stale on socket death), and
          // never over an existing pin (the finally rolls this one back).
          if (pool && conn && conn.inTransaction && !conn.closed && !pin) {
            const adopted = conn
            conn = null
            adoptPin(adopted, pool, database)
          }
          throw mapCancelled(error)
        } finally {
          running.delete(entry)
          // Reset on release, not before use: a failed script's open transaction
          // rolls back now instead of holding locks while the connection idles,
          // and metadata reads borrowing from this pool always start clean.
          if (pool && conn) await releaseClean(pool, conn)
        }
      }

      const entry = { executionId, request: null as sql.Request | null, tediousCancel: null as (() => void) | null, cancelRequested: false }
      running.add(entry)

      // While pinned, a parameterized run joins the transaction through the
      // tedious-level parameter path (execSql) on the pinned connection — the
      // throwaway-pool path below would silently execute outside it.
      const pinnedParams = pin
      if (pinnedParams) {
        const database = databaseForQuery(childDb)
        if (database !== pinnedParams.database) {
          running.delete(entry)
          throw new Error(t('query.transactionOtherDatabase', { database: pinnedParams.database }))
        }
        const run = pinnedParams.chain.then(async () => {
          if (pin !== pinnedParams) return null
          entry.tediousCancel = () => pinnedParams.conn.cancel()
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          try {
            const result = await streamTediousBatch(pinnedParams.conn, plan.batches[0]!, started, { bytes: 0 }, plan.params)
            if (pin === pinnedParams && !pinnedParams.conn.inTransaction) await dropPin(true)
            return result
          } catch (error) {
            if (pin === pinnedParams) {
              if (pinnedParams.conn.closed) await dropPin(false)
              else if (!pinnedParams.conn.inTransaction) await dropPin(true)
            }
            throw error
          }
        })
        pinnedParams.chain = run.catch(() => {})
        try {
          const result = await run
          if (result) return result
          // Transaction ended before this run's turn: use the normal path.
        } catch (error) {
          throw mapCancelled(error)
        } finally {
          running.delete(entry)
        }
        running.add(entry)
      }

      let userPool: sql.ConnectionPool | null = null
      try {
        const pool = await openUserPool(childDb)
        userPool = pool
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
        let result: QueryResult = { columns: [], rows: [], rowCount: 0, durationMs: 0 }
        const resultSets: QueryResultSet[] = []
        const budget = { bytes: 0 }
        for (const batch of plan.batches) {
          entry.request = bind(pool.request(), plan.params)
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          result = await streamQuery(entry.request, batch, started, budget)
          collect(result, resultSets)
        }
        // A followed foreign key runs through here (its value is bound), so the
        // parameterized path needs sources too or the followed result could
        // neither be edited safely nor followed further.
        const sets = shown(resultSets)
        const selected = await withColumnSources(
          sets[sets.length - 1] ?? result,
          plan.batches,
          sets.length,
          plan.params.length,
          childDb,
        )
        return {
          ...selected,
          durationMs: result.durationMs,
          ...(sets.length > 1 ? { resultSets: sets } : {}),
        }
      } catch (error) {
        throw isCancelled(error) || (error as Error).message === t('query.cancelled') ? new Error(t('query.cancelled')) : error
      } finally {
        running.delete(entry)
        await userPool?.close().catch(() => {})
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      const entry = { request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      let userPool: sql.ConnectionPool | null = null
      let transaction: sql.Transaction | null = null
      let index = -1
      try {
        userPool = await openUserPool(childDb)
        transaction = new sql.Transaction(userPool)
        await transaction.begin()
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          entry.request = bind(new sql.Request(transaction), statement.params)
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          const result = await entry.request.query(statement.sql)
          // A write that matched nothing means the row moved or vanished since
          // the user reviewed it — abort the whole batch rather than half-apply.
          const affected = result.rowsAffected[0] ?? 0
          if (statement.expectedRows !== undefined ? affected !== statement.expectedRows : affected === 0) {
            await transaction.rollback()
            return {
              success: false,
              failedIndex: index,
              error: statement.expectedRows !== undefined
                ? `Expected ${statement.expectedRows} affected row(s), but ${affected} matched. Refresh and try again.`
                : BATCH_ZERO_ROWS,
            }
          }
        }
        await transaction.commit()
        return { success: true }
      } catch (error) {
        await transaction?.rollback().catch(() => {})
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isCancelled(error) || (error as Error).message === t('query.cancelled') ? t('query.saveCancelled') : errorMessage(error),
        }
      } finally {
        running.delete(entry)
        await userPool?.close().catch(() => {})
      }
    },

    async runDdl(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // SQL Server DDL is transactional, so all-or-nothing like Postgres.
      const entry = { request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      let userPool: sql.ConnectionPool | null = null
      let transaction: sql.Transaction | null = null
      let index = -1
      try {
        userPool = await openUserPool(childDb)
        transaction = new sql.Transaction(userPool)
        await transaction.begin()
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
        for (index = 0; index < statements.length; index += 1) {
          // batch() not query(): DDL like CREATE VIEW must be alone in a batch,
          // and sp_executesql (query with params) counts as one.
          entry.request = new sql.Request(transaction)
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          await entry.request.batch(statements[index]!)
        }
        await transaction.commit()
        return { success: true }
      } catch (error) {
        await transaction?.rollback().catch(() => {})
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isCancelled(error) || (error as Error).message === t('query.cancelled') ? t('query.saveCancelled') : errorMessage(error),
        }
      } finally {
        running.delete(entry)
        await userPool?.close().catch(() => {})
      }
    },

    async databaseCreateMeta() {
      const collations = await metaRows<{ name: string }>('select name from sys.fn_helpcollations() order by name')
      const [server] = await metaRows<{ collation: string }>(
        "select cast(serverproperty('Collation') as nvarchar(200)) as collation",
      )
      return {
        engine: profile.engine,
        collations: collations.map((row) => row.name),
        defaults: { collation: server?.collation },
      }
    },

    async createDatabase(name, options) {
      const collate = options?.collation ? ` collate ${sqlOptionToken(options.collation)}` : ''
      // CREATE DATABASE refuses transactions and sp_executesql; plain batch.
      await requestOn(null, (request) => request.batch(`create database ${dialect.quoteIdent(name)}${collate}`))
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
        await pool.close().catch(() => {})
      }
      // A refused drop (e.g. other sessions) propagates: the database stays in
      // childNames, so it remains browsable and re-opens its pool on demand.
      await requestOn(null, (request) => request.batch(`drop database ${dialect.quoteIdent(name)}`))
      childNames = childNames.filter((child) => child !== name)
    },

    async cancel(executionId) {
      // tedious cancels in-band on the request itself; no KILL needed.
      const entries = [...running].filter((entry) => executionId === undefined || entry.executionId === executionId)
      for (const entry of entries) entry.cancelRequested = true
      for (const entry of entries) {
        entry.request?.cancel()
        entry.tediousCancel?.()
      }
      return { running: entries.length, cancelled: entries.length }
    },

    async exportQuery({ sql: sqlText, params, childDb, sort, filter, filePath, format, sqlTarget, executionId }) {
      const plan = prepareSqlRun({ engine: 'sqlserver', sql: sqlText, params, sort, filter })
      if (plan.batches.length !== 1) {
        throw new Error(t('export.sqlServerSingleBatch'))
      }
      // Registered like query() so Stop (and disconnect) can interrupt a
      // runaway export instead of it streaming to completion unstoppably.
      const entry = { executionId, request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      let userPool: sql.ConnectionPool | null = null
      let writer: ExportWriter | null = null
      try {
        userPool = await openUserPool(childDb)
        writer = openExportWriter(filePath, format, sqlTarget)
        const request = bind(userPool.request(), plan.params)
        entry.request = request
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
        await streamMssqlExport(request, plan.batches[0]!, writer)
        return await writer.close()
      } catch (error) {
        await writer?.close().catch(() => {})
        throw isCancelled(error) || (error as Error).message === t('query.cancelled') ? new Error(t('query.cancelled')) : error
      } finally {
        running.delete(entry)
        await userPool?.close().catch(() => {})
      }
    },

    async listTables(childDb = null) {
      const rows = await metaRows<{ table_schema: string; name: string; type: string }>(
        `select table_schema as table_schema, table_name as name, table_type as type
         from information_schema.tables where table_type in ('BASE TABLE', 'VIEW')
         order by table_schema, table_name`,
        [],
        childDb,
      )
      return rows.map(
        (row): TableRef => ({ schema: row.table_schema, name: row.name, kind: row.type === 'VIEW' ? 'view' : 'table' }),
      )
    },

    async listTableStats(childDb = null) {
      const rows = await metaRows<{ table_schema: string; name: string; total_bytes: string | number | null }>(
        `select s.name as table_schema, t.name as name,
                sum(cast(a.total_pages as bigint)) * 8192 as total_bytes
         from sys.tables t
         join sys.schemas s on s.schema_id = t.schema_id
         join sys.indexes i on i.object_id = t.object_id
         join sys.partitions p on p.object_id = i.object_id and p.index_id = i.index_id
         join sys.allocation_units a
           on a.container_id = case when a.type in (1, 3) then p.hobt_id else p.partition_id end
         group by s.name, t.name
         order by s.name, t.name`,
        [],
        childDb,
      )
      return rows.flatMap((row) => {
        const totalBytes = byteCount(row.total_bytes)
        return totalBytes === null ? [] : [{ schema: row.table_schema, name: row.name, totalBytes } satisfies TableStat]
      })
    },

    async listColumns(childDb = null) {
      const rows = await metaRows<{
        table_schema: string
        table_name: string
        name: string
        data_type: string
        nullable: boolean
        pk: number
        fk: number
        ref_constraint: string | null
        ref_schema: string | null
        ref_table: string | null
        ref_column: string | null
      }>(
        // The FK target comes from the same sys.foreign_key_columns row the fk
        // flag is derived from. A column can sit in several foreign keys, so the
        // apply takes the first constraint by name — the same stable rule the
        // postgres and mysql drivers use.
        `select s.name as table_schema, t.name as table_name, c.name as name,
                ${mssqlTypeExpression} as data_type,
                c.is_nullable as nullable,
                iif(exists (select 1 from sys.index_columns ic
                            join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                            where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id), 1, 0) as pk,
                iif(exists (select 1 from sys.foreign_key_columns fkc
                            where fkc.parent_object_id = c.object_id and fkc.parent_column_id = c.column_id), 1, 0) as fk,
                ref.ref_constraint, ref.ref_schema, ref.ref_table, ref.ref_column
         from sys.columns c
         join sys.objects t on t.object_id = c.object_id and t.type in ('U', 'V')
         join sys.schemas s on s.schema_id = t.schema_id
         join sys.types ty on ty.user_type_id = c.user_type_id
         outer apply (
           select top 1 fk.name as ref_constraint,
                  object_schema_name(fkc.referenced_object_id) as ref_schema,
                  object_name(fkc.referenced_object_id) as ref_table,
                  col_name(fkc.referenced_object_id, fkc.referenced_column_id) as ref_column
           from sys.foreign_key_columns fkc
           join sys.foreign_keys fk on fk.object_id = fkc.constraint_object_id
           where fkc.parent_object_id = c.object_id and fkc.parent_column_id = c.column_id
           order by fk.name
         ) ref
         order by s.name, t.name, c.column_id`,
        [],
        childDb,
      )
      return rows.map(
        (row): ColumnRef => ({
          schema: row.table_schema,
          table: row.table_name,
          name: row.name,
          dataType: row.data_type,
          nullable: !!row.nullable,
          primaryKey: !!row.pk,
          foreignKey: !!row.fk,
          ...columnReference(row.ref_schema, row.ref_table, row.ref_column, row.ref_constraint),
        }),
      )
    },

    async listObjects(childDb = null) {
      const functions = await metaRows<DbObject>(
        `select s.name as [schema], o.name as name,
                isnull(stuff((select ', ' + concat(p.name, ' ', type_name(p.user_type_id))
                              from sys.parameters p
                              where p.object_id = o.object_id and p.parameter_id > 0
                              order by p.parameter_id for xml path('')), 1, 2, ''), '') as detail
         from sys.objects o
         join sys.schemas s on s.schema_id = o.schema_id
         where o.type in ('FN', 'IF', 'TF', 'P') and o.is_ms_shipped = 0
         order by s.name, o.name`,
        [],
        childDb,
      )
      return { functions, types: [] }
    },

    async inspectObject(object, _objectKind, childDb = null) {
      const qualified = object.schema
        ? `${dialect.quoteIdent(object.schema)}.${dialect.quoteIdent(object.name)}`
        : dialect.quoteIdent(object.name)
      const rows = await metaRows<{ definition: string | null }>(
        'select object_definition(object_id(@p1)) as definition',
        [qualified],
        childDb,
      )
      const definition = rows[0]?.definition
      if (!definition) throw new Error(`Routine ${object.name} was not found (or its definition is not accessible).`)
      return { columns: [], sections: [{ title: 'Definition', rows: [{ name: object.name, definition }] }] }
    },

    async objectDdl(ref, childDb = null) {
      const qualified = ref.schema
        ? `${dialect.quoteIdent(ref.schema)}.${dialect.quoteIdent(ref.name)}`
        : dialect.quoteIdent(ref.name)
      const rows = await metaRows<{ definition: string | null }>(
        'select object_definition(object_id(@p1)) as definition',
        [qualified],
        childDb,
      )
      const definition = rows[0]?.definition
      if (!definition) {
        const noun = ref.kind === 'function' ? 'Function' : 'View'
        throw new Error(`${noun} ${ref.name} was not found (or its definition is not accessible).`)
      }
      // CREATE OR ALTER (SQL Server 2016 SP1+) re-runs as a single batch — no
      // DROP/GO dance, and it keeps existing permissions. Leave one alone if the
      // stored text already uses it.
      if (/\bCREATE\s+OR\s+ALTER\b/i.test(definition)) return definition
      return definition.replace(/\bCREATE\s+(FUNCTION|VIEW|PROC|PROCEDURE|TRIGGER)\b/i, 'CREATE OR ALTER $1')
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
      const [counts] = await metaRows<{ used: number; max: number }>(
        // 'user connections' is 0 by default, meaning no configured limit — the
        // gauge shows a bare count rather than a ratio against zero.
        `select (select count(*) from sys.dm_exec_sessions where is_user_process = 1) as used,
                (select cast(value_in_use as int) from sys.configurations where name = 'user connections') as [max]`,
        [],
        childDb,
      )
      const [uptime] = await metaRows<{ uptime_seconds: number }>(
        `select datediff(second, sqlserver_start_time, getdate()) as uptime_seconds from sys.dm_os_sys_info`,
        [],
        childDb,
      )
      const sessions = await metaRows<SessionRow>(
        `select top ${MAX_SESSIONS}
                cast(s.session_id as varchar(20)) as id,
                coalesce(s.login_name, '') as [user],
                db_name(s.database_id) as [database],
                lower(coalesce(r.status, s.status, '')) as state,
                r.total_elapsed_time as elapsed_ms,
                nullif(ltrim(rtrim(coalesce(t.text, ''))), '') as sql,
                case when s.program_name = @p1 then 1 else 0 end as self
         from sys.dm_exec_sessions s
         left join sys.dm_exec_requests r on r.session_id = s.session_id
         outer apply sys.dm_exec_sql_text(r.sql_handle) t
         -- Exclude the reader itself, which would otherwise head its own list.
         where s.is_user_process = 1 and s.session_id <> @@spid
         order by case when r.session_id is not null then 0 else 1 end, s.last_request_start_time desc`,
        [APP_CONNECTION_NAME],
        childDb,
      )
      const max = counts?.max
      return {
        connections: { used: counts?.used ?? 0, max: max && max > 0 ? max : null },
        stats: uptime?.uptime_seconds ? [{ label: 'Uptime', value: formatUptime(uptime.uptime_seconds) }] : [],
        selfIdentificationAvailable: true,
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
      // SQL Server has no statement-level cancel for another session: KILL always
      // ends the session and rolls it back. Refuse rather than quietly terminate
      // something the caller asked to merely interrupt — engine-capabilities
      // reports cancelSession: false so the UI never offers it here.
      if (mode === 'cancel') throw new Error(t('server.cancelUnsupported'))
      // KILL takes a literal spid, so validate rather than quote.
      const spid = Number(sessionId)
      if (!Number.isInteger(spid) || spid <= 0) throw new Error(t('server.sessionUnknown'))
      await metaRows(`KILL ${spid}`)
    },

    async inspectServer(childDb = null) {
      type Row = { name: string; definition: string }
      const properties = await metaRows<Row>(
        `select 'Edition' as name, cast(serverproperty('Edition') as nvarchar(200)) as definition
         union all select 'Product Version', cast(serverproperty('ProductVersion') as nvarchar(200))
         union all select 'Collation', cast(serverproperty('Collation') as nvarchar(200))
         union all select 'Machine Name', cast(serverproperty('MachineName') as nvarchar(200))`,
        [],
        childDb,
      )
      // Server principals need VIEW ANY DEFINITION; absent, skip the section.
      const logins = await metaRows<Row>(
        `select name as name, lower(type_desc) as definition
         from sys.server_principals where type in ('S', 'U') and name not like '##%' order by name`,
        [],
        childDb,
      ).catch(() => [])
      return [
        { title: 'Server Properties', rows: properties },
        { title: 'Logins', rows: logins },
      ].filter((section) => section.rows.length)
    },

    async inspectTable(table, childDb = null) {
      type Row = { name: string; definition: string }
      const qualified = table.schema
        ? `${dialect.quoteIdent(table.schema)}.${dialect.quoteIdent(table.name)}`
        : dialect.quoteIdent(table.name)

      const [columns, primaryKey, foreignKeys, checks, indexes, partitions, triggers] = await Promise.all([
        metaRows<{
          name: string
          data_type: string
          nullable: boolean
          default_expr: string | null
          pk: number
          fk: number
          identity: boolean
          computed: boolean
          collation: string | null
        }>(
          `select c.name as name,
                  ${mssqlTypeExpression} as data_type,
                  c.is_nullable as nullable,
                  dc.definition as default_expr,
                  iif(exists (select 1 from sys.index_columns ic
                              join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                              where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id), 1, 0) as pk,
                  iif(exists (select 1 from sys.foreign_key_columns fkc
                              where fkc.parent_object_id = c.object_id and fkc.parent_column_id = c.column_id), 1, 0) as fk,
                  c.is_identity as [identity],
                  c.is_computed as computed,
                  nullif(c.collation_name, convert(sysname, databasepropertyex(db_name(), 'Collation'))) as collation
           from sys.columns c
           join sys.types ty on ty.user_type_id = c.user_type_id
           left join sys.default_constraints dc on dc.object_id = c.default_object_id
           where c.object_id = object_id(@p1)
           order by c.column_id`,
          [qualified],
          childDb,
        ),
        // The primary key (its own constraint name); one row or none.
        metaRows<Row>(
          `select kc.name as name,
                  concat('PRIMARY KEY (',
                         stuff((select ', ' + col_name(ic.object_id, ic.column_id)
                                from sys.index_columns ic
                                where ic.object_id = kc.parent_object_id and ic.index_id = kc.unique_index_id
                                order by ic.key_ordinal for xml path('')), 1, 2, ''), ')') as definition
           from sys.key_constraints kc
           where kc.parent_object_id = object_id(@p1) and kc.type = 'PK'`,
          [qualified],
          childDb,
        ),
        metaRows<Row>(
          `select fk.name as name,
                  concat('FOREIGN KEY (',
                         stuff((select ', ' + col_name(fkc.parent_object_id, fkc.parent_column_id)
                                from sys.foreign_key_columns fkc where fkc.constraint_object_id = fk.object_id
                                order by fkc.constraint_column_id for xml path('')), 1, 2, ''),
                         ') REFERENCES ', object_schema_name(fk.referenced_object_id), '.', object_name(fk.referenced_object_id),
                         ' (', stuff((select ', ' + col_name(fkc.referenced_object_id, fkc.referenced_column_id)
                                      from sys.foreign_key_columns fkc where fkc.constraint_object_id = fk.object_id
                                      order by fkc.constraint_column_id for xml path('')), 1, 2, ''), ')',
                         ' ON UPDATE ', replace(fk.update_referential_action_desc, '_', ' '),
                         ' ON DELETE ', replace(fk.delete_referential_action_desc, '_', ' ')) as definition
           from sys.foreign_keys fk
           where fk.parent_object_id = object_id(@p1)
           order by fk.name`,
          [qualified],
          childDb,
        ),
        metaRows<Row>(
          `select name as name, definition as definition
           from sys.check_constraints where parent_object_id = object_id(@p1) order by name`,
          [qualified],
          childDb,
        ),
        metaRows<Row & { size_bytes: string | number | null }>(
          `select i.name as name,
                  concat(iif(i.is_unique = 1, 'UNIQUE ', ''), '(',
                         stuff((select ', ' + col_name(ic.object_id, ic.column_id)
                                from sys.index_columns ic
                                where ic.object_id = i.object_id and ic.index_id = i.index_id and ic.is_included_column = 0
                                order by ic.key_ordinal for xml path('')), 1, 2, ''),
                         ') ', i.type_desc) as definition,
                  (select sum(cast(a.total_pages as bigint)) * 8192
                   from sys.partitions p
                   join sys.allocation_units a
                     on a.container_id = case when a.type in (1, 3) then p.hobt_id else p.partition_id end
                   where p.object_id = i.object_id and p.index_id = i.index_id) as size_bytes
           from sys.indexes i
           where i.object_id = object_id(@p1) and i.is_primary_key = 0 and i.type > 0
           order by i.name`,
          [qualified],
          childDb,
        ),
        // Partition N spans boundary N-1 to boundary N; which end includes its
        // boundary is what RANGE LEFT/RIGHT decides, so the interval brackets
        // carry it. A table not on a partition scheme joins to no function and
        // drops out here, which is how the section stays hidden for it.
        metaRows<Row & { size_bytes: string | number | null }>(
          `with part_scheme as (
             select ps.function_id, pf.type_desc, pf.boundary_value_on_right,
                    col_name(ic.object_id, ic.column_id) as column_name
             from sys.indexes i
             join sys.index_columns ic
               on ic.object_id = i.object_id and ic.index_id = i.index_id and ic.partition_ordinal > 0
             join sys.partition_schemes ps on ps.data_space_id = i.data_space_id
             join sys.partition_functions pf on pf.function_id = ps.function_id
             where i.object_id = object_id(@p1) and i.index_id in (0, 1)
           ),
           part_size as (
             select p.partition_number, sum(cast(a.total_pages as bigint)) * 8192 as size_bytes
             from sys.partitions p
             join sys.allocation_units a
               on a.container_id = case when a.type in (1, 3) then p.hobt_id else p.partition_id end
             where p.object_id = object_id(@p1)
             group by p.partition_number
           )
           select concat('Partition ', s.partition_number) as name,
                  concat(f.type_desc, iif(f.boundary_value_on_right = 1, ' RIGHT', ' LEFT'),
                         ' (', f.column_name, ') — ',
                         iif(f.boundary_value_on_right = 1, '[', '('),
                         isnull(convert(nvarchar(64), lo.value, 121), 'MIN'), ', ',
                         isnull(convert(nvarchar(64), hi.value, 121), 'MAX'),
                         iif(f.boundary_value_on_right = 1, ')', ']')) as definition,
                  s.size_bytes
           from part_size s
           cross join part_scheme f
           left join sys.partition_range_values lo
             on lo.function_id = f.function_id and lo.boundary_id = s.partition_number - 1
           left join sys.partition_range_values hi
             on hi.function_id = f.function_id and hi.boundary_id = s.partition_number
           order by s.partition_number`,
          [qualified],
          childDb,
        ),
        metaRows<Row>(
          `select t.name as name, isnull(object_definition(t.object_id), '(encrypted)') as definition
           from sys.triggers t where t.parent_id = object_id(@p1) order by t.name`,
          [qualified],
          childDb,
        ),
      ])

      const sections: InspectSection[] = [
        { title: 'Foreign Keys', rows: foreignKeys },
        // PK is shown read-only in the UI (also the columns table's key marker), like FKs.
        { title: 'Constraints', rows: [...primaryKey, ...checks] },
        // Sizes are allocated pages, not estimates, so they aren't marked approximate.
        { title: 'Indexes', rows: indexes.map(({ size_bytes, ...row }) => sizedRow(row, size_bytes)) },
        { title: 'Partitions', rows: partitions.map(({ size_bytes, ...row }) => sizedRow(row, size_bytes)) },
        { title: 'Triggers', rows: triggers },
      ]
      return {
        columns: columns.map((row) => ({
          name: row.name,
          dataType: row.data_type,
          nullable: !!row.nullable,
          // identity plays the role of a default, like auto_increment on MySQL.
          default: row.default_expr ?? (row.identity ? 'identity' : null),
          primaryKey: !!row.pk,
          foreignKey: !!row.fk,
          comment: null,
          collation: row.collation,
          generated: !!row.computed,
          identity: row.identity ? 'always' as const : undefined,
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

    openTransaction() {
      return pin ? { childDb: pin.database } : null
    },

    async endTransaction(mode) {
      const pinned = pin
      if (!pinned) throw new Error(t('transaction.none'))
      // Ending and unpinning happen inside the chain, so a queued run cannot
      // start until the release has fully completed.
      const run = pinned.chain.then(async () => {
        if (pin !== pinned) return
        try {
          await streamTediousBatch(pinned.conn, mode === 'commit' ? 'COMMIT' : 'ROLLBACK', performance.now(), { bytes: 0 })
          // COMMIT at @@TRANCOUNT > 1 only decrements the count: the outer
          // transaction is still open, so the pin must survive — unpinning
          // would let sp_reset_connection roll it back behind the user.
          if (pin === pinned && !pinned.conn.inTransaction) await dropPin(true)
        } catch (error) {
          // A failed COMMIT on a live, still-open transaction (uncommittable,
          // error 3930) leaves rollback as the way out: keep the pin. Only a
          // dead or transaction-less connection forfeits it.
          if (pin === pinned && (pinned.conn.closed || !pinned.conn.inTransaction)) await dropPin(false)
          throw error as Error
        }
      })
      pinned.chain = run.catch(() => {})
      await run
    },
  }
}

// Streams rows so a huge or multi-result batch can't OOM the main process.
// The byte budget is shared by every result set in this execution.
function streamQuery(
  request: sql.Request,
  sqlText: string,
  started: number,
  budget: { bytes: number } = { bytes: 0 },
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    request.stream = true
    request.arrayRowMode = true
    let columns: string[] = []
    let rows: unknown[][] = []
    let total = 0
    let sawRecordset = false
    let affected = 0
    let limited = false
    let active = false
    let fields: MssqlColumn[] = []
    let conversionError: Error | null = null
    const resultSets: QueryResultSet[] = []
    const pushCurrent = () => {
      if (!active) return
      resultSets.push({ columns, rows, rowCount: total, truncated: limited || total > rows.length, rowCountExact: true })
      active = false
    }
    request.on('recordset', (recordset: MssqlColumn[]) => {
      pushCurrent()
      sawRecordset = true
      fields = recordset
      columns = recordset.map((column) => column.name)
      rows = []
      total = 0
      limited = false
      active = true
    })
    request.on('row', (row: unknown[]) => {
      if (conversionError) return
      let normalized: unknown[]
      try {
        normalized = normalizeMssqlRow(row, fields)
      } catch (error) {
        conversionError = error as Error
        try { request.cancel() } catch { /* request may already be complete */ }
        return
      }
      total += 1
      if (rows.length < MAX_BUFFERED_ROWS) {
        const bounded = boundedRow(normalized, budget.bytes)
        if (bounded) {
          rows.push(bounded.row)
          budget.bytes += bounded.bytes
          limited ||= bounded.truncated
        } else {
          limited = true
        }
      } else {
        limited = true
      }
    })
    request.on('rowsaffected', (count: number) => {
      affected += count
    })
    const finish = () => {
      if (conversionError) {
        reject(conversionError)
        return
      }
      pushCurrent()
      if (!sawRecordset) resultSets.push({ columns: [], rows: [], rowCount: affected })
      const selected = resultSets[resultSets.length - 1] ?? { columns: [], rows: [], rowCount: affected }
      resolve({
        ...selected,
        durationMs: performance.now() - started,
        ...(resultSets.length > 1 ? { resultSets } : {}),
      })
    }
    request.on('error', (error) => {
      if (conversionError) reject(conversionError)
      else reject(error instanceof Error ? error : new Error(String(error)))
    })
    request.on('done', finish)
    void request.query(sqlText).catch(() => {
      // Errors surface via the 'error' event in stream mode; swallow the
      // duplicate rejection from the promise API.
    })
  })
}

// Streams every row of a read-only query into `writer` with backpressure: while
// a chunk is written to disk the request is paused so the server can't outrun
// the file. Rows are normalized losslessly (like the buffered path); no row cap.
export function streamMssqlExport(
  request: sql.Request,
  sqlText: string,
  writer: ExportWriter,
  chunkSize = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.stream = true
    request.arrayRowMode = true
    let columnsSet = false
    let fields: MssqlColumn[] = []
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
      request.pause()
      writer.rows(batch).then(() => {
        draining = false
        request.resume()
        flush()
      }, fail)
    }
    request.on('recordset', (recordset: MssqlColumn[]) => {
      // A second result set (T-SQL needs no semicolons between statements, so
      // the read-only guard can miss a batch) would silently merge rows of a
      // different shape under the first header — fail the export instead.
      if (columnsSet) {
        fail(new Error(t('export.singleStatement')))
        try { request.cancel() } catch { /* request may already be complete */ }
        return
      }
      fields = recordset
      writer.columns(recordset.map((column) => column.name))
      columnsSet = true
    })
    request.on('row', (row: unknown[]) => {
      if (failed) return
      let normalized: unknown[]
      try {
        normalized = normalizeMssqlRow(row, fields)
      } catch (error) {
        fail(error)
        try { request.cancel() } catch { /* request may already be complete */ }
        return
      }
      chunk.push(normalized)
      if (chunk.length >= chunkSize) flush()
    })
    request.on('error', fail)
    request.on('done', () => {
      ended = true
      flush()
    })
    void request.query(sqlText).catch(() => {
      // Errors surface via the 'error' event in stream mode.
    })
  })
}

// --- reset-connection read path -------------------------------------------
// node-mssql pools raw tedious Connections but never resets one on release, so
// reusing a pooled connection would leak session state (open transaction, SET
// options, #temp tables) between query tabs. tedious's Connection.reset() issues
// sp_reset_connection — a one-round-trip session scrub, no re-login. To use it we
// run the read at the tedious level on a connection we reset first; the result is
// normalized through the same normalizeMssqlRow the node-mssql path uses.

type TediousColumnMeta = { colName: string; type: { name: string }; precision?: number; scale?: number; dataLength?: number }
type TediousRowColumn = { value: unknown; metadata: TediousColumnMeta }
type TediousConnection = {
  reset(callback: (err?: Error | null) => void): void
  execSqlBatch(request: TediousRequest): void
  execSql(request: TediousRequest): void
  cancel(): void
  /** Synchronously marks the connection closed; the pool's validate discards it. */
  close(): void
  /** Maintained by tedious from ENVCHANGE tokens, so it tracks transactions
   * opened by raw BEGIN TRAN in a batch, not just tedious's own API. */
  inTransaction: boolean
  /** True once the socket is gone; inTransaction goes stale then. */
  closed: boolean
  on(event: 'error' | 'end', listener: () => void): void
  removeListener(event: 'error' | 'end', listener: () => void): void
}
// node-mssql's ConnectionPool acquires/releases the underlying tedious Connection
// through these methods; the public types omit them, so assert at this boundary.
export type AcquirablePool = sql.ConnectionPool & {
  acquire(requester: object, callback: (err: Error | null, connection: TediousConnection) => void): void
  release(connection: TediousConnection): void
}

export const acquireConnection = (pool: AcquirablePool): Promise<TediousConnection> =>
  new Promise((resolve, reject) => pool.acquire({}, (err, connection) => (err ? reject(err) : resolve(connection))))

export const resetConnection = (connection: TediousConnection): Promise<void> =>
  new Promise((resolve, reject) => connection.reset((err) => (err ? reject(err) : resolve())))

// Returns a pooled connection clean: sp_reset_connection rolls back any open
// transaction and clears USE/SET/temp state left by the run, whether it
// succeeded or failed. A connection whose reset fails is closed instead, so
// the pool discards it rather than handing out a session in an unknown state.
export const releaseClean = async (pool: AcquirablePool, connection: TediousConnection): Promise<void> => {
  try {
    await resetConnection(connection)
  } catch {
    try { connection.close() } catch { /* already closed */ }
  }
  pool.release(connection)
}

// The lossless value-parser patch already decodes decimal/money/datetimeoffset to
// strings, so those reach us as strings and normalizeMssqlRow leaves them. Only
// the temporal types still arrive as JS Date and need mapping back to the mssql
// type constant so normalizeMssqlRow renders them as lossless UTC text.
export function tediousToMssqlType(meta: TediousColumnMeta): { type?: unknown; precision?: number; scale?: number } {
  switch (meta.type.name) {
    case 'DateTime2':
    case 'DateTime2N':
      return { type: sql.DateTime2, scale: meta.scale }
    case 'DateTime':
    case 'DateTimeN':
      // datetime and smalldatetime share this token; 4-byte payload is smalldatetime.
      return { type: meta.dataLength === 4 ? sql.SmallDateTime : sql.DateTime }
    case 'SmallDateTime':
    case 'SmallDateTimeN':
      return { type: sql.SmallDateTime }
    case 'Date':
    case 'DateN':
      return { type: sql.Date }
    case 'Time':
    case 'TimeN':
      return { type: sql.Time, scale: meta.scale }
    case 'DateTimeOffset':
    case 'DateTimeOffsetN':
      return { type: sql.DateTimeOffset, scale: meta.scale }
    case 'Decimal':
    case 'DecimalN':
      return { type: sql.Decimal, precision: meta.precision, scale: meta.scale }
    case 'Numeric':
    case 'NumericN':
      return { type: sql.Numeric, precision: meta.precision, scale: meta.scale }
    case 'Money':
      return { type: sql.Money }
    case 'MoneyN':
      return { type: meta.dataLength === 4 ? sql.SmallMoney : sql.Money }
    case 'SmallMoney':
      return { type: sql.SmallMoney }
    default:
      return {}
  }
}

// Runs one batch on a tedious connection and buffers it into the shared
// QueryResult shape — the tedious-level twin of streamQuery, so both read
// paths return identical results. With `params` it goes through execSql
// (sp_executesql under the hood, @p1..@pN); without, the plain batch API.
// rowsAffected is only surfaced for a batch with no result set (a write),
// matching the node-mssql path.
function streamTediousBatch(
  conn: TediousConnection,
  sqlText: string,
  started: number,
  budget: { bytes: number },
  params?: unknown[],
  batchParameters = false,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    // RPC scope rejects a changed transaction count; typed batch locals preserve it.
    if (batchParameters && params?.length) sqlText = parameterizedBatch(sqlText, params)
    let columns: string[] = []
    let fields: MssqlColumn[] = []
    let rows: unknown[][] = []
    let total = 0
    let sawRecordset = false
    let affected = 0
    let limited = false
    let activeSet = false
    let conversionError: Error | null = null
    const resultSets: QueryResultSet[] = []
    const pushCurrent = () => {
      if (!activeSet) return
      resultSets.push({ columns, rows, rowCount: total, truncated: limited || total > rows.length, rowCountExact: true })
      activeSet = false
    }
    const request = new TediousRequest(sqlText, (err) => {
      if (conversionError) return reject(conversionError)
      if (err) return reject(err)
      pushCurrent()
      if (!sawRecordset) resultSets.push({ columns: [], rows: [], rowCount: affected })
      const selected = resultSets[resultSets.length - 1] ?? { columns: [], rows: [], rowCount: affected }
      resolve({ ...selected, durationMs: performance.now() - started, ...(resultSets.length > 1 ? { resultSets } : {}) })
    })
    const withEvents = request as unknown as {
      on(event: 'columnMetadata', listener: (columns: TediousColumnMeta[]) => void): void
      on(event: 'row', listener: (columns: TediousRowColumn[]) => void): void
      on(event: 'done' | 'doneInProc', listener: (rowCount: number | undefined) => void): void
    }
    withEvents.on('columnMetadata', (meta) => {
      pushCurrent()
      sawRecordset = true
      fields = meta.map((column) => ({ name: column.colName, ...tediousToMssqlType(column) }))
      columns = meta.map((column) => column.colName)
      rows = []
      total = 0
      limited = false
      activeSet = true
    })
    withEvents.on('row', (cols) => {
      if (conversionError) return
      let normalized: unknown[]
      try {
        normalized = normalizeMssqlRow(cols.map((column) => column.value), fields)
      } catch (error) {
        conversionError = error as Error
        try { conn.cancel() } catch { /* request may already be complete */ }
        return
      }
      total += 1
      if (rows.length < MAX_BUFFERED_ROWS) {
        const bounded = boundedRow(normalized, budget.bytes)
        if (bounded) {
          rows.push(bounded.row)
          budget.bytes += bounded.bytes
          limited ||= bounded.truncated
        } else {
          limited = true
        }
      } else {
        limited = true
      }
    })
    const onDone = (rowCount: number | undefined) => { if (typeof rowCount === 'number') affected += rowCount }
    withEvents.on('done', onDone)
    withEvents.on('doneInProc', onDone)
    if (params?.length && !batchParameters) {
      for (const [index, value] of params.entries()) {
        const bindable = toBindable(typeof value === 'bigint' ? value.toString() : value)
        request.addParameter(`p${index + 1}`, tediousTypeFor(bindable), bindable)
      }
      conn.execSql(request)
    } else {
      conn.execSqlBatch(request)
    }
  })
}
