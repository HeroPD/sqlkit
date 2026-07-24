import type { Engine, QuerySort } from './electron'
import type { SqlModeFlags } from './sql-mask'
import { applyOrderBy as placeOrderBy } from './sql-order'

// Per-engine SQL construction. Each backend spells things differently —
// identifier quoting, parameter placeholders, pagination, ORDER BY — so the
// rules live behind one Dialect per engine instead of as conditionals scattered
// through the code. Adding a backend is a new Dialect, not edits everywhere.
// Lives in src/ (not the driver layer) so both the renderer write path
// (sql-write) and the main-process drivers share one source of quoting rules.
// The engine-agnostic bits (where ORDER BY goes in a statement) stay in
// src/sql-order; the Dialect only supplies the engine-specific pieces.
export type Dialect = {
  engine: Engine
  /** Quotes one identifier (column/table/schema name). */
  quoteIdent(name: string): string
  /** Bind placeholder for a 1-based parameter position: `$1`.. on Postgres, `?` elsewhere. */
  placeholder(index: number): string
  /** Inserts or replaces the outer query's ORDER BY for a single-column sort. */
  applyOrderBy(sql: string, sort: QuerySort, mode?: SqlModeFlags): string
  /** A small browse query for a table, using this engine's row-limit syntax. */
  browseTable(qualifiedTable: string, limit: number): string
  /** Whether this engine has native column comments — drives whether the inspector
   *  shows a Comment column at all (shown even when every value is empty). */
  supportsColumnComments: boolean
  /** How a JS boolean binds as a parameter — SQLite has no boolean type and
   *  rejects a boolean bind, so it stores 1/0; other engines take the boolean. */
  bindBoolean(value: boolean): unknown
  /** Per-field column-editor capabilities: gates both the Inspect tab's editable
   *  cells and the statements sql-write emits for this engine. */
  columnEdits: ColumnEditCapabilities
  /** Common column types offered by the inspector's type picker, spelled as
   *  valid DDL for this engine; empty when the engine isn't wired up. */
  commonColumnTypes: string[]
  /** Common default-value expressions for the inspector's default picker, valid
   *  for this engine; empty when the engine isn't wired up. */
  commonDefaultValues: string[]
}

// The column-editor operations an engine can run in place, without a table
// rebuild. `add`/`drop` are whole-column; the rest edit one property.
export type ColumnEditCapabilities = {
  rename: boolean
  dataType: boolean
  nullable: boolean
  default: boolean
  comment: boolean
  add: boolean
  drop: boolean
}

// SQL-standard double quotes (Postgres, SQLite), MySQL backticks, SQL Server
// brackets. Each doubles its own quote char to escape it.
// Validates a bare-word SQL option token (charset/collation/encoding/locale
// name): letters, digits, and _ . - only. Throws otherwise, so a server-sourced
// value can be interpolated into DDL without quoting or injection risk.
export const sqlOptionToken = (value: string): string => {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid SQL option value: ${value}`)
  return value
}

const ansiQuote = (name: string) => `"${name.replaceAll('"', '""')}"`
const backtickQuote = (name: string) => `\`${name.replaceAll('`', '``')}\``
const bracketQuote = (name: string) => `[${name.replaceAll(']', ']]')}]`

const quoteFor: Record<Engine, (name: string) => string> = {
  postgresql: ansiQuote,
  sqlite: ansiQuote,
  mysql: backtickQuote,
  sqlserver: bracketQuote,
}

/** Quoting fn keyed by opening char, for requoting in the style the user already typed. */
export const quoteStyleFor: Record<string, (name: string) => string> = {
  '"': ansiQuote,
  '`': backtickQuote,
  '[': bracketQuote,
}

// Native column comments: Postgres (COMMENT ON), MySQL (COLUMN COMMENT). SQLite
// has none; SQL Server uses extended properties (not wired up yet), so off here.
const columnCommentsFor: Record<Engine, boolean> = {
  postgresql: true,
  sqlite: false,
  mysql: true,
  sqlserver: false,
}

// False cells await unbuilt machinery: SQLite table rebuilds, MySQL full MODIFY
// COLUMN (would drop untracked charset/auto_increment), SQL Server default constraints.
const columnEditsFor: Record<Engine, ColumnEditCapabilities> = {
  postgresql: { rename: true, dataType: true, nullable: true, default: true, comment: true, add: true, drop: true },
  sqlite: { rename: true, dataType: false, nullable: false, default: false, comment: false, add: true, drop: true },
  mysql: { rename: true, dataType: false, nullable: false, default: true, comment: false, add: true, drop: true },
  sqlserver: { rename: true, dataType: true, nullable: true, default: false, comment: false, add: true, drop: true },
}

// Common DDL type names for the inspector picker. Entries with (…) are templates
// — the picker opens them in the inline editor with the parameters selected for adjustment.
const columnTypesFor: Record<Engine, string[]> = {
  postgresql: [
    'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision', 'smallserial', 'serial', 'bigserial',
    'int2', 'int4', 'int8', 'int', 'float4', 'float8', 'float', 'serial2', 'serial4', 'serial8',
    'character', 'character varying', 'char', 'varchar', 'text', 'name',
    'boolean', 'bool',
    'date', 'time', 'time without time zone', 'time with time zone', 'timetz',
    'timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz', 'interval',
    'uuid',
    'json', 'jsonb', 'jsonpath',
    'bytea',
    'money',
    'inet', 'cidr', 'macaddr', 'macaddr8',
    'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
    'tsvector', 'tsquery',
    'xml',
    'bit', 'bit varying', 'varbit',
    'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
    'int4multirange', 'int8multirange', 'nummultirange', 'tsmultirange', 'tstzmultirange', 'datemultirange',
    'oid', 'regclass', 'regcollation', 'regconfig', 'regdictionary', 'regnamespace', 'regoper', 'regoperator',
    'regproc', 'regprocedure', 'regrole', 'regtype',
    'xid', 'xid8', 'cid', 'tid', 'pg_lsn', 'pg_snapshot', 'txid_snapshot',
    'smallint[]', 'integer[]', 'bigint[]', 'decimal[]', 'numeric[]', 'real[]', 'double precision[]',
    'text[]', 'varchar[]', 'char[]', 'boolean[]', 'date[]', 'time[]', 'timetz[]', 'timestamp[]', 'timestamptz[]',
    'interval[]', 'uuid[]', 'json[]', 'jsonb[]', 'bytea[]', 'money[]', 'inet[]', 'cidr[]', 'macaddr[]', 'macaddr8[]',
    'point[]', 'line[]', 'lseg[]', 'box[]', 'path[]', 'polygon[]', 'circle[]', 'tsvector[]', 'tsquery[]', 'xml[]',
    'int4range[]', 'int8range[]', 'numrange[]', 'tsrange[]', 'tstzrange[]', 'daterange[]',
    'varchar(255)', 'char(1)', 'character(1)', 'character varying(255)', 'numeric(10, 2)',
    'decimal(10, 2)', 'float(24)', 'bit(1)', 'bit varying(8)', 'varbit(8)',
    'time(6)', 'time(6) without time zone', 'time(6) with time zone',
    'timestamp(6)', 'timestamp(6) without time zone', 'timestamp(6) with time zone',
    'interval(6)', 'interval year', 'interval month', 'interval day', 'interval hour', 'interval minute', 'interval second',
    'interval year to month', 'interval day to hour', 'interval day to minute', 'interval day to second',
    'interval hour to minute', 'interval hour to second', 'interval minute to second',
  ],
  sqlite: ['text', 'integer', 'real', 'numeric', 'blob'],
  mysql: [
    'varchar(255)', 'char(1)', 'text', 'tinyint', 'smallint', 'int', 'bigint',
    'decimal(10,2)', 'float', 'double', 'bool',
    'date', 'time', 'datetime', 'timestamp',
    'json', 'blob',
  ],
  sqlserver: [
    'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'char(1)', 'bit',
    'tinyint', 'smallint', 'int', 'bigint', 'decimal(10,2)', 'float', 'real', 'money',
    'date', 'time', 'datetime2', 'datetimeoffset',
    'uniqueidentifier', 'varbinary(max)', 'xml',
  ],
}

// Common default-value expressions for the inspector picker, valid per engine —
// now()/booleans aren't universal (SQL Server needs GETDATE()/1/0; SQLite 1/0).
const defaultValuesFor: Record<Engine, string[]> = {
  postgresql: ['NULL', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'now()', 'true', 'false', '0', '1', "''"],
  sqlite: ['NULL', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', '0', '1', "''"],
  mysql: ['NULL', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'now()', 'true', 'false', '0', '1', "''"],
  sqlserver: ['NULL', 'GETDATE()', 'SYSDATETIME()', '0', '1', "''"],
}

const TEMPORAL_DEFAULTS = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'now()', 'GETDATE()', 'SYSDATETIME()'])

// Narrows an engine's default expressions to those sensible for a column of the
// given type, adding NULL only when the column is nullable. Suggestions only —
// the editor still accepts any typed expression. Unknown types keep the full
// list so nothing useful is hidden.
export const defaultValueSuggestions = (engine: Engine, dataType: string, nullable: boolean): string[] => {
  const type = dataType.toLowerCase()
  const temporal = /date|time|timestamp|interval/.test(type)
  const boolean = /bool/.test(type) || type === 'bit'
  const numeric = /int|serial|numeric|decimal|real|double|float|money/.test(type)
  const text = /char|text|string|clob/.test(type)
  const known = temporal || boolean || numeric || text
  return defaultValuesFor[engine].filter((value) => {
    if (value === 'NULL') return nullable
    if (!known) return true
    if (TEMPORAL_DEFAULTS.has(value)) return temporal
    if (value === 'true' || value === 'false') return boolean
    if (value === '0' || value === '1') return numeric || boolean
    if (value === "''") return text
    return false
  })
}

const makeDialect = (engine: Engine): Dialect => {
  const quoteIdent = quoteFor[engine]
  return {
    engine,
    quoteIdent,
    // SQL Server's driver (tedious) has no positional '?', only named params.
    placeholder: (index) => (engine === 'postgresql' ? `$${index}` : engine === 'sqlserver' ? `@p${index}` : '?'),
    // Positional ORDER BY (`ORDER BY <n>`) targets the Nth output column
    // unambiguously; a named ORDER BY breaks on duplicate or expression columns.
    applyOrderBy: (sql, sort, mode) => placeOrderBy(sql, { column: String(sort.columnIndex + 1), dir: sort.direction }, engine, mode),
    browseTable: (qualifiedTable, limit) =>
      engine === 'sqlserver'
        ? `SELECT TOP ${Math.max(1, Math.trunc(limit))} * FROM ${qualifiedTable}`
        : `SELECT * FROM ${qualifiedTable} LIMIT ${Math.max(1, Math.trunc(limit))}`,
    supportsColumnComments: columnCommentsFor[engine],
    bindBoolean: (value) => (engine === 'sqlite' ? (value ? 1 : 0) : value),
    columnEdits: columnEditsFor[engine],
    commonColumnTypes: columnTypesFor[engine],
    commonDefaultValues: defaultValuesFor[engine],
  }
}

const dialects: Record<Engine, Dialect> = {
  postgresql: makeDialect('postgresql'),
  sqlite: makeDialect('sqlite'),
  mysql: makeDialect('mysql'),
  sqlserver: makeDialect('sqlserver'),
}

export const dialectFor = (engine: Engine): Dialect => dialects[engine]
