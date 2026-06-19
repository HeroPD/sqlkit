import type { ColumnRef, QueryResult, TableRef } from './electron'
import type { QueryRun, CellCoord } from './components/results-panel'
import type { SqlTabState } from './controllers/contexts'
import { inferEditableTable } from './sql-edit-context'
import type { BatchUpdateEdit, RowKey } from './sql-write'

export type ResultEditInput = {
  tab: SqlTabState | null
  profileId: string | null
  run: QueryRun
  tables: TableRef[]
  columns: ColumnRef[]
}

export type SingleTableEditContext = {
  table: TableRef
  columns: ColumnRef[]
  result: QueryResult
  pkIndexes: Array<{ name: string; index: number }>
}

export type CellEditContext = SingleTableEditContext & {
  columnName: string
  columnMeta: ColumnRef
}

export type EditIssue = { title: string; detail: string }

export type EditResult<T> = { ok: true; value: T } | { ok: false; issue: EditIssue }

const cannotEditColumn: EditIssue = {
  title: 'Cannot edit this column',
  detail: 'The selected column is not an editable table column with its primary key in the result.',
}

export function hasResultCells(run: QueryRun): boolean {
  return run.phase === 'done' && run.result.columns.length > 0
}

export function tableMatchesSource(table: TableRef, source: { schema: string | null; table: string | null; column: string | null }) {
  if (!source.table) return false
  const tableMatches = table.name === source.table || table.name.toLowerCase() === source.table.toLowerCase()
  const schemaMatches = source.schema === null || table.schema === source.schema || table.schema?.toLowerCase() === source.schema.toLowerCase()
  return tableMatches && schemaMatches
}

export function singleTableEditContext(input: ResultEditInput): SingleTableEditContext | null {
  const { tab, profileId, run } = input
  if (!tab || !profileId || run.phase !== 'done') return null
  const table = tab.table ?? inferEditableTable(run.sql ?? '', input.tables)
  if (!table) return null
  if (run.result.columnSources?.some((source) => source.table !== null && !tableMatchesSource(table, source))) return null
  const columns = columnsForTable(input.columns, table)
  const pkIndexes = primaryKeyIndexes(run.result, table, columns, true)
  return pkIndexes.length ? { table, columns, result: run.result, pkIndexes } : null
}

export function cellEditContext(input: ResultEditInput, cell: CellCoord): CellEditContext | null {
  const single = singleTableEditContext(input)
  if (!input.profileId || input.run.phase !== 'done') return null
  if (single) {
    const source = single.result.columnSources?.[cell.col]
    const columnName = single.result.columnSources
      ? source && tableMatchesSource(single.table, source)
        ? source.column
        : null
      : single.result.columns[cell.col]
    const columnMeta = single.columns.find((column) => column.name.toLowerCase() === columnName?.toLowerCase())
    return columnName && columnMeta ? { ...single, columnName, columnMeta } : null
  }

  const source = input.run.result.columnSources?.[cell.col]
  if (!source?.table || !source.column) return null
  const table = input.tables.find((candidate) => tableMatchesSource(candidate, source))
  if (!table) return null
  const columns = columnsForTable(input.columns, table)
  const columnMeta = columns.find((column) => column.name.toLowerCase() === source.column!.toLowerCase())
  const pkIndexes = primaryKeyIndexes(input.run.result, table, columns, false)
  return columnMeta && pkIndexes.length ? { table, columns, result: input.run.result, pkIndexes, columnName: columnMeta.name, columnMeta } : null
}

export function buildEditSpecs(input: ResultEditInput, cells: CellCoord[], value: string): EditResult<{ table: TableRef; edits: BatchUpdateEdit[] }> {
  const specs: BatchUpdateEdit[] = []
  let table: TableRef | null = null
  for (const cell of cells) {
    const ctx = cellEditContext(input, cell)
    if (!ctx) return { ok: false, issue: cannotEditColumn }
    if (table && !sameTable(table, ctx.table)) {
      return { ok: false, issue: { title: 'Cannot edit this selection', detail: 'Selected cells must belong to the same source table.' } }
    }
    table = ctx.table
    const row = ctx.result.rows[cell.row]
    if (!row) return { ok: false, issue: { title: 'Cannot edit this row', detail: 'It is no longer loaded in the current result.' } }
    const pks = rowKey(ctx.result, cell.row, ctx.pkIndexes)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: 'Cannot edit this row', detail: 'Its primary key value is missing from the result.' } }
    }
    specs.push({ column: ctx.columnName, columnMeta: ctx.columnMeta, value, pks })
  }
  return table && specs.length ? { ok: true, value: { table, edits: specs } } : { ok: false, issue: cannotEditColumn }
}

export function rowKeysForDelete(ctx: SingleTableEditContext, rows: number[]): EditResult<RowKey[]> {
  const keys: RowKey[] = []
  for (const rowIndex of rows) {
    if (!ctx.result.rows[rowIndex]) {
      return { ok: false, issue: { title: 'Cannot delete this row', detail: 'It is no longer loaded in the current result.' } }
    }
    const pks = rowKey(ctx.result, rowIndex, ctx.pkIndexes)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: 'Cannot delete this row', detail: 'Its primary key value is missing from the result.' } }
    }
    keys.push(pks)
  }
  return keys.length ? { ok: true, value: keys } : { ok: false, issue: { title: 'Cannot delete rows', detail: 'No rows are selected.' } }
}

function columnsForTable(columns: ColumnRef[], table: TableRef) {
  return columns.filter((column) => column.schema === table.schema && column.table === table.name)
}

function sameTable(a: TableRef, b: TableRef) {
  return a.name === b.name && a.schema === b.schema
}

function primaryKeyIndexes(result: QueryResult, table: TableRef, columns: ColumnRef[], allowNameFallback: boolean): Array<{ name: string; index: number }> {
  const pk = columns.filter((column) => column.primaryKey)
  if (!pk.length) return []
  const hasSources = result.columnSources !== undefined
  const indexes = pk.map((column) => {
    const sourceIndex = result.columnSources?.findIndex(
      (source) => tableMatchesSource(table, source) && source.column?.toLowerCase() === column.name.toLowerCase(),
    )
    const index = sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex : !hasSources && allowNameFallback ? result.columns.indexOf(column.name) : -1
    return { name: column.name, index }
  })
  return indexes.every((entry) => entry.index >= 0) ? indexes : []
}

function rowKey(result: QueryResult, rowIndex: number, pkIndexes: Array<{ name: string; index: number }>): RowKey {
  const row = result.rows[rowIndex]
  return pkIndexes.map((pk) => ({ name: pk.name, value: row?.[pk.index] }))
}
