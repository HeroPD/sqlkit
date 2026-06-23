import { firstStatement } from '../codemirror/run-query'
import type { QueryRun } from '../components/results-panel'
import type { SqlTabState } from './contexts'
import type { DialogsController } from './dialogs'
import type { ColumnRef, ConnectionProfile, TableRef } from '../electron'
import { buildBatchUpdate, buildDeleteRows, buildInsert } from '../sql-write'
import { previewSql } from '../components/review-query-dialog'
import {
  buildInsertRows,
  buildPendingUpdate,
  hasResultCells,
  rowKeysForDelete,
  singleTableEditContext,
  type DraftRow,
  type EditIssue,
} from '../result-editing'

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
  // The active tab's staged new rows and cell edits, and how to clear them once saved.
  drafts: () => DraftRow[]
  dropDrafts: (tabId: string, indexes: number[]) => void
  edits: () => Array<{ row: number; col: number; value: string }>
  clearEdits: (tabId: string) => void
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

  /** Whether there is anything staged to save (cell edits or new rows). */
  hasPendingChanges() {
    return this.deps.edits().length > 0 || this.deps.drafts().length > 0
  }

  // Commits every staged change together: one batch UPDATE for the edited cells
  // plus one INSERT per new row, shown in the review dialog before running.
  saveChanges() {
    const profile = this.activeProfileForWrite()
    if (!profile) return
    const editsList = this.deps.edits()
    const drafts = this.deps.drafts()
    if (!editsList.length && !drafts.length) return
    const input = this.input()
    const statements: Array<{ sql: string; params: unknown[] }> = []

    let hasUpdate = false
    if (editsList.length) {
      const built = buildPendingUpdate(input, editsList)
      if (!built.ok) return this.notice(built.issue)
      statements.push(buildBatchUpdate({ table: built.value.table, edits: built.value.edits, dialect: profile.engine }))
      hasUpdate = true
    }

    if (drafts.length) {
      const built = buildInsertRows(input, drafts)
      if (!built.ok) return this.notice(built.issue)
      for (const row of built.value.rows) {
        statements.push(buildInsert({ table: built.value.table, columns: row.columns, values: row.values, dialect: profile.engine }))
      }
    }

    const display = statements.map((statement) => previewSql(statement.sql, statement.params)).join(';\n\n')
    const childDb = this.deps.activeChildDb()
    const tab = this.deps.activeTab()
    const tabId = tab?.id ?? null
    const refreshSql = tab ? firstStatement(tab.content) || tab.content : null
    this.deps.dialogs.review = {
      sql: display,
      params: [],
      run: () => void this.runChanges(profile, childDb, statements, hasUpdate, tabId, refreshSql),
    }
  }

  private async runChanges(
    profile: ConnectionProfile,
    childDb: string | null,
    statements: Array<{ sql: string; params: unknown[] }>,
    hasUpdate: boolean,
    tabId: string | null,
    refreshSql: string | null,
  ) {
    // No cross-statement transaction: pooling can route each call to a different
    // backend, so a wrapping BEGIN/COMMIT wouldn't share a connection. Run in
    // order (UPDATE first), stop at the first failure, and only clear what landed.
    let done = 0
    let updateDone = false
    let insertsDone = 0
    for (const statement of statements) {
      const isUpdate = hasUpdate && done === 0
      let response
      try {
        response = await window.sqlkit.runQuery(profile.id, childDb, statement.sql, statement.params)
      } catch (error) {
        response = { success: false as const, error: (error as Error).message }
      }
      if (!response.success) {
        this.deps.dialogs.notice(
          'Save failed',
          `Saved ${done} of ${statements.length} change${statements.length === 1 ? '' : 's'}. Change ${done + 1} failed: ${response.error}`,
        )
        break
      }
      if (response.result.rowCount === 0) {
        this.deps.dialogs.notice(
          'Save failed',
          `Saved ${done} of ${statements.length} change${statements.length === 1 ? '' : 's'}. Change ${done + 1} affected no rows.`,
        )
        break
      }
      if (isUpdate) updateDone = true
      else insertsDone += 1
      done += 1
    }
    if (tabId && updateDone) this.deps.clearEdits(tabId)
    if (tabId && insertsDone > 0) this.deps.dropDrafts(tabId, Array.from({ length: insertsDone }, (_, i) => i))
    if ((updateDone || insertsDone > 0) && refreshSql && this.deps.activeTab()?.id === tabId) void this.deps.runSql(refreshSql)
  }

  deleteRows(rows: number[]) {
    const ctx = singleTableEditContext(this.input())
    const profile = this.activeProfileForWrite()
    if (!ctx || !profile || !rows.length) return
    const keys = rowKeysForDelete(ctx, rows)
    if (!keys.ok) return this.notice(keys.issue)
    const { sql, params } = buildDeleteRows({ table: ctx.table, rows: keys.value, dialect: profile.engine })
    this.reviewWrite(profile, sql, params)
  }

  private reviewWrite(profile: ConnectionProfile, sql: string, params: unknown[]) {
    const childDb = this.deps.activeChildDb()
    const tab = this.deps.activeTab()
    const refreshSql = tab ? firstStatement(tab.content) || tab.content : null
    this.deps.dialogs.review = { sql, params, run: () => void this.runWrite(profile, childDb, sql, params, tab?.id ?? null, refreshSql) }
  }

  private async runWrite(profile: ConnectionProfile, childDb: string | null, sql: string, params: unknown[], tabId: string | null, refreshSql: string | null) {
    let response
    try {
      response = await window.sqlkit.runQuery(profile.id, childDb, sql, params)
    } catch (error) {
      this.deps.dialogs.notice('Write failed', (error as Error).message)
      return
    }
    if (!response.success) {
      this.deps.dialogs.notice('Write failed', response.error)
      return
    }
    if (response.result.rowCount === 0) {
      this.deps.dialogs.notice('No rows changed', 'The selected row may have changed or been removed.')
      return
    }
    if (refreshSql && this.deps.activeTab()?.id === tabId) void this.deps.runSql(refreshSql)
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
