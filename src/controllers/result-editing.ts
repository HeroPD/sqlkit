import type { QueryRun } from '../components/results-panel'
import type { SqlTabState } from './contexts'
import type { DialogsController } from './dialogs'
import type { BatchResult, BatchStatement, ColumnRef, ConnectionProfile, TableRef } from '../electron'
import { buildBatchUpdates, buildDeleteRowBatches, buildDraftInserts, type CellInput } from '../sql-write'
import { previewSql } from '../components/review-query-dialog'
import {
  buildInsertRows,
  buildPendingUpdate,
  hasResultCells,
  resultKeyColumns,
  resultSourceTable,
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
  /** Re-runs what produced the shown result — same SQL, sort, parameters and
   * filter — reporting whether a result actually landed. False when the refresh
   * never started, which a dismissed parameter prompt is enough to cause. */
  refreshResult: () => Promise<boolean>
  /** Tells the panel the refresh it armed a view restore for is not coming. */
  refreshNotComing: () => void
  // The active tab's staged new rows and cell edits, and how to clear them once saved.
  drafts: () => DraftRow[]
  dropDrafts: (tabId: string, indexes: number[]) => void
  edits: () => Array<{ row: number; col: number; value: CellInput }>
  clearEdits: (tabId: string) => void
  // Result rows (data indices) staged for deletion; the DELETE runs with the save.
  deletes: () => number[]
  clearDeletions: (tabId: string) => void
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

  /** The table the shown rows came from, for naming an INSERT the result is
   * copied/exported as. Null for a join or expression-only query. */
  resultTable() {
    return resultSourceTable(this.input())
  }

  /** Result columns carrying the primary key of the shown rows. The panel uses
   * them to recognise a row across the re-run a save triggers; the write path
   * already refuses anything they come back empty for. */
  keyColumns() {
    return resultKeyColumns(this.input())
  }

  /** Whether there is anything staged to save (cell edits, new rows, or deletes). */
  hasPendingChanges() {
    return this.deps.edits().length > 0 || this.deps.drafts().length > 0 || this.deps.deletes().length > 0
  }

  // Commits every staged change together: plain UPDATEs for the edited cells,
  // grouped INSERTs for new rows, and one DELETE for the rows marked for
  // deletion — all shown in the review dialog before running.
  saveChanges() {
    const profile = this.activeProfileForWrite()
    if (!profile) return
    const editsList = this.deps.edits()
    const drafts = this.deps.drafts()
    const deletes = this.deps.deletes()
    if (!editsList.length && !drafts.length && !deletes.length) return
    const input = this.input()
    const statements: BatchStatement[] = []

    // A row marked for deletion needn't have its edits applied first.
    const deleteSet = new Set(deletes)
    const liveEdits = editsList.filter((edit) => !deleteSet.has(edit.row))

    if (liveEdits.length) {
      const built = buildPendingUpdate(input, liveEdits)
      if (!built.ok) return this.notice(built.issue)
      statements.push(...buildBatchUpdates({ table: built.value.table, edits: built.value.edits, engine: profile.engine }))
    }

    if (drafts.length) {
      const built = buildInsertRows(input, drafts)
      if (!built.ok) return this.notice(built.issue)
      statements.push(...buildDraftInserts(built.value.table, built.value.rows, profile.engine))
    }

    if (deletes.length) {
      const ctx = singleTableEditContext(input)
      if (!ctx) return
      const keys = rowKeysForDelete(ctx, deletes)
      if (!keys.ok) return this.notice(keys.issue)
      statements.push(...buildDeleteRowBatches({ table: ctx.table, rows: keys.value, engine: profile.engine }))
    }

    if (!statements.length) return

    const display = statements.map((statement) => previewSql(statement.sql, statement.params)).join(';\n\n')
    const childDb = this.deps.activeChildDb()
    const tab = this.deps.activeTab()
    const tabId = tab?.id ?? null
    const applied = { hadEdits: editsList.length > 0, draftCount: drafts.length, hadDeletes: deletes.length > 0, tabId }
    this.deps.dialogs.review = {
      sql: display,
      params: [],
      run: () => this.runChanges(profile, childDb, statements, applied),
    }
  }

  // Sends the whole save as one transaction: it all commits or none of it does,
  // so the user can't be left with a half-applied batch they reviewed as one
  // unit. Edits/drafts/deletes clear (and the tab refreshes) only on a clean commit.
  private async runChanges(
    profile: ConnectionProfile,
    childDb: string | null,
    statements: BatchStatement[],
    applied: { hadEdits: boolean; draftCount: number; hadDeletes: boolean; tabId: string | null },
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
    const { hadEdits, draftCount, hadDeletes, tabId } = applied
    if (tabId && hadEdits) this.deps.clearEdits(tabId)
    if (tabId && hadDeletes) this.deps.clearDeletions(tabId)
    if (tabId && draftCount > 0) this.deps.dropDrafts(tabId, Array.from({ length: draftCount }, (_, index) => index))
    // The write is committed; any pre-save undo history would restore already-
    // saved rows/edits, so drop it (the dropDrafts above may have recorded a step).
    if (tabId) this.deps.clearStagedHistory?.(tabId)
    // Re-runs the result the way ⌘R does, carrying its sort, parameters and
    // filter: hand-rolling the SQL here dropped all three, so a sorted grid came
    // back in table order and a parameterised one re-prompted. Not awaited — the
    // review dialog closes on this returning, and it must not sit over the
    // re-query. The panel armed a view restore for this refresh, so a refresh
    // that never starts has to say so; left waiting, the token is spent on
    // whatever result lands next.
    if (this.deps.activeTab()?.id === tabId) {
      void this.deps.refreshResult().then((refreshed) => {
        if (!refreshed) this.deps.refreshNotComing()
      })
    } else {
      this.deps.refreshNotComing()
    }
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
