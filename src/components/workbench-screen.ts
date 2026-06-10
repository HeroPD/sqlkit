import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, typography } from '../shared-styles'
import './activity-button'

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

  render() {
    const activeView = VIEWS.find((view) => view.id === this._activeView)
    return html`
      <div class="body">
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
              <aside class="sidebar">
                <div class="sidebar-title">${activeView.title}</div>
                <p class="muted hint">${activeView.hint}</p>
              </aside>
            `
          : ''}

        <div class="editor-area">
          <div class="empty">
            <i class="codicon codicon-database" aria-hidden="true"></i>
            <h2>${this.workspace?.name ?? 'Workbench'}</h2>
            <p class="muted">${this.workspace?.path ?? 'No workspace open.'}</p>
            <button class="secondary" @click=${this._onCloseWorkspace}>Close Workspace</button>
          </div>
        </div>
      </div>

      <footer class="status-bar">
        <span>${this.workspace?.name ?? 'SqlKit'}</span>
        <span class="spacer"></span>
        <span>Not connected</span>
      </footer>
    `
  }

  private _onActivitySelect(event: Event) {
    const { view } = (event as CustomEvent<{ view: ViewId }>).detail
    this._activeView = this._activeView === view ? null : view
  }

  private _onCloseWorkspace() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
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
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex-shrink: 0;
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

      .editor-area {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--editor-bg);
        min-width: 0;
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

      .secondary {
        height: var(--control-h);
        padding: 0 14px;
        font-family: inherit;
        font-size: var(--font-size);
        color: var(--btn-secondary-fg);
        background: var(--btn-secondary-bg);
        border: none;
        border-radius: 3px;
        cursor: pointer;
      }

      .secondary:hover {
        background: var(--btn-secondary-hover);
      }

      .secondary:focus-visible {
        outline: 1px solid var(--focus-border);
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
