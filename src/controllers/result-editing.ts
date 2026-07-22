import { firstStatement } from '../codemirror/run-query'
import type { QueryRun } from '../components/results-panel'
import type { SqlTabState } from './contexts'
import type { DialogsController } from './dialogs'
import type { BatchResult, BatchStatement, ColumnRef, ConnectionProfile, TableRef } from '../electron'
import { buildBatchUpdates, buildDeleteRowBatches, buildInsert, type CellInput } from '../sql-write'
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
import { t } from '../i18n'

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
  edits: () => Array<{ row: number; col: number; value: CellInput }>
  clearEdits: (tabId: string) => void
  // Drops the tab's staged undo/redo history — a saved batch is a commit point.
  clearStagedHistory?: (tabId: string) => void
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
    const statements: BatchStatement[] = []

    if (editsList.length) {
      const built = buildPendingUpdate(input, editsList)
      if (!built.ok) return this.notice(built.issue)
      statements.push(...buildBatchUpdates({ table: built.value.table, edits: built.value.edits, engine: profile.engine }))
    }

    if (drafts.length) {
      const built = buildInsertRows(input, drafts)
      if (!built.ok) return this.notice(built.issue)
      for (const row of built.value.rows) {
        statements.push(buildInsert({ table: built.value.table, columns: row.columns, values: row.values, engine: profile.engine }))
      }
    }

    const display = statements.map((statement) => previewSql(statement.sql, statement.params)).join(';\n\n')
    const childDb = this.deps.activeChildDb()
    const tab = this.deps.activeTab()
    const tabId = tab?.id ?? null
    const refreshSql = tab ? firstStatement(tab.content) || tab.content : null
    const applied = { hadEdits: editsList.length > 0, draftCount: drafts.length, tabId, refreshSql }
    this.deps.dialogs.review = {
      sql: display,
      params: [],
      run: () => this.runChanges(profile, childDb, statements, applied),
    }
  }

  // Sends the whole save as one transaction: it all commits or none of it does,
  // so the user can't be left with a half-applied batch they reviewed as one
  // unit. Edits/drafts clear (and the tab refreshes) only on a clean commit.
  private async runChanges(
    profile: ConnectionProfile,
    childDb: string | null,
    statements: BatchStatement[],
    applied: { hadEdits: boolean; draftCount: number; tabId: string | null; refreshSql: string | null },
  ): Promise<string | null> {
    let outcome: BatchResult
    try {
      outcome = await window.sqlkit.runBatch(profile.id, childDb, statements)
    } catch (error) {
      outcome = { success: false, error: (error as Error).message }
    }
    if (!outcome.success) {
      const reason =
        outcome.failedIndex !== undefined
          ? t('editing.changeFailed', { index: outcome.failedIndex + 1, total: statements.length, error: outcome.error })
          : outcome.error
      return t('editing.saveRolledBack', { error: reason })
    }
    const { hadEdits, draftCount, tabId, refreshSql } = applied
    if (tabId && hadEdits) this.deps.clearEdits(tabId)
    if (tabId && draftCount > 0) this.deps.dropDrafts(tabId, Array.from({ length: draftCount }, (_, index) => index))
    // The write is committed; any pre-save undo history would restore already-
    // saved rows/edits, so drop it (the dropDrafts above may have recorded a step).
    if (tabId) this.deps.clearStagedHistory?.(tabId)
    if (refreshSql && this.deps.activeTab()?.id === tabId) void this.deps.runSql(refreshSql)
    return null
  }

  deleteRows(rows: number[]) {
    const ctx = singleTableEditContext(this.input())
    const profile = this.activeProfileForWrite()
    if (!ctx || !profile || !rows.length) return
    const keys = rowKeysForDelete(ctx, rows)
    if (!keys.ok) return this.notice(keys.issue)
    const statements = buildDeleteRowBatches({ table: ctx.table, rows: keys.value, engine: profile.engine })
    this.reviewWrite(profile, statements)
  }

  private reviewWrite(profile: ConnectionProfile, statements: BatchStatement[]) {
    const childDb = this.deps.activeChildDb()
    const tab = this.deps.activeTab()
    const refreshSql = tab ? firstStatement(tab.content) || tab.content : null
    const sql = statements.map((statement) => previewSql(statement.sql, statement.params)).join(';\n\n')
    this.deps.dialogs.review = { sql, params: [], run: () => this.runWrite(profile, childDb, statements, tab?.id ?? null, refreshSql) }
  }

  private async runWrite(profile: ConnectionProfile, childDb: string | null, statements: BatchStatement[], tabId: string | null, refreshSql: string | null): Promise<string | null> {
    let outcome: BatchResult
    try {
      outcome = await window.sqlkit.runBatch(profile.id, childDb, statements)
    } catch (error) {
      return (error as Error).message
    }
    if (!outcome.success) return outcome.error
    if (refreshSql && this.deps.activeTab()?.id === tabId) void this.deps.runSql(refreshSql)
    return null
  }

  private input() {
    return {
      tab: this.deps.activeTab(),
      profileId: this.deps.activeDbId(),
      engine: this.deps.activeProfile()?.engine ?? null,
      run: this.deps.run(),
      tables: this.deps.tables(),
      columns: this.deps.columns(),
    }
  }

  private activeProfileForWrite() {
    const profile = this.deps.activeProfile()
    if (profile) return profile
    this.deps.dialogs.notice(t('editing.noConnectionTitle'), t('editing.noConnectionDetail'))
    return null
  }

  private notice(issue: EditIssue) {
    this.deps.dialogs.notice(issue.title, issue.detail)
  }
}
