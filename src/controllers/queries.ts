import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse, QueryResult, QueryResultSet, QuerySort } from '../electron'
import type { QueryRun } from '../components/results-panel'
import type { DraftRow } from '../result-editing'
import type { HistoryItem } from '../components/history-view'
import { LONG_RUNNING_MS, type TaskItem } from '../components/tasks-view'

// Keep the most recent runs per context (not globally), so a busy context can't
// evict another context's history — the history view is filtered per context.
const MAX_HISTORY = 200

// Caps each context's entries to `max`, keeping the newest. Input is newest-first.
export const capHistoryPerContext = (items: HistoryItem[], max: number): HistoryItem[] => {
  const seen = new Map<string, number>()
  return items.filter((item) => {
    const count = (seen.get(item.contextKey) ?? 0) + 1
    seen.set(item.contextKey, count)
    return count <= max
  })
}

const MAX_TASKS = 50

// Rows pulled per lazy fetch as the grid scrolls into not-yet-loaded territory.
const FETCH_PAGE = 200
const MAX_RETAINED_RESULT_BYTES = 64 * 1024 * 1024

const retainedValueBytes = (value: unknown): number => {
  if (typeof value === 'string') return value.length * 2
  if (value instanceof Uint8Array) return value.byteLength
  if (value === null || value === undefined || typeof value !== 'object') return 16
  try { return (JSON.stringify(value)?.length ?? 0) * 2 } catch { return 64 }
}

const retainedResultBytes = (result: QueryResult): number => {
  const seen = new Set<unknown[][]>()
  let bytes = 0
  for (const rows of [result.rows, ...(result.resultSets?.map((set) => set.rows) ?? [])]) {
    if (seen.has(rows)) continue
    seen.add(rows)
    for (const row of rows) for (const value of row) bytes += retainedValueBytes(value)
  }
  return bytes
}

// Shared empty edits map, so a tab with no pending edits returns a stable
// reference (no spurious re-renders).
const NO_EDITS: ReadonlyMap<string, string> = new Map()

// Same stable-empty trick for column widths.
const NO_WIDTHS: ReadonlyMap<number, number> = new Map()

const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((column, index) => column === b[index])

// Cap on a tab's undo depth; the oldest steps fall off so the snapshot stack
// can't grow with every keystroke-commit.
const MAX_STAGED_HISTORY = 100

// A point-in-time capture of everything staged on a tab, for undo/redo.
type StagedSnapshot = { drafts: DraftRow[]; edits: Map<string, string> }

// Owns everything a query run produces: the per-tab results (switching tabs
// brings a tab's result back), the cross-connection task list with its live
// ticker, and per-context history. The workbench decides what to run and
// ensures the connection; execute() does the bookkeeping. Runtime-only, like
// the other controllers.
export class QueriesController implements ReactiveController {
  /** Last run of every tab, keyed by tab id. */
  runs = new Map<string, QueryRun>()

  /** Unsaved new rows staged in the grid, keyed by tab id. */
  drafts = new Map<string, DraftRow[]>()

  /** Unsaved cell edits per tab: inner key "row:col" → new value string. */
  edits = new Map<string, Map<string, string>>()

  /** The column sort the result grid injected, per tab; absent when unsorted. */
  sorts = new Map<string, QuerySort>()

  /** User-dragged column widths per tab (col index → px), tagged with the columns
   * they were set against so a differently-shaped result re-measures. */
  columnWidths = new Map<string, { columns: string[]; widths: Map<number, number> }>()

  /** Per-tab undo/redo stacks over the staged state; `index` points at the live snapshot. */
  private stagedHistory = new Map<string, { stack: StagedSnapshot[]; index: number }>()

  /** Query history of every context in this workspace, newest first. */
  history: HistoryItem[] = []

  /** Every query run across all connections; the Tasks view shows long ones. */
  tasks: TaskItem[] = []

  private host: ReactiveControllerHost
  /** Guards against landing results on tabs closed mid-run. */
  private tabExists: (tabId: string) => boolean
  private timer: number | null = null
  /** Bumped on reset(); a run started under an older value is stale. */
  private generation = 0
  /** Tabs with a fetch-more page in flight, so scroll spam can't double-fetch. */
  private fetching = new Set<string>()

  constructor(host: ReactiveControllerHost, tabExists: (tabId: string) => boolean) {
    this.host = host
    this.tabExists = tabExists
    host.addController(this)
  }

  hostConnected() {}

  hostDisconnected() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** What the results panel shows: the given tab's last run. */
  runFor(tabId: string | null): QueryRun {
    return (tabId ? this.runs.get(tabId) : undefined) ?? { phase: 'idle' }
  }

  /** The column sort applied to the tab's current result, if any. */
  sortFor(tabId: string | null): QuerySort | null {
    return (tabId ? this.sorts.get(tabId) : undefined) ?? null
  }

  /** The tab's dragged column widths, but only when they were set against these
   * same columns — a new result of a different shape falls back to auto-measure. */
  columnWidthsFor(tabId: string | null, columns: string[]): ReadonlyMap<number, number> {
    const entry = tabId ? this.columnWidths.get(tabId) : undefined
    return entry && sameColumns(entry.columns, columns) ? entry.widths : NO_WIDTHS
  }

  setColumnWidths(tabId: string, columns: string[], widths: Map<number, number>) {
    if (widths.size) this.columnWidths.set(tabId, { columns, widths })
    else this.columnWidths.delete(tabId)
    this.host.requestUpdate()
  }

  /** A run belongs to the tab that started it, wherever the user is now. */
  setRun(tabId: string, run: QueryRun) {
    if (!this.tabExists(tabId)) return
    const next = new Map(this.runs)
    next.delete(tabId)
    next.set(tabId, run)
    this.runs = next
    this.evictRetainedResults(tabId)
    this.host.requestUpdate()
  }

  private evictRetainedResults(protectedTabId: string) {
    let total = [...this.runs.values()].reduce((bytes, entry) =>
      bytes + (entry.phase === 'done' ? retainedResultBytes(entry.result) : 0), 0)
    if (total <= MAX_RETAINED_RESULT_BYTES) return
    const next = new Map(this.runs)
    for (const [tabId, entry] of next) {
      if (total <= MAX_RETAINED_RESULT_BYTES) break
      if (tabId === protectedTabId || entry.phase !== 'done') continue
      total -= retainedResultBytes(entry.result)
      this.closeResultSessions(entry.result)
      next.set(tabId, { phase: 'error', error: 'This result was released to keep SqlKit memory usage bounded. Run the query again to reload it.' })
    }
    this.runs = next
  }

  // --- draft (unsaved new) rows --------------------------------------------

  /** The tab's staged new rows; empty when none. */
  draftsFor(tabId: string | null): DraftRow[] {
    return (tabId ? this.drafts.get(tabId) : undefined) ?? []
  }

  /** Inserts an all-default new row (every cell untouched) below result row
   * `after` (-1 = above the first row) at array position `index`, or appends. */
  addDraft(tabId: string, columnCount: number, after = -1, index?: number) {
    const rows = [...this.stagedDrafts(tabId)]
    const at = index === undefined ? rows.length : Math.max(0, Math.min(index, rows.length))
    rows.splice(at, 0, { after, cells: Array<string | null>(columnCount).fill(null) })
    this.commitStaged(tabId, { drafts: rows, edits: this.stagedEdits(tabId) })
  }

  addDrafts(tabId: string, drafts: DraftRow[]) {
    if (!drafts.length) return
    this.commitStaged(tabId, { drafts: [...this.stagedDrafts(tabId), ...drafts], edits: this.stagedEdits(tabId) })
  }

  setDraftCell(tabId: string, index: number, col: number, value: string) {
    const rows = this.drafts.get(tabId)
    if (!rows?.[index] || col < 0 || col >= rows[index].cells.length) return
    const nextCells = [...rows[index].cells]
    nextCells[col] = value
    const nextRows = rows.map((row, i) => (i === index ? { ...row, cells: nextCells } : row))
    this.commitStaged(tabId, { drafts: nextRows, edits: this.stagedEdits(tabId) })
  }

  removeDraft(tabId: string, index: number) {
    this.dropDrafts(tabId, [index])
  }

  /** Drops the given draft indexes (e.g. the rows just inserted), keeping the rest. */
  dropDrafts(tabId: string, indexes: number[]) {
    const rows = this.drafts.get(tabId)
    if (!rows || !indexes.length) return
    const drop = new Set(indexes)
    const remaining = rows.filter((_, i) => !drop.has(i))
    this.commitStaged(tabId, { drafts: remaining, edits: this.stagedEdits(tabId) })
  }

  // --- pending cell edits ---------------------------------------------------

  /** The tab's staged edits as a lookup map ("row:col" → value); empty when none. */
  editsFor(tabId: string | null): ReadonlyMap<string, string> {
    return (tabId ? this.edits.get(tabId) : undefined) ?? NO_EDITS
  }

  /** The tab's staged edits as a flat list, for building the UPDATE. */
  editsList(tabId: string | null): Array<{ row: number; col: number; value: string }> {
    const map = tabId ? this.edits.get(tabId) : undefined
    if (!map) return []
    return [...map.entries()].map(([key, value]) => {
      const [row, col] = key.split(':')
      return { row: Number(row), col: Number(col), value }
    })
  }

  setEdit(tabId: string, row: number, col: number, value: string) {
    const inner = new Map(this.stagedEdits(tabId))
    inner.set(`${row}:${col}`, value)
    this.commitStaged(tabId, { drafts: this.stagedDrafts(tabId), edits: inner })
  }

  clearEdit(tabId: string, row: number, col: number) {
    const inner = this.edits.get(tabId)
    if (!inner?.has(`${row}:${col}`)) return
    const nextInner = new Map(inner)
    nextInner.delete(`${row}:${col}`)
    this.commitStaged(tabId, { drafts: this.stagedDrafts(tabId), edits: nextInner })
  }

  // Applies a whole multi-cell fill in one undoable step: result-cell edits and
  // clears (keyed row:col) plus per-draft cell writes, committed as one snapshot.
  applyFill(
    tabId: string,
    changes: {
      edits: Array<{ row: number; col: number; value: string }>
      clears: Array<{ row: number; col: number }>
      draftCells: Array<{ index: number; col: number; value: string }>
    },
  ) {
    const inner = new Map(this.stagedEdits(tabId))
    for (const { row, col, value } of changes.edits) inner.set(`${row}:${col}`, value)
    for (const { row, col } of changes.clears) inner.delete(`${row}:${col}`)
    let drafts = this.stagedDrafts(tabId)
    if (changes.draftCells.length) {
      drafts = drafts.map((row) => ({ ...row, cells: [...row.cells] }))
      for (const { index, col, value } of changes.draftCells) {
        const row = drafts[index]
        if (row && col >= 0 && col < row.cells.length) row.cells[col] = value
      }
    }
    this.commitStaged(tabId, { drafts, edits: inner })
  }

  // Bulk-clears the tab's cell edits without an undo step — a commit point
  // (post-save) or a realign, both of which invalidate any staged-edit history.
  clearEdits(tabId: string) {
    this.resetStagedHistory(tabId)
    if (!this.edits.has(tabId)) return
    const next = new Map(this.edits)
    next.delete(tabId)
    this.edits = next
    this.host.requestUpdate()
  }

  /** Discards all staged changes (new rows and cell edits) for a tab — undoable. */
  clearStaged(tabId: string) {
    this.commitStaged(tabId, { drafts: [], edits: new Map() })
  }

  // --- staged-edit undo/redo ------------------------------------------------

  private stagedDrafts(tabId: string): DraftRow[] {
    return this.drafts.get(tabId) ?? []
  }

  private stagedEdits(tabId: string): Map<string, string> {
    return this.edits.get(tabId) ?? new Map<string, string>()
  }

  // Writes a tab's staged state into the top-level maps, dropping empty entries
  // so editsFor()/draftsFor() keep returning their stable empty references.
  private writeStaged(tabId: string, snap: StagedSnapshot) {
    const drafts = new Map(this.drafts)
    if (snap.drafts.length) drafts.set(tabId, snap.drafts)
    else drafts.delete(tabId)
    this.drafts = drafts
    const edits = new Map(this.edits)
    if (snap.edits.size) edits.set(tabId, snap.edits)
    else edits.delete(tabId)
    this.edits = edits
  }

  private stagedEqual(a: StagedSnapshot, b: StagedSnapshot): boolean {
    if (a.edits.size !== b.edits.size) return false
    for (const [key, value] of a.edits) if (b.edits.get(key) !== value) return false
    return JSON.stringify(a.drafts) === JSON.stringify(b.drafts)
  }

  // The single funnel every staging mutation goes through: writes the new state,
  // records it on the tab's undo stack (dropping the redo branch and no-op steps).
  private commitStaged(tabId: string, next: StagedSnapshot) {
    const before = { drafts: this.stagedDrafts(tabId), edits: this.stagedEdits(tabId) }
    if (this.stagedEqual(before, next)) return
    this.writeStaged(tabId, next)
    const hist = this.stagedHistory.get(tabId) ?? { stack: [before], index: 0 }
    hist.stack = [...hist.stack.slice(0, hist.index + 1), next]
    if (hist.stack.length > MAX_STAGED_HISTORY) hist.stack = hist.stack.slice(hist.stack.length - MAX_STAGED_HISTORY)
    hist.index = hist.stack.length - 1
    this.stagedHistory.set(tabId, hist)
    this.host.requestUpdate()
  }

  private resetStagedHistory(tabId: string) {
    this.stagedHistory.delete(tabId)
  }

  /** Public reset for commit points (a successful save invalidates undo history). */
  clearStagedHistory(tabId: string) {
    this.resetStagedHistory(tabId)
  }

  /** Steps the tab's staged state back/forward one commit; false if there's none. */
  undoStaged(tabId: string | null): boolean {
    const hist = tabId ? this.stagedHistory.get(tabId) : undefined
    if (!tabId || !hist || hist.index <= 0) return false
    hist.index -= 1
    this.writeStaged(tabId, hist.stack[hist.index]!)
    this.host.requestUpdate()
    return true
  }

  redoStaged(tabId: string | null): boolean {
    const hist = tabId ? this.stagedHistory.get(tabId) : undefined
    if (!tabId || !hist || hist.index >= hist.stack.length - 1) return false
    hist.index += 1
    this.writeStaged(tabId, hist.stack[hist.index]!)
    this.host.requestUpdate()
    return true
  }

  hasStaged(tabId: string | null): boolean {
    if (!tabId) return false
    return (this.drafts.get(tabId)?.length ?? 0) > 0 || (this.edits.get(tabId)?.size ?? 0) > 0
  }

  hasAnyStaged(): boolean {
    return [...this.drafts.values()].some((rows) => rows.length > 0) || [...this.edits.values()].some((edits) => edits.size > 0)
  }

  // A run that changes the result's shape (or errors) invalidates staged rows and
  // edits (aligned to the old result rows). Drafts can survive a same-shape
  // refresh, but cell edits are keyed by row index and must not retarget silently.
  private realignStaged(tabId: string, columnCount: number | null) {
    // Drafts align by cell count, so they survive any run that keeps that count.
    const rows = this.drafts.get(tabId)
    if (rows?.length && !(columnCount !== null && rows.every((row) => row.cells.length === columnCount))) {
      const next = new Map(this.drafts)
      next.delete(tabId)
      this.drafts = next
    }
    // Cell edits are row-index keyed, so any rerun invalidates them and their
    // undo history — clearEdits resets both, even when the edits map is empty.
    this.clearEdits(tabId)
  }

  /** Marks a tab as running before connection/child alignment awaits. */
  beginRun(tabId: string, executionId: string, profileId: string, note?: string) {
    this.closeRunSession(this.runs.get(tabId))
    this.setRun(tabId, note ? { phase: 'running', executionId, profileId, note } : { phase: 'running', executionId, profileId })
  }

  /** Runs the SQL on an already-connected profile and records the outcome.
   * `sort` re-runs with an injected ORDER BY (built engine-side); absent clears
   * any previous sort so a fresh run starts unsorted. */
  async execute(args: {
    tabId: string
    profile: ConnectionProfile
    childDb: string | null
    contextKey: string
    sql: string
    sort?: QuerySort | null
    executionId?: string
  }) {
    const { tabId, profile, childDb, contextKey, sql, sort } = args
    const executionId = args.executionId ?? crypto.randomUUID()
    if (sort) this.sorts.set(tabId, sort)
    else this.sorts.delete(tabId)
    const gen = this.generation
    // A new query supersedes the tab's old buffered result.
    this.closeRunSession(this.runs.get(tabId))
    this.setRun(tabId, { phase: 'running', executionId, profileId: profile.id })
    const task: TaskItem = {
      id: executionId,
      profileId: profile.id,
      contextLabel: childDb ? `${profile.name} / ${childDb}` : profile.name,
      sql,
      startedAt: Date.now(),
      status: 'running',
      durationMs: null,
      rowCount: null,
    }
    this.tasks = [task, ...this.tasks].slice(0, MAX_TASKS)
    this.ensureTimer()
    this.host.requestUpdate()

    let response: QueryResponse
    try {
      response = await window.sqlkit.runQuery(profile.id, childDb, sql, undefined, sort, executionId)
    } catch (error) {
      // A rejected IPC (channel error, main-side throw) would otherwise leave
      // the run and its task stuck on 'running' forever.
      response = { success: false, error: (error as Error).message }
    }

    // A workspace switch (reset) happened while this ran: the result belongs
    // to the old workspace, so drop it instead of writing into the new one's
    // freshly-cleared history/tasks. Free its main-process buffer too — reset()
    // never saw this run, so it couldn't close the session itself.
    if (this.generation !== gen) {
      if (response.success) this.closeResultSessions(response.result)
      return
    }

    if (!this.tabExists(tabId)) {
      if (response.success) this.closeResultSessions(response.result)
      this.finishTask(task.id, response, task.startedAt)
      this.host.requestUpdate()
      return
    }

    this.realignStaged(tabId, response.success ? response.result.columns.length : null)
    this.setRun(
      tabId,
      response.success ? { phase: 'done', result: response.result, sql } : { phase: 'error', error: response.error },
    )
    this.finishTask(task.id, response, task.startedAt)
    this.history = capHistoryPerContext(
      [
        {
          id: crypto.randomUUID(),
          contextKey,
          sql,
          success: response.success,
          durationMs: response.success ? response.result.durationMs : 0,
          rowCount: response.success ? response.result.rowCount : null,
          error: response.success ? '' : response.error,
          createdAt: new Date().toISOString(),
        },
        ...this.history,
      ],
      MAX_HISTORY,
    )
    this.host.requestUpdate()
  }

  private finishTask(taskId: string, response: QueryResponse, startedAt: number) {
    this.tasks = this.tasks.map((entry) =>
      entry.id === taskId
        ? {
            ...entry,
            status: response.success ? 'done' : response.error === 'Query cancelled.' ? 'cancelled' : 'error',
            durationMs: response.success ? response.result.durationMs : Date.now() - startedAt,
            rowCount: response.success ? response.result.rowCount : null,
          }
        : entry,
    )
  }

  /** Running queries past the threshold — the Tasks activity-bar badge. */
  longRunningCount(): number {
    const now = Date.now()
    return this.tasks.filter((task) => task.status === 'running' && now - task.startedAt >= LONG_RUNNING_MS).length
  }

  clearFinishedTasks() {
    this.tasks = this.tasks.filter((task) => task.status === 'running')
    this.host.requestUpdate()
  }

  clearHistory(contextKey: string) {
    this.history = this.history.filter((item) => item.contextKey !== contextKey)
    this.host.requestUpdate()
  }

  // Pulls the next page of a paged result from the main-process buffer and
  // appends it. Called as the grid scrolls toward the end of what's loaded.
  async loadMore(tabId: string, resultSetIndex?: number) {
    const run = this.runs.get(tabId)
    if (run?.phase !== 'done') return
    const isEarlierSet = resultSetIndex !== undefined
      && !!run.result.resultSets
      && resultSetIndex >= 0
      && resultSetIndex < run.result.resultSets.length - 1
    const result = isEarlierSet ? run.result.resultSets![resultSetIndex]! : run.result
    if (result.sessionId === undefined || result.bufferedRowCount === undefined) return
    const fetchKey = `${tabId}:${isEarlierSet ? resultSetIndex : 'final'}`
    if (result.rows.length >= result.bufferedRowCount || this.fetching.has(fetchKey)) return

    this.fetching.add(fetchKey)
    const gen = this.generation
    try {
      const response = await window.sqlkit.fetchRows(result.sessionId, result.rows.length, FETCH_PAGE)
      if (this.generation !== gen) return
      // The run may have been superseded (new query) while fetching; only touch
      // it when it's still the same buffered result.
      const current = this.runs.get(tabId)
      if (current?.phase !== 'done') return
      const currentResult = isEarlierSet ? current.result.resultSets?.[resultSetIndex] : current.result
      if (currentResult?.sessionId !== result.sessionId) return

      const replaceResult = (nextSet: QueryResultSet): QueryResult => {
        if (!isEarlierSet) return { ...current.result, ...nextSet, durationMs: current.result.durationMs }
        const sets = [...current.result.resultSets!]
        sets[resultSetIndex] = nextSet
        return { ...current.result, resultSets: sets }
      }

      // Buffer gone (evicted / disconnected) or nothing more came back: pin
      // bufferedRowCount to what's loaded so the grid stops asking.
      if (!response.success || response.rows.length === 0) {
        if (currentResult.bufferedRowCount !== currentResult.rows.length) {
          this.setRun(tabId, { phase: 'done', result: replaceResult({ ...currentResult, bufferedRowCount: currentResult.rows.length }), sql: current.sql })
        }
        return
      }
      this.setRun(tabId, {
        phase: 'done',
        result: replaceResult({ ...currentResult, rows: [...currentResult.rows, ...response.rows] }),
        sql: current.sql,
      })
    } finally {
      this.fetching.delete(fetchKey)
    }
  }

  // Frees a run's main-process row buffer, if it has one.
  private closeRunSession(run: QueryRun | undefined) {
    if (run?.phase !== 'done') return
    this.closeResultSessions(run.result)
  }

  private closeResultSessions(result: QueryResult) {
    const ids = new Set([
      result.sessionId,
      ...(result.resultSets?.map((set) => set.sessionId) ?? []),
    ].filter((id): id is string => !!id))
    for (const id of ids) void window.sqlkit.closeSession(id).catch(() => {})
  }

  // --- tab lifecycle hooks, called by the workbench's tab management -------

  dropTab(tabId: string) {
    this.closeRunSession(this.runs.get(tabId))
    this.runs.delete(tabId)
    this.drafts.delete(tabId)
    this.edits.delete(tabId)
    this.sorts.delete(tabId)
    this.columnWidths.delete(tabId)
    this.stagedHistory.delete(tabId)
  }

  renameTab(oldId: string, newId: string) {
    const draft = this.drafts.get(oldId)
    if (draft) {
      const nextDrafts = new Map(this.drafts)
      nextDrafts.delete(oldId)
      this.drafts = nextDrafts.set(newId, draft)
    }
    const edit = this.edits.get(oldId)
    if (edit) {
      const nextEdits = new Map(this.edits)
      nextEdits.delete(oldId)
      this.edits = nextEdits.set(newId, edit)
    }
    const sort = this.sorts.get(oldId)
    if (sort) {
      this.sorts.delete(oldId)
      this.sorts.set(newId, sort)
    }
    const widths = this.columnWidths.get(oldId)
    if (widths) {
      this.columnWidths.delete(oldId)
      this.columnWidths.set(newId, widths)
    }
    const hist = this.stagedHistory.get(oldId)
    if (hist) {
      this.stagedHistory.delete(oldId)
      this.stagedHistory.set(newId, hist)
    }
    const run = this.runs.get(oldId)
    if (!run) return
    const next = new Map(this.runs)
    next.delete(oldId)
    this.runs = next.set(newId, run)
  }

  /** Drops runs whose tabs are gone (folder deletes, context removals). */
  sweepOrphans() {
    for (const id of [...this.runs.keys()]) {
      if (!this.tabExists(id)) {
        this.closeRunSession(this.runs.get(id))
        this.runs.delete(id)
      }
    }
    for (const id of [...this.drafts.keys()]) {
      if (!this.tabExists(id)) this.drafts.delete(id)
    }
    for (const id of [...this.edits.keys()]) {
      if (!this.tabExists(id)) this.edits.delete(id)
    }
    for (const id of [...this.sorts.keys()]) {
      if (!this.tabExists(id)) this.sorts.delete(id)
    }
    for (const id of [...this.columnWidths.keys()]) {
      if (!this.tabExists(id)) this.columnWidths.delete(id)
    }
    for (const id of [...this.stagedHistory.keys()]) {
      if (!this.tabExists(id)) this.stagedHistory.delete(id)
    }
  }

  /** Workspace switch: results, tasks and history all belong to the old one. */
  reset() {
    // Invalidate any in-flight execute() so its result can't land in the new
    // workspace's state after this clears everything.
    this.generation += 1
    for (const run of this.runs.values()) this.closeRunSession(run)
    this.runs = new Map()
    this.drafts = new Map()
    this.edits = new Map()
    this.sorts = new Map()
    this.columnWidths = new Map()
    this.stagedHistory = new Map()
    this.history = []
    this.tasks = []
    this.host.requestUpdate()
  }

  // Re-renders the host twice a second while queries run, so live elapsed
  // labels tick and the badge appears once a run crosses the threshold;
  // stops itself when nothing is running.
  private ensureTimer() {
    if (this.timer !== null) return
    this.timer = window.setInterval(() => {
      if (this.tasks.some((task) => task.status === 'running')) {
        this.host.requestUpdate()
      } else {
        clearInterval(this.timer!)
        this.timer = null
      }
    }, 500)
  }
}
