import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, controls, scrollbars, typography } from '../shared-styles'
import type { ConnectionProfile, ConnectionStatus } from '../electron'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './db-list-item'
import { t } from '../i18n'

// The Databases sidebar view: connection list with live status, the child
// databases of all-databases connections, and the add button. Exactly one child
// carries the "active" tag — the workbench's single active context — and any
// other child can be clicked (or picked from its menu) to switch to it. Events
// (db-select / db-connect / db-disconnect / db-use-child / db-drop-database /
// db-remove / add-database) bubble through to the workbench.
@customElement('databases-view')
export class DatabasesView extends LitElement {
  @property({ attribute: false })
  connections: ConnectionProfile[] = []

  @property({ attribute: false })
  statuses: Record<string, ConnectionStatus> = {}

  /** Highlights the connection whose config tab is active. */
  @property()
  activeTabId: string | null = null

  /** The workbench's single active context — the one child that shows "active". */
  @property()
  activeProfileId: string | null = null

  @property()
  activeChildDb: string | null = null

  @state()
  private _menu: { x: number; y: number; id: string } | null = null

  @state()
  private _childMenu: { x: number; y: number; id: string; database: string; canDrop: boolean } | null = null

  render() {
    return html`
      <div class="db-list">
        ${this.connections.length
          ? this.connections.map((connection) => this._renderItem(connection))
          : html`<p class="muted hint">${t('view.databases.empty')}</p>`}
      </div>
      <button class="link add" @click=${this._onAdd}>
        <i class="icon icon-plus" aria-hidden="true"></i>
        <span>${t('action.addDatabase')}</span>
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
      connected ? { id: 'disconnect', label: t('database.disconnect') } : { id: 'connect', label: t('database.connect') },
      ...(connected && engine !== 'sqlite' ? [{ id: 'create-db', label: t('database.create') }] : []),
      { id: 'edit', label: t('database.edit') },
      { id: 'remove', label: t('database.remove'), danger: true, separatorBefore: true },
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
    // Switch to any non-active child; drop only one the driver isn't sitting on.
    const items: MenuItem[] = [{ id: 'use-db', label: t('database.use') }]
    if (menu.canDrop) items.push({ id: 'drop-db', label: t('database.drop', { name: menu.database }), danger: true, separatorBefore: true })
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onChildMenuPick(e.detail.id, menu)}
        @menu-close=${() => (this._childMenu = null)}
      ></context-menu>
    `
  }

  private _onChildMenuPick(action: string, menu: { id: string; database: string }) {
    const type = action === 'use-db' ? 'db-use-child' : 'db-drop-database'
    this.dispatchEvent(
      new CustomEvent(type, { detail: { id: menu.id, database: menu.database }, bubbles: true, composed: true }),
    )
  }

  // The active child already is the context (nothing to switch to or drop), so
  // it gets no menu. `inUse` (driver) gates dropping — you can't drop the DB the
  // connection sits on, even when it isn't the active context.
  private _onChildMenu(event: MouseEvent, id: string, database: string, active: boolean, inUse: boolean) {
    event.preventDefault()
    if (active) return
    this._childMenu = { x: event.clientX, y: event.clientY, id, database, canDrop: !inUse }
  }

  // Left-click a non-active child to make it the connection's active database.
  private _onChildClick(id: string, database: string, active: boolean) {
    if (active) return
    this.dispatchEvent(new CustomEvent('db-use-child', { detail: { id, database }, bubbles: true, composed: true }))
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

  // Child databases of an all-databases connection. Click a non-active child (or
  // use its menu) to make it the connection's active database. A single child
  // carries no information, so the list stays hidden.
  private _renderChildren(profileId: string, status: ConnectionStatus) {
    const children = status.children ?? []
    if (children.length < 2) return ''
    return html`
      <div class="child-list">
        ${children.map((child) => {
          // "active" is the single workbench context; driver in-use only gates drop.
          const active = profileId === this.activeProfileId && child.name === this.activeChildDb
          return html`
            <div
              class="child-row ${active ? 'active' : 'switchable'}"
              title=${active ? child.name : t('database.use')}
              @click=${() => this._onChildClick(profileId, child.name, active)}
              @contextmenu=${(event: MouseEvent) => this._onChildMenu(event, profileId, child.name, active, child.inUse)}
            >
              <i class="icon icon-package" aria-hidden="true"></i>
              <span class="child-name">${child.name}</span>
              ${active ? html`<span class="child-tag">${t('database.active')}</span>` : ''}
            </div>
          `
        })}
      </div>
    `
  }

  private _onAdd() {
    this.dispatchEvent(new CustomEvent('add-database', { bubbles: true, composed: true }))
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
        font-size: var(--font-size);
        color: var(--text-2);
        white-space: nowrap;
        user-select: none;
      }

      .child-row.active {
        color: var(--text);
      }

      .child-row.switchable {
        cursor: pointer;
      }

      .child-row.switchable:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      .child-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .child-row .icon {
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

      .add .icon {
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
