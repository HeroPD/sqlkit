import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { ConnectionProfile, ConnectionStatus, TableRef } from '../electron'
import './db-list-item'

// The Databases sidebar view: connection list with live status, the table
// list under each connected database, and the add button. db-list-item events
// (db-select / db-connect / db-disconnect) bubble through; this view adds
// `add-database`.
@customElement('databases-view')
export class DatabasesView extends LitElement {
  @property({ attribute: false })
  connections: ConnectionProfile[] = []

  @property({ attribute: false })
  statuses: Record<string, ConnectionStatus> = {}

  @property({ attribute: false })
  tables: Record<string, TableRef[]> = {}

  /** Highlights the connection whose config tab is active. */
  @property()
  activeTabId: string | null = null

  render() {
    return html`
      <div class="db-list">
        ${this.connections.length
          ? this.connections.map((connection) => this._renderItem(connection))
          : html`<p class="muted hint">No database connections yet.</p>`}
      </div>
      <button class="link add" @click=${this._onAdd}>
        <i class="codicon codicon-add" aria-hidden="true"></i>
        <span>Add Database</span>
      </button>
    `
  }

  private _renderItem(connection: ConnectionProfile) {
    const status = this.statuses[connection.id]
    const detail =
      status?.phase === 'error'
        ? status.error
        : status?.phase === 'connected'
          ? `${status.serverVersion}${status.tunneled ? ' · SSH' : ''}`
          : connection.engine
    return html`
      <db-list-item
        dbId=${connection.id}
        name=${connection.name}
        detail=${detail ?? connection.engine}
        status=${status?.phase ?? ''}
        .active=${this.activeTabId === connection.id}
      ></db-list-item>
      ${status?.phase === 'connected' ? this._renderTables(connection.id) : ''}
    `
  }

  private _renderTables(profileId: string) {
    const tables = this.tables[profileId]
    if (!tables) return ''
    if (!tables.length) return html`<p class="muted hint table-hint">No tables.</p>`
    return html`
      <div class="table-list">
        ${tables.map(
          (table) => html`
            <div class="table-row" title=${table.schema ? `${table.schema}.${table.name}` : table.name}>
              <i class="codicon codicon-table" aria-hidden="true"></i>
              <span>${table.schema ? `${table.schema}.${table.name}` : table.name}</span>
            </div>
          `,
        )}
      </div>
    `
  }

  private _onAdd() {
    this.dispatchEvent(new CustomEvent('add-database', { bubbles: true, composed: true }))
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

      .hint {
        padding: 0 20px;
      }

      .db-list {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .table-list {
        display: flex;
        flex-direction: column;
        padding: 2px 0 6px;
      }

      .table-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 36px;
        font-size: var(--font-size-sm);
        color: var(--text-2);
        white-space: nowrap;
      }

      .table-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .table-row .codicon {
        font-size: 13px;
        flex-shrink: 0;
      }

      .table-hint {
        padding: 2px 10px 6px 36px;
        font-size: var(--font-size-sm);
      }

      .add {
        width: auto;
        margin: 4px 10px;
        flex-shrink: 0;
      }

      .add .codicon {
        font-size: 14px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'databases-view': DatabasesView
  }
}
