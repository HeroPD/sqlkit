import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { ConnectionProfile, ConnectionStatus } from '../electron'
import './db-list-item'

// The Databases sidebar view: connection list with live status, the child
// databases of all-databases connections (display-only — the active context
// is switched via ⌘K, never from here), and the add button. db-list-item
// events (db-select / db-connect / db-disconnect) bubble through; this view
// adds `add-database`.
@customElement('databases-view')
export class DatabasesView extends LitElement {
  @property({ attribute: false })
  connections: ConnectionProfile[] = []

  @property({ attribute: false })
  statuses: Record<string, ConnectionStatus> = {}

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
      ${status?.phase === 'connected' ? this._renderChildren(connection.id, status) : ''}
    `
  }

  // Child databases of an all-databases connection — display only; switching
  // the active one happens in the ⌘K palette. A single child carries no
  // information, so it stays hidden.
  private _renderChildren(_profileId: string, status: ConnectionStatus) {
    const children = status.children ?? []
    if (children.length < 2) return ''
    return html`
      <div class="child-list">
        ${children.map(
          (child) => html`
            <div class="child-row ${child.inUse ? 'in-use' : ''}" title=${child.name}>
              <i class="codicon codicon-symbol-namespace" aria-hidden="true"></i>
              <span class="child-name">${child.name}</span>
              ${child.inUse ? html`<span class="child-tag">active</span>` : ''}
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

      .child-list {
        display: flex;
        flex-direction: column;
        padding: 2px 0 6px;
      }

      .child-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 36px;
        font-size: var(--font-size-sm);
        color: var(--text-2);
        white-space: nowrap;
        user-select: none;
      }

      .child-row.in-use {
        color: var(--text);
      }

      .child-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .child-row .codicon {
        font-size: 13px;
        flex-shrink: 0;
      }

      .child-tag {
        margin-left: auto;
        flex-shrink: 0;
        padding: 0 5px;
        border-radius: 3px;
        background: var(--accent);
        color: var(--on-accent);
        font-size: 10px;
        line-height: 14px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
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
