import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { typography } from '../shared-styles'

// Blank workbench shell: an empty editor area over the status bar. The real
// regions (activity bar, sidebar, editor, panel) land here later. Dispatches a
// `close-workspace` intent; <app-root> owns the screen switch.
@customElement('workbench-screen')
export class WorkbenchScreen extends LitElement {
  @property({ attribute: false })
  workspace: { name: string; path: string } | null = null

  render() {
    return html`
      <div class="body">
        <div class="empty">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
            <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
          </svg>
          <h2>${this.workspace?.name ?? 'Workbench'}</h2>
          <p class="muted">${this.workspace?.path ?? 'No workspace open.'}</p>
          <button class="secondary" @click=${this._onCloseWorkspace}>Close Workspace</button>
        </div>
      </div>

      <footer class="status-bar">
        <span>${this.workspace?.name ?? 'SqlKit'}</span>
        <span class="spacer"></span>
        <span>Not connected</span>
      </footer>
    `
  }

  private _onCloseWorkspace() {
    this.dispatchEvent(new CustomEvent('close-workspace', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    css`
      :host {
        flex-direction: column;
        min-height: 0;
      }

      .body {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--editor-bg);
        min-height: 0;
      }

      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        text-align: center;
      }

      .empty p {
        margin-bottom: 12px;
      }

      .icon {
        width: 40px;
        height: 40px;
        color: var(--text-3);
        margin-bottom: 4px;
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
