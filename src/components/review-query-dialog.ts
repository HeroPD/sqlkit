import { LitElement, type PropertyValues, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, icons, overlay, scrollbars, sqlHighlight, typography } from '../shared-styles'
import { t } from '../i18n'
import { formatPreviewParam, previewSql, sqlPreviewParts } from '../sql-preview'

// The focused element, followed into shadow roots: document.activeElement stops
// at the outermost host, which is never the editor the user was typing in.
function deepActiveElement(): HTMLElement | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active instanceof HTMLElement ? active : null
}

// Re-exported so existing importers keep their path.
export { formatPreviewParam, previewSql, sqlPreviewParts }

// Shows a statement and its bound params for the user to read before it runs:
// a generated write (UPDATE today; INSERT/DELETE later), or one the user wrote
// that the destructive preflight stopped. Dispatches `dialog-done` /
// `dialog-cancel`; closes itself on Escape or backdrop click. Enter runs the
// statement, unless the Cancel button holds focus (then Enter cancels).
@customElement('review-query-dialog')
export class ReviewQueryDialog extends LitElement {
  @property()
  sql = ''

  @property({ attribute: false })
  params: unknown[] = []

  @property()
  confirmLabel = t('review.apply')

  /** Defaults to the review copy; a destructive preflight supplies its own. */
  @property()
  heading = ''

  @property()
  description = ''

  /** Styles the confirm button as destructive, for a run that cannot be undone. */
  @property({ type: Boolean })
  danger = false

  // Runs the reviewed statement, resolving to an error message (shown inline) or
  // null on success. The dialog owns the applying/error UI so failures stay in
  // context instead of popping a separate notice.
  @property({ attribute: false })
  run: (() => Promise<string | null>) | null = null

  @state() private _applying = false
  @state() private _error = ''
  private _returnFocus: HTMLElement | null = null
  /**
   * Whether Enter may confirm yet. The keystroke that opens this dialog is still
   * propagating when it mounts — ⌘↵ in the editor, or Enter on a command-palette
   * entry, runs the query, Lit renders us in the microtask that follows, and the
   * same keydown then reaches the window listener below. Confirming on it ran a
   * destructive statement the user never got to see. Arming on the next task
   * puts the opening keystroke out of reach; a click is unaffected.
   */
  private _armed = false
  private _armTimer: ReturnType<typeof setTimeout> | null = null

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
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
    // Hand focus back to whatever opened the dialog, so cancelling returns the
    // user to the editor they were in rather than to nothing.
    this._returnFocus?.focus()
    this._returnFocus = null
  }

  // Takes focus on open. The keydown listener is on window, so leaving focus
  // where it was lets one Escape land twice: whatever had focus sees it first
  // (the JSON editor closed itself and returned to the grid) and this dialog
  // sees it on the way up.
  protected firstUpdated() {
    this._returnFocus = deepActiveElement()
    this.shadowRoot?.querySelector<HTMLElement>('.panel')?.focus()
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
    const title = this.heading || t('review.title')
    const description = this.description || t('review.description')
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div
          class="panel ${this.danger ? 'danger-review' : 'normal-review'}"
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-title"
          aria-describedby="review-description"
          tabindex="-1"
        >
          <header class="dialog-head">
            <span class="dialog-icon" aria-hidden="true">
              <i class="icon ${this.danger ? 'icon-list-x' : 'icon-file-code'}"></i>
            </span>
            <div class="heading">
              <h4 id="review-title">${title}</h4>
              <p id="review-description">${description}</p>
            </div>
          </header>
          <div class="content">
            <span class="preview-label">${t('review.preview')}</span>
            <pre class="sql"><code>${sqlPreviewParts(preview).map((part) =>
              part.kind ? html`<span class=${part.kind}>${part.text}</span>` : part.text,
            )}</code></pre>
            ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : ''}
          </div>
          <div class="footer">
            <div class="actions">
              <button class="secondary" ?disabled=${this._applying} @click=${this._cancel}>
                ${t('common.cancel')}<kbd aria-hidden="true">esc</kbd>
              </button>
              <button class="primary ${this.danger ? 'danger' : ''}" ?disabled=${this._applying} @click=${this._confirm}>
                ${this._applying
                  ? html`<i class="icon icon-loader-circle icon-modifier-spin" aria-hidden="true"></i> ${t('common.applying')}`
                  : html`${this.confirmLabel}<kbd aria-hidden="true">↵</kbd>`}
              </button>
            </div>
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
    // A bare Enter runs the statement. A focused button handles its own Enter (so
    // Enter on Cancel still cancels); otherwise we confirm. Chords are not this
    // dialog's: ⌘↵ is the editor's run shortcut, and taking it here would let a
    // second reflexive press stand in for reading what is about to run.
    if (
      event.key === 'Enter' &&
      this._armed &&
      !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) &&
      !(this.shadowRoot?.activeElement instanceof HTMLButtonElement)
    ) {
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

      /* Focused on open so Escape belongs to the dialog; it is a container, not
         a control, so it shows no ring of its own. */
      .panel:focus {
        outline: none;
      }

      .panel {
        position: relative;
        width: min(620px, calc(100vw - 80px));
        max-height: min(680px, calc(100vh - 80px));
        padding: 0;
        gap: 0;
        overflow: hidden;
      }

      .panel::before {
        position: absolute;
        inset: 0 0 auto;
        z-index: 1;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        content: '';
      }

      .panel.danger-review::before {
        background: linear-gradient(90deg, transparent, var(--status-dot-error), transparent);
      }

      .dialog-head {
        display: grid;
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 12px;
        padding: 20px 22px 15px;
      }

      .dialog-icon {
        --icon-size: 17px;
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        color: color-mix(in srgb, var(--accent) 76%, var(--text));
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
        border-radius: 8px;
      }

      .danger-review .dialog-icon {
        color: color-mix(in srgb, var(--status-dot-error) 82%, var(--text));
        background: color-mix(in srgb, var(--status-dot-error) 10%, transparent);
        border-color: color-mix(in srgb, var(--status-dot-error) 24%, transparent);
      }

      .heading {
        min-width: 0;
        padding-top: 1px;
      }

      .heading h4 {
        margin-bottom: 4px;
        font-size: 16px;
        font-weight: 600;
      }

      .heading p {
        line-height: 1.45;
      }

      .content {
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 0 22px 18px;
      }

      .preview-label {
        margin-bottom: 7px;
        color: var(--text-2);
        font-size: var(--font-size-sm);
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .sql {
        margin: 0;
        padding: 10px 12px;
        max-height: min(240px, 48vh);
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

      .error {
        margin: 10px 0 0;
        padding: 0;
        color: color-mix(in srgb, var(--status-dot-error) 70%, var(--text));
        line-height: 1.4;
      }

      .sql code {
        font: inherit;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 10px 22px;
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
