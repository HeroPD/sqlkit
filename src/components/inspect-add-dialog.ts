import { LitElement, css, html, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'
import type { Engine, TableRef } from '../electron'
import {
  PG_INDEX_METHODS,
  buildAddConstraint,
  buildAddForeignKey,
  buildAddPartition,
  buildCreateIndex,
  buildCreateTrigger,
  foreignKeyActions,
  triggerCapabilities,
  type ForeignKeyAction,
  type TriggerEvent,
  type TriggerSpec,
} from '../sql-write'

export type AddObjectKind = 'index' | 'trigger' | 'partition' | 'foreignKey' | 'constraint'
export type AddObjectDetail = { statements: string[] }

const TRIGGER_EVENTS: TriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE']
const KIND_TITLES: Record<AddObjectKind, string> = {
  index: 'index',
  trigger: 'trigger',
  partition: 'partition',
  foreignKey: 'foreign key',
  constraint: 'constraint',
}

// Modal form that builds one schema-add statement for the inspected table. Field
// rows mirror db-config-form; the statement still goes through the workbench
// review dialog before it runs.
@customElement('inspect-add-dialog')
export class InspectAddDialog extends LitElement {
  @property()
  kind: AddObjectKind = 'index'

  @property({ attribute: false })
  table: TableRef | null = null

  @property()
  engine: Engine = 'postgresql'

  /** Table column names, for the index/FK/unique column pickers. */
  @property({ attribute: false })
  columns: string[] = []

  @state() private _name = ''
  @state() private _indexColumns: string[] = []
  @state() private _unique = false
  @state() private _method = 'btree'
  @state() private _timing: TriggerSpec['timing'] | null = null
  @state() private _events: TriggerEvent[] = ['INSERT']
  @state() private _level: TriggerSpec['level'] | null = null
  @state() private _functionName = ''
  @state() private _body = ''
  @state() private _bounds = ''
  @state() private _fkColumns: string[] = []
  @state() private _refTable = ''
  @state() private _refColumns = ''
  @state() private _onDelete: ForeignKeyAction = 'NO ACTION'
  @state() private _onUpdate: ForeignKeyAction = 'NO ACTION'
  @state() private _constraintType: 'CHECK' | 'UNIQUE' = 'CHECK'
  @state() private _checkExpression = ''
  @state() private _uniqueColumns: string[] = []
  @state() private _error = ''

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
    const title = `Add ${KIND_TITLES[this.kind]} · ${this.table?.name ?? ''}`
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel" role="dialog" aria-label=${title}>
          <h4>${title}</h4>
          ${this._fields()}
          ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : ''}
          <div class="actions">
            <button class="secondary" @click=${this._cancel}>Cancel</button>
            <button class="primary" @click=${this._create}>Create</button>
          </div>
        </div>
      </div>
    `
  }

  private _fields() {
    switch (this.kind) {
      case 'index':
        return this._indexFields()
      case 'trigger':
        return this._triggerFields()
      case 'partition':
        return this._partitionFields()
      case 'foreignKey':
        return this._foreignKeyFields()
      case 'constraint':
        return this._constraintFields()
    }
  }

  private _columnChecks(selected: string[], toggle: (column: string) => void) {
    return html`
      <div class="checks">
        ${this.columns.map(
          (column) => html`
            <label class="toggle">
              <input type="checkbox" .checked=${selected.includes(column)} @change=${() => toggle(column)} />
              <span class="mono">${column}</span>
            </label>
          `,
        )}
      </div>
    `
  }

  private _foreignKeyFields() {
    const actions = foreignKeyActions(this.engine)
    return html`
      ${this._field('Name', this._nameInput(`fk_${this.table?.name ?? ''}`))}
      ${this._field('Columns', this._columnChecks(this._fkColumns, (column) => this._toggleFkColumn(column)), 'Local columns, in reference order.')}
      ${this._field(
        'References',
        html`
          <input
            type="text"
            placeholder="schema.table"
            spellcheck="false"
            autocomplete="off"
            .value=${this._refTable}
            @input=${(e: Event) => (this._refTable = (e.target as HTMLInputElement).value)}
          />
        `,
        'Referenced table.',
      )}
      ${this._field(
        'Ref columns',
        html`
          <input
            type="text"
            placeholder="id"
            spellcheck="false"
            autocomplete="off"
            .value=${this._refColumns}
            @input=${(e: Event) => (this._refColumns = (e.target as HTMLInputElement).value)}
          />
        `,
        'Comma-separated; must match the local column count.',
      )}
      ${this._field('On delete', this._actionSelect(this._onDelete, actions, (value) => (this._onDelete = value)))}
      ${this._field('On update', this._actionSelect(this._onUpdate, actions, (value) => (this._onUpdate = value)))}
    `
  }

  private _actionSelect(value: ForeignKeyAction, actions: ForeignKeyAction[], set: (value: ForeignKeyAction) => void) {
    return html`
      <select @change=${(e: Event) => set((e.target as HTMLSelectElement).value as ForeignKeyAction)}>
        ${actions.map((action) => html`<option value=${action} ?selected=${value === action}>${action}</option>`)}
      </select>
    `
  }

  private _constraintFields() {
    return html`
      ${this._field('Name', this._nameInput(`chk_${this.table?.name ?? ''}`))}
      ${this._field(
        'Type',
        html`
          <select @change=${(e: Event) => (this._constraintType = (e.target as HTMLSelectElement).value as 'CHECK' | 'UNIQUE')}>
            <option value="CHECK" ?selected=${this._constraintType === 'CHECK'}>CHECK</option>
            <option value="UNIQUE" ?selected=${this._constraintType === 'UNIQUE'}>UNIQUE</option>
          </select>
        `,
      )}
      ${this._constraintType === 'CHECK'
        ? this._field(
            'Expression',
            html`
              <textarea
                rows="3"
                spellcheck="false"
                placeholder=${'age >= 0'}
                .value=${this._checkExpression}
                @input=${(e: Event) => (this._checkExpression = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            `,
            'A boolean expression each row must satisfy.',
          )
        : this._field('Columns', this._columnChecks(this._uniqueColumns, (column) => this._toggleUniqueColumn(column)), 'Rows must be unique across these columns.')}
    `
  }

  private _indexFields() {
    return html`
      ${this._field('Name', this._nameInput(`idx_${this.table?.name ?? ''}`))}
      ${this._field(
        'Columns',
        html`
          <div class="checks">
            ${this.columns.map(
              (column) => html`
                <label class="toggle">
                  <input
                    type="checkbox"
                    .checked=${this._indexColumns.includes(column)}
                    @change=${() => this._toggleIndexColumn(column)}
                  />
                  <span class="mono">${column}</span>
                </label>
              `,
            )}
          </div>
        `,
        'Key order follows the table column order.',
      )}
      ${this._field(
        '',
        html`
          <label class="toggle">
            <input type="checkbox" .checked=${this._unique} @change=${(e: Event) => (this._unique = (e.target as HTMLInputElement).checked)} />
            <span>Unique</span>
          </label>
        `,
      )}
      ${this.engine === 'postgresql'
        ? this._field(
            'Method',
            html`
              <select @change=${(e: Event) => (this._method = (e.target as HTMLSelectElement).value)}>
                ${PG_INDEX_METHODS.map((method) => html`<option value=${method} ?selected=${this._method === method}>${method}</option>`)}
              </select>
            `,
          )
        : ''}
    `
  }

  private _triggerFields() {
    const caps = triggerCapabilities(this.engine)
    const timing = this._timing ?? caps.timings[0]!
    const level = this._level ?? caps.levels[0]!
    return html`
      ${this._field('Name', this._nameInput(`trg_${this.table?.name ?? ''}`))}
      ${this._field(
        'Timing',
        html`
          <select @change=${(e: Event) => (this._timing = (e.target as HTMLSelectElement).value as TriggerSpec['timing'])}>
            ${caps.timings.map((option) => html`<option value=${option} ?selected=${timing === option}>${option}</option>`)}
          </select>
        `,
      )}
      ${this._field(
        caps.multiEvent ? 'Events' : 'Event',
        caps.multiEvent
          ? html`
              <div class="checks row">
                ${TRIGGER_EVENTS.map(
                  (event) => html`
                    <label class="toggle">
                      <input type="checkbox" .checked=${this._events.includes(event)} @change=${() => this._toggleEvent(event)} />
                      <span>${event}</span>
                    </label>
                  `,
                )}
              </div>
            `
          : html`
              <select @change=${(e: Event) => (this._events = [(e.target as HTMLSelectElement).value as TriggerEvent])}>
                ${TRIGGER_EVENTS.map((event) => html`<option value=${event} ?selected=${this._events[0] === event}>${event}</option>`)}
              </select>
            `,
      )}
      ${caps.levels.length > 1
        ? this._field(
            'For each',
            html`
              <select @change=${(e: Event) => (this._level = (e.target as HTMLSelectElement).value as TriggerSpec['level'])}>
                ${caps.levels.map((option) => html`<option value=${option} ?selected=${level === option}>${option}</option>`)}
              </select>
            `,
          )
        : ''}
      ${caps.usesFunction
        ? this._field(
            'Function',
            html`
              <input
                type="text"
                placeholder="schema.function_name"
                spellcheck="false"
                autocomplete="off"
                .value=${this._functionName}
                @input=${(e: Event) => (this._functionName = (e.target as HTMLInputElement).value)}
              />
            `,
            'Existing trigger function to EXECUTE; () is added if omitted.',
          )
        : this._field(
            'Body',
            html`
              <textarea
                rows="5"
                spellcheck="false"
                placeholder=${this.engine === 'mysql' ? 'SET NEW.updated_at = NOW();' : 'UPDATE …;'}
                .value=${this._body}
                @input=${(e: Event) => (this._body = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            `,
            'Statements only — they are wrapped in BEGIN … END for you.',
          )}
    `
  }

  private _partitionFields() {
    const pg = this.engine === 'postgresql'
    return html`
      ${this._field('Name', this._nameInput(`${this.table?.name ?? ''}_p1`))}
      ${this._field(
        'Bounds',
        html`
          <input
            type="text"
            placeholder=${pg ? `FROM ('2026-01-01') TO ('2027-01-01')` : 'VALUES LESS THAN (2027)'}
            spellcheck="false"
            autocomplete="off"
            .value=${this._bounds}
            @input=${(e: Event) => (this._bounds = (e.target as HTMLInputElement).value)}
          />
        `,
        pg ? `Also IN (…), WITH (MODULUS m, REMAINDER r), or DEFAULT.` : `Also VALUES IN (…) for LIST partitioning.`,
      )}
    `
  }

  private _nameInput(placeholder: string) {
    return html`
      <input
        type="text"
        placeholder=${placeholder}
        spellcheck="false"
        autocomplete="off"
        .value=${this._name}
        @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
      />
    `
  }

  private _field(label: string, control: TemplateResult, helper = '') {
    return html`
      <div class="field">
        <span class="field-label">${label}</span>
        <div class="field-control">${control}</div>
        ${helper ? html`<div class="field-helper muted small">${helper}</div>` : ''}
      </div>
    `
  }

  private _toggleIndexColumn(column: string) {
    this._indexColumns = this._toggleColumn(this._indexColumns, column)
  }

  private _toggleEvent(event: TriggerEvent) {
    this._events = this._events.includes(event)
      ? this._events.filter((name) => name !== event)
      : TRIGGER_EVENTS.filter((name) => [...this._events, event].includes(name))
  }

  // Toggle a column while keeping selection in the table's column order.
  private _toggleColumn(current: string[], column: string): string[] {
    const next = current.includes(column) ? current.filter((name) => name !== column) : [...current, column]
    return this.columns.filter((name) => next.includes(name))
  }

  private _toggleFkColumn(column: string) {
    this._fkColumns = this._toggleColumn(this._fkColumns, column)
  }

  private _toggleUniqueColumn(column: string) {
    this._uniqueColumns = this._toggleColumn(this._uniqueColumns, column)
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

  private _statement(table: TableRef): string {
    const caps = triggerCapabilities(this.engine)
    switch (this.kind) {
      case 'index':
        return buildCreateIndex(table, { name: this._name, columns: this._indexColumns, unique: this._unique, method: this._method }, this.engine)
      case 'trigger':
        return buildCreateTrigger(table, {
          name: this._name,
          timing: this._timing ?? caps.timings[0]!,
          events: this._events,
          level: this._level ?? caps.levels[0]!,
          functionName: this._functionName,
          body: this._body,
        }, this.engine)
      case 'partition':
        return buildAddPartition(table, { name: this._name, bounds: this._bounds }, this.engine)
      case 'foreignKey':
        return buildAddForeignKey(table, {
          name: this._name,
          columns: this._fkColumns,
          refTable: this._refTable,
          refColumns: this._refColumns.split(',').map((column) => column.trim()).filter(Boolean),
          onDelete: this._onDelete,
          onUpdate: this._onUpdate,
        }, this.engine)
      case 'constraint':
        return buildAddConstraint(table, {
          name: this._name,
          type: this._constraintType,
          expression: this._checkExpression,
          columns: this._uniqueColumns,
        }, this.engine)
    }
  }

  private _create() {
    if (!this.table) return
    try {
      const statement = this._statement(this.table)
      this.dispatchEvent(
        new CustomEvent<AddObjectDetail>('add-ddl', { detail: { statements: [statement] }, bubbles: true, composed: true }),
      )
    } catch (error) {
      this._error = (error as Error).message
    }
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
        width: min(460px, calc(100vw - 80px));
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        background: var(--sidebar-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
      }

      h4 {
        text-transform: capitalize;
      }

      .field {
        display: grid;
        grid-template-columns: 90px minmax(0, 1fr);
        align-items: start;
        gap: 6px 14px;
      }

      .field-label {
        min-height: var(--control-h);
        display: flex;
        align-items: center;
        justify-content: flex-end;
        font-size: var(--font-size);
        color: var(--text-2);
      }

      .field-control {
        min-width: 0;
      }

      .field-helper {
        grid-column: 2;
        line-height: 1.35;
      }

      .checks {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 180px;
        overflow-y: auto;
      }

      .checks.row {
        flex-direction: row;
        gap: 14px;
      }

      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 22px;
        font-size: var(--font-size);
        color: var(--text);
        cursor: pointer;
        user-select: none;
      }

      .toggle input[type='checkbox'] {
        width: auto;
        height: auto;
        margin: 0;
        accent-color: var(--accent);
      }

      .mono {
        font-family: var(--font-mono);
      }

      textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        padding: 5px 8px;
        font-family: var(--font-mono);
        font-size: var(--font-size);
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        outline: none;
      }

      textarea:focus {
        border-color: var(--input-focus-border);
      }

      textarea::placeholder {
        color: var(--input-placeholder);
      }

      .error {
        color: var(--status-dot-error);
        font-size: var(--font-size-sm);
        margin: 0;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 6px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'inspect-add-dialog': InspectAddDialog
  }
}
