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
  }
}

const dialects: Record<Engine, Dialect> = {
  postgresql: makeDialect('postgresql'),
  sqlite: makeDialect('sqlite'),
  mysql: makeDialect('mysql'),
  sqlserver: makeDialect('sqlserver'),
}

export const dialectFor = (engine: Engine): Dialect => dialects[engine]
