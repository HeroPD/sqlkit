import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { Engine } from '../electron'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import { formatInteger, formatTime, rowWord, t } from '../i18n'

// One run in the query history. Runtime-only, like the reference app: capped
// per workspace, scoped to the database context that ran it.
// Shared with the main process (persistence), so the type lives in electron.d.ts.
import type { HistoryItem } from '../electron'
export type { HistoryItem }

export type HistoryOpenDetail = { sql: string }
export type HistoryExplainDetail = { sql: string; analyze: boolean }

const summarize = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 120)

// The History sidebar view: the active context's runs, newest first. Rows
// dispatch `history-open` with their SQL (the workbench opens it in the
// preview tab). The clear button lives in the workbench's sidebar title row.
@customElement('history-view')
export class HistoryView extends LitElement {
  @property({ attribute: false })
  items: HistoryItem[] = []

  /** Engine of the active context; decides which explain flavors exist. */
  @property()
  engine: Engine | null = null

  @state()
  private _menu: { x: number; y: number; item: HistoryItem } | null = null

  render() {
    return html`
      <div class="list">
        ${this.items.length
          ? this.items.map((item) => this._renderItem(item))
          : html`<p class="muted hint">${t('history.empty')}</p>`}
      </div>
      ${this._renderMenu()}
    `
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const items: MenuItem[] = [
      { id: 'explain', label: t('history.explain') },
      // ANALYZE actually executes the query — Postgres and MySQL 8.0.18+;
      // SQLite's counterpart is the single `explain query plan` mode.
      ...(this.engine === 'postgresql' || this.engine === 'mysql'
        ? [{ id: 'explain-analyze', label: t('history.explainAnalyze') }]
        : []),
      { id: 'copy-sql', label: t('history.copySql') },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onMenuPick(e.detail.id, menu.item)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _onMenuPick(action: string, item: HistoryItem) {
    if (action === 'copy-sql') {
      void navigator.clipboard.writeText(item.sql)
      return
    }
    this.dispatchEvent(
      new CustomEvent<HistoryExplainDetail>('history-explain', {
        detail: { sql: item.sql, analyze: action === 'explain-analyze' },
        bubbles: true,
        composed: true,
      }),
    )
  }

  private _renderItem(item: HistoryItem) {
    const meta = [
      formatTime(item.createdAt),
      item.success ? t('common.ok') : t('common.error'),
      `${Math.max(1, Math.round(item.durationMs))} ms`,
      item.rowCount !== null ? `${formatInteger(item.rowCount)} ${rowWord(item.rowCount)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return html`
      <div
        class="item ${item.success ? 'ok' : 'error'}"
        role="button"
        tabindex="0"
        title=${item.success ? item.sql : `${item.sql}\n\n${item.error}`}
        @click=${() => this._open(item)}
        @dblclick=${() => this._openPermanent(item)}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault()
          this._menu = { x: event.clientX, y: event.clientY, item }
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            this._open(item)
          }
        }}
      >
        <span class="sql">${summarize(item.sql)}</span>
        <span class="meta">${meta}</span>
      </div>
    `
  }

  private _open(item: HistoryItem) {
    this.dispatchEvent(
      new CustomEvent<HistoryOpenDetail>('history-open', {
        detail: { sql: item.sql },
        bubbles: true,
        composed: true,
      }),
    )
  }

  // Double click promotes the preview into a permanent tab (the two single
  // clicks before it recycled the same preview, so this just pins it).
  private _openPermanent(item: HistoryItem) {
    this.dispatchEvent(
      new CustomEvent<HistoryOpenDetail>('history-open-permanent', {
        detail: { sql: item.sql },
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
        border-left: 2px solid var(--status-dot-connected);
        cursor: pointer;
        user-select: none;
      }

      .item.error {
        border-left-color: var(--status-dot-error);
      }

      .item:hover {
        background: var(--list-hover);
      }

      .sql {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--mono-font);
        font-size: 12px;
        color: var(--text);
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
    'history-view': HistoryView
  }
}
