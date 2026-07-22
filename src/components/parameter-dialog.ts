import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import type { QueryParameter } from '../query-parameters'
import { controls, typography } from '../shared-styles'
import { t } from '../i18n'

export type ParametersConfirmDetail = { values: string[] }

@customElement('parameter-dialog')
export class ParameterDialog extends LitElement {
  @property({ attribute: false })
  parameters: QueryParameter[] = []

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onWindowKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onWindowKeydown)
  }

  protected firstUpdated() {
    this.renderRoot.querySelector('input')?.focus()
  }

  render() {
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <form class="panel" @submit=${this._confirm}>
          <h4>${t('parameters.title')}</h4>
          <p class="muted small">${t('parameters.help')}</p>
          <div class="fields">
            ${this.parameters.map((parameter) => html`
              <label><span>${parameter.label}</span><input type="text" autocomplete="off" spellcheck="false" /></label>
            `)}
          </div>
          <div class="actions">
            <button type="button" class="secondary" @click=${this._cancel}>${t('common.cancel')}</button>
            <button type="submit" class="primary">${t('common.run')}</button>
          </div>
        </form>
      </div>
    `
  }

  private _onWindowKeydown = (event: KeyboardEvent) => {
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

  private _confirm(event: SubmitEvent) {
    event.preventDefault()
    const values = [...this.renderRoot.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value)
    this.dispatchEvent(new CustomEvent<ParametersConfirmDetail>('parameters-confirm', {
      detail: { values }, bubbles: true, composed: true,
    }))
  }

  static styles = [typography, controls, css`
    :host { display: contents; }
    .backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; }
    .panel { width: min(440px, calc(100vw - 80px)); max-height: calc(100vh - 80px); overflow: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; background: var(--sidebar-bg); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45); }
    code { color: var(--text); }
    .fields { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    label { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 10px; }
    label span { color: var(--text-2); font-family: var(--mono-font); }
    input { padding: 5px 8px; font: inherit; color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px; outline: none; }
    input:focus { border-color: var(--input-focus-border); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  `]
}

declare global { interface HTMLElementTagNameMap { 'parameter-dialog': ParameterDialog } }
