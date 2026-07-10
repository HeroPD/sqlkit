import type { ColumnRef, QueryResult, TableRef } from './electron'
import type { QueryRun, CellCoord } from './components/results-panel'
import type { SqlTabState } from './controllers/contexts'
import { inferEditableTable } from './sql-edit-context'
import type { BatchUpdateEdit, RowKey } from './sql-write'

// An unsaved new row staged in the grid. `cells` align to the result's columns:
// null = never touched (omit from INSERT so the DB default applies); a string =
// a typed value ('' coerces to NULL for nullable columns). `after` is the result
// row index it renders below (-1 = above the first row), purely for display.
export type DraftRow = { after: number; cells: Array<string | null> }

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
  const pkIndexes = primaryKeyIndexes(run.result, table, columns, true, run.sql ?? tab.content)
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
  const pkIndexes = primaryKeyIndexes(input.run.result, table, columns, false, input.run.sql ?? input.tab?.content ?? '')
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
    specs.push({ column: ctx.columnName, columnMeta: ctx.columnMeta, value, originalValue: row[cell.col], pks })
  }
  return table && specs.length ? { ok: true, value: { table, edits: specs } } : { ok: false, issue: cannotEditColumn }
}

// The table column a result column maps to, for INSERT: from columnSources when
// present, else the projected name (SELECT * / simple projection). null when the
// column isn't a plain column of the editable table.
export function insertableColumn(ctx: SingleTableEditContext, colIndex: number): { name: string; columnMeta: ColumnRef | undefined } | null {
  const source = ctx.result.columnSources?.[colIndex]
  const name = ctx.result.columnSources
    ? source && tableMatchesSource(ctx.table, source)
      ? source.column
      : null
    : ctx.result.columns[colIndex]
  if (!name) return null
  const columnMeta = ctx.columns.find((column) => column.name.toLowerCase() === name.toLowerCase())
  return { name, columnMeta }
}

export function buildInsertRows(
  input: ResultEditInput,
  drafts: DraftRow[],
): EditResult<{ table: TableRef; rows: Array<{ columns: { name: string; columnMeta: ColumnRef | undefined }[]; values: string[] }> }> {
  if (!drafts.length) return { ok: false, issue: { title: 'No new rows', detail: 'Add a row before saving.' } }
  const ctx = singleTableEditContext(input)
  if (!ctx) {
    return { ok: false, issue: { title: 'Cannot add rows here', detail: 'New rows can only be saved to a result that maps to one editable table.' } }
  }
  const rows: Array<{ columns: { name: string; columnMeta: ColumnRef | undefined }[]; values: string[] }> = []
  for (const draft of drafts) {
    const columns: { name: string; columnMeta: ColumnRef | undefined }[] = []
    const values: string[] = []
    for (let col = 0; col < draft.cells.length; col += 1) {
      const cell = draft.cells[col]
      if (cell === null || cell === undefined) continue
      const ref = insertableColumn(ctx, col)
      if (!ref) return { ok: false, issue: { title: 'Cannot save this row', detail: 'A filled column is not an editable column of the table.' } }
      columns.push(ref)
      values.push(cell)
    }
    rows.push({ columns, values })
  }
  return { ok: true, value: { table: ctx.table, rows } }
}

// Turns staged per-cell edits (each its own value) into batch-UPDATE specs,
// validating that every cell is an editable column of one source table whose
// primary key is present in the result.
export function buildPendingUpdate(
  input: ResultEditInput,
  edits: Array<{ row: number; col: number; value: string }>,
): EditResult<{ table: TableRef; edits: BatchUpdateEdit[] }> {
  const specs: BatchUpdateEdit[] = []
  let table: TableRef | null = null
  for (const edit of edits) {
    const ctx = cellEditContext(input, { row: edit.row, col: edit.col })
    if (!ctx) return { ok: false, issue: cannotEditColumn }
    if (table && !sameTable(table, ctx.table)) {
      return { ok: false, issue: { title: 'Cannot save these edits', detail: 'Edited cells must belong to the same source table.' } }
    }
    table = ctx.table
    if (!ctx.result.rows[edit.row]) {
      return { ok: false, issue: { title: 'Cannot save an edit', detail: 'A row is no longer loaded in the current result.' } }
    }
    const pks = rowKey(ctx.result, edit.row, ctx.pkIndexes)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: 'Cannot save an edit', detail: 'A row\'s primary key value is missing from the result.' } }
    }
    specs.push({
      column: ctx.columnName,
      columnMeta: ctx.columnMeta,
      value: edit.value,
      originalValue: ctx.result.rows[edit.row]?.[edit.col],
      pks,
    })
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

function primaryKeyIndexes(result: QueryResult, table: TableRef, columns: ColumnRef[], allowNameFallback: boolean, sql: string): Array<{ name: string; index: number }> {
  const pk = columns.filter((column) => column.primaryKey)
  if (!pk.length) return []
  const hasSources = result.columnSources !== undefined
  const indexes = pk.map((column) => {
    const sourceIndex = result.columnSources?.findIndex(
      (source) => tableMatchesSource(table, source) && source.column?.toLowerCase() === column.name.toLowerCase(),
    )
    const fallbackIndex = !hasSources && allowNameFallback ? simpleColumnProjectionIndex(result.columns, sql, column.name) : -1
    const index = sourceIndex !== undefined && sourceIndex >= 0 ? sourceIndex : fallbackIndex
    return { name: column.name, index }
  })
  return indexes.every((entry) => entry.index >= 0) ? indexes : []
}

function simpleColumnProjectionIndex(resultColumns: string[], sql: string, columnName: string) {
  const index = resultColumns.findIndex((column) => column.toLowerCase() === columnName.toLowerCase())
  if (index < 0) return -1
  const projections = selectProjections(sql)
  return projectionIsSimpleColumn(projections[index] ?? '', columnName) ? index : -1
}

function selectProjections(sql: string) {
  const match = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(sql)
  if (!match?.[1]) return []
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < match[1].length; i += 1) {
    if (match[1][i] === '(') depth += 1
    else if (match[1][i] === ')') depth = Math.max(0, depth - 1)
    else if (match[1][i] === ',' && depth === 0) {
      parts.push(match[1].slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(match[1].slice(start).trim())
  return parts
}

function projectionIsSimpleColumn(projection: string, columnName: string) {
  const expression = projection.replace(/\s+as\s+"?[A-Za-z_][\w$]*"?\s*$/i, '').trim()
  const match = /^(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*$/.exec(expression)
  if (!match) return false
  const last = expression.split('.').at(-1)?.trim().replace(/^"|"$/g, '')
  return last?.toLowerCase() === columnName.toLowerCase()
}

function rowKey(result: QueryResult, rowIndex: number, pkIndexes: Array<{ name: string; index: number }>): RowKey {
  const row = result.rows[rowIndex]
  return pkIndexes.map((pk) => ({ name: pk.name, value: row?.[pk.index] }))
}
