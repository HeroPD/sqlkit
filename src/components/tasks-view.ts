import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, controls, scrollbars, typography } from '../shared-styles'
import { formatInteger, rowWord, t } from '../i18n'

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
  if (ms < 10_000) return t('tasks.durationShort', { seconds: (ms / 1000).toFixed(1) })
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? t('tasks.durationShort', { seconds })
    : t('tasks.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

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
          : html`<p class="muted hint">${t('tasks.empty', { seconds: LONG_RUNNING_MS / 1000 })}</p>`}
      </div>
    `
  }

  private _renderItem(item: TaskItem) {
    const running = item.status === 'running'
    const duration = formatDuration(running ? this._now - item.startedAt : (item.durationMs ?? 0))
    const meta = [
      item.contextLabel,
      item.status === 'running'
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
          ${running
            ? html`<i class="icon icon-loader-circle icon-modifier-spin" aria-hidden="true"></i>`
            : ''}
          <span class="sql">${summarize(item.sql)}</span>
          ${running
            ? html`
                <button class="stop" title=${t('tasks.stopQuery')} @click=${() => this._stop(item)}>
                  <i class="icon icon-square" aria-hidden="true"></i>
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

      .row .icon-loader-circle {
        flex-shrink: 0;
        color: var(--accent);
      }

      .sql {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--mono-font);
        font-size: var(--font-size);
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
