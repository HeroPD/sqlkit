// Turning result rows into INSERT statements — the one copy/export format that
// goes back into a database. Values inline as literals instead of binding as
// parameters (a clipboard payload has nowhere to carry params), so sqlLiteral is
// the only place a value becomes SQL text and the only escaping boundary here.
// Deliberately no formula-injection neutralization: that guard belongs to
// spreadsheet formats and would corrupt the value a database reads back.

import type { Engine, TableRef } from './electron'
import { dialectFor } from './dialect'
import { quoteQualified } from './sql-write'

// Stand-in target when the result has no single source table (a join, an
// expression-only select). Quoted like any identifier so the statement still
// parses, and distinctive enough to find and replace.
export const INSERT_TABLE_PLACEHOLDER = 'table_name'

// SQL Server caps a VALUES list at 1,000 rows; the other engines have no such
// limit but a statement per 1,000 rows keeps a large export readable and well
// inside MySQL's max_allowed_packet.
const ROWS_PER_STATEMENT = 1_000

// MySQL reads a backslash inside a string literal as an escape under its default
// sql_mode, so doubling `'` alone would let a value ending in `\` swallow the
// closing quote. Postgres (standard_conforming_strings), SQLite, and SQL Server
// all treat a backslash as an ordinary character.
export function sqlStringLiteral(text: string, engine: Engine): string {
  const escaped = engine === 'mysql' ? text.replaceAll('\\', '\\\\') : text
  return `'${escaped.replaceAll("'", "''")}'`
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// Binary literals: Postgres hex bytea, the X'' form on MySQL/SQLite, and T-SQL's
// bare 0x. An empty SQL Server value can't be written as `0x`, so it casts an
// empty string instead.
function bytesLiteral(bytes: Uint8Array, engine: Engine): string {
  const hex = toHex(bytes)
  if (engine === 'postgresql') return `'\\x${hex}'::bytea`
  if (engine === 'sqlserver') return hex ? `0x${hex}` : `CONVERT(varbinary(max), '')`
  return `X'${hex}'`
}

// Every driver here already returns temporal columns as text (see the lossless
// type parsers), so this is a fallback for a Date that slips through. UTC keeps
// it unambiguous, spelled without the ISO `T`/`Z` that MySQL rejects.
const timestampText = (date: Date): string => date.toISOString().replace('T', ' ').replace('Z', '')

const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

/** One result value as an inline SQL literal for `engine`. */
export function sqlLiteral(value: unknown, engine: Engine): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return sqlStringLiteral(value, engine)
  // Only Postgres spells booleans as keywords; 1/0 is what the others accept.
  if (typeof value === 'boolean') return engine === 'postgresql' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0'
  // bigint renders from its own decimal form — never through Number, which
  // rounds past 2^53.
  if (typeof value === 'bigint') return value.toString()
  // NaN/±Infinity have no portable literal spelling; NULL is the honest stand-in.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (value instanceof Uint8Array) return bytesLiteral(value, engine)
  if (value instanceof Date) return sqlStringLiteral(timestampText(value), engine)
  // JSON/array columns arrive as objects or as the engine's own literal text;
  // either way a string literal is what an INSERT into that column takes.
  try {
    return sqlStringLiteral(JSON.stringify(value, bigintReplacer) ?? 'null', engine)
  } catch {
    return 'NULL'
  }
}

/** The `INSERT INTO` target for a result: its source table when one is known,
 * else the placeholder for the user to replace. */
export const insertTargetName = (table: TableRef | null | undefined, engine: Engine): string => {
  const dialect = dialectFor(engine)
  return table ? quoteQualified(table, dialect) : dialect.quoteIdent(INSERT_TABLE_PLACEHOLDER)
}

// Result column names quoted as target columns. A duplicate name (select a.id,
// b.id) or an expression column (?column?, count) is passed through as it came:
// the statement names what the grid showed, and fixing an unassignable column is
// an edit the user can see and make.
const insertColumnList = (columns: string[], engine: Engine): string => {
  const dialect = dialectFor(engine)
  return columns.map((column) => dialect.quoteIdent(column)).join(', ')
}

const valuesTuple = (row: unknown[], columns: number, engine: Engine): string =>
  `(${Array.from({ length: columns }, (_, index) => sqlLiteral(row[index], engine)).join(', ')})`

export type InsertOptions = {
  columns: string[]
  rows: unknown[][]
  engine: Engine
  /** Source table; omitted or null uses INSERT_TABLE_PLACEHOLDER. */
  table?: TableRef | null
}

/** Rows as terminated INSERT statements with packed multi-row VALUES lists,
 * split every ROWS_PER_STATEMENT rows. Empty when there is nothing to insert. */
export function toInsertStatements({ columns, rows, engine, table }: InsertOptions): string {
  if (!columns.length || !rows.length) return ''
  const head = `INSERT INTO ${insertTargetName(table, engine)} (${insertColumnList(columns, engine)})`
  const statements: string[] = []
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_STATEMENT) {
    const tuples = rows
      .slice(offset, offset + ROWS_PER_STATEMENT)
      .map((row) => valuesTuple(row, columns.length, engine))
    statements.push(`${head}\nVALUES ${tuples.join(',\n       ')};`)
  }
  return `${statements.join('\n\n')}\n`
}

/** One row as its own complete INSERT — what the streaming file export emits,
 * since it serializes row by row and can't pack a VALUES list. */
export function insertStatementForRow(row: unknown[], { columns, engine, table }: Omit<InsertOptions, 'rows'>): string {
  if (!columns.length) return ''
  const head = `INSERT INTO ${insertTargetName(table, engine)} (${insertColumnList(columns, engine)})`
  return `${head}\nVALUES ${valuesTuple(row, columns.length, engine)};\n`
}
