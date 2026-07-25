import { LitElement, type PropertyValues, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, icons, overlay, scrollbars, sqlHighlight, typography } from '../shared-styles'
import { t } from '../i18n'
import { formatPreviewParam, previewSql, sqlPreviewParts } from '../sql-preview'

// Re-exported so existing importers keep their path.
export { formatPreviewParam, previewSql, sqlPreviewParts }

// Shows a generated write statement (UPDATE today; INSERT/DELETE later) and its
// bound params for the user to read before it runs. Dispatches `dialog-confirm`
// / `dialog-cancel`; closes itself on Escape or backdrop click. Enter runs the
// statement, unless the Cancel button holds focus (then Enter cancels).
@customElement('review-query-dialog')
export class ReviewQueryDialog extends LitElement {
  @property()
  sql = ''

  @property({ attribute: false })
  params: unknown[] = []

  @property()
  confirmLabel = t('common.run')

  @property()
  warning = ''

  // Runs the reviewed statement, resolving to an error message (shown inline) or
  // null on success. The dialog owns the applying/error UI so failures stay in
  // context instead of popping a separate notice.
  @property({ attribute: false })
  run: (() => Promise<string | null>) | null = null

  @state() private _applying = false
  @state() private _error = ''

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  // A new statement (queued review) resets the transient applying/error state.
  protected willUpdate(changed: PropertyValues) {
    if (changed.has('sql')) {
      this._applying = false
      this._error = ''
    }
  }

  render() {
    const preview = previewSql(this.sql, this.params)
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${t('review.title')}>
          <h4>${t('review.title')}</h4>
          ${this.warning ? html`<p class="warning" role="alert">${this.warning}</p>` : ''}
          <pre class="sql"><code>${sqlPreviewParts(preview).map((part) =>
            part.kind ? html`<span class=${part.kind}>${part.text}</span>` : part.text,
          )}</code></pre>
          ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : ''}
          <div class="actions">
            <button class="secondary" ?disabled=${this._applying} @click=${this._cancel}>${t('common.cancel')}</button>
            <button class="primary" ?disabled=${this._applying} @click=${this._confirm}>
              ${this._applying
                ? html`<i class="icon icon-loader-circle icon-modifier-spin" aria-hidden="true"></i> ${t('common.applying')}`
                : this.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (this._applying) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this._cancel()
      return
    }
    // Enter runs the statement. A focused button handles its own Enter (so Enter
    // on Cancel still cancels); otherwise we confirm.
    if (event.key === 'Enter' && !(this.shadowRoot?.activeElement instanceof HTMLButtonElement)) {
      event.preventDefault()
      void this._confirm()
    }
  }

  private _onBackdropDown(event: MouseEvent) {
    if (this._applying) return
    if (event.target === event.currentTarget) this._cancel()
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('dialog-cancel', { bubbles: true, composed: true }))
  }

  private async _confirm() {
    if (this._applying || !this.run) return
    this._applying = true
    this._error = ''
    try {
      const error = await this.run()
      if (error !== null) {
        this._error = error
        this._applying = false
        return
      }
      this.dispatchEvent(new CustomEvent('dialog-done', { bubbles: true, composed: true }))
    } catch (error) {
      // A run should resolve to an error string, not throw; recover anyway so a
      // rejecting producer can't leave the dialog stuck with every exit disabled.
      this._error = (error as Error).message
      this._applying = false
    }
  }

  static styles = [
    typography,
    controls,
    scrollbars,
    icons,
    overlay,
    sqlHighlight,
    css`
      :host {
        display: contents;
      }

      .panel {
        width: min(560px, calc(100vw - 80px));
        max-height: min(680px, calc(100vh - 80px));
        padding: 18px 20px;
        gap: 8px;
      }

      .sql {
        margin: 0;
        padding: 10px 12px;
        min-height: 140px;
        max-height: min(420px, 60vh);
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--mono-font);
        font-feature-settings: 'liga' 0, 'calt' 0;
        font-size: var(--font-size);
        line-height: 1.5;
        color: var(--text);
        background: var(--editor-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
      }

      .warning {
        margin: 0;
        padding: 8px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--status-dot-warning) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--status-dot-warning) 45%, transparent);
        border-radius: 4px;
        line-height: 1.4;
      }

      .error {
        margin: 0;
        padding: 8px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--status-dot-error) 14%, transparent);
        border: 1px solid color-mix(in srgb, var(--status-dot-error) 45%, transparent);
        border-radius: 4px;
        line-height: 1.4;
      }

      .sql code {
        font: inherit;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      .actions button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .icon-modifier-spin {
        --icon-size: 13px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'review-query-dialog': ReviewQueryDialog
  }
}
