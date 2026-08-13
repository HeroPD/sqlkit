import pg from 'pg'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import type { ConnectionOptions } from 'node:tls'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef, TableStat } from '../../src/electron'
import { dialectFor, sqlOptionToken } from '../../src/dialect'
import { isReadOnlyQuery } from '../../src/sql-order'
import { t } from '../../src/i18n'
import { columnReference } from './column-reference'
import { APP_CONNECTION_NAME, BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS, MAX_POOL_CONNECTIONS, MAX_SESSIONS, POOL_IDLE_MS } from './limits'
import { byteCount } from './table-stats'
import { formatUptime } from './server-stats'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { openExportWriter, type ExportWriter } from './export'
import { prepareSqlRun } from './sql-script'

// PostgreSQL server encodings are a fixed, compile-time set with no catalog to
// query, so the create dialog offers this documented list.
const PG_ENCODINGS = [
  'UTF8', 'SQL_ASCII', 'LATIN1', 'LATIN2', 'LATIN9', 'WIN1250', 'WIN1251', 'WIN1252', 'WIN1256',
  'ISO_8859_5', 'ISO_8859_7', 'KOI8R', 'EUC_CN', 'EUC_JP', 'EUC_KR', 'EUC_TW',
]

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

export function sslOptions(profile: ConnectionProfile): boolean | ConnectionOptions {
  const ssl = profile.ssl
  if (!ssl || ssl.mode === 'disable') return false
  if (ssl.mode === 'require') return { rejectUnauthorized: false }

  const options: ConnectionOptions = { rejectUnauthorized: true }
  const caPath = ssl.ca.trim()
  if (caPath) {
    try {
      if (statSync(expandHome(caPath)).size > 5 * 1024 * 1024) throw new Error(t('connection.caTooLarge'))
      options.ca = readFileSync(expandHome(caPath), 'utf8')
    } catch (error) {
      throw new Error(`Failed to read SSL CA certificate at ${caPath}: ${(error as Error).message}`, { cause: error })
    }
  }
  if (ssl.mode === 'verify-ca') options.checkServerIdentity = () => undefined
  return options
}

// PostgreSQL with all-databases support (reference behavior): connect to a
// discovery database and optionally list every database on the server. Only the
// database in use holds a pool: a connection cannot switch database, so each one
// needs its own, and keeping every child's alive spent the connection budget
// many times over on a server shared with real traffic. Switching child retires
// the outgoing pool and opens the incoming one on demand.
// Dials the endpoint, not the profile — the transport layer may have
// rewritten host/port to an SSH tunnel's local end.
type RunningEntry = { executionId?: string; pid: number | null; secret: number | null; cancelRequested: boolean }

// node-postgres exposes the backend PID at runtime but omits it from the public
// PoolClient type. Keep that upgrade-sensitive assertion at one boundary.
const backendPid = (client: pg.PoolClient): number | null =>
  (client as pg.PoolClient & { processID?: number }).processID ?? null

// The cancel key from the same BackendKeyData as the PID; both are needed for a
// protocol-level CancelRequest. Also untyped on the public PoolClient.
const backendSecret = (client: pg.PoolClient): number | null =>
  (client as pg.PoolClient & { secretKey?: number }).secretKey ?? null

// The client's underlying socket, for pausing reads to backpressure a streamed
// export. node-postgres doesn't expose it publicly, so reach it at one boundary.
const clientSocket = (client: pg.PoolClient): { pause(): void; resume(): void } | null =>
  (client as pg.PoolClient & { connection?: { stream?: { pause(): void; resume(): void } } }).connection?.stream ?? null

// The connection's transaction status from its last ReadyForQuery ('I' idle,
// 'T' in transaction, 'E' failed). node-postgres records it but doesn't type it.
const txStatus = (client: pg.PoolClient): string | null =>
  (client as pg.PoolClient & { _txStatus?: string | null })._txStatus ?? null

/** What the explorer lists: ordinary and partitioned tables, views, materialized
 * views, foreign tables. information_schema.tables would miss matviews entirely. */
const LISTED_RELKINDS = `'r', 'p', 'v', 'm', 'f'`

/** Of those, the ones that occupy storage: a view has none of its own. */
const SIZED_RELKINDS = `'r', 'p', 'm'`

/**
 * The relation scope every listing shares, so tables, columns and sizes cannot
 * drift apart. Assumes pg_class as `c` joined to its pg_namespace as `n`. An
 * individual partition is left out — its parent stands for the whole set, and
 * counting both would double every partitioned table.
 */
const userRelations = (relkinds: string) =>
  `c.relkind in (${relkinds})
           and not coalesce(c.relispartition, false)
           and n.nspname !~ '^pg_'
           and n.nspname <> 'information_schema'`

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
  // JSON/JSONB (114/3802) must also stay text: JSON.parse would round numeric
  // literals before the result-cell editor has a chance to preserve them.
  for (const oid of [1082, 1083, 1114, 1184, 1186, 1266, 1115, 1182, 1183, 1185, 1187, 1270, 1231, 114, 3802]) {
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
      application_name: APP_CONNECTION_NAME,
      // Read-only guardrail: the server rejects writes on every pooled
      // connection. A session-level default, so SET can still undo it.
      ...(profile.readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
      max: MAX_POOL_CONNECTIONS,
      idleTimeoutMillis: POOL_IDLE_MS,
      connectionTimeoutMillis: 8000,
      // TCP keepalive (on by default in mysql2/tedious, off in pg): a dead peer
      // self-terminates, so an abandoned pool.end() can't hold sockets forever.
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    })
    // Idle clients emit 'error' when the server closes them (restart,
    // timeout); without a handler that exception takes down the main
    // process. The pool discards the client; surface it as a status update.
    pool.on('error', (error) => events.onError(error.message))
    // pg-pool only guards idle clients — checkout strips that listener, and a
    // client whose socket dies mid-flight emits 'error' as well as rejecting
    // the in-flight query (pg-pool's own pool.query() re-attaches a guard;
    // manual connect() gets nothing). 'connect' fires once per physical
    // client: one permanent absorber covers every checkout for its lifetime,
    // while callers keep seeing the failure through the rejection.
    pool.on('connect', (client) => client.on('error', () => {}))
    return pool
  }

  // A manual transaction (the user ran BEGIN) pins its checked-out client so
  // later runs join it instead of drawing a fresh pooled connection.
  type Pin = { client: pg.PoolClient; database: string; chain: Promise<unknown>; onError: (error: Error) => void }
  let pin: Pin | null = null

  const adoptPin = (client: pg.PoolClient, database: string) => {
    // A checked-out client whose socket dies emits 'error' with no listener,
    // which would take down the main process: absorb it, drop the pin, and let
    // the status indicator clear through onTransactionChange.
    const onError = (error: Error) => {
      if (pin?.client !== client) return
      pin = null
      client.release(error)
      events.onTransactionChange?.()
    }
    client.on('error', onError)
    pin = { client, database, chain: Promise.resolve(), onError }
  }

  // `release: false` destroys the client — severing the socket makes the
  // server abort the transaction, so pool drains can't hang on it.
  const dropPin = async (release: boolean, error?: Error) => {
    if (!pin) return
    const { client, onError } = pin
    pin = null
    client.removeListener('error', onError)
    if (!release) {
      client.release(error ?? new Error(t('query.cancelled')))
      return
    }
    try {
      await resetUserSession(client)
      client.release()
    } catch (resetError) {
      client.release(resetError as Error)
    }
  }

  // The pool for `database`, opening it on demand and retiring whichever other
  // one was live. end() drains rather than severs, so a query already in flight
  // on the outgoing database finishes; the next call for it opens a fresh pool.
  const poolFor = (database: string) => {
    if (!pools) throw new Error(t('connection.notConnected'))
    // A pinned transaction holds a client of its database; resolving another
    // database would retire that pool, whose end() would then drain forever.
    if (pin && database !== pin.database) {
      throw new Error(t('query.transactionOtherDatabase', { database: pin.database }))
    }
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

  /**
   * The refusals poolForQuery would raise, without resolving a pool — so a
   * caller can validate up front without triggering a switch it is not ready
   * to use yet.
   */
  const assertQueryable = (childDb?: string | null) => {
    if (!pools) throw new Error(t('connection.notConnected'))
    if (childDb && !childNames.includes(childDb)) {
      throw new Error(t('connection.databaseUnavailable', { database: childDb }))
    }
    const database = childDb ?? active
    if (pin && database !== pin.database) {
      throw new Error(t('query.transactionOtherDatabase', { database: pin.database }))
    }
  }

  /**
   * Resolves a pool and checks a client out of it as one indivisible step.
   *
   * Only the database in use holds a pool, so resolving one retires the others.
   * A caller that resolved a pool and had not yet checked out would find it
   * ended the moment anyone else resolved a different child, and fail having
   * done nothing wrong. Serialising the pair makes a switch atomic with respect
   * to everyone about to use one; end() then drains the clients already out.
   */
  let poolGate: Promise<unknown> = Promise.resolve()
  const clientFor = (childDb?: string | null): Promise<pg.PoolClient> => {
    const next = poolGate.then(() => poolForQuery(childDb).connect())
    poolGate = next.then(() => undefined, () => undefined)
    return next
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

  // Cancellation goes over the wire protocol rather than through
  // pg_cancel_backend, which is what libpq's PQcancel does. A CancelRequest is a
  // bare connection carrying the BackendKeyData this session was given, and it is
  // the only form that survives a connection pooler: PgBouncer hands clients a
  // synthetic PID and routes cancels itself, so pg_cancel_backend against that
  // PID returns false and the query runs to completion (verified against
  // PgBouncer 1.25.2 in transaction mode). Passing a pooler's random 32-bit key
  // to pg_cancel_backend is also not merely useless — it could land in real PID
  // range and interrupt an unrelated backend.
  // No reply is defined, so delivery is all this can report; the cancelled
  // statement itself surfaces as 57014 on the query that was running.
  const CANCEL_REQUEST_CODE = 80877102
  const SSL_REQUEST_CODE = 80877103

  const cancelPacket = (processId: number, secretKey: number): Buffer => {
    const packet = Buffer.alloc(16)
    packet.writeInt32BE(16, 0)
    packet.writeInt32BE(CANCEL_REQUEST_CODE, 4)
    packet.writeInt32BE(processId, 8)
    packet.writeInt32BE(secretKey, 12)
    return packet
  }

  const sendCancelRequest = (processId: number, secretKey: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host: endpoint.host, port: endpoint.port })
      let settled = false
      const done = (delivered: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(delivered)
      }
      socket.setTimeout(8000, () => done(false))
      socket.on('error', () => done(false))
      socket.on('connect', () => {
        if (!ssl) {
          socket.write(cancelPacket(processId, secretKey), () => done(true))
          return
        }
        // TLS endpoints need the SSLRequest handshake before any other message.
        const request = Buffer.alloc(8)
        request.writeInt32BE(8, 0)
        request.writeInt32BE(SSL_REQUEST_CODE, 4)
        socket.write(request)
        socket.once('data', (response) => {
          // 'S' accepts TLS; 'N' refuses it, and a cleartext cancel on a server
          // demanding TLS would be rejected anyway.
          if (response[0] !== 0x53) return done(false)
          const secure = tls.connect({
            socket,
            ...(typeof ssl === 'object' ? ssl : {}),
            servername: endpoint.host,
          })
          secure.on('error', () => done(false))
          secure.on('secureConnect', () =>
            secure.write(cancelPacket(processId, secretKey), () => done(true)))
        })
      })
    })

  const cancelBackends = async (entries: RunningEntry[]) => {
    // Re-check membership: a query that finished in the meantime must not have a
    // cancel aimed at the key its connection now serves another statement under.
    const live = entries.filter((entry) => running.has(entry) && entry.pid !== null && entry.secret !== null)
    return await Promise.all(live.map((entry) => sendCancelRequest(entry.pid!, entry.secret!)))
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
      } else {
        childNames = [discovery]
      }

      // Prefer the configured database, otherwise the first discovered one.
      active = childNames.includes(discovery) ? discovery : (childNames[0] ?? discovery)
      return version
    },

    async disconnect() {
      // Destroy the pinned client first: pool.end() drains rather than severs,
      // and a never-released client would hold the drain past the manager's
      // teardown deadline. Severing the socket aborts the server-side txn.
      await dropPin(false)
      const closing = pools
      pools = null
      if (!closing) return
      await Promise.all([...closing.values()].map((pool) => pool.end().catch(() => {})))
    },

    async query(sql, params = [], childDb = null, sort = null, filter = null, executionId) {
      const started = performance.now()
      const plan = prepareSqlRun({ engine: 'postgresql', sql, params, sort, filter })
      // Validated without resolving a pool: the switch happens at checkout, so
      // nothing is retired for a run that may still be refused or cancelled.
      assertQueryable(childDb)
      // Checked out manually (not pool.query) so the backend PID is known
      // while the statement runs and cancel() has a target.
      const entry = { executionId, pid: null as number | null, secret: null as number | null, cancelRequested: false }
      running.add(entry)

      const mapCancelled = (error: unknown) =>
        (error as { code?: string }).code === '57014' || (error as Error).message === t('query.cancelled')
          ? new Error(t('query.cancelled'))
          : error

      // A pinned transaction's client can't multiplex: queue this run behind
      // whatever the transaction is already doing and route it there. The
      // unpin decision happens INSIDE the chain, so a queued run can never
      // execute on a client an earlier COMMIT already released — it observes
      // the cleared pin at its own turn (null result) and reroutes below.
      const pinned = pin
      if (pinned) {
        const run = pinned.chain.then(async (): Promise<QueryResult | null> => {
          if (pin !== pinned) return null
          entry.pid = backendPid(pinned.client)
          entry.secret = backendSecret(pinned.client)
          if (entry.cancelRequested) throw new Error(t('query.cancelled'))
          try {
            const result = await streamQuery(pinned.client, plan.batches[0]!, plan.params, started, sourceCacheFor(childDb))
            // COMMIT/ROLLBACK in this run closed the transaction: unpin.
            if (pin === pinned && txStatus(pinned.client) === 'I') await dropPin(true)
            return result
          } catch (error) {
            if (pin === pinned) {
              // Severity ERROR means the statement failed but the connection
              // lives (transaction stays open in state 'E' for rollback).
              // Anything else — no severity (socket death; node-pg routes it
              // to the active query, not the client's 'error' event) or
              // FATAL/PANIC (backend terminated) — means the client is dead.
              if ((error as { severity?: string }).severity !== 'ERROR') await dropPin(false, error as Error)
              else if (txStatus(pinned.client) === 'I') await dropPin(true)
            }
            throw error
          }
        })
        pinned.chain = run.catch(() => {})
        try {
          const result = await run
          if (result) {
            if (!isReadOnlyQuery(sql, 'postgresql')) sourceCacheFor(childDb).clear()
            return result
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
        client = await clientFor(childDb)
        entry.pid = backendPid(client)
        entry.secret = backendSecret(client)
        if (entry.cancelRequested) {
          releaseToPool()
          throw new Error(t('query.cancelled'))
        }
        const result = await streamQuery(client, plan.batches[0]!, plan.params, started, sourceCacheFor(childDb))
        // Anything that could have changed the catalog invalidates the cached
        // column-source lookups (a rename would otherwise map to stale names).
        if (!isReadOnlyQuery(sql, 'postgresql')) sourceCacheFor(childDb).clear()
        // The run left a transaction open (manual BEGIN): pin the client for
        // later runs instead of resetting it.
        if (txStatus(client) !== 'I') {
          // One pin per connection. If a concurrent run adopted one while this
          // executed, keeping both would leak this client and its locks
          // forever — roll this transaction back and report it instead.
          if (pin) {
            try {
              await resetUserSession(client)
              releaseToPool()
            } catch (resetError) {
              running.delete(entry)
              client.release(resetError as Error)
              released = true
            }
            throw new Error(t('query.transactionAlreadyOpen'))
          }
          running.delete(entry)
          released = true
          adoptPin(client, childDb ?? active)
          return result
        }
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
        // `BEGIN; bad-statement` leaves a live transaction in state 'E' the
        // user must roll back: pin it. Severity ERROR marks a statement-level
        // failure on a live connection (FATAL/PANIC/no severity = dead). An
        // existing pin wins (one per connection); the destroy below aborts
        // this one.
        if (
          client && !released && !pin && plan.transaction.sawControl
          && (error as { severity?: string }).severity === 'ERROR' && txStatus(client) !== 'I'
        ) {
          running.delete(entry)
          adoptPin(client, childDb ?? active)
        } else if (client && !released) {
          // Mirror pool.query: an errored client is destroyed, not reused.
          client.release(error as Error)
        }
        throw mapCancelled(error)
      } finally {
        running.delete(entry)
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // One checked-out client for the whole batch: a pool-routed sequence would
      // spread the statements across backends, so BEGIN/COMMIT couldn't bind them.
      const client = await clientFor(childDb)
      const entry = { pid: backendPid(client), secret: backendSecret(client), cancelRequested: false }
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
        return { success: false, failedIndex: index >= 0 ? index : undefined, error: cancelled ? t('query.saveCancelled') : (error as Error).message }
      } finally {
        running.delete(entry)
      }
    },

    async runDdl(statements, childDb = null) {
      if (!statements.length) return { success: true }
      const client = await clientFor(childDb)
      const entry = { pid: backendPid(client), secret: backendSecret(client), cancelRequested: false }
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
        return { success: false, failedIndex: index >= 0 ? index : undefined, error: cancelled ? t('query.saveCancelled') : (error as Error).message }
      } finally {
        running.delete(entry)
      }
    },

    async databaseCreateMeta() {
      const rows = async <T>(sql: string) => (await activePool().query(sql)).rows as T[]
      const locales = await rows<{ loc: string }>(
        `select distinct collcollate as loc from pg_collation where collcollate <> ''
         union select distinct collctype from pg_collation where collctype <> '' order by 1`,
      )
      const owners = await rows<{ rolname: string }>('select rolname from pg_roles order by rolname')
      const templates = await rows<{ datname: string }>(
        'select datname from pg_database where datistemplate order by datname',
      )
      // A new database inherits template1's encoding/collation/ctype and is owned
      // by the current role unless overridden — those are the defaults to show.
      const [tpl] = await rows<{ owner: string; encoding: string; collation: string; ctype: string }>(
        `select current_user as owner, pg_encoding_to_char(encoding) as encoding,
                datcollate as collation, datctype as ctype
         from pg_database where datname = 'template1'`,
      )
      const uniq = (values: (string | undefined)[]): string[] =>
        values.filter((value, index, all): value is string => !!value && all.indexOf(value) === index)
      const collations = uniq(['C', 'POSIX', tpl?.collation, tpl?.ctype, ...locales.map((row) => row.loc)])
      return {
        engine: profile.engine,
        collations,
        encodings: uniq([tpl?.encoding, ...PG_ENCODINGS]),
        owners: owners.map((row) => row.rolname),
        templates: templates.map((row) => row.datname),
        defaults: {
          owner: tpl?.owner,
          template: 'template1',
          encoding: tpl?.encoding,
          collation: tpl?.collation,
          ctype: tpl?.ctype,
        },
      }
    },

    async createDatabase(name, options) {
      // CREATE DATABASE refuses to run inside a transaction; a plain
      // single-statement pool query never opens one, so this is fine.
      const literal = (value: string) => `'${sqlOptionToken(value)}'`
      const parts: string[] = []
      if (options?.owner) parts.push(`owner ${dialect.quoteIdent(options.owner)}`)
      if (options?.template) parts.push(`template ${dialect.quoteIdent(options.template)}`)
      if (options?.encoding) parts.push(`encoding ${literal(options.encoding)}`)
      if (options?.collation) parts.push(`lc_collate ${literal(options.collation)}`)
      if (options?.ctype) parts.push(`lc_ctype ${literal(options.ctype)}`)
      const withClause = parts.length ? ` with ${parts.join(' ')}` : ''
      await activePool().query(`create database ${dialect.quoteIdent(name)}${withClause}`)
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
      // The server refuses while connections exist; ours must go first.
      const pool = pools.get(name)
      if (pool) {
        pools.delete(name)
        await pool.end().catch(() => {})
      }
      // A refused drop (someone else is connected) propagates: the database stays
      // in childNames, so it remains browsable and re-opens its pool on demand.
      await activePool().query(`drop database ${dialect.quoteIdent(name)}`)
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
      const sent = await cancelBackends(targets)
      return { running: entries.length, cancelled: queued.length + sent.filter(Boolean).length }
    },

    async exportQuery({ sql, params, childDb, sort, filter, filePath, format, sqlTarget, executionId }) {
      const plan = prepareSqlRun({ engine: 'postgresql', sql, params, sort, filter })
      // Registered like query() so Stop (and disconnect) can interrupt a
      // runaway export instead of it streaming to completion unstoppably.
      const entry = { executionId, pid: null as number | null, secret: null as number | null, cancelRequested: false }
      running.add(entry)
      let client: pg.PoolClient | null = null
      const writer = openExportWriter(filePath, format, sqlTarget)
      try {
        client = await clientFor(childDb)
        entry.pid = backendPid(client)
        entry.secret = backendSecret(client)
        if (entry.cancelRequested) throw new Error(t('query.cancelled'))
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
        throw (error as { code?: string }).code === '57014' || (error as Error).message === t('query.cancelled')
          ? new Error(t('query.cancelled'))
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
         where ${userRelations(LISTED_RELKINDS)}
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

    async listTableStats(childDb = null) {
      const result = await poolForQuery(childDb).query(
        `select n.nspname as table_schema, c.relname as table_name,
                case when c.relkind = 'p' then
                  (select coalesce(sum(pg_catalog.pg_total_relation_size(tree.relid)), 0)
                   from pg_catalog.pg_partition_tree(c.oid) tree)
                else pg_catalog.pg_total_relation_size(c.oid)
                end::text as total_bytes
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where ${userRelations(SIZED_RELKINDS)}
         order by table_schema, table_name`,
      )
      return result.rows.flatMap((row: { table_schema: string; table_name: string; total_bytes: string | null }) => {
        // pg_total_relation_size() answers NULL for a relation dropped between
        // the catalog scan and the size call; Number(null) is 0, which would
        // report a live table as empty rather than as unmeasured.
        const totalBytes = byteCount(row.total_bytes)
        return totalBytes === null ? [] : [{ schema: row.table_schema, name: row.table_name, totalBytes } satisfies TableStat]
      })
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
                        where fk.contype = 'f' and fk.conrelid = a.attrelid and a.attnum = any(fk.conkey)) as foreign_key,
                ref.constraint_name, ref.ref_schema, ref.ref_table, ref.ref_column
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         left join pg_catalog.pg_index i
           on i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)
         -- conkey and confkey are positionally paired arrays, so the referenced
         -- column is confkey at the same subscript this column sits at in conkey.
         -- A column can belong to several foreign keys; take the first by name so
         -- the choice is stable rather than plan-dependent.
         left join lateral (
           select fk.conname as constraint_name, fn.nspname as ref_schema,
                  fc.relname as ref_table, fa.attname as ref_column
           from pg_catalog.pg_constraint fk
           cross join lateral generate_subscripts(fk.conkey, 1) as pos(i)
           join pg_catalog.pg_class fc on fc.oid = fk.confrelid
           join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
           join pg_catalog.pg_attribute fa
             on fa.attrelid = fk.confrelid and fa.attnum = fk.confkey[pos.i] and not fa.attisdropped
           where fk.contype = 'f' and fk.conrelid = a.attrelid and fk.conkey[pos.i] = a.attnum
           order by fk.conname
           limit 1
         ) ref on true
         where ${userRelations(LISTED_RELKINDS)}
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
          constraint_name: string | null
          ref_schema: string | null
          ref_table: string | null
          ref_column: string | null
        }): ColumnRef => ({
          schema: row.table_schema,
          table: row.table_name,
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.nullable,
          primaryKey: row.primary_key,
          foreignKey: row.foreign_key,
          ...columnReference(row.ref_schema, row.ref_table, row.ref_column, row.constraint_name),
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

    async serverActivity(childDb = null) {
      // All three reads share one connection, sequentially. Running them in
      // parallel took three pooled connections, which both inflated the
      // connection gauge the panel is reporting and left the other two visible
      // in its own session list — pg_backend_pid() only excludes the one.
      const client = await clientFor(childDb)
      try {
        const [connections, stats, sessions] = [
          await client.query<{ used: number; max: number }>(
            `select count(*)::int as used, current_setting('max_connections')::int as max
             from pg_stat_activity where backend_type = 'client backend'`,
          ),
          await client.query<{ uptime_seconds: string; cache_hit: string | null }>(
            `select extract(epoch from (now() - pg_postmaster_start_time()))::bigint as uptime_seconds,
                    round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 1)::text as cache_hit
             from pg_stat_database`,
          ),
          // elapsed_ms arrives as text (bigint), hence the Number() below.
          await client.query<{ id: string; user: string; database: string | null; state: string; elapsed_ms: string | null; sql: string | null; self: boolean }>(
            `select pid::text as id,
                    coalesce(usename, '') as "user",
                    datname as database,
                    coalesce(state, '') as state,
                    (extract(epoch from (clock_timestamp() - state_change)) * 1000)::bigint as elapsed_ms,
                    nullif(btrim(query), '') as sql,
                    coalesce(application_name = $1, false) as self
             from pg_stat_activity
             -- Exclude the reader itself: the polling query would otherwise sit at
             -- the top of its own list on every refresh.
             where backend_type = 'client backend' and pid <> pg_backend_pid()
             order by (state = 'active') desc nulls last, state_change desc nulls last
             limit ${MAX_SESSIONS}`,
            [APP_CONNECTION_NAME],
          ),
        ]
        const summary = stats.rows[0]
        const activity = {
          connections: { used: connections.rows[0]?.used ?? 0, max: connections.rows[0]?.max ?? null },
          stats: [
            ...(summary?.uptime_seconds ? [{ label: 'Uptime', value: formatUptime(Number(summary.uptime_seconds)) }] : []),
            ...(summary?.cache_hit ? [{ label: 'Cache hit', value: `${summary.cache_hit}%` }] : []),
          ],
          selfIdentificationAvailable: true,
          sessions: sessions.rows.map((row) => ({
            id: row.id,
            user: row.user,
            database: row.database,
            state: row.state,
            elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
            sql: row.sql,
            self: row.self,
          })),
        }
        client.release()
        return activity
      } catch (error) {
        // Mirror pool.query: an errored client is destroyed, not reused.
        client.release(error as Error)
        throw error
      }
    },

    async endSession(sessionId, mode) {
      const pid = Number(sessionId)
      if (!Number.isInteger(pid)) throw new Error(t('server.sessionUnknown'))
      // pg_cancel_backend interrupts the statement; pg_terminate_backend drops
      // the connection. Both return false when the backend is already gone.
      const fn = mode === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend'
      const result = await activePool().query<{ ok: boolean }>(`select ${fn}($1) as ok`, [pid])
      if (result.rows[0]?.ok !== true) throw new Error(t('server.sessionEndFailed'))
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

    async objectDdl(ref, childDb = null) {
      const pool = poolForQuery(childDb)
      const schema = ref.schema ?? 'public'
      const qualified = `${dialect.quoteIdent(schema)}.${dialect.quoteIdent(ref.name)}`

      if (ref.kind === 'function') {
        // pg_get_functiondef already emits a CREATE OR REPLACE FUNCTION, so it
        // re-runs as-is; detail is the identity args that pick one overload.
        const result = await pool.query<{ definition: string }>(
          `select pg_catalog.pg_get_functiondef(p.oid) as definition
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and p.proname = $2
             and pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`,
          [schema, ref.name, ref.detail ?? ''],
        )
        const definition = result.rows[0]?.definition
        if (!definition) throw new Error(`Function ${ref.name}(${ref.detail ?? ''}) was not found.`)
        return definition
      }

      // pg_get_viewdef returns only the SELECT body (with a trailing ;), so wrap it.
      const result = await pool.query<{ definition: string | null }>(
        `select pg_catalog.pg_get_viewdef(c.oid, true) as definition
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2`,
        [schema, ref.name],
      )
      const body = result.rows[0]?.definition
      if (!body) throw new Error(`View ${ref.name} was not found.`)
      // Materialized views have no CREATE OR REPLACE, so drop-then-create.
      if (ref.kind === 'matview') {
        return `DROP MATERIALIZED VIEW IF EXISTS ${qualified};\n\nCREATE MATERIALIZED VIEW ${qualified} AS\n${body}`
      }
      return `CREATE OR REPLACE VIEW ${qualified} AS\n${body}`
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
                  a.attidentity as identity,
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
            identity: string | null
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
            identity: row.identity === 'a'
              ? 'always' as const
              : row.identity === 'd' || /^nextval\s*\(/i.test(row.default_expr ?? '')
                ? 'default' as const
                : undefined,
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

    openTransaction() {
      if (!pin) return null
      return { childDb: pin.database, ...(txStatus(pin.client) === 'E' ? { failed: true } : {}) }
    },

    async endTransaction(mode) {
      const pinned = pin
      if (!pinned) throw new Error(t('transaction.none'))
      // COMMIT inside a failed transaction performs the rollback without
      // erroring, so both modes resolve any transaction state. Ending and
      // unpinning happen inside the chain: a queued run behind this cannot
      // start until the release has fully completed.
      const run = pinned.chain.then(async () => {
        if (pin !== pinned) return
        try {
          await pinned.client.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK')
          await dropPin(true)
        } catch (error) {
          await dropPin(false, error as Error)
          throw error
        }
      })
      pinned.chain = run.catch(() => {})
      await run
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
      const list = fields ?? []
      // json/jsonb by result position, straight off the row description — these
      // cells go into a JSON export as raw documents rather than quoted text.
      const jsonColumns = new Set(list.flatMap((field, index) =>
        field.dataTypeID === 114 || field.dataTypeID === 3802 ? [index] : []))
      writer.columns(list.map((field) => field.name), jsonColumns)
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
