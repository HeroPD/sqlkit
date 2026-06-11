import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'

// In-app confirmation modal (native dialogs would clash with the app's
// look). Render it conditionally; it dispatches `dialog-confirm` /
// `dialog-cancel` and closes itself on Escape or backdrop click.
@customElement('confirm-dialog')
export class ConfirmDialog extends LitElement {
  @property()
  message = ''

  @property()
  detail = ''

  @property()
  confirmLabel = 'Confirm'

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  render() {
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="alertdialog" aria-label=${this.message}>
          <h4>${this.message}</h4>
          <p class="muted small">${this.detail}</p>
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>Cancel</button>
            <button class="primary danger" @click=${this._confirm}>${this.confirmLabel}</button>
          </div>
        </div>
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    this._cancel()
  }

  private _onBackdropDown(event: MouseEvent) {
    if (event.target === event.currentTarget) this._cancel()
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('dialog-cancel', { bubbles: true, composed: true }))
  }

  private _confirm() {
    this.dispatchEvent(new CustomEvent('dialog-confirm', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .panel {
        width: min(380px, calc(100vw - 80px));
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--sidebar-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      button.danger {
        background: color-mix(in srgb, var(--status-dot-error) 75%, #000);
      }

      button.danger:hover {
        background: var(--status-dot-error);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'confirm-dialog': ConfirmDialog
  }
}
