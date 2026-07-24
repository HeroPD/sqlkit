import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { ColumnRef, InspectColumn, TableRef } from '../electron'
import { csvShapeError, parseCsv } from '../csv-import'
import { SQL_NULL, type CellInput } from '../sql-write'
import { controls, overlay, scrollbars, typography } from '../shared-styles'
import { formatInteger, rowWord, t } from '../i18n'

export type ImportConfirmDetail = { columns: ColumnRef[]; rows: CellInput[][] }
export type ImportColumn = {
  column: ColumnRef
  generated: boolean
  identity: InspectColumn['identity'] | null
}

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ROWS = 100_000

@customElement('import-dialog')
export class ImportDialog extends LitElement {
  @property({ attribute: false }) table: TableRef | null = null
  @property({ attribute: false }) columns: ImportColumn[] = []
  @property({ attribute: false }) run: ((detail: ImportConfirmDetail) => Promise<string | null>) | null = null

  @state() private _fileName = ''
  @state() private _source = ''
  @state() private _rows: string[][] = []
  @state() private _mapping: Array<number | null> = []
  @state() private _delimiter = ','
  @state() private _header = true
  @state() private _emptyAsNull = false
  @state() private _loading = false
  @state() private _importing = false
  @state() private _error = ''

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('columns') && !this._source) this._mapping = this.columns.map(() => null)
  }

  render() {
    const headers = this._sourceHeaders()
    const data = this._dataRows()
    const table = this.table ? (this.table.schema ? `${this.table.schema}.${this.table.name}` : this.table.name) : ''
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${t('import.title', { table })}>
          <h4>${t('import.title', { table })}</h4>
          <div class="toolbar">
            <label class="file secondary">
              <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" @change=${this._onFileChange} />
              ${this._fileName || t('import.chooseCsv')}
            </label>
            <label class="compact">
              <span>${t('import.delimiter')}</span>
              <select .value=${this._delimiter} @change=${this._onDelimiterChange}>
                <option value=",">${t('import.comma')}</option>
                <option value="\t">${t('import.tab')}</option>
                <option value=";">${t('import.semicolon')}</option>
              </select>
            </label>
          </div>
          <div class="options">
            <label><input type="checkbox" .checked=${this._header} @change=${this._onHeaderChange} /> ${t('import.firstRowHeaders')}</label>
            <label><input type="checkbox" .checked=${this._emptyAsNull} @change=${this._onNullChange} /> ${t('import.emptyAsNull')}</label>
          </div>
          ${headers.length
            ? html`
                <div class="mapping-wrap">
                  <div class="mapping-title">${t('import.columnMapping')}</div>
                  <div class="mapping">
                    ${this.columns.map((importColumn, targetIndex) => {
                      const { column, generated, identity } = importColumn
                      const locked = generated || identity === 'always'
                      const qualifier = generated ? t('import.generated') : identity ? t('import.identity') : ''
                      return html`
                      <label>
                        <span title=${`${column.dataType}${qualifier ? ` · ${qualifier}` : ''}`}>
                          ${column.name}${qualifier ? html` <em>${qualifier}</em>` : ''}
                        </span>
                        <select
                          .value=${this._mapping[targetIndex] === null ? '' : String(this._mapping[targetIndex])}
                          ?disabled=${locked}
                          @change=${(event: Event) => this._mapColumn(targetIndex, event)}
                        >
                          <option value="">${locked ? t('import.notInsertable') : t('import.skip')}</option>
                          ${headers.map((header, sourceIndex) => html`
                            <option value=${sourceIndex}>${header || t('import.column', { index: sourceIndex + 1 })}</option>
                          `)}
                        </select>
                      </label>
                    `})}
                  </div>
                </div>
                ${this._renderPreview(headers, data)}
              `
            : html`<div class="empty muted">${t('import.emptyHint')}</div>`}
          ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : ''}
          <div class="footer">
            <span class="muted small">${data.length
              ? t('import.dataRows', { count: formatInteger(data.length), rows: rowWord(data.length) })
              : ''}</span>
            <div class="actions">
              <button class="secondary" ?disabled=${this._importing} @click=${this._cancel}>${t('common.cancel')}</button>
              <button class="primary" ?disabled=${!data.length || this._loading || this._importing} @click=${this._confirm}>
                ${this._importing ? t('common.importing') : t('common.import')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `
  }

  private _renderPreview(headers: string[], rows: string[][]) {
    return html`
      <div class="preview" role="region" aria-label=${t('import.preview')}>
        <table>
          <thead><tr>${headers.map((header, index) => html`<th>${header || t('import.column', { index: index + 1 })}</th>`)}</tr></thead>
          <tbody>
            ${rows.slice(0, 8).map((row) => html`<tr>${headers.map((_, index) => html`<td>${row[index] ?? ''}</td>`)}</tr>`)}
          </tbody>
        </table>
      </div>
    `
  }

  private _sourceHeaders() {
    const first = this._rows[0]
    if (!first) return []
    return this._header ? first : first.map((_, index) => t('import.column', { index: index + 1 }))
  }

  private _dataRows() {
    return this._header ? this._rows.slice(1) : this._rows
  }

  private _onFileChange = async (event: Event) => {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      this._fileName = file.name
      this._source = ''
      this._rows = []
      this._error = t('import.fileTooLarge')
      return
    }
    this._loading = true
    this._error = ''
    try {
      this._source = await file.text()
      this._fileName = file.name
      this._parseAndMap()
    } catch (error) {
      this._rows = []
      this._error = (error as Error).message
    } finally {
      this._loading = false
    }
  }

  private _parseAndMap() {
    const { rows } = parseCsv(this._source, this._delimiter)
    const shapeError = csvShapeError(rows)
    if (shapeError) throw new Error(shapeError)
    const dataCount = Math.max(0, rows.length - (this._header ? 1 : 0))
    if (!dataCount) throw new Error(t('import.noData'))
    if (dataCount > MAX_ROWS) throw new Error(t('import.tooManyRows', { count: formatInteger(MAX_ROWS) }))
    this._rows = rows
    this._mapping = this._defaultMapping()
    this._error = ''
  }

  private _defaultMapping() {
    const headers = this._sourceHeaders()
    if (!this._header) {
      let sourceIndex = 0
      return this.columns.map(({ generated, identity }) => {
        if (generated || identity) return null
        return sourceIndex < headers.length ? sourceIndex++ : null
      })
    }
    const normalized = headers.map((header) => header.trim().toLocaleLowerCase())
    return this.columns.map(({ column, generated, identity }) => {
      if (generated || identity) return null
      const index = normalized.indexOf(column.name.toLocaleLowerCase())
      return index < 0 ? null : index
    })
  }

  private _onDelimiterChange(event: Event) {
    this._delimiter = (event.target as HTMLSelectElement).value
    if (!this._source) return
    try {
      this._parseAndMap()
    } catch (error) {
      this._rows = []
      this._error = (error as Error).message
    }
  }

  private _onHeaderChange(event: Event) {
    this._header = (event.target as HTMLInputElement).checked
    if (!this._source) return
    try {
      this._parseAndMap()
    } catch (error) {
      this._error = (error as Error).message
    }
  }

  private _onNullChange(event: Event) {
    this._emptyAsNull = (event.target as HTMLInputElement).checked
  }

  private _mapColumn(targetIndex: number, event: Event) {
    const value = (event.target as HTMLSelectElement).value
    this._mapping = this._mapping.map((mapped, index) => index === targetIndex ? (value === '' ? null : Number(value)) : mapped)
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this._importing) return
    event.preventDefault()
    this._cancel()
  }

  private _onBackdropDown(event: MouseEvent) {
    if (event.target === event.currentTarget && !this._importing) this._cancel()
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('dialog-cancel', { bubbles: true, composed: true }))
  }

  private async _confirm() {
    if (this._importing || !this.run) return
    const selected = this._mapping
      .map((source, target) => ({ source, importColumn: this.columns[target] }))
      .filter((entry): entry is { source: number; importColumn: ImportColumn } => entry.source !== null && entry.importColumn !== undefined)
    if (!selected.length) {
      this._error = t('import.mapOne')
      return
    }
    if (selected.some((entry) => entry.importColumn.generated || entry.importColumn.identity === 'always')) {
      this._error = t('import.generatedBlocked')
      return
    }
    if (new Set(selected.map((entry) => entry.source)).size !== selected.length) {
      this._error = t('import.uniqueMapping')
      return
    }
    const rows = this._dataRows().map((row) => selected.map(({ source }) => {
      const value = row[source] ?? ''
      return this._emptyAsNull && value === '' ? SQL_NULL : value
    }))
    this._importing = true
    this._error = ''
    try {
      const error = await this.run({ columns: selected.map((entry) => entry.importColumn.column), rows })
      if (error) this._error = error
      else this.dispatchEvent(new CustomEvent('dialog-done', { bubbles: true, composed: true }))
    } catch (error) {
      this._error = (error as Error).message
    } finally {
      this._importing = false
    }
  }

  static styles = [
    typography,
    controls,
    scrollbars,
    overlay,
    css`
      :host { display: contents; }
      .panel { width: min(760px, calc(100vw - 64px)); max-height: calc(100vh - 64px); padding: 18px 20px; gap: 12px; overflow: hidden; }
      .toolbar, .options, .footer, .actions { display: flex; align-items: center; gap: 10px; }
      .toolbar { justify-content: space-between; }
      .file { display: inline-flex; align-items: center; width: min(360px, 55%); height: var(--control-h); padding: 0 12px; overflow: hidden; color: var(--text); white-space: nowrap; text-overflow: ellipsis; background: color-mix(in srgb, var(--text) 5%, transparent); border: 1px solid var(--border-subtle); border-radius: 6px; box-sizing: border-box; cursor: pointer; }
      .file:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
      .file input { display: none; }
      .compact { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: var(--font-size); }
      .compact select { width: 120px; }
      .options { flex-wrap: wrap; color: var(--text-2); font-size: var(--font-size); }
      .options label { display: flex; align-items: center; gap: 6px; }
      .options input { width: auto; height: auto; }
      .mapping-wrap { min-height: 0; display: flex; flex-direction: column; gap: 6px; }
      .mapping-title { color: var(--text-2); font-size: var(--font-size); font-weight: 600; }
      .mapping { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; max-height: 190px; overflow: auto; padding-right: 4px; }
      .mapping label { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(130px, 1.4fr); align-items: center; gap: 8px; min-width: 0; }
      .mapping span { overflow: hidden; color: var(--text); font-family: var(--mono-font); font-size: var(--font-size); text-overflow: ellipsis; white-space: nowrap; }
      .mapping em { color: var(--text-3); font-family: var(--ui-font); font-size: var(--font-size); font-style: normal; }
      .mapping select { height: 28px; font-size: var(--font-size); }
      .preview { min-height: 120px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--editor-bg); }
      table { border-collapse: collapse; min-width: 100%; font-family: var(--mono-font); font-size: var(--font-size); }
      th, td { max-width: 240px; padding: 5px 8px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
      th { position: sticky; top: 0; color: var(--text-2); background: var(--sidebar-bg); }
      td { color: var(--text); }
      .empty { min-height: 180px; display: grid; place-items: center; border: 1px dashed var(--border); border-radius: 4px; font-size: var(--font-size); }
      .error { color: var(--status-dot-error); font-size: var(--font-size); }
      .footer { justify-content: space-between; }
      .actions { margin-left: auto; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      @media (max-width: 640px) { .mapping { grid-template-columns: 1fr; } }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap { 'import-dialog': ImportDialog }
}
