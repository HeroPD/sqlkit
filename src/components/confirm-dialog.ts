import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { controls, overlay, typography } from '../shared-styles'
import { t } from '../i18n'

function deepActiveElement(): HTMLElement | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active instanceof HTMLElement ? active : null
}

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
  confirmLabel = t('common.confirm')

  @property({ attribute: false })
  cancelLabel: string | null = t('common.cancel')

  @property({ type: Boolean })
  danger = false

  private _returnFocus: HTMLElement | null = null
  private _armed = false
  private _armTimer: ReturnType<typeof setTimeout> | null = null

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
    // A confirm can mount from an Enter-driven action. Do not let that opening
    // keystroke continue to window and accept a decision the user has not read.
    this._armTimer = setTimeout(() => {
      this._armed = true
    }, 0)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
    if (this._armTimer !== null) clearTimeout(this._armTimer)
    this._armTimer = null
    this._armed = false
    this._returnFocus?.focus()
    this._returnFocus = null
  }

  protected firstUpdated() {
    this._returnFocus = deepActiveElement()
    this.shadowRoot?.querySelector<HTMLElement>('.panel')?.focus()
  }

  render() {
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div
          class="panel ${this.danger ? 'danger-confirm' : 'normal-confirm'}"
          role=${this.danger ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-detail"
          tabindex="-1"
        >
          <header class="dialog-head">
            <h4 id="confirm-title">${this.message}</h4>
            <p id="confirm-detail">${this.detail}</p>
          </header>
          <div class="footer">
            <div class="actions">
              ${this.cancelLabel
                ? html`
                    <button class="secondary" @click=${this._cancel}>
                      ${this.cancelLabel}<kbd aria-hidden="true">esc</kbd>
                    </button>
                  `
                : ''}
              <button class="primary ${this.danger ? 'danger' : ''}" @click=${this._confirm}>
                ${this.confirmLabel}<kbd aria-hidden="true">↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._cancel()
      return
    }
    if (
      event.key === 'Enter' &&
      this._armed &&
      !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) &&
      !(this.shadowRoot?.activeElement instanceof HTMLButtonElement)
    ) {
      event.preventDefault()
      this._confirm()
    }
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
    overlay,
    css`
      :host {
        display: contents;
      }

      .panel:focus {
        outline: none;
      }

      .panel {
        position: relative;
        width: min(500px, calc(100vw - 80px));
        padding: 0;
        gap: 0;
        overflow: hidden;
      }

      .panel::before {
        position: absolute;
        inset: 0 0 auto;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        content: '';
      }

      .panel.danger-confirm::before {
        background: linear-gradient(90deg, transparent, var(--status-dot-error), transparent);
      }

      .dialog-head {
        padding: 20px 22px 19px;
      }

      .dialog-head h4 {
        margin-bottom: 5px;
        font-size: 16px;
        font-weight: 600;
      }

      .dialog-head p {
        line-height: 1.5;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 12px 22px;
        background: color-mix(in srgb, var(--bg) 18%, transparent);
        border-top: 1px solid var(--border-subtle);
      }

      .actions {
        display: flex;
        flex: none;
        gap: 8px;
      }

      .actions button {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
      }

      .actions kbd {
        color: var(--text-2);
        font: var(--font-size) var(--mono-font);
      }

      button.primary kbd {
        color: color-mix(in srgb, var(--on-accent) 72%, transparent);
      }

      /* Extra .primary keeps these above the shared primary:hover rule in specificity. */
      button.primary.danger {
        background: color-mix(in srgb, var(--status-dot-error) 78%, #000);
      }

      button.primary.danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--status-dot-error) 92%, #000);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'confirm-dialog': ConfirmDialog
  }
}
