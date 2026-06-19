import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'
import type { QueryRun } from '../components/results-panel'
import type { HistoryItem } from '../components/history-view'
import { LONG_RUNNING_MS, type TaskItem } from '../components/tasks-view'

// Reference behavior: keep the most recent runs, drop the tail.
const MAX_HISTORY = 200

const MAX_TASKS = 50

// Rows pulled per lazy fetch as the grid scrolls into not-yet-loaded territory.
const FETCH_PAGE = 200

// Owns everything a query run produces: the per-tab results (switching tabs
// brings a tab's result back), the cross-connection task list with its live
// ticker, and per-context history. The workbench decides what to run and
// ensures the connection; execute() does the bookkeeping. Runtime-only, like
// the other controllers.
export class QueriesController implements ReactiveController {
  /** Last run of every tab, keyed by tab id. */
  runs = new Map<string, QueryRun>()

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

    this.setRun(
      tabId,
      response.success ? { phase: 'done', result: response.result, sql } : { phase: 'error', error: response.error },
    )
    this.finishTask(task.id, response, task.startedAt)
    this.history = [
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
    ].slice(0, MAX_HISTORY)
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
  }

  renameTab(oldId: string, newId: string) {
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
  }

  /** Workspace switch: results, tasks and history all belong to the old one. */
  reset() {
    // Invalidate any in-flight execute() so its result can't land in the new
    // workspace's state after this clears everything.
    this.generation += 1
    for (const run of this.runs.values()) this.closeRunSession(run)
    this.runs = new Map()
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
