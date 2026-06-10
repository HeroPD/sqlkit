import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { codicons, typography } from '../shared-styles'
import type { RecentWorkspace } from '../electron'

// Welcome view: brand, start actions, and the recent-workspace list (passed
// down by <app-root>). The screen is dumb — it dispatches `open-folder` /
// `open-recent` intents and <app-root> decides what opening a workspace does.
@customElement('welcome-screen')
export class WelcomeScreen extends LitElement {
  @property({ attribute: false })
  recents: RecentWorkspace[] = []

  render() {
    return html`
      <div class="inner">
        <div class="brand">
          <i class="codicon codicon-database logo" aria-hidden="true"></i>
          <h1>SqlKit</h1>
          <p class="muted">SQL Database Explorer</p>
        </div>

        <div class="section">
          <h3>Start</h3>
          <button class="link" @click=${this._onOpenFolder}>Open Folder...</button>
        </div>

        ${this.recents.length
          ? html`
              <div class="section">
                <h3>Recent</h3>
                ${this.recents.map(
                  (workspace) => html`
                    <button class="link recent" title=${workspace.path} @click=${() => this._onOpenRecent(workspace)}>
                      <span class="name">${workspace.name}</span>
                      <span class="path">${workspace.path}</span>
                    </button>
                  `,
                )}
              </div>
            `
          : ''}
      </div>
    `
  }

  private _onOpenFolder() {
    this.dispatchEvent(new CustomEvent('open-folder', { bubbles: true, composed: true }))
  }

  private _onOpenRecent(workspace: RecentWorkspace) {
    this.dispatchEvent(
      new CustomEvent('open-recent', { detail: { path: workspace.path }, bubbles: true, composed: true }),
    )
  }

  static styles = [
    typography,
    codicons,
    css`
      :host {
        align-items: center;
        justify-content: center;
      }

      .inner {
        width: 380px;
        display: flex;
        flex-direction: column;
        gap: 28px;
      }

      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        text-align: center;
      }

      .codicon.logo {
        font-size: 56px;
        color: var(--accent);
        margin-bottom: 4px;
      }

      .section h3 {
        margin-bottom: 8px;
      }

      .link {
        display: block;
        width: 100%;
        padding: 6px 10px;
        font-family: inherit;
        font-size: var(--font-size);
        color: var(--accent);
        background: transparent;
        border: none;
        border-radius: 3px;
        text-align: left;
        cursor: pointer;
      }

      .link:hover {
        background: var(--list-hover);
      }

      .link:focus-visible {
        outline: 1px solid var(--focus-border);
      }

      .recent {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }

      .recent .name {
        flex: none;
      }

      .recent .path {
        color: var(--text-3);
        font-size: var(--font-size-sm);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'welcome-screen': WelcomeScreen
  }
}
