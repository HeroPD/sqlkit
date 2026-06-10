import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, typography } from '../shared-styles'
import type { ConnectionProfile } from '../electron'
import './activity-button'
import './db-list-item'
import './db-config-form'

const VIEWS = [
  { id: 'explorer', title: 'Explorer', icon: 'codicon-files', hint: 'No files yet.' },
  { id: 'search', title: 'Search', icon: 'codicon-search', hint: 'Search across your SQL files.' },
  { id: 'databases', title: 'Databases', icon: 'codicon-database', hint: 'No database connections yet.' },
  { id: 'history', title: 'History', icon: 'codicon-history', hint: 'No query history yet.' },
  { id: 'tasks', title: 'Tasks', icon: 'codicon-checklist', hint: 'No running jobs.' },
] as const

type ViewId = (typeof VIEWS)[number]['id']

// Workbench shell: activity bar + switchable sidebar + editor area over the
// status bar. Clicking an activity button shows its view; clicking the active
// one hides the sidebar (reference behavior). Dispatches a `close-workspace`
// intent; <app-root> owns the screen switch.
@customElement('workbench-screen')
export class WorkbenchScreen extends LitElement {
  @property({ attribute: false })
  workspace: { name: string; path: string } | null = null

  @state()
  private _activeView: ViewId | null = 'explorer'

  @state()
  private _connections: ConnectionProfile[] = []

  @state()
  private _editingProfile: ConnectionProfile | null = null

  @state()
  private _sidebarWidth = 280

  @state()
  private _resizing: { startX: number; startWidth: number } | null = null

  // True while a drag is below the collapse threshold: the sidebar hides live
  // but the handle stays mounted so the drag (pointer capture) survives, and
  // dragging back out restores it. Committed on release.
  @state()
  private _sidebarCollapsing = false

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('workspace')) {
      this._editingProfile = null
      this._connections = []
      if (this.workspace) void this._loadConfig()
    }
  }

  private async _loadConfig() {
    const config = await window.sqlkit.getWorkspaceConfig()
    this._connections = config.connections
  }

  render() {
    const activeView = VIEWS.find((view) => view.id === this._activeView)
    return html`
      <div class="body" @db-select=${this._onDbSelect} @config-save=${this._onConfigSave} @config-cancel=${this._onConfigCancel}>
        <nav class="activity-bar" @activity-select=${this._onActivitySelect}>
          ${VIEWS.map(
            (view) => html`
              <activity-button view=${view.id} title=${view.title} .active=${view.id === this._activeView}>
                <i class="codicon ${view.icon}" aria-hidden="true"></i>
              </activity-button>
            `,
          )}
        </nav>

        ${activeView
          ? html`
              <aside class="sidebar ${this._sidebarCollapsing ? 'collapsed' : ''}" style="width: ${this._sidebarWidth}px">
                <div class="sidebar-title">${activeView.title}</div>
                ${activeView.id === 'databases' ? this._renderDatabasesView() : html`<p class="muted hint">${activeView.hint}</p>`}
              </aside>
              <div
                class="sidebar-resize ${this._resizing ? 'active' : ''}"
                role="separator"
                aria-label="Resize sidebar"
                title="Resize sidebar"
                @pointerdown=${this._onResizeStart}
                @pointermove=${this._onResizeMove}
                @pointerup=${this._onResizeEnd}
                @pointercancel=${this._onResizeEnd}
                @dblclick=${this._onResizeReset}
              ></div>
            `
          : ''}

        <div class="editor-area ${this._editingProfile ? 'form' : ''}">
          ${this._editingProfile
            ? html`<db-config-form .profile=${this._editingProfile}></db-config-form>`
            : html`
                <div class="empty">
                  <i class="codicon codicon-database" aria-hidden="true"></i>
                  <h2>${this.workspace?.name ?? 'Workbench'}</h2>
                  <p class="muted">${this.workspace?.path ?? 'No workspace open.'}</p>
                  <button class="secondary" @click=${this._onCloseWorkspace}>Close Workspace</button>
                </div>
              `}
        </div>
      </div>

      <footer class="status-bar">
        <span>${this.workspace?.name ?? 'SqlKit'}</span>
        <span class="spacer"></span>
        <span>Not connected</span>
      </footer>
    `
  }

  private _renderDatabasesView() {
    return html`
      <div class="db-list">
        ${this._connections.length
          ? this._connections.map(
              (connection) => html`
                <db-list-item
                  dbId=${connection.id}
                  name=${connection.name}
                  detail=${connection.engine}
                  .active=${this._editingProfile?.id === connection.id}
                ></db-list-item>
              `,
            )
          : html`<p class="muted hint">No database connections yet.</p>`}
      </div>
      <button class="link sidebar-action" @click=${this._onAddDatabase}>
        <i class="codicon codicon-add" aria-hidden="true"></i>
        <span>Add Database</span>
      </button>
    `
  }

  private _onActivitySelect(event: Event) {
    const { view } = (event as CustomEvent<{ view: ViewId }>).detail
    this._activeView = this._activeView === view ? null : view
  }

  private _onResizeStart(event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._resizing = { startX: event.clientX, startWidth: this._sidebarWidth }
    event.preventDefault()
  }

  private _onResizeMove(event: PointerEvent) {
    if (!this._resizing) return
    const raw = this._resizing.startWidth + (event.clientX - this._resizing.startX)

    // Dragged under the minimum with a little intent margin: snap closed.
    // Dragging back out reopens at the minimum.
    if (raw < 110) {
      this._sidebarCollapsing = true
      return
    }

    this._sidebarCollapsing = false
    this._sidebarWidth = Math.max(170, Math.min(500, raw))
  }

  private _onResizeEnd(event: PointerEvent) {
    if (!this._resizing) return
    this._resizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)

    if (this._sidebarCollapsing) {
      this._sidebarCollapsing = false
      this._activeView = null
      this._sidebarWidth = 280
    }
  }

  private _onResizeReset() {
    this._sidebarWidth = 280
  }

  private _onAddDatabase() {
    this._editingProfile = {
      id: crypto.randomUUID(),
      name: '',
      engine: 'postgresql',
      host: 'localhost',
      port: '5432',
      username: '',
      password: '',
      database: '',
    }
  }

  private _onDbSelect(event: Event) {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const connection = this._connections.find((profile) => profile.id === id)
    if (connection) this._editingProfile = { ...connection }
  }

  private async _onConfigSave(event: Event) {
    const { profile } = (event as CustomEvent<{ profile: ConnectionProfile }>).detail
    const existing = this._connections.findIndex((connection) => connection.id === profile.id)
    const connections =
      existing >= 0
        ? this._connections.map((connection) => (connection.id === profile.id ? profile : connection))
        : [...this._connections, profile]

    const result = await window.sqlkit.saveWorkspaceConfig({ version: 1, connections })
    if (!result.success) {
      console.error('Failed to save workspace config:', result.error)
      return
    }

    this._connections = connections
    this._editingProfile = null
    this._activeView = 'databases'
  }

  private _onConfigCancel() {
    this._editingProfile = null
  }

  private _onCloseWorkspace() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    codicons,
    css`
      :host {
        flex-direction: column;
        min-height: 0;
      }

      .body {
        flex: 1;
        display: flex;
        min-height: 0;
      }

      .activity-bar {
        width: var(--activity-bar-w);
        background: var(--activity-bar-bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-top: 4px;
        flex-shrink: 0;
        border-right: 1px solid var(--border);
      }

      .activity-bar .codicon {
        font-size: 24px;
      }

      .sidebar {
        width: var(--sidebar-w);
        min-width: 170px;
        background: var(--sidebar-bg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex-shrink: 0;
      }

      .sidebar.collapsed {
        display: none;
      }

      .sidebar-resize {
        width: 1px;
        flex-shrink: 0;
        cursor: col-resize;
        background: var(--border);
        position: relative;
        z-index: 20;
        touch-action: none;
      }

      /* Wider invisible hit area than the 1px visible line. */
      .sidebar-resize::after {
        content: '';
        position: absolute;
        inset: 0 -2px;
      }

      .sidebar-resize:hover,
      .sidebar-resize.active {
        background: var(--resize-hover);
      }

      .body:has(.sidebar-resize.active) {
        cursor: col-resize;
        user-select: none;
      }

      .sidebar-title {
        height: 35px;
        display: flex;
        align-items: center;
        padding: 0 20px;
        font-size: var(--font-size-sm);
        color: var(--text);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        user-select: none;
        flex-shrink: 0;
      }

      .sidebar .hint {
        padding: 0 20px;
      }

      .db-list {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        min-height: 0;
      }

      .sidebar-action {
        width: auto;
        margin: 4px 10px;
      }

      .sidebar-action .codicon {
        font-size: 14px;
      }

      .editor-area {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--editor-bg);
        min-width: 0;
      }

      .editor-area.form {
        display: block;
        overflow-y: auto;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        text-align: center;
      }

      .empty .codicon {
        font-size: 40px;
        color: var(--text-3);
        margin-bottom: 4px;
      }

      .empty p {
        margin-bottom: 12px;
      }

      .status-bar {
        height: var(--status-bar-h);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        font-size: var(--font-size-sm);
        color: var(--status-bar-fg);
        background: var(--status-bar-disconnected);
      }

      .spacer {
        flex: 1;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'workbench-screen': WorkbenchScreen
  }
}
