import type { Engine, QuerySort } from './electron'
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
  applyOrderBy(sql: string, sort: QuerySort): string
  /** Strips this engine's auto-generated constraint/index name suffix for display
   *  (e.g. Postgres `_fkey`); returns the name unchanged when there's nothing to strip. */
  displayConstraintName(name: string): string
  /** Whether this engine has native column comments — drives whether the inspector
   *  shows a Comment column at all (shown even when every value is empty). */
  supportsColumnComments: boolean
  /** How a JS boolean binds as a parameter — SQLite has no boolean type and
   *  rejects a boolean bind, so it stores 1/0; other engines take the boolean. */
  bindBoolean(value: boolean): unknown
  /** Whether columns can be altered in place (type/nullable/default/comment).
   *  SQLite can only RENAME without a table rebuild; MySQL/SQL Server spell the
   *  alters differently, so they stay off until their drivers are wired up. */
  supportsColumnAlter: boolean
  /** Whether the standard ALTER TABLE … RENAME COLUMN works; SQL Server needs
   *  sp_rename, and MySQL stays off until its driver lands. */
  supportsColumnRename: boolean
  /** Common column types offered by the inspector's type picker, spelled as
   *  valid DDL for this engine; empty when the engine isn't wired up. */
  commonColumnTypes: string[]
}

// SQL-standard double quotes (Postgres, SQLite), MySQL backticks, SQL Server
// brackets. Each doubles its own quote char to escape it.
const ansiQuote = (name: string) => `"${name.replaceAll('"', '""')}"`
const backtickQuote = (name: string) => `\`${name.replaceAll('`', '``')}\``
const bracketQuote = (name: string) => `[${name.replaceAll(']', ']]')}]`

const quoteFor: Record<Engine, (name: string) => string> = {
  postgresql: ansiQuote,
  sqlite: ansiQuote,
  mysql: backtickQuote,
  sqlserver: bracketQuote,
}

// Auto-generated constraint/index name suffix per engine, stripped for display.
// Postgres uses <table>_<cols>_<suffix>; SQLite section names are real column or
// index identifiers (never strip). MySQL's _ibfk_N/_chk_N strip down to just the
// table name — not useful — so it opts out until its driver proves otherwise.
const constraintSuffixFor: Record<Engine, RegExp | null> = {
  postgresql: /_(?:pkey|key|fkey|check|excl)$/,
  sqlite: null,
  mysql: null,
  sqlserver: null,
}

// Native column comments: Postgres (COMMENT ON), MySQL (COLUMN COMMENT). SQLite
// has none; SQL Server uses extended properties (not wired up yet), so off here.
const columnCommentsFor: Record<Engine, boolean> = {
  postgresql: true,
  sqlite: false,
  mysql: true,
  sqlserver: false,
}

// In-place column alters, gating the Postgres-flavored ALTER/COMMENT statements
// that sql-write builds. Only engines sharing that syntax may turn this on.
const columnAlterFor: Record<Engine, boolean> = {
  postgresql: true,
  sqlite: false,
  mysql: false,
  sqlserver: false,
}

const columnRenameFor: Record<Engine, boolean> = {
  postgresql: true,
  sqlite: true,
  mysql: true,
  sqlserver: false,
}

// Short spellings that are valid DDL (int, timestamptz, float8 …); SQLite's
// are its storage classes. Entries with (…) are templates — the picker opens
// them in the inline editor with the parameters selected for adjustment.
const columnTypesFor: Record<Engine, string[]> = {
  postgresql: [
    'text', 'varchar(255)', 'char(1)', 'bool',
    'smallint', 'int', 'bigint', 'numeric(10,2)', 'real', 'float8',
    'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval',
    'uuid', 'json', 'jsonb', 'bytea', 'inet',
  ],
  sqlite: ['text', 'integer', 'real', 'numeric', 'blob'],
  mysql: [
    'varchar(255)', 'char(1)', 'text', 'tinyint', 'smallint', 'int', 'bigint',
    'decimal(10,2)', 'float', 'double', 'bool',
    'date', 'time', 'datetime', 'timestamp',
    'json', 'blob',
  ],
  sqlserver: [],
}

const makeDialect = (engine: Engine): Dialect => {
  const quoteIdent = quoteFor[engine]
  const suffix = constraintSuffixFor[engine]
  return {
    engine,
    quoteIdent,
    placeholder: (index) => (engine === 'postgresql' ? `$${index}` : '?'),
    applyOrderBy: (sql, sort) => placeOrderBy(sql, { column: quoteIdent(sort.column), dir: sort.direction }),
    displayConstraintName: (name) => (suffix ? name.replace(suffix, '') : name),
    supportsColumnComments: columnCommentsFor[engine],
    bindBoolean: (value) => (engine === 'sqlite' ? (value ? 1 : 0) : value),
    supportsColumnAlter: columnAlterFor[engine],
    supportsColumnRename: columnRenameFor[engine],
    commonColumnTypes: columnTypesFor[engine],
  }
}

const dialects: Record<Engine, Dialect> = {
  postgresql: makeDialect('postgresql'),
  sqlite: makeDialect('sqlite'),
  mysql: makeDialect('mysql'),
  sqlserver: makeDialect('sqlserver'),
}

export const dialectFor = (engine: Engine): Dialect => dialects[engine]
