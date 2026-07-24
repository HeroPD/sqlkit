import { LitElement, type PropertyValues, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { DatabaseCreateMeta, DatabaseCreateOptions } from '../electron'
import { controls, overlay, typography } from '../shared-styles'
import { t } from '../i18n'

export type CreateDatabaseDetail = { name: string; options: DatabaseCreateOptions }

// prompt-dialog's richer sibling for CREATE DATABASE: a name plus the engine's
// own options (MySQL charset/collation, Postgres owner/encoding/locale/template,
// SQL Server collation), all sourced from server metadata. Dispatches
// `dialog-confirm` with { name, options } / `dialog-cancel`.
@customElement('create-database-dialog')
export class CreateDatabaseDialog extends LitElement {
  @property({ attribute: false })
  meta: DatabaseCreateMeta | null = null

  @property()
  confirmLabel = t('common.create')

  @state() private _name = ''
  @state() private _charset = ''
  @state() private _collation = ''
  @state() private _encoding = ''
  @state() private _ctype = ''
  @state() private _owner = ''
  @state() private _template = ''
  private _seeded = false

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  // Pre-select the server's real defaults so the dialog shows what CREATE
  // DATABASE would use with no options, rather than a placeholder.
  protected willUpdate(changed: PropertyValues) {
    if (this._seeded || !changed.has('meta') || !this.meta) return
    const defaults = this.meta.defaults ?? {}
    this._charset = defaults.charset ?? ''
    this._collation = defaults.collation ?? ''
    this._encoding = defaults.encoding ?? ''
    this._ctype = defaults.ctype ?? ''
    this._owner = defaults.owner ?? ''
    this._template = defaults.template ?? ''
    this._seeded = true
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  protected firstUpdated() {
    this.shadowRoot?.querySelector('input')?.focus()
  }

  render() {
    const engine = this.meta?.engine
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${t('schema.createDatabase')}>
          <h4>${t('schema.createDatabase')}</h4>
          <div class="field">
            <label>${t('schema.dbName')}</label>
            <input
              type="text"
              placeholder="my_database"
              spellcheck="false"
              autocomplete="off"
              .value=${this._name}
              @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  this._confirm()
                }
              }}
            />
          </div>
          ${engine === 'mysql' ? this._mysqlFields() : ''}
          ${engine === 'postgresql' ? this._postgresFields() : ''}
          ${engine === 'sqlserver' ? this._select(t('schema.collation'), this._collation, this.meta?.collations ?? [], (v) => (this._collation = v)) : ''}
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>${t('common.cancel')}</button>
            <button class="primary" ?disabled=${!this._name.trim()} @click=${this._confirm}>${this.confirmLabel}</button>
          </div>
        </div>
      </div>
    `
  }

  private _mysqlFields() {
    const charsets = this.meta?.charsets ?? []
    const collations = this._charset ? (this.meta?.collationsByCharset?.[this._charset] ?? []) : (this.meta?.collations ?? [])
    return html`
      ${this._select(t('schema.charset'), this._charset, charsets, (v) => {
        this._charset = v
        // A charset change can orphan the picked collation; clear to the default.
        if (this._collation && !(this.meta?.collationsByCharset?.[v] ?? []).includes(this._collation)) this._collation = ''
      })}
      ${this._select(t('schema.collation'), this._collation, collations, (v) => (this._collation = v))}
    `
  }

  private _postgresFields() {
    return html`
      ${this._select(t('schema.owner'), this._owner, this.meta?.owners ?? [], (v) => (this._owner = v))}
      ${this._select(t('schema.template'), this._template, this.meta?.templates ?? [], (v) => (this._template = v))}
      ${this._select(t('schema.encoding'), this._encoding, this.meta?.encodings ?? [], (v) => (this._encoding = v))}
      ${this._select(t('schema.lcCollate'), this._collation, this.meta?.collations ?? [], (v) => (this._collation = v))}
      ${this._select(t('schema.ctype'), this._ctype, this.meta?.collations ?? [], (v) => (this._ctype = v))}
    `
  }

  private _select(label: string, value: string, options: string[], onChange: (value: string) => void) {
    return html`
      <div class="field">
        <label>${label}</label>
        <select .value=${value} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
          ${value === '' ? html`<option value="">${t('schema.serverDefault')}</option>` : ''}
          ${options.map((option) => html`<option value=${option} ?selected=${option === value}>${option}</option>`)}
        </select>
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
    const name = this._name.trim()
    if (!name) return
    const engine = this.meta?.engine
    const options: DatabaseCreateOptions = {}
    if (engine === 'mysql') {
      if (this._charset) options.charset = this._charset
      if (this._collation) options.collation = this._collation
    } else if (engine === 'postgresql') {
      if (this._owner) options.owner = this._owner
      if (this._template) options.template = this._template
      if (this._encoding) options.encoding = this._encoding
      if (this._collation) options.collation = this._collation
      if (this._ctype) options.ctype = this._ctype
    } else if (engine === 'sqlserver') {
      if (this._collation) options.collation = this._collation
    }
    this.dispatchEvent(
      new CustomEvent<CreateDatabaseDetail>('dialog-confirm', { detail: { name, options }, bubbles: true, composed: true }),
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
        width: min(420px, calc(100vw - 80px));
        padding: 16px;
        gap: 10px;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      label {
        font-size: var(--font-size);
        color: var(--text-3);
      }

      input,
      select {
        padding: 5px 8px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        outline: none;
      }

      input:focus,
      select:focus {
        border-color: var(--input-focus-border);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'create-database-dialog': CreateDatabaseDialog
  }
}
