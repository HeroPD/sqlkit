import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'

export type ExportFormat = 'csv' | 'tsv' | 'json'
export type ExportConfirmDetail = { format: ExportFormat; rows: number }

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

  @state()
  private _format: ExportFormat = 'csv'

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
        <div class="panel" role="dialog" aria-label="Export results">
          <h4>Export Results</h4>
          <p class="muted small">
            ${this.total} row${this.total === 1 ? '' : 's'} received${this.truncated ? ' (the query returned more; the result was capped)' : ''}.
          </p>
          <div class="field">
            <span class="label">Format</span>
            <div class="formats" role="radiogroup" aria-label="Format">
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
          <div class="field">
            <label class="label" for="rows">Rows</label>
            <input id="rows" type="number" min="1" max=${this.total} .value=${String(this.total)} />
            <span class="muted small">of ${this.total}</span>
          </div>
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>Cancel</button>
            <button class="primary" @click=${this._confirm}>Export</button>
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

  private _confirm() {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('#rows')
    const requested = Number(input?.value)
    const rows = Number.isFinite(requested) ? Math.min(this.total, Math.max(1, Math.floor(requested))) : this.total
    this.dispatchEvent(
      new CustomEvent<ExportConfirmDetail>('export-confirm', {
        detail: { format: this._format, rows },
        bubbles: true,
        composed: true,
      }),
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
        gap: 8px;
        background: var(--sidebar-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      }

      .field {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .label {
        width: 52px;
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        color: var(--text-2);
      }

      .formats {
        display: flex;
        gap: 4px;
      }

      .format {
        padding: 3px 12px;
        font: inherit;
        font-size: var(--font-size-sm);
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
