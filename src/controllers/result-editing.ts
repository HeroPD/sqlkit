import { firstStatement } from '../codemirror/run-query'
import type { CellCoord, QueryRun } from '../components/results-panel'
import type { SqlTabState } from './contexts'
import type { DialogsController } from './dialogs'
import type { ColumnRef, ConnectionProfile, TableRef } from '../electron'
import { buildBatchUpdate, buildDeleteRows, buildInsertDefault, buildUpdate } from '../sql-write'
import { buildEditSpecs, hasResultCells, rowKeysForDelete, singleTableEditContext, type EditIssue } from '../result-editing'

type Deps = {
  activeTab: () => SqlTabState | null
  activeDbId: () => string | null
  activeChildDb: () => string | null
  activeProfile: () => ConnectionProfile | null
  run: () => QueryRun
  tables: () => TableRef[]
  columns: () => ColumnRef[]
  dialogs: DialogsController
  runSql: (sql: string) => Promise<void>
}

// Owns result-grid write behavior: validation, prompts, review SQL, execution,
// and refresh. Pure source/PK rules live in result-editing.ts.
export class ResultEditingController {
  private deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  hasResultCells() {
    return hasResultCells(this.deps.run())
  }

  rowEditable() {
    return singleTableEditContext(this.input()) !== null
  }

  cellEdit(detail: { row: number; col: number; value: string }) {
    const built = buildEditSpecs(this.input(), [{ row: detail.row, col: detail.col }], detail.value)
    if (!built.ok) return this.notice(built.issue)
    const [spec] = built.value.edits
    if (!spec) return
    const profile = this.activeProfileForWrite()
    if (!profile) return
    const { sql, params } = buildUpdate({ table: built.value.table, ...spec, dialect: profile.engine })
    this.deps.dialogs.review = { sql, params, run: () => void this.runWrite(profile, sql, params) }
  }

  promptCellsEdit(cells: CellCoord[]) {
    if (!cells.length) return
    this.deps.dialogs.prompt = {
      message: cells.length === 1 ? 'Edit Cell' : `Edit ${cells.length} Cells`,
      detail: 'Enter the value to write. Empty writes NULL for nullable columns.',
      confirmLabel: 'Review Update',
      placeholder: 'new value',
      allowEmpty: true,
      trim: false,
      action: (value) => this.reviewCellsEdit(cells, value),
    }
  }

  addRow() {
    const ctx = singleTableEditContext(this.input())
    const profile = this.activeProfileForWrite()
    if (!ctx || !profile) return
    const { sql, params } = buildInsertDefault(ctx.table)
    this.deps.dialogs.review = { sql, params, run: () => void this.runWrite(profile, sql, params) }
  }

  deleteRows(rows: number[]) {
    const ctx = singleTableEditContext(this.input())
    const profile = this.activeProfileForWrite()
    if (!ctx || !profile || !rows.length) return
    const keys = rowKeysForDelete(ctx, rows)
    if (!keys.ok) return this.notice(keys.issue)
    const { sql, params } = buildDeleteRows({ table: ctx.table, rows: keys.value, dialect: profile.engine })
    this.deps.dialogs.review = { sql, params, run: () => void this.runWrite(profile, sql, params) }
  }

  private reviewCellsEdit(cells: CellCoord[], value: string) {
    const built = buildEditSpecs(this.input(), cells, value)
    if (!built.ok) return this.notice(built.issue)
    const profile = this.activeProfileForWrite()
    if (!profile) return
    const { sql, params } = buildBatchUpdate({ table: built.value.table, edits: built.value.edits, dialect: profile.engine })
    this.deps.dialogs.review = { sql, params, run: () => void this.runWrite(profile, sql, params) }
  }

  private async runWrite(profile: ConnectionProfile, sql: string, params: unknown[]) {
    const response = await window.sqlkit.runQuery(profile.id, this.deps.activeChildDb(), sql, params)
    if (!response.success) {
      this.deps.dialogs.notice('Write failed', response.error)
      return
    }
    if (response.result.rowCount === 0) {
      this.deps.dialogs.notice('No rows changed', 'The selected row may have changed or been removed.')
      return
    }
    const tab = this.deps.activeTab()
    if (tab) void this.deps.runSql(firstStatement(tab.content) || tab.content)
  }

  private input() {
    return {
      tab: this.deps.activeTab(),
      profileId: this.deps.activeDbId(),
      run: this.deps.run(),
      tables: this.deps.tables(),
      columns: this.deps.columns(),
    }
  }

  private activeProfileForWrite() {
    const profile = this.deps.activeProfile()
    if (profile) return profile
    this.deps.dialogs.notice('Cannot edit this result', 'Select a database connection before writing changes.')
    return null
  }

  private notice(issue: EditIssue) {
    this.deps.dialogs.notice(issue.title, issue.detail)
  }
}
