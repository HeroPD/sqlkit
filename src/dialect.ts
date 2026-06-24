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

const makeDialect = (engine: Engine): Dialect => {
  const quoteIdent = quoteFor[engine]
  return {
    engine,
    quoteIdent,
    placeholder: (index) => (engine === 'postgresql' ? `$${index}` : '?'),
    applyOrderBy: (sql, sort) => placeOrderBy(sql, { column: quoteIdent(sort.column), dir: sort.direction }),
  }
}

const dialects: Record<Engine, Dialect> = {
  postgresql: makeDialect('postgresql'),
  sqlite: makeDialect('sqlite'),
  mysql: makeDialect('mysql'),
  sqlserver: makeDialect('sqlserver'),
}

export const dialectFor = (engine: Engine): Dialect => dialects[engine]
