import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { ConnectionProfile, ConnectionStatus } from '../electron'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './db-list-item'

// The Databases sidebar view: connection list with live status, the child
// databases of all-databases connections (display-only — the active child
// is switched via ⌘K, never from here; connecting does adopt the connection
// as the in-use context), and the add button. db-list-item events
// (db-select / db-connect / db-disconnect) bubble through; this view adds
// `add-database` and, via the right-click menu, `db-remove`.
@customElement('databases-view')
export class DatabasesView extends LitElement {
  @property({ attribute: false })
  connections: ConnectionProfile[] = []

  @property({ attribute: false })
  statuses: Record<string, ConnectionStatus> = {}

  /** Highlights the connection whose config tab is active. */
  @property()
  activeTabId: string | null = null

  @state()
  private _menu: { x: number; y: number; id: string } | null = null

  @state()
  private _childMenu: { x: number; y: number; id: string; database: string } | null = null

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
      ${this._renderMenu()} ${this._renderChildMenu()}
    `
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const connected = this.statuses[menu.id]?.phase === 'connected'
    const engine = this.connections.find((connection) => connection.id === menu.id)?.engine
    const items: MenuItem[] = [
      connected ? { id: 'disconnect', label: 'Disconnect' } : { id: 'connect', label: 'Connect' },
      ...(connected && engine !== 'sqlite' ? [{ id: 'create-db', label: 'Create Database…' }] : []),
      { id: 'edit', label: 'Edit Connection' },
      { id: 'remove', label: 'Remove Database…', danger: true },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onMenuPick(e.detail.id, menu.id)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _renderChildMenu() {
    const menu = this._childMenu
    if (!menu) return ''
    const items: MenuItem[] = [{ id: 'drop-db', label: `Drop Database "${menu.database}"…`, danger: true }]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${() =>
          this.dispatchEvent(
            new CustomEvent('db-drop-database', {
              detail: { id: menu.id, database: menu.database },
              bubbles: true,
              composed: true,
            }),
          )}
        @menu-close=${() => (this._childMenu = null)}
      ></context-menu>
    `
  }

  // The in-use child can't be dropped (the connection sits on it), so it
  // gets no menu rather than a doomed action.
  private _onChildMenu(event: MouseEvent, id: string, database: string, inUse: boolean) {
    event.preventDefault()
    if (inUse) return
    this._childMenu = { x: event.clientX, y: event.clientY, id, database }
  }

  private _onItemMenu(event: MouseEvent, id: string) {
    event.preventDefault()
    this._menu = { x: event.clientX, y: event.clientY, id }
  }

  private _onMenuPick(action: string, id: string) {
    const type =
      action === 'connect'
        ? 'db-connect'
        : action === 'disconnect'
          ? 'db-disconnect'
          : action === 'create-db'
            ? 'db-create-database'
            : action === 'edit'
              ? 'db-select'
              : 'db-remove'
    this.dispatchEvent(new CustomEvent(type, { detail: { id }, bubbles: true, composed: true }))
  }

  private _renderItem(connection: ConnectionProfile) {
    const status = this.statuses[connection.id]
    const detail =
      status?.phase === 'error'
        ? status.error
        : status?.phase === 'connected'
          ? `${status.serverVersion}${status.tunneled ? ' · SSH' : ''}`
          : (connection.flavor ?? connection.engine)
    return html`
      <db-list-item
        dbId=${connection.id}
        name=${connection.name}
        detail=${detail ?? connection.engine}
        engine=${connection.engine}
        flavor=${connection.flavor ?? ''}
        status=${status?.phase ?? ''}
        .active=${this.activeTabId === connection.id}
        @contextmenu=${(event: MouseEvent) => this._onItemMenu(event, connection.id)}
      ></db-list-item>
      ${status?.phase === 'connected' ? this._renderChildren(connection.id, status) : ''}
    `
  }

  // Child databases of an all-databases connection — display only; switching
  // the active one happens in the ⌘K palette. A single child carries no
  // information, so it stays hidden.
  private _renderChildren(profileId: string, status: ConnectionStatus) {
    const children = status.children ?? []
    if (children.length < 2) return ''
    return html`
      <div class="child-list">
        ${children.map(
          (child) => html`
            <div
              class="child-row ${child.inUse ? 'in-use' : ''}"
              title=${child.name}
              @contextmenu=${(event: MouseEvent) => this._onChildMenu(event, profileId, child.name, child.inUse)}
            >
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
