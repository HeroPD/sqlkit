import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'

export type PromptConfirmDetail = { value: string }

// confirm-dialog's sibling for actions that need a name: one text input,
// Enter or the primary button submits. Render it conditionally; it
// dispatches `dialog-confirm` with the value / `dialog-cancel`.
@customElement('prompt-dialog')
export class PromptDialog extends LitElement {
  @property()
  message = ''

  @property()
  detail = ''

  @property()
  confirmLabel = 'OK'

  @property()
  placeholder = ''

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  protected firstUpdated() {
    this.shadowRoot?.querySelector('input')?.focus()
  }

  render() {
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${this.message}>
          <h4>${this.message}</h4>
          <p class="muted small">${this.detail}</p>
          <input
            type="text"
            placeholder=${this.placeholder}
            spellcheck="false"
            autocomplete="off"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                this._confirm()
              }
            }}
          />
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>Cancel</button>
            <button class="primary" @click=${this._confirm}>${this.confirmLabel}</button>
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
    const value = this.shadowRoot?.querySelector('input')?.value.trim() ?? ''
    if (!value) return
    this.dispatchEvent(
      new CustomEvent<PromptConfirmDetail>('dialog-confirm', { detail: { value }, bubbles: true, composed: true }),
    )
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

      input {
        margin-top: 6px;
        padding: 5px 8px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        outline: none;
      }

      input:focus {
        border-color: var(--input-focus-border);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dialog': PromptDialog
  }
}
