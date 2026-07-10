import sql from 'mssql'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ColumnRef, ConnectionProfile, DbObject, InspectSection, QueryResult, QueryResultSet, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import { BATCH_ZERO_ROWS, boundedRow, MAX_BUFFERED_ROWS } from './limits'
import type { Driver, DriverEvents } from './driver'
import type { Endpoint } from './transport'
import { assertSelfContainedTransaction, isCappableRead, splitSqlServerBatches } from './sql-script'

// Always-present databases; hidden from all-databases children except master,
// which is a legitimate browsing target (it's the default sa database).
const SYSTEM_DBS = ['tempdb', 'model', 'msdb']

const isCancelled = (error: unknown) => (error as { code?: string }).code === 'ECANCEL'

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
  // tedious has already converted decimal to a binary float. Up to 15
  // significant decimal digits can be round-tripped reliably; above that we
  // must refuse the lossy value instead of displaying/editing corrupted data.
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
    throw new Error('SQL Server does not support CA-only verification; use Verify full to verify the certificate and hostname.')
  }
  const caPath = profile.ssl?.ca.trim()
  if (!caPath) return { encrypt: true, trustServerCertificate: false }
  try {
    if (statSync(expandHome(caPath)).size > 5 * 1024 * 1024) throw new Error('certificate file exceeds 5 MB')
    return { encrypt: true, trustServerCertificate: false, ca: readFileSync(expandHome(caPath), 'utf8') }
  } catch (error) {
    throw new Error(`Failed to read SSL CA certificate at ${caPath}: ${(error as Error).message}`, { cause: error })
  }
}

// SQL Server with all-databases support, mirroring the postgres driver: one
// connection pool per child database. Unlike MySQL, SQL Server has real
// schemas (dbo, …) inside each database, so TableRef.schema is populated.
// Dials the endpoint — the transport layer may have rewritten host/port to an
// SSH tunnel's local end.
export function createMssqlDriver(profile: ConnectionProfile, endpoint: Endpoint, events: DriverEvents): Driver {
  let pools: Map<string, sql.ConnectionPool> | null = null
  let childNames: string[] = []
  let active = ''
  // In-flight requests; tedious cancels in-band, so no out-of-band connection.
  const running = new Set<{ executionId?: string; request: sql.Request | null; cancelRequested: boolean }>()
  const tls = mssqlTls(profile)

  const makePool = (database: string) => {
    const pool = new sql.ConnectionPool({
      server: endpoint.host,
      port: endpoint.port,
      user: profile.username,
      password: profile.password,
      database: database || undefined,
      connectionTimeout: 8000,
      // No statement timeout: user queries legitimately run long; Stop cancels.
      requestTimeout: 0,
      pool: { max: 4 },
      options: {
        encrypt: tls.encrypt,
        trustServerCertificate: tls.trustServerCertificate,
        ...(tls.ca ? { cryptoCredentialsDetails: { ca: tls.ca } } : {}),
      },
    })
    // node-mssql does not reset tedious sessions when returning them to its
    // pool. Delay every release until the TDS RESETCONNECTION request has
    // rolled back implicit transactions and cleared SET/temp/session state.
    type ResettableConnection = { reset(callback: (error?: Error) => void): void; close(): void }
    type PoolWithRelease = { release(connection: ResettableConnection): sql.ConnectionPool }
    const poolWithRelease = pool as unknown as PoolWithRelease
    const originalRelease = poolWithRelease.release.bind(poolWithRelease)
    poolWithRelease.release = (connection) => {
      connection.reset((error) => {
        if (error) connection.close()
        originalRelease(connection)
      })
      return pool
    }
    pool.on('error', (error: Error) => events.onError(error.message))
    return pool
  }

  const connectedPool = async (database: string) => {
    const pool = pools?.get(database)
    if (!pool) throw new Error(database ? `Database "${database}" is not available on this connection` : 'Not connected')
    // connect() is a no-op when already connected; pools open lazily.
    return pool.connected ? pool : pool.connect()
  }

  const poolForQuery = (childDb?: string | null) => connectedPool(childDb ?? active)

  const bind = (request: sql.Request, params: unknown[]) => {
    params.forEach((value, index) => request.input(`p${index + 1}`, value))
    return request
  }

  const metaRows = async <T>(sqlText: string, params: unknown[] = [], childDb?: string | null): Promise<T[]> => {
    const pool = await poolForQuery(childDb)
    const result = await bind(pool.request(), params).query<T>(sqlText)
    return result.recordset
  }

  const dialect = dialectFor(profile.engine)

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
      await Promise.all([...closing.values()].map((pool) => pool.close().catch(() => {})))
    },

    async query(sqlText, params = [], childDb = null, sort = null, executionId) {
      const started = performance.now()
      const finalSql = sort ? dialect.applyOrderBy(sqlText, sort) : sqlText
      assertSelfContainedTransaction(finalSql, 'sqlserver')
      const entry = { executionId, request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      try {
        const pool = await poolForQuery(childDb)
        if (entry.cancelRequested) throw new Error('Query cancelled.')
        let result: QueryResult = { columns: [], rows: [], rowCount: 0, durationMs: 0 }
        const resultSets: QueryResultSet[] = []
        const budget = { bytes: 0 }
        const batches = splitSqlServerBatches(finalSql)
        for (const batch of batches) {
          entry.request = bind(pool.request(), params)
          if (entry.cancelRequested) throw new Error('Query cancelled.')
          result = await streamQuery(entry.request, batch, started, budget, batches.length === 1 && isCappableRead(batch))
          resultSets.push(...(result.resultSets ?? [{
            columns: result.columns,
            columnSources: result.columnSources,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            rowCountExact: result.rowCountExact,
          }]))
        }
        const selected = resultSets[resultSets.length - 1] ?? result
        return {
          ...selected,
          durationMs: result.durationMs,
          ...(resultSets.length > 1 ? { resultSets } : {}),
        }
      } catch (error) {
        throw isCancelled(error) || (error as Error).message === 'Query cancelled.' ? new Error('Query cancelled.') : error
      } finally {
        running.delete(entry)
      }
    },

    async runBatch(statements, childDb = null) {
      if (!statements.length) return { success: true }
      const pool = await poolForQuery(childDb)
      const transaction = new sql.Transaction(pool)
      const entry = { request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      let index = -1
      try {
        await transaction.begin()
        if (entry.cancelRequested) throw new Error('Query cancelled.')
        for (index = 0; index < statements.length; index += 1) {
          const statement = statements[index]!
          entry.request = bind(new sql.Request(transaction), statement.params)
          if (entry.cancelRequested) throw new Error('Query cancelled.')
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
        await transaction.rollback().catch(() => {})
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isCancelled(error) || (error as Error).message === 'Query cancelled.' ? 'Save cancelled.' : (error as Error).message,
        }
      } finally {
        running.delete(entry)
      }
    },

    async runDdl(statements, childDb = null) {
      if (!statements.length) return { success: true }
      // SQL Server DDL is transactional, so all-or-nothing like Postgres.
      const pool = await poolForQuery(childDb)
      const transaction = new sql.Transaction(pool)
      const entry = { request: null as sql.Request | null, cancelRequested: false }
      running.add(entry)
      let index = -1
      try {
        await transaction.begin()
        if (entry.cancelRequested) throw new Error('Query cancelled.')
        for (index = 0; index < statements.length; index += 1) {
          // batch() not query(): DDL like CREATE VIEW must be alone in a batch,
          // and sp_executesql (query with params) counts as one.
          entry.request = new sql.Request(transaction)
          if (entry.cancelRequested) throw new Error('Query cancelled.')
          await entry.request.batch(statements[index]!)
        }
        await transaction.commit()
        return { success: true }
      } catch (error) {
        await transaction.rollback().catch(() => {})
        return {
          success: false,
          failedIndex: index >= 0 ? index : undefined,
          error: isCancelled(error) || (error as Error).message === 'Query cancelled.' ? 'Save cancelled.' : (error as Error).message,
        }
      } finally {
        running.delete(entry)
      }
    },

    async createDatabase(name) {
      const pool = await poolForQuery()
      // CREATE DATABASE refuses transactions and sp_executesql; plain batch.
      await pool.request().batch(`create database ${dialect.quoteIdent(name)}`)
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
        await pool.close().catch(() => {})
      }
      try {
        const activeDb = await poolForQuery()
        await activeDb.request().batch(`drop database ${dialect.quoteIdent(name)}`)
      } catch (error) {
        // Drop refused (e.g. other sessions): keep it browsable.
        if (pool) pools.set(name, makePool(name))
        throw error
      }
      childNames = childNames.filter((child) => child !== name)
    },

    async cancel(executionId) {
      // tedious cancels in-band on the request itself; no KILL needed.
      const entries = [...running].filter((entry) => executionId === undefined || entry.executionId === executionId)
      for (const entry of entries) entry.cancelRequested = true
      const cancellable = entries.filter((entry) => entry.request !== null)
      for (const entry of cancellable) entry.request?.cancel()
      return { running: entries.length, cancelled: entries.length }
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

    async listColumns(childDb = null) {
      const rows = await metaRows<{
        table_schema: string
        table_name: string
        name: string
        data_type: string
        nullable: boolean
        pk: number
        fk: number
      }>(
        `select s.name as table_schema, t.name as table_name, c.name as name,
                ${mssqlTypeExpression} as data_type,
                c.is_nullable as nullable,
                iif(exists (select 1 from sys.index_columns ic
                            join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
                            where i.is_primary_key = 1 and ic.object_id = c.object_id and ic.column_id = c.column_id), 1, 0) as pk,
                iif(exists (select 1 from sys.foreign_key_columns fkc
                            where fkc.parent_object_id = c.object_id and fkc.parent_column_id = c.column_id), 1, 0) as fk
         from sys.columns c
         join sys.objects t on t.object_id = c.object_id and t.type in ('U', 'V')
         join sys.schemas s on s.schema_id = t.schema_id
         join sys.types ty on ty.user_type_id = c.user_type_id
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

      const [columns, foreignKeys, checks, indexes, triggers] = await Promise.all([
        metaRows<{
          name: string
          data_type: string
          nullable: boolean
          default_expr: string | null
          pk: number
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
        metaRows<Row>(
          `select i.name as name,
                  concat(iif(i.is_unique = 1, 'UNIQUE ', ''), '(',
                         stuff((select ', ' + col_name(ic.object_id, ic.column_id)
                                from sys.index_columns ic
                                where ic.object_id = i.object_id and ic.index_id = i.index_id and ic.is_included_column = 0
                                order by ic.key_ordinal for xml path('')), 1, 2, ''),
                         ') ', i.type_desc) as definition
           from sys.indexes i
           where i.object_id = object_id(@p1) and i.is_primary_key = 0 and i.type > 0
           order by i.name`,
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
        { title: 'Constraints', rows: checks },
        { title: 'Indexes', rows: indexes },
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
          comment: null,
          collation: row.collation,
          generated: !!row.computed,
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

// Streams rows so a huge or multi-result batch can't OOM the main process.
// The byte budget is shared by every result set in this execution.
function streamQuery(
  request: sql.Request,
  sqlText: string,
  started: number,
  budget: { bytes: number } = { bytes: 0 },
  stopAtLimit = false,
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
    let limitCancellation = false
    const resultSets: QueryResultSet[] = []
    const pushCurrent = () => {
      if (!active) return
      resultSets.push({ columns, rows, rowCount: total, truncated: limited || total > rows.length, rowCountExact: !limitCancellation })
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
      let capacityExceeded = false
      if (rows.length < MAX_BUFFERED_ROWS) {
        const bounded = boundedRow(normalized, budget.bytes)
        if (bounded) {
          rows.push(bounded.row)
          budget.bytes += bounded.bytes
          limited ||= bounded.truncated
        } else {
          limited = true
          capacityExceeded = true
        }
      } else {
        limited = true
        capacityExceeded = true
      }
      if (capacityExceeded && !limitCancellation && stopAtLimit) {
        limitCancellation = true
        request.cancel()
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
      else if (limitCancellation) finish()
      else reject(error instanceof Error ? error : new Error(String(error)))
    })
    request.on('done', finish)
    void request.query(sqlText).catch(() => {
      // Errors surface via the 'error' event in stream mode; swallow the
      // duplicate rejection from the promise API.
    })
  })
}
