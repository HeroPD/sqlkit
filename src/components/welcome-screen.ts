import { LitElement, css, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { typography } from '../shared-styles'

// Welcome view: brand + start actions. The screen is dumb — it dispatches an
// `open-folder` intent and <app-root> decides what opening a workspace does.
@customElement('welcome-screen')
export class WelcomeScreen extends LitElement {
  render() {
    return html`
      <div class="inner">
        <div class="brand">
          <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
            <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
          </svg>
          <h1>SqlKit</h1>
          <p class="muted">SQL Database Explorer</p>
        </div>

        <div class="section">
          <h3>Start</h3>
          <button class="link" @click=${this._onOpenFolder}>Open Folder...</button>
        </div>
      </div>
    `
  }

  private _onOpenFolder() {
    this.dispatchEvent(new CustomEvent('open-folder', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
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

      .logo {
        width: 56px;
        height: 56px;
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
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'welcome-screen': WelcomeScreen
  }
}
