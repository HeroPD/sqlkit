import type { ColumnRef, ColumnReference, QueryResult } from './electron'

// Which result columns can be followed to the row they reference, mapped by
// result column index. Kept out of the results panel so the rule is testable
// without a grid, and out of result-editing so following a key stays independent
// of whether the result is editable.

const key = (schema: string | null | undefined, table: string, column: string) => `${schema ?? ''}\0${table}\0${column}`

export function foreignKeyTargets(result: QueryResult, columns: ColumnRef[]): Map<number, ColumnReference> {
  const targets = new Map<number, ColumnReference>()
  // Without column sources there is no way to tell which table a result column
  // came from, so nothing can be followed. Engines that report them cover the
  // browse queries this feature starts from.
  const sources = result.columnSources
  if (!sources) return targets

  // A composite key spans several columns, so following one of them would filter
  // on half the key and return rows that merely share that half. Count the
  // columns each constraint covers and offer only the single-column keys.
  const constraintSpan = new Map<string, number>()
  for (const column of columns) {
    if (!column.references) continue
    const id = key(column.schema, column.table, column.references.constraint)
    constraintSpan.set(id, (constraintSpan.get(id) ?? 0) + 1)
  }

  // Exact match first, folded as a fallback: quoted identifiers can differ only
  // by case (Postgres "ID" vs "id"), so a folded-only lookup could bind the
  // wrong sibling column — the same care findColumnMeta takes in result-editing.
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
    const references = meta?.references
    if (!meta || !references) return
    if ((constraintSpan.get(key(meta.schema, meta.table, references.constraint)) ?? 0) > 1) return
    targets.set(index, references)
  })
  return targets
}
