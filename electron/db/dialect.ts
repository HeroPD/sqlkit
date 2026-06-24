import type { Engine, QuerySort } from '../../src/electron'
import { applyOrderBy as placeOrderBy } from '../../src/sql-order'

// Per-engine SQL construction. Each backend spells things differently —
// identifier quoting, parameter placeholders, pagination, ORDER BY — so the
// rules live behind one Dialect per engine instead of as conditionals scattered
// through the renderer. Adding a backend is a new Dialect, not edits everywhere.
// The engine-agnostic bits (where ORDER BY goes in a statement) stay shared in
// src/sql-order; the Dialect only supplies the engine-specific quoting.
export type Dialect = {
  engine: Engine
  /** Quotes one identifier (column/table/schema name). */
  quoteIdent(name: string): string
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
