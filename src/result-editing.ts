import type { ColumnRef, Engine, QueryResult, TableRef } from './electron'
import type { QueryRun, CellCoord } from './components/results-panel'
import type { SqlTabState } from './controllers/contexts'
import { inferEditableTable } from './sql-edit-context'
import { supportsOptimisticComparison, type BatchUpdateEdit, type CellInput, type RowKey } from './sql-write'
import { t } from './i18n'

// An unsaved new row staged in the grid. `cells` align to the result's columns:
// null = never touched (omit from INSERT so the DB default applies); CellInput
// keeps an empty string distinct from an explicit SQL NULL. `after` is the result
// row index it renders below (-1 = above the first row), purely for display.
export type DraftRow = { after: number; cells: Array<CellInput | null> }

export type ResultEditInput = {
  tab: SqlTabState | null
  profileId: string | null
  engine?: Engine | null
  run: QueryRun
  tables: TableRef[]
  columns: ColumnRef[]
}

export type SingleTableEditContext = {
  engine: Engine | null
  table: TableRef
  columns: ColumnRef[]
  result: QueryResult
  sql: string
  pkIndexes: Array<{ name: string; index: number; columnMeta: ColumnRef }>
}

export type CellEditContext = SingleTableEditContext & {
  columnName: string
  columnMeta: ColumnRef
}

export type EditIssue = { title: string; detail: string }

export type EditResult<T> = { ok: true; value: T } | { ok: false; issue: EditIssue }

const cannotEditColumn: EditIssue = {
  title: t('editing.cannotEditColumnTitle'),
  detail: t('editing.cannotEditColumnDetail'),
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

// Exact match first, case-insensitive as a fallback: quoted identifiers can be
// case-sensitive (Postgres "ID" vs "id"), so a folded-only lookup could bind
// the wrong sibling column.
function findColumnMeta(columns: ColumnRef[], name: string | null | undefined): ColumnRef | undefined {
  if (!name) return undefined
  return columns.find((column) => column.name === name)
    ?? columns.find((column) => column.name.toLowerCase() === name.toLowerCase())
}

function columnSourceIndex(
  result: QueryResult,
  table: TableRef,
  columnName: string,
): number {
  const sources = result.columnSources
  if (!sources) return -1
  const exact = sources.findIndex((source) => tableMatchesSource(table, source) && source.column === columnName)
  if (exact >= 0) return exact
  return sources.findIndex((source) => tableMatchesSource(table, source) && source.column?.toLowerCase() === columnName.toLowerCase())
}

export function singleTableEditContext(input: ResultEditInput): SingleTableEditContext | null {
  const { tab, profileId, run } = input
  if (!tab || !profileId || run.phase !== 'done') return null
  // The run's own table wins over the tab's: a result reached by following a
  // foreign key belongs to another table while the tab still names the one it
  // was opened for, and writing to the tab's table would target the wrong rows.
  const table = run.table ?? tab.table ?? inferEditableTable(run.sql ?? '', input.tables, input.engine ?? undefined)
  if (!table) return null
  if (run.result.columnSources?.some((source) => source.table !== null && !tableMatchesSource(table, source))) return null
  const columns = columnsForTable(input.columns, table)
  const pkIndexes = primaryKeyIndexes(run.result, table, columns, true, run.sql ?? tab.content)
  const sql = run.sql ?? tab.content
  return pkIndexes.length ? { engine: input.engine ?? null, table, columns, result: run.result, sql, pkIndexes } : null
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
    const columnMeta = findColumnMeta(single.columns, columnName)
    return columnName && columnMeta ? { ...single, columnName, columnMeta } : null
  }

  const source = input.run.result.columnSources?.[cell.col]
  if (!source?.table || !source.column) return null
  const table = input.tables.find((candidate) => tableMatchesSource(candidate, source))
  if (!table) return null
  const columns = columnsForTable(input.columns, table)
  const columnMeta = findColumnMeta(columns, source.column)
  const pkIndexes = primaryKeyIndexes(input.run.result, table, columns, false, input.run.sql ?? input.tab?.content ?? '')
  return columnMeta && pkIndexes.length
    ? {
        engine: input.engine ?? null,
        table,
        columns,
        result: input.run.result,
        sql: input.run.sql ?? input.tab?.content ?? '',
        pkIndexes,
        columnName: columnMeta.name,
        columnMeta,
      }
    : null
}

const cannotCompareColumn = (column: ColumnRef, action: string): EditIssue => ({
  title: t('editing.cannotSafely', { action }),
  detail: t('editing.unsafeComparison', { column: column.name, dataType: column.dataType }),
})

export function buildEditSpecs(input: ResultEditInput, cells: CellCoord[], value: CellInput): EditResult<{ table: TableRef; edits: BatchUpdateEdit[] }> {
  const specs: BatchUpdateEdit[] = []
  let table: TableRef | null = null
  for (const cell of cells) {
    const ctx = cellEditContext(input, cell)
    if (!ctx) return { ok: false, issue: cannotEditColumn }
    if (table && !sameTable(table, ctx.table)) {
      return { ok: false, issue: { title: t('editing.cannotEditSelectionTitle'), detail: t('editing.sameTableDetail') } }
    }
    table = ctx.table
    const row = ctx.result.rows[cell.row]
    if (!row) return { ok: false, issue: { title: t('editing.cannotEditRowTitle'), detail: t('editing.rowNotLoaded') } }
    if (input.engine && !supportsOptimisticComparison(input.engine, ctx.columnMeta)) {
      return { ok: false, issue: cannotCompareColumn(ctx.columnMeta, t('editing.actionEditCell')) }
    }
    const pks = rowKey(ctx, cell.row)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: t('editing.cannotEditRowTitle'), detail: t('editing.missingPrimaryKey') } }
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
  const columnMeta = findColumnMeta(ctx.columns, name)
  return { name, columnMeta }
}

export function buildInsertRows(
  input: ResultEditInput,
  drafts: DraftRow[],
): EditResult<{ table: TableRef; rows: Array<{ columns: { name: string; columnMeta: ColumnRef | undefined }[]; values: CellInput[] }> }> {
  if (!drafts.length) return { ok: false, issue: { title: t('editing.noNewRowsTitle'), detail: t('editing.addRowFirst') } }
  const ctx = singleTableEditContext(input)
  if (!ctx) {
    return { ok: false, issue: { title: t('editing.cannotAddRowsTitle'), detail: t('editing.singleTableResult') } }
  }
  const rows: Array<{ columns: { name: string; columnMeta: ColumnRef | undefined }[]; values: CellInput[] }> = []
  for (const draft of drafts) {
    const columns: { name: string; columnMeta: ColumnRef | undefined }[] = []
    const values: CellInput[] = []
    for (let col = 0; col < draft.cells.length; col += 1) {
      const cell = draft.cells[col]
      if (cell === null || cell === undefined) continue
      const ref = insertableColumn(ctx, col)
      if (!ref) return { ok: false, issue: { title: t('editing.cannotSaveRowTitle'), detail: t('editing.nonEditableColumn') } }
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
  edits: Array<{ row: number; col: number; value: CellInput }>,
): EditResult<{ table: TableRef; edits: BatchUpdateEdit[] }> {
  const specs: BatchUpdateEdit[] = []
  let table: TableRef | null = null
  for (const edit of edits) {
    const ctx = cellEditContext(input, { row: edit.row, col: edit.col })
    if (!ctx) return { ok: false, issue: cannotEditColumn }
    if (table && !sameTable(table, ctx.table)) {
      return { ok: false, issue: { title: t('editing.cannotSaveEditsTitle'), detail: t('editing.sameSourceTable') } }
    }
    table = ctx.table
    if (!ctx.result.rows[edit.row]) {
      return { ok: false, issue: { title: t('editing.cannotSaveEditTitle'), detail: t('editing.saveRowNotLoaded') } }
    }
    if (input.engine && !supportsOptimisticComparison(input.engine, ctx.columnMeta)) {
      return { ok: false, issue: cannotCompareColumn(ctx.columnMeta, t('editing.actionSaveEdit')) }
    }
    const pks = rowKey(ctx, edit.row)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: t('editing.cannotSaveEditTitle'), detail: t('editing.saveMissingPrimaryKey') } }
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

// Deletes match on the primary key alone — it already identifies the row, so
// guarding every displayed column only bloats the statement. SQL Server's
// rowversion token still rides along via rowKey: one column, exact concurrency.
export function rowKeysForDelete(ctx: SingleTableEditContext, rows: number[]): EditResult<RowKey[]> {
  const version = versionGuard(ctx)
  const keyColumns = [...ctx.pkIndexes.map((pk) => pk.columnMeta), ...(version ? [version.columnMeta] : [])]
  const unsupported = ctx.engine ? keyColumns.find((column) => !supportsOptimisticComparison(ctx.engine!, column)) : undefined
  if (unsupported) return { ok: false, issue: cannotCompareColumn(unsupported, t('editing.actionDeleteRow')) }
  const keys: RowKey[] = []
  for (const rowIndex of rows) {
    if (!ctx.result.rows[rowIndex]) {
      return { ok: false, issue: { title: t('editing.cannotDeleteRowTitle'), detail: t('editing.rowNotLoaded') } }
    }
    const pks = rowKey(ctx, rowIndex, false)
    if (pks.some((pk) => pk.value === null || pk.value === undefined)) {
      return { ok: false, issue: { title: t('editing.cannotDeleteRowTitle'), detail: t('editing.missingPrimaryKey') } }
    }
    if (version && !pks.some((key) => key.name.toLowerCase() === version.name.toLowerCase())) {
      pks.push({ name: version.name, value: ctx.result.rows[rowIndex]?.[version.index], columnMeta: version.columnMeta })
    }
    keys.push(pks)
  }
  return keys.length ? { ok: true, value: keys } : { ok: false, issue: { title: t('editing.cannotDeleteRowsTitle'), detail: t('editing.noRowsSelected') } }
}

function columnsForTable(columns: ColumnRef[], table: TableRef) {
  return columns.filter((column) => column.schema === table.schema && column.table === table.name)
}

function sameTable(a: TableRef, b: TableRef) {
  return a.name === b.name && a.schema === b.schema
}

function primaryKeyIndexes(
  result: QueryResult,
  table: TableRef,
  columns: ColumnRef[],
  allowNameFallback: boolean,
  sql: string,
): Array<{ name: string; index: number; columnMeta: ColumnRef }> {
  const pk = columns.filter((column) => column.primaryKey)
  if (!pk.length) return []
  const hasSources = result.columnSources !== undefined
  const indexes = pk.map((column) => {
    const sourceIndex = columnSourceIndex(result, table, column.name)
    const fallbackIndex = !hasSources && allowNameFallback ? simpleColumnProjectionIndex(result.columns, sql, column.name) : -1
    const index = sourceIndex >= 0 ? sourceIndex : fallbackIndex
    return { name: column.name, index, columnMeta: column }
  })
  return indexes.every((entry) => entry.index >= 0) ? indexes : []
}

function simpleColumnProjectionIndex(resultColumns: string[], sql: string, columnName: string) {
  const index = resultColumns.findIndex((column) => column.toLowerCase() === columnName.toLowerCase())
  if (index < 0) return -1
  const projections = selectProjections(sql)
  if (projections.length === 1 && /^(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*\.\s*)?\*$/.test(projections[0]!)) return index
  return projectionIsSimpleColumn(projections[index] ?? '', columnName) ? index : -1
}

function selectProjections(sql: string) {
  const match = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(sql)
  if (!match?.[1]) return []
  // Result names are trustworthy for a single-table star projection. Remove
  // read modifiers that precede the projection list (notably SQL Server TOP).
  const projectionSql = match[1]
    .replace(/^\s*distinct\s+/i, '')
    .replace(/^\s*top\s*(?:\(\s*\d+\s*\)|\d+)\s+(?:percent\s+)?(?:with\s+ties\s+)?/i, '')
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < projectionSql.length; i += 1) {
    if (projectionSql[i] === '(') depth += 1
    else if (projectionSql[i] === ')') depth = Math.max(0, depth - 1)
    else if (projectionSql[i] === ',' && depth === 0) {
      parts.push(projectionSql.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(projectionSql.slice(start).trim())
  return parts
}

function projectionIsSimpleColumn(projection: string, columnName: string) {
  const expression = projection.replace(/\s+as\s+"?[A-Za-z_][\w$]*"?\s*$/i, '').trim()
  const match = /^(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*$/.exec(expression)
  if (!match) return false
  const last = expression.split('.').at(-1)?.trim().replace(/^"|"$/g, '')
  return last?.toLowerCase() === columnName.toLowerCase()
}

// SQL Server rowversion (legacy alias: timestamp): the engine bumps it on every
// write, so it is the strongest optimistic token when the result includes it.
// Only SQL Server — elsewhere `timestamp` is an ordinary datetime column.
function versionGuard(ctx: SingleTableEditContext) {
  if (ctx.engine !== 'sqlserver') return null
  const columnMeta = ctx.columns.find((column) => /^(?:rowversion|timestamp)$/i.test(column.dataType.trim()))
  if (!columnMeta) return null
  const sourceIndex = columnSourceIndex(ctx.result, ctx.table, columnMeta.name)
  const index = sourceIndex >= 0 ? sourceIndex : simpleColumnProjectionIndex(ctx.result.columns, ctx.sql, columnMeta.name)
  return index >= 0 ? { name: columnMeta.name, index, columnMeta } : null
}

function rowKey(ctx: SingleTableEditContext, rowIndex: number, includeVersion = true): RowKey {
  const row = ctx.result.rows[rowIndex]
  const keys: RowKey = ctx.pkIndexes.map((pk) => ({ name: pk.name, value: row?.[pk.index], columnMeta: pk.columnMeta }))
  const version = includeVersion ? versionGuard(ctx) : null
  if (version && !keys.some((key) => key.name.toLowerCase() === version.name.toLowerCase())) {
    keys.push({ name: version.name, value: row?.[version.index], columnMeta: version.columnMeta })
  }
  return keys
}
