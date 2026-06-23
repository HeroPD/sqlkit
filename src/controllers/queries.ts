import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
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

// Shared empty edits map, so a tab with no pending edits returns a stable
// reference (no spurious re-renders).
const NO_EDITS: ReadonlyMap<string, string> = new Map()

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

  /** A run belongs to the tab that started it, wherever the user is now. */
  setRun(tabId: string, run: QueryRun) {
    if (!this.tabExists(tabId)) return
    this.runs = new Map(this.runs).set(tabId, run)
    this.host.requestUpdate()
  }

  // --- draft (unsaved new) rows --------------------------------------------

  /** The tab's staged new rows; empty when none. */
  draftsFor(tabId: string | null): DraftRow[] {
    return (tabId ? this.drafts.get(tabId) : undefined) ?? []
  }

  /** Inserts an all-default new row (every cell untouched) below result row
   * `after` (-1 = above the first row) at array position `index`, or appends. */
  addDraft(tabId: string, columnCount: number, after = -1, index?: number) {
    const rows = [...(this.drafts.get(tabId) ?? [])]
    const at = index === undefined ? rows.length : Math.max(0, Math.min(index, rows.length))
    rows.splice(at, 0, { after, cells: Array<string | null>(columnCount).fill(null) })
    this.drafts = new Map(this.drafts).set(tabId, rows)
    this.host.requestUpdate()
  }

  setDraftCell(tabId: string, index: number, col: number, value: string) {
    const rows = this.drafts.get(tabId)
    if (!rows?.[index] || col < 0 || col >= rows[index].cells.length) return
    const nextCells = [...rows[index].cells]
    nextCells[col] = value
    this.drafts = new Map(this.drafts).set(
      tabId,
      rows.map((row, i) => (i === index ? { ...row, cells: nextCells } : row)),
    )
    this.host.requestUpdate()
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
    const next = new Map(this.drafts)
    if (remaining.length) next.set(tabId, remaining)
    else next.delete(tabId)
    this.drafts = next
    this.host.requestUpdate()
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
    const inner = new Map(this.edits.get(tabId) ?? [])
    inner.set(`${row}:${col}`, value)
    this.edits = new Map(this.edits).set(tabId, inner)
    this.host.requestUpdate()
  }

  clearEdit(tabId: string, row: number, col: number) {
    const inner = this.edits.get(tabId)
    if (!inner?.has(`${row}:${col}`)) return
    const nextInner = new Map(inner)
    nextInner.delete(`${row}:${col}`)
    const next = new Map(this.edits)
    if (nextInner.size) next.set(tabId, nextInner)
    else next.delete(tabId)
    this.edits = next
    this.host.requestUpdate()
  }

  clearEdits(tabId: string) {
    if (!this.edits.has(tabId)) return
    const next = new Map(this.edits)
    next.delete(tabId)
    this.edits = next
    this.host.requestUpdate()
  }

  /** Discards all staged changes (new rows and cell edits) for a tab. */
  clearStaged(tabId: string) {
    let changed = false
    if (this.drafts.has(tabId)) {
      const next = new Map(this.drafts)
      next.delete(tabId)
      this.drafts = next
      changed = true
    }
    if (this.edits.has(tabId)) {
      const next = new Map(this.edits)
      next.delete(tabId)
      this.edits = next
      changed = true
    }
    if (changed) this.host.requestUpdate()
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
    if (this.edits.has(tabId)) this.clearEdits(tabId)
  }

  /** Marks a tab as running before connection/child alignment awaits. */
  beginRun(tabId: string, note?: string) {
    this.closeRunSession(this.runs.get(tabId))
    this.setRun(tabId, note ? { phase: 'running', note } : { phase: 'running' })
  }

  /** Runs the SQL on an already-connected profile and records the outcome. */
  async execute(args: {
    tabId: string
    profile: ConnectionProfile
    childDb: string | null
    contextKey: string
    sql: string
  }) {
    const { tabId, profile, childDb, contextKey, sql } = args
    const gen = this.generation
    // A new query supersedes the tab's old buffered result.
    this.closeRunSession(this.runs.get(tabId))
    this.setRun(tabId, { phase: 'running' })
    const task: TaskItem = {
      id: crypto.randomUUID(),
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
      response = await window.sqlkit.runQuery(profile.id, childDb, sql)
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
      if (response.success && response.result.sessionId) void window.sqlkit.closeSession(response.result.sessionId)
      return
    }

    if (!this.tabExists(tabId)) {
      if (response.success && response.result.sessionId) void window.sqlkit.closeSession(response.result.sessionId)
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
  async loadMore(tabId: string) {
    const run = this.runs.get(tabId)
    if (run?.phase !== 'done') return
    const { result } = run
    if (result.sessionId === undefined || result.bufferedRowCount === undefined) return
    if (result.rows.length >= result.bufferedRowCount || this.fetching.has(tabId)) return

    this.fetching.add(tabId)
    const gen = this.generation
    try {
      const response = await window.sqlkit.fetchRows(result.sessionId, result.rows.length, FETCH_PAGE)
      if (this.generation !== gen) return
      // The run may have been superseded (new query) while fetching; only touch
      // it when it's still the same buffered result.
      const current = this.runs.get(tabId)
      if (current?.phase !== 'done' || current.result.sessionId !== result.sessionId) return

      // Buffer gone (evicted / disconnected) or nothing more came back: pin
      // bufferedRowCount to what's loaded so the grid stops asking.
      if (!response.success || response.rows.length === 0) {
        if (current.result.bufferedRowCount !== current.result.rows.length) {
          this.setRun(tabId, { phase: 'done', result: { ...current.result, bufferedRowCount: current.result.rows.length }, sql: current.sql })
        }
        return
      }
      this.setRun(tabId, {
        phase: 'done',
        result: { ...current.result, rows: [...current.result.rows, ...response.rows] },
        sql: current.sql,
      })
    } finally {
      this.fetching.delete(tabId)
    }
  }

  // Frees a run's main-process row buffer, if it has one.
  private closeRunSession(run: QueryRun | undefined) {
    if (run?.phase === 'done' && run.result.sessionId) {
      void window.sqlkit.closeSession(run.result.sessionId)
    }
  }

  // --- tab lifecycle hooks, called by the workbench's tab management -------

  dropTab(tabId: string) {
    this.closeRunSession(this.runs.get(tabId))
    this.runs.delete(tabId)
    this.drafts.delete(tabId)
    this.edits.delete(tabId)
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
