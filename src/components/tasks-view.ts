import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'

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

/** Runs shorter than this never show up — they were never worth tracking.
 * The workbench uses the same threshold for the activity-bar badge. */
export const LONG_RUNNING_MS = 2000

const summarize = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 120)

const formatDuration = (ms: number) => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const STATUS_LABEL = { done: 'Done', error: 'Error', cancelled: 'Cancelled' } as const

// The Tasks sidebar view: long-running queries across every connection —
// running ones tick live and offer Stop (dispatches `task-stop`); finished
// ones keep their final duration until cleared.
@customElement('tasks-view')
export class TasksView extends LitElement {
  @property({ attribute: false })
  items: TaskItem[] = []

  // Drives the live elapsed labels and the 2s appearance threshold.
  @state()
  private _now = Date.now()

  private _timer: number | null = null

  connectedCallback() {
    super.connectedCallback()
    this._timer = window.setInterval(() => {
      this._now = Date.now()
    }, 500)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._timer !== null) clearInterval(this._timer)
    this._timer = null
  }

  render() {
    const visible = this.items
      .filter((item) =>
        item.status === 'running' ? this._now - item.startedAt >= LONG_RUNNING_MS : (item.durationMs ?? 0) >= LONG_RUNNING_MS,
      )
      .sort(
        (a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.startedAt - a.startedAt,
      )
    return html`
      <div class="list">
        ${visible.length
          ? visible.map((item) => this._renderItem(item))
          : html`<p class="muted hint">No long-running queries. Runs over ${LONG_RUNNING_MS / 1000}s show up here.</p>`}
      </div>
    `
  }

  private _renderItem(item: TaskItem) {
    const running = item.status === 'running'
    const duration = formatDuration(running ? this._now - item.startedAt : (item.durationMs ?? 0))
    const meta = [
      item.contextLabel,
      item.status === 'running' ? `running · ${duration}` : `${STATUS_LABEL[item.status]} · ${duration}`,
      !running && item.rowCount !== null ? `${item.rowCount} row${item.rowCount === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return html`
      <div class="item ${item.status}" title=${item.sql}>
        <div class="row">
          ${running
            ? html`<i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>`
            : ''}
          <span class="sql">${summarize(item.sql)}</span>
          ${running
            ? html`
                <button class="stop" title="Stop this query" @click=${() => this._stop(item)}>
                  <i class="codicon codicon-debug-stop" aria-hidden="true"></i>
                </button>
              `
            : ''}
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

  static styles = [
    typography,
    controls,
    codicons,
    scrollbars,
    css`
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .hint {
        padding: 0 20px;
      }

      .item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 5px 10px 5px 12px;
        border-left: 2px solid var(--accent);
      }

      .item.done {
        border-left-color: var(--status-dot-connected);
      }

      .item.error {
        border-left-color: var(--status-dot-error);
      }

      .item.cancelled {
        border-left-color: var(--status-dot-warning);
      }

      .item:hover {
        background: var(--list-hover);
      }

      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .row .codicon-loading {
        flex-shrink: 0;
        color: var(--accent);
      }

      .sql {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--mono-font);
        font-size: 12px;
        color: var(--text);
      }

      .stop {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        padding: 2px;
        color: var(--status-dot-error);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .stop:hover {
        background: var(--list-hover);
      }

      .meta {
        font-size: var(--font-size-sm);
        color: var(--text-3);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'tasks-view': TasksView
  }
}
