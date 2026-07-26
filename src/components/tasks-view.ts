import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, controls, scrollbars, typography } from '../shared-styles'
import { capabilitiesFor } from '../engine-capabilities'
import type { Engine, ServerActivity, ServerSession, SessionEndMode } from '../electron'
import { formatCompact, formatInteger, rowWord, t } from '../i18n'
import './task-sparkline'
import './task-meter'

// One query run tracked as a task. Every run is recorded; the view only
// surfaces the long ones. Runtime-only, capped, spanning every connection.
export type TaskItem = {
  id: string
  profileId: string
  /** "connection / child" at the time the run started. */
  contextLabel: string
  sql: string
  startedAt: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** Driver-measured once finished; running tasks derive elapsed live. */
  durationMs: number | null
  rowCount: number | null
}

export type TaskStopDetail = { taskId: string; profileId: string }

/** A session the user asked to end; the workbench confirms and performs it. */
export type SessionEndDetail = {
  profileId: string
  session: ServerSession
  mode: SessionEndMode
}

/** Runs shorter than this never show up — they were never worth tracking.
 * The workbench uses the same threshold for the activity-bar badge. */
export const LONG_RUNNING_MS = 2000

// The panel is a live view, so it refetches on a timer rather than waiting for a
// user action. Only while it is mounted and the window is visible — switching
// activity views unmounts it, which is what stops the polling.
const POLL_MS = 2500

/** Slowest finished runs listed under the trend. */
const SLOWEST_COUNT = 3

const summarize = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 120)

const formatDuration = (ms: number) => {
  if (ms < 10_000) return t('tasks.durationShort', { seconds: (ms / 1000).toFixed(1) })
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? t('tasks.durationShort', { seconds })
    : t('tasks.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

// The Tasks sidebar view: a session dashboard over this workspace's own runs
// (free — the data is already in memory) above a live server panel (polled, and
// absent on engines with no server to ask). Emits `task-stop` for a running
// query and `session-end` for someone else's session.
@customElement('tasks-view')
export class TasksView extends LitElement {
  @property({ attribute: false })
  items: TaskItem[] = []

  /** Connected profile whose server to poll; null hides the server panel. */
  @property()
  profileId: string | null = null

  /** Active child database (all-databases mode); null otherwise. */
  @property()
  childDb: string | null = null

  /** Engine of the connected profile, for the server-activity capability. */
  @property()
  engine: Engine | null = null

  // Drives the live elapsed labels and the 2s appearance threshold.
  @state()
  private _now = Date.now()

  @state()
  private _server:
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'error'; error: string }
    | { phase: 'done'; activity: ServerActivity } = { phase: 'idle' }

  private _timer: number | null = null
  private _poll: number | null = null
  /** Bumped on every context change; a slower in-flight fetch is stale. */
  private _generation = 0

  connectedCallback() {
    super.connectedCallback()
    this._timer = window.setInterval(() => {
      this._now = Date.now()
    }, 500)
    this._startPolling()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._timer !== null) clearInterval(this._timer)
    this._timer = null
    this._stopPolling()
    // Invalidate anything in flight so it can't land on a remounted element.
    this._generation += 1
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('profileId') || changed.has('childDb') || changed.has('engine')) {
      this._server = { phase: 'idle' }
      this._generation += 1
      if (this.isConnected) this._startPolling()
    }
  }

  /** Refetches immediately — after ending a session, say. */
  refresh() {
    void this._load()
  }

  private get _serverSupported() {
    return !!this.profileId && !!this.engine && capabilitiesFor(this.engine).serverActivity !== false
  }

  private get _cancelSupported() {
    const capability = this.engine ? capabilitiesFor(this.engine).serverActivity : false
    return capability !== false && capability.cancelSession
  }

  private _startPolling() {
    this._stopPolling()
    if (!this._serverSupported) return
    void this._load()
    this._poll = window.setInterval(() => {
      // A hidden window is not being read; don't query someone's database for it.
      if (!document.hidden) void this._load()
    }, POLL_MS)
  }

  private _stopPolling() {
    if (this._poll !== null) clearInterval(this._poll)
    this._poll = null
  }

  private async _load() {
    const profileId = this.profileId
    if (!profileId || !this._serverSupported) return
    const generation = this._generation
    // Only the first fetch shows a spinner; later polls swap in place so the
    // panel doesn't flicker every few seconds.
    if (this._server.phase === 'idle') this._server = { phase: 'loading' }
    let result: Awaited<ReturnType<typeof window.sqlkit.serverActivity>>
    try {
      result = await window.sqlkit.serverActivity(profileId, this.childDb)
    } catch (error) {
      if (this._generation === generation) this._server = { phase: 'error', error: (error as Error).message }
      return
    }
    if (this._generation !== generation) return
    this._server = result.success
      ? { phase: 'done', activity: result.activity }
      : { phase: 'error', error: result.error }
  }

  render() {
    return html`
      <div class="scroll">
        ${this._renderSession()}
        ${this._serverSupported ? this._renderServer() : nothing}
      </div>
    `
  }

  // --- this session --------------------------------------------------------

  private _renderSession() {
    const items = this.items
    const finished = items.filter((item) => item.status !== 'running')
    const errors = items.filter((item) => item.status === 'error').length
    const rows = items.reduce((total, item) => total + (item.rowCount ?? 0), 0)
    const running = items
      .filter((item) => item.status === 'running' && this._now - item.startedAt >= LONG_RUNNING_MS)
      .sort((a, b) => a.startedAt - b.startedAt)
    // Oldest → newest, so the trend reads left to right like every other chart.
    const durations = [...finished].reverse().map((item) => item.durationMs ?? 0)
    const slowest = [...finished]
      .filter((item) => (item.durationMs ?? 0) > 0)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, SLOWEST_COUNT)

    return html`
      <section>
        <h3>${t('tasks.session')}</h3>
        ${items.length
          ? html`
              <div class="tiles">
                ${this._renderTile(t('tasks.runs'), formatCompact(items.length))}
                ${this._renderTile(t('tasks.errors'), formatCompact(errors), errors > 0 ? 'bad' : '')}
                ${this._renderTile(t('tasks.rowsRead'), formatCompact(rows))}
              </div>
              ${durations.length > 1 ? this._renderTrend(durations) : nothing}
              ${running.length
                ? html`
                    <h4><span class="dot running"></span>${t('tasks.runningNow')} <span class="count">${running.length}</span></h4>
                    ${running.map((item) => this._renderItem(item))}
                  `
                : nothing}
              ${slowest.length
                ? html`
                    <h4>${t('tasks.slowest')}</h4>
                    ${slowest.map((item) => this._renderItem(item))}
                  `
                : nothing}
            `
          : html`<p class="muted hint">${t('tasks.noRuns')}</p>`}
      </section>
    `
  }

  private _renderTile(label: string, value: string, tone = '') {
    return html`
      <div class="tile">
        <span class="value ${tone}">${value}</span>
        <span class="label">${label}</span>
      </div>
    `
  }

  private _renderTrend(durations: number[]) {
    const min = Math.min(...durations)
    const max = Math.max(...durations)
    const last = durations[durations.length - 1] ?? 0
    return html`
      <div class="trend">
        <div class="trend-head">
          <span class="label">${t('tasks.durationTrend')}</span>
          <!-- The peak, not the latest run: the sparkline is scaled to it, so
               this is the number that makes the chart's height legible. -->
          <span class="trend-last">${t('tasks.trendPeak', { peak: formatDuration(max) })}</span>
        </div>
        <task-sparkline
          .values=${durations}
          summary=${t('tasks.trendSummary', {
            count: durations.length,
            min: formatDuration(min),
            max: formatDuration(max),
            last: formatDuration(last),
          })}
        ></task-sparkline>
      </div>
    `
  }

  private _renderItem(item: TaskItem) {
    const running = item.status === 'running'
    const duration = formatDuration(running ? this._now - item.startedAt : (item.durationMs ?? 0))
    const meta = [
      item.contextLabel,
      running
        ? `${t('tasks.running')} · ${duration}`
        : `${t(item.status === 'done' ? 'tasks.done' : item.status === 'error' ? 'common.error' : 'tasks.cancelled')} · ${duration}`,
      !running && item.rowCount !== null
        ? t('tasks.rowCount', { count: formatInteger(item.rowCount), rows: rowWord(item.rowCount) })
        : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return html`
      <div class="item ${item.status}" title=${item.sql}>
        <div class="row">
          ${running ? html`<i class="icon icon-loader-circle icon-modifier-spin" aria-hidden="true"></i>` : ''}
          <span class="sql">${summarize(item.sql)}</span>
          ${running
            ? html`
                <button class="act" title=${t('tasks.stopQuery')} @click=${() => this._stop(item)}>
                  <i class="icon icon-square" aria-hidden="true"></i>
                </button>
              `
            : ''}
        </div>
        <span class="meta">${meta}</span>
      </div>
    `
  }

  // --- the server ---------------------------------------------------------

  private _renderServer() {
    const state = this._server
    return html`
      <section class="server">
        <h3>
          ${t('tasks.server')}
          <button class="act" title=${t('tasks.refresh')} @click=${() => this.refresh()}>
            <i class="icon icon-refresh-cw" aria-hidden="true"></i>
          </button>
        </h3>
        ${state.phase === 'error'
          ? html`<p class="muted hint">${t('tasks.serverUnavailable')} — ${state.error}</p>`
          : state.phase === 'done'
            ? this._renderActivity(state.activity)
            : html`<p class="muted hint">${t('server.loading')}</p>`}
      </section>
    `
  }

  private _renderActivity(activity: ServerActivity) {
    const { used, max } = activity.connections
    return html`
      <div class="gauge">
        <div class="gauge-head">
          <span class="label">${t('tasks.connections')}</span>
          <span class="gauge-value">
            ${max === null ? formatInteger(used) : t('tasks.connectionsOf', { used: formatInteger(used), max: formatInteger(max) })}
          </span>
        </div>
        <task-meter .used=${used} .max=${max}></task-meter>
      </div>
      ${activity.stats.length
        ? html`<p class="stats">${activity.stats.map((stat) => html`<span><span class="label">${stat.label}</span> ${stat.value}</span>`)}</p>`
        : nothing}
      <h4>${t('tasks.sessions')} <span class="count">${activity.sessions.length}</span></h4>
      ${activity.sessions.length
        ? activity.sessions.map((session) => this._renderSessionRow(session))
        : html`<p class="muted hint">${t('tasks.noSessions')}</p>`}
    `
  }

  private _renderSessionRow(session: ServerSession) {
    const idle = !session.sql
    const meta = [
      session.user,
      session.database ?? '',
      session.state || (idle ? t('tasks.sessionIdle') : ''),
      session.elapsedMs !== null && session.elapsedMs >= 1000 ? formatDuration(session.elapsedMs) : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return html`
      <div class="item session ${session.self ? 'self' : ''}" title=${session.sql ?? ''}>
        <div class="row">
          <span class="sid" title=${session.self ? t('tasks.sessionSelf') : ''}>${session.id}</span>
          <span class="sql ${idle ? 'muted' : ''}">${session.sql ? summarize(session.sql) : t('tasks.sessionIdle')}</span>
          ${this._cancelSupported && !idle
            ? html`
                <button class="act" title=${t('tasks.cancelStatement')} @click=${() => this._endSession(session, 'cancel')}>
                  <i class="icon icon-square" aria-hidden="true"></i>
                </button>
              `
            : nothing}
          <button class="act danger" title=${t('tasks.endSession')} @click=${() => this._endSession(session, 'terminate')}>
            <i class="icon icon-x" aria-hidden="true"></i>
          </button>
        </div>
        <span class="meta">${meta}</span>
      </div>
    `
  }

  private _stop(item: TaskItem) {
    this.dispatchEvent(
      new CustomEvent<TaskStopDetail>('task-stop', {
        detail: { taskId: item.id, profileId: item.profileId },
        bubbles: true,
        composed: true,
      }),
    )
  }

  private _endSession(session: ServerSession, mode: SessionEndMode) {
    if (!this.profileId) return
    this.dispatchEvent(
      new CustomEvent<SessionEndDetail>('session-end', {
        detail: { profileId: this.profileId, session, mode },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    typography,
    controls,
    icons,
    scrollbars,
    css`
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding-bottom: 8px;
      }

      section {
        padding: 8px 10px 10px;
      }

      section.server {
        border-top: 1px solid var(--border-subtle);
      }

      h3 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 0 8px;
        font-size: var(--font-size-sm);
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-3);
      }

      h4 {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 12px 0 4px;
        font-size: var(--font-size-sm);
        font-weight: 600;
        color: var(--text-3);
      }

      .count {
        color: var(--text-3);
        font-weight: 400;
      }

      /* --- stat tiles --- */

      .tiles {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }

      .tile {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
        padding: 6px 8px;
        border-radius: 4px;
        background: var(--btn-secondary-bg);
      }

      .tile .value {
        font-size: 17px;
        font-weight: 600;
        color: var(--text);
        /* Proportional figures: these are standalone values, not a column. */
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tile .value.bad {
        color: var(--status-dot-error);
      }

      .label {
        font-size: var(--font-size-sm);
        color: var(--text-3);
      }

      /* --- trend + gauge --- */

      .trend,
      .gauge {
        margin-top: 10px;
      }

      .trend-head,
      .gauge-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 3px;
      }

      .trend-last,
      .gauge-value {
        font-size: var(--font-size-sm);
        color: var(--text-2);
        font-variant-numeric: tabular-nums;
      }

      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        margin: 8px 0 0;
        font-size: var(--font-size-sm);
        color: var(--text-2);
      }

      /* --- rows --- */

      .item {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 5px 6px;
        border-left: 2px solid transparent;
        border-radius: 3px;
      }

      .item:hover {
        background: var(--list-hover);
      }

      .item.running {
        border-left-color: var(--status-dot-warning);
      }

      .item.session.self {
        border-left-color: var(--accent);
      }

      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .sql {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        color: var(--text);
      }

      .sql.muted,
      .muted {
        color: var(--text-3);
      }

      .sid {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        font-variant-numeric: tabular-nums;
        color: var(--text-3);
      }

      .meta {
        font-size: var(--font-size-sm);
        color: var(--text-3);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .item.error .meta {
        color: var(--status-dot-error);
      }

      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--status-dot-warning);
      }

      /* --- actions --- */

      button.act {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-3);
        opacity: 0;
      }

      h3 button.act,
      .item:hover button.act,
      button.act:focus-visible {
        opacity: 1;
      }

      button.act:hover {
        background: var(--btn-secondary-hover);
        color: var(--text);
      }

      button.act.danger:hover {
        color: var(--status-dot-error);
      }

      .hint {
        margin: 0;
        font-size: var(--font-size-sm);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'tasks-view': TasksView
  }
}
