import type { ColumnRef, QueryResult } from './electron'

// Which result columns hold a JSON document, by result column index. Kept out
// of the results panel so the rule is testable without a grid, and shaped like
// foreign-keys.ts: both answer "what is this result column, really?" from the
// same column sources, and both stay silent when they cannot be sure.

const key = (schema: string | null | undefined, table: string, column: string) => `${schema ?? ''}\0${table}\0${column}`

// Postgres json/jsonb and MySQL json. MariaDB spells JSON as LONGTEXT plus a
// json_valid check; the mysql driver reads that check back and reports the
// column as `json`, so it matches here like any other. SQLite and SQL Server
// have no JSON type — their documents live in TEXT/nvarchar columns,
// indistinguishable from prose, so nothing is offered there rather than
// guessing from the value.
const isJsonType = (dataType: string) => /^jsonb?$/.test(dataType.trim().toLowerCase())

export function jsonColumns(result: QueryResult, columns: ColumnRef[]): Set<number> {
  const found = new Set<number>()
  // Without column sources a result column cannot be traced back to a table,
  // so its declared type is unknown.
  const sources = result.columnSources
  if (!sources) return found

  // Exact match first, folded as a fallback: quoted identifiers can differ only
  // by case (Postgres "Payload" vs payload), so a folded-only lookup could bind
  // the wrong sibling column — the same care foreignKeyTargets takes.
  const exact = new Map<string, ColumnRef>()
  const folded = new Map<string, ColumnRef>()
  for (const column of columns) {
    exact.set(key(column.schema, column.table, column.name), column)
    folded.set(key(column.schema?.toLowerCase(), column.table.toLowerCase(), column.name.toLowerCase()), column)
  }

  sources.forEach((source, index) => {
    if (!source.table || !source.column) return
    const meta = exact.get(key(source.schema, source.table, source.column))
      ?? folded.get(key(source.schema?.toLowerCase(), source.table.toLowerCase(), source.column.toLowerCase()))
    if (meta && isJsonType(meta.dataType)) found.add(index)
  })
  return found
}
