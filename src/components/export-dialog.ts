import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, overlay, typography } from '../shared-styles'
import type { ExportFormat } from '../result-export'
import { formatInteger, rowWord, t } from '../i18n'

export type { ExportFormat }
// `stream` requests a full re-run streamed to disk (past the buffered rows);
// otherwise `rows` of the already-received rows are exported.
export type ExportConfirmDetail = { format: ExportFormat; rows: number; stream: boolean }

const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: 'csv', label: 'CSV' },
  { id: 'tsv', label: 'TSV' },
  { id: 'json', label: 'JSON' },
]

// Export options modal for the results panel: pick a format and how many of
// the received rows to write, then `export-confirm` carries the choice. The
// host owns the actual file dialog and writing.
@customElement('export-dialog')
export class ExportDialog extends LitElement {
  /** Rows the panel holds — the most an export can contain. */
  @property({ type: Number })
  total = 0

  /** The result was capped at the IPC boundary; exports can't exceed it. */
  @property({ type: Boolean })
  truncated = false

  /** The query is read-only, so the full result can be re-run and streamed to
   * disk past the buffered rows. Offered only when the result was truncated. */
  @property({ type: Boolean })
  streamable = false

  @state()
  private _format: ExportFormat = 'csv'

  // Default to the full streamed export when it's on offer (the buffered subset
  // is rarely what the user wants once the result was capped).
  @state()
  private _streamFull = true

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  render() {
    const offerStream = this.streamable && this.truncated
    const streaming = offerStream && this._streamFull
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${t('export.title')}>
          <h4>${t('export.title')}</h4>
          <p class="muted small">
            ${t('export.received', {
              count: formatInteger(this.total),
              rows: rowWord(this.total),
              capped: this.truncated ? t('export.capped') : '',
            })}
          </p>
          <div class="field">
            <span class="label">${t('export.format')}</span>
            <div class="formats" role="radiogroup" aria-label=${t('export.format')}>
              ${FORMATS.map(
                (format) => html`
                  <button
                    class="format ${this._format === format.id ? 'active' : ''}"
                    role="radio"
                    aria-checked=${this._format === format.id}
                    @click=${() => (this._format = format.id)}
                  >
                    ${format.label}
                  </button>
                `,
              )}
            </div>
          </div>
          ${offerStream
            ? html`
                <label class="field stream-toggle">
                  <input type="checkbox" .checked=${this._streamFull} @change=${this._onStreamToggle} />
                  <span class="muted small">${t('export.fullResult')}</span>
                </label>
              `
            : ''}
          <div class="field">
            <label class="label" for="rows">${t('export.rows')}</label>
            <input id="rows" type="number" min="1" max=${this.total} .value=${String(this.total)} ?disabled=${streaming} />
            <span class="muted small">${streaming ? t('export.allRows') : t('export.ofRows', { count: formatInteger(this.total) })}</span>
          </div>
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>${t('common.cancel')}</button>
            <button class="primary" @click=${this._confirm}>${t('common.export')}</button>
          </div>
        </div>
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._cancel()
    }
    if (event.key === 'Enter') {
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

  private _onStreamToggle(event: Event) {
    this._streamFull = (event.target as HTMLInputElement).checked
  }

  private _confirm() {
    const stream = this.streamable && this.truncated && this._streamFull
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('#rows')
    const requested = Number(input?.value)
    const rows = stream
      ? this.total
      : Number.isFinite(requested)
        ? Math.min(this.total, Math.max(1, Math.floor(requested)))
        : this.total
    this.dispatchEvent(
      new CustomEvent<ExportConfirmDetail>('export-confirm', {
        detail: { format: this._format, rows, stream },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    typography,
    controls,
    overlay,
    css`
      :host {
        display: contents;
      }

      .panel {
        width: min(380px, calc(100vw - 80px));
        padding: 18px 20px;
        gap: 8px;
      }

      .field {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .label {
        width: 52px;
        flex-shrink: 0;
        font-size: var(--font-size);
        color: var(--text-2);
      }

      .formats {
        display: flex;
        gap: 4px;
      }

      .format {
        padding: 3px 12px;
        font: inherit;
        font-size: var(--font-size);
        color: var(--text-2);
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 4px;
        cursor: pointer;
      }

      .format.active {
        color: var(--on-accent, #fff);
        background: var(--accent);
        border-color: var(--accent);
      }

      input[type='number'] {
        width: 90px;
        padding: 4px 8px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        outline: none;
      }

      input[type='number']:focus {
        border-color: var(--input-focus-border);
      }

      .stream-toggle {
        align-items: flex-start;
        cursor: pointer;
      }

      .stream-toggle input {
        flex-shrink: 0;
        margin-top: 2px;
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
    'export-dialog': ExportDialog
  }
}
