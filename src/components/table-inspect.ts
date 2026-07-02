import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import type { DbObject, DbObjectKind, Engine, InspectColumn, TableInspection, TableRef } from '../electron'
import { abbreviateType } from '../sql-types'
import { dialectFor } from '../dialect'
import type { ColumnAlter } from '../sql-write'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import { TABLE_KIND_ICONS, TABLE_KIND_LABELS } from '../table-kinds'

// A column property the user can edit inline (click). Nullable is edited via a
// yes/no menu; primary key stays read-only. Capabilities come from the dialect.
type EditField = 'name' | 'dataType' | 'comment' | 'default'

// One column's staged edits — the fields that differ from what was loaded.
type ColumnDiff = Partial<Omit<ColumnAlter, 'original'>>

// Emitted on ⌘S / Save so the workbench routes the change through SchemaOps
// (build DDL → review dialog → runDdl). `onApplied` reloads this tab on success.
export type ColumnAlterEventDetail = {
  profileId: string
  childDb: string | null
  table: TableRef
  engine: Engine
  edits: ColumnAlter[]
  onApplied: () => void
}

// The DDL words that show up in constraint/index/trigger/policy definitions;
// matched case-insensitively so SQLite's hand-written DDL highlights too.
const SQL_KEYWORDS = new Set(
  `PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK NOT NULL DEFAULT ON UPDATE DELETE INSERT SELECT
   CASCADE RESTRICT SET USING CREATE INDEX TRIGGER BEFORE AFTER INSTEAD OF FOR EACH ROW STATEMENT
   EXECUTE FUNCTION PROCEDURE WHEN WHERE AND OR IN IS LIKE BETWEEN EXISTS TO WITH AS VALUES
   PARTITION BY RANGE LIST HASH FROM MINVALUE MAXVALUE ASC DESC NULLS FIRST LAST ALL
   DEFERRABLE INITIALLY DEFERRED IMMEDIATE MATCH FULL SIMPLE PARTIAL GENERATED ALWAYS STORED DO ALSO`
    .split(/\s+/)
    .filter(Boolean),
)

// Splitting on word runs keeps every character of the original text; only
// keyword tokens get wrapped, everything else passes through verbatim.
const highlightDefinition = (text: string) =>
  text.split(/(\w+)/).map((part) => (SQL_KEYWORDS.has(part.toUpperCase()) ? html`<span class="kw">${part}</span>` : part))

// The Inspect tab's body: one table's structure — columns up top, then the
// engine's sections (foreign keys, constraints, indexes, partitions,
// triggers, rules, policies). Fetches its own data from the profile so the
// workbench only mounts it; re-fetches when retargeted to another table.
@customElement('table-inspect')
export class TableInspect extends LitElement {
  @property()
  profileId = ''

  /** Child database this inspect tab belongs to (all-databases mode); null otherwise. */
  @property()
  childDb: string | null = null

  @property({ attribute: false })
  table: TableRef | null = null

  /** Alternative target: a schema object (function/type) instead of a table. */
  @property({ attribute: false })
  object: DbObject | null = null

  @property()
  objectKind: DbObjectKind | null = null

  @property()
  engine: Engine | null = null

  @state()
  private _state: { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'done'; inspection: TableInspection } = {
    phase: 'loading',
  }

  @state()
  private _menu: { x: number; y: number; name: string; definition: string | null } | null = null

  /** Staged column edits, keyed by the column's original name. */
  @state()
  private _edits = new Map<string, ColumnDiff>()

  /** The cell in inline-edit mode; `seed` pre-fills the editor (type templates). */
  @state()
  private _editing: { col: string; field: EditField; seed?: string } | null = null

  /** The option menu open on a column cell — nullable's yes/no or the type
   *  list; `filter` narrows the types to what's typed (Ctrl+Space completion). */
  @state()
  private _cellMenu: { x: number; y: number; col: InspectColumn; kind: 'nullable' | 'type'; filter?: string } | null = null

  // When the click that blurred an open editor lands on another cell, it should
  // only commit — not open that cell's menu/editor on the same gesture.
  private _blurCommitAt = -Infinity

  private _dismissedEditor() {
    return performance.now() - this._blurCommitAt < 300
  }

  protected willUpdate(changed: PropertyValues) {
    if (
      changed.has('profileId') ||
      changed.has('childDb') ||
      changed.has('table') ||
      changed.has('object') ||
      changed.has('objectKind')
    ) {
      void this._load()
    }
  }

  protected updated(changed: PropertyValues) {
    // Focus the inline editor whenever a cell enters edit mode. A seeded type
    // template gets just its parameters selected so typing replaces them.
    if (changed.has('_editing') && this._editing) {
      const input = this.renderRoot.querySelector<HTMLInputElement>('.cell-input')
      if (!input) return
      input.focus()
      const seed = this._editing.seed
      const open = seed?.indexOf('(') ?? -1
      if (seed && open >= 0) input.setSelectionRange(open + 1, seed.endsWith(')') ? seed.length - 1 : seed.length)
      else input.select()
    }
    // Surface the dirty state so the workbench can mark the tab (the • marker).
    if (changed.has('_edits')) {
      this.dispatchEvent(
        new CustomEvent('inspect-dirty', { detail: { dirty: this._edits.size > 0 }, bubbles: true, composed: true }),
      )
    }
  }

  private async _load() {
    const profileId = this.profileId
    const childDb = this.childDb
    const table = this.table
    const object = this.object
    const objectKind = this.objectKind
    if (!profileId || (!table && !object)) return
    // A fresh structure invalidates any staged edits against the old one.
    this._edits = new Map()
    this._editing = null
    this._cellMenu = null
    this._state = { phase: 'loading' }
    const result =
      object && objectKind
        ? await window.sqlkit.inspectObject(profileId, childDb, object, objectKind)
        : await window.sqlkit.inspectTable(profileId, childDb, table!)
    // Stale guard: the tab may have been retargeted (profile, child, or target)
    // while this was in flight.
    if (
      this.profileId !== profileId ||
      this.childDb !== childDb ||
      this.table !== table ||
      this.object !== object ||
      this.objectKind !== objectKind
    ) {
      return
    }
    this._state = result.success ? { phase: 'done', inspection: result.inspection } : { phase: 'error', error: result.error }
  }

  render() {
    const target = this.object ?? this.table
    if (!target) return ''
    const label = target.schema ? `${target.schema}.${target.name}` : target.name
    const icon = this.object
      ? this.objectKind === 'function'
        ? 'codicon-symbol-method'
        : this.object.detail === 'enum'
          ? 'codicon-symbol-enum'
          : 'codicon-symbol-structure'
      : (TABLE_KIND_ICONS[this.table!.kind] ?? 'codicon-table')
    const badge = this.object
      ? this.objectKind === 'function'
        ? 'function'
        : this.object.detail
      : this.table!.kind !== 'table'
        ? TABLE_KIND_LABELS[this.table!.kind]
        : ''
    return html`
      <div class="scroll">
        <div class="head">
          <i class="codicon ${icon}" aria-hidden="true"></i>
          <h3>${label}</h3>
          ${badge ? html`<span class="kind">${badge}</span>` : ''}
          <button class="refresh" title="Reload structure" aria-label="Reload structure" @click=${() => void this._load()}>
            <i class="codicon codicon-refresh" aria-hidden="true"></i>
          </button>
        </div>
        ${this._renderBody()}
      </div>
      ${this._renderMenu()} ${this._renderCellMenu()}
    `
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const items: MenuItem[] = [
      { id: 'copy-name', label: 'Copy Name' },
      ...(menu.definition ? [{ id: 'copy-definition', label: 'Copy Definition' }] : []),
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) =>
          void navigator.clipboard.writeText(e.detail.id === 'copy-name' ? menu.name : (menu.definition ?? ''))}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _onRowMenu(event: MouseEvent, name: string, definition: string | null = null) {
    event.preventDefault()
    this._menu = { x: event.clientX, y: event.clientY, name, definition }
  }

  // --- column editing --------------------------------------------------------

  // Editability comes from the engine dialect's capabilities. Object attributes
  // (function/type inspections) aren't editable.
  private _canEdit(field: EditField | 'nullable'): boolean {
    if (this.object || !this.table || !this.engine) return false
    const dialect = dialectFor(this.engine)
    if (field === 'name') return dialect.supportsColumnRename
    if (field === 'comment') return dialect.supportsColumnAlter && dialect.supportsColumnComments
    return dialect.supportsColumnAlter
  }

  // Effective text for a field: the staged value if edited, else what loaded.
  private _fieldText(col: InspectColumn, field: EditField): string {
    const edit = this._edits.get(col.name)
    if (edit && field in edit) return (edit[field] as string | null) ?? ''
    return this._fieldOriginal(col, field)
  }

  private _isEdited(colName: string, field: EditField | 'nullable'): boolean {
    const edit = this._edits.get(colName)
    return !!edit && field in edit
  }

  private _startEdit(colName: string, field: EditField, seed?: string) {
    this._editing = { col: colName, field, seed }
  }

  private _cancelEdit() {
    this._editing = null
  }

  private _applyEdit(colName: string, edit: ColumnDiff) {
    const next = new Map(this._edits)
    if (Object.keys(edit).length) next.set(colName, edit)
    else next.delete(colName)
    this._edits = next
  }

  // Records a text edit, dropping it back out of the staged set when the value
  // returns to the original. Name/type can't be blanked, so empty reverts;
  // an emptied comment or default means "drop it" and stays staged.
  private _commitText(col: InspectColumn, field: EditField, raw: string) {
    const value = field === 'comment' ? raw : raw.trim()
    const original = this._fieldOriginal(col, field)
    const edit: ColumnDiff = { ...this._edits.get(col.name) }
    if (value === original || ((field === 'name' || field === 'dataType') && value === '')) delete edit[field]
    else edit[field] = value
    this._applyEdit(col.name, edit)
    this._editing = null
  }

  private _fieldOriginal(col: InspectColumn, field: EditField): string {
    if (field === 'name') return col.name
    if (field === 'dataType') return col.dataType
    if (field === 'default') return col.default ?? ''
    return col.comment ?? ''
  }

  // Nullable is a yes/no choice, not free text; staged like the text fields.
  private _setNullable(col: InspectColumn, value: boolean) {
    const edit: ColumnDiff = { ...this._edits.get(col.name) }
    if (value === col.nullable) delete edit.nullable
    else edit.nullable = value
    this._applyEdit(col.name, edit)
  }

  private _fieldNullable(col: InspectColumn): boolean {
    const edit = this._edits.get(col.name)
    return edit && 'nullable' in edit ? !!edit.nullable : col.nullable
  }

  private _onEditKeydown(event: KeyboardEvent, col: InspectColumn, field: EditField) {
    if (event.key === 'Enter') {
      event.preventDefault()
      this._commitText(col, field, (event.target as HTMLInputElement).value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // With the completion menu open, Escape closes it and keeps editing.
      if (this._cellMenu) this._cellMenu = null
      else this._cancelEdit()
    } else if (event.key === ' ' && event.ctrlKey && field === 'dataType') {
      // Editor-style completion: the type choices anchored under the input,
      // narrowed by what's typed so far.
      event.preventDefault()
      const input = event.target as HTMLInputElement
      const rect = input.getBoundingClientRect()
      this._cellMenu = { x: rect.left, y: rect.bottom + 2, col, kind: 'type', filter: input.value.trim() }
    }
  }

  /** Whether there are staged column edits. Read by the workbench close-confirm. */
  hasPendingChanges() {
    return this._edits.size > 0
  }

  // Commits any focused editor, then emits the staged edits for the workbench to
  // review and apply. Called on ⌘S and the Save button; a no-op when nothing is
  // staged.
  save() {
    this.renderRoot.querySelector<HTMLElement>('.cell-input')?.blur()
    if (this._state.phase !== 'done' || !this._edits.size || !this.table || !this.engine) return
    const byName = new Map(this._state.inspection.columns.map((column) => [column.name, column]))
    const edits: ColumnAlter[] = []
    for (const [name, diff] of this._edits) {
      const original = byName.get(name)
      if (original) edits.push({ original, ...diff })
    }
    if (!edits.length) return
    this.dispatchEvent(
      new CustomEvent<ColumnAlterEventDetail>('alter-columns', {
        bubbles: true,
        composed: true,
        detail: {
          profileId: this.profileId,
          childDb: this.childDb,
          table: this.table,
          engine: this.engine,
          edits,
          onApplied: () => {
            this._edits = new Map()
            this._editing = null
            void this._load()
          },
        },
      }),
    )
  }

  private _renderBody() {
    const state = this._state
    if (state.phase === 'loading') {
      return html`<p class="muted hint">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i> Loading structure…
      </p>`
    }
    if (state.phase === 'error') return html`<pre class="error">${state.error}</pre>`

    const { columns, sections } = state.inspection
    return html`
      ${columns.length ? this._renderColumnsTable(columns) : ''}
      ${sections.map(
        (section) => html`
          <h4>
            ${section.title} <span class="count">${section.rows.length}</span>
            <button class="add-btn" type="button" title="Add ${section.title}" aria-label="Add ${section.title}">
              <i class="codicon codicon-add" aria-hidden="true"></i>
            </button>
          </h4>
          <table class="section-table">
            <colgroup>
              <col class="name-col" />
              <col />
            </colgroup>
            <tbody>
              ${section.rows.map(
                (row) => html`
                  <tr @contextmenu=${(event: MouseEvent) => this._onRowMenu(event, row.name, row.definition)}>
                    <td class="mono name-cell" title=${row.name}>
                      ${this.engine ? dialectFor(this.engine).displayConstraintName(row.name) : row.name}
                    </td>
                    <td class="mono def" title=${row.definition}>${highlightDefinition(row.definition)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `,
      )}
      ${sections.length
        ? ''
        : this.object
          ? columns.length
            ? ''
            : html`<p class="muted hint">Nothing to show.</p>`
          : html`<p class="muted hint">No constraints, indexes, or triggers.</p>`}
    `
  }

  private _renderColumnsTable(columns: TableInspection['columns']) {
    const hasComments = this.engine ? dialectFor(this.engine).supportsColumnComments : false
    return html`
      <h4>${this.object ? 'Attributes' : 'Columns'} <span class="count">${columns.length}</span></h4>
      <table class="columns-table">
        <colgroup>
          <col class="icon-col" />
          <col class="name-col" />
          <col class="type-col" />
          <col class="nullable-col" />
          <col />
          ${hasComments ? html`<col />` : ''}
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            ${hasComments ? html`<th>Comment</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${columns.map(
            (column) => html`
              <tr @contextmenu=${(event: MouseEvent) => this._onRowMenu(event, column.name)}>
                <td class="icon-cell">
                  ${column.primaryKey ? html`<i class="codicon codicon-key pk" aria-hidden="true" title="Primary key"></i>` : ''}
                </td>
                ${this._renderTextCell(column, 'name', 'mono clip', this._fieldText(column, 'name'))}
                ${this._renderTextCell(column, 'dataType', 'mono type clip', abbreviateType(this._fieldText(column, 'dataType'), this.engine))}
                ${this._renderNullableCell(column)}
                ${this._renderTextCell(column, 'default', 'mono muted clip', this._fieldText(column, 'default'))}
                ${hasComments ? this._renderTextCell(column, 'comment', 'muted clip', this._fieldText(column, 'comment')) : ''}
              </tr>
            `,
          )}
        </tbody>
      </table>
    `
  }

  // Type/nullable/default are editable on Postgres but not SQLite (which would
  // need a table rebuild); explain that on hover rather than leaving them inert.
  private _rebuildTip(field: EditField | 'nullable'): string | null {
    return this.engine === 'sqlite' && !this.object && field !== 'name'
      ? 'SQLite requires a table rebuild to change this'
      : null
  }

  private _renderTextCell(col: InspectColumn, field: EditField, cls: string, display: unknown) {
    const editable = this._canEdit(field)
    if (this._editing?.col === col.name && this._editing.field === field) {
      return html`
        <td class=${cls}>
          <input
            class="cell-input"
            .value=${this._editing.seed ?? this._fieldText(col, field)}
            @keydown=${(event: KeyboardEvent) => this._onEditKeydown(event, col, field)}
            @blur=${(event: FocusEvent) => {
              this._blurCommitAt = performance.now()
              this._commitText(col, field, (event.target as HTMLInputElement).value)
            }}
          />
        </td>
      `
    }
    const choices = field === 'dataType' && editable
    const classes = `${cls}${this._isEdited(col.name, field) ? ' edited' : ''}${editable ? ' editable' : ''}${choices ? ' has-choices' : ''}`
    return html`
      <td
        class=${classes}
        title=${this._rebuildTip(field) ?? this._fieldText(col, field)}
        @click=${editable ? () => this._onCellClick(col, field) : undefined}
      >
        ${display}${choices
          ? html`
              <button
                class="choices-btn"
                title="Choose type"
                aria-label="Choose type"
                @click=${(event: MouseEvent) => this._openTypeMenu(event, col)}
              >
                <i class="codicon codicon-chevron-down" aria-hidden="true"></i>
              </button>
            `
          : ''}
      </td>
    `
  }

  // Every cell edits inline on click; the type cell's end arrow opens the menu.
  private _onCellClick(col: InspectColumn, field: EditField) {
    if (this._dismissedEditor()) return
    this._startEdit(col.name, field)
  }

  private _openTypeMenu(event: MouseEvent, col: InspectColumn) {
    event.stopPropagation() // the cell behind it would start an inline edit
    if (this._dismissedEditor()) return
    this._cellMenu = { x: event.clientX, y: event.clientY, col, kind: 'type' }
  }

  private _renderNullableCell(col: InspectColumn) {
    const editable = this._canEdit('nullable')
    const classes = `muted${this._isEdited(col.name, 'nullable') ? ' edited' : ''}${editable ? ' editable has-choices' : ''}`
    return html`
      <td
        class=${classes}
        title=${this._rebuildTip('nullable') ?? ''}
        @click=${editable
          ? (event: MouseEvent) => {
              if (this._dismissedEditor()) return
              this._cellMenu = { x: event.clientX, y: event.clientY, col, kind: 'nullable' }
            }
          : undefined}
      >
        ${this._fieldNullable(col) ? 'yes' : 'no'}${editable
          ? html`
              <button class="choices-btn" tabindex="-1" aria-hidden="true">
                <i class="codicon codicon-chevron-down" aria-hidden="true"></i>
              </button>
            `
          : ''}
      </td>
    `
  }

  private _nullableItems(col: InspectColumn): MenuItem[] {
    const current = this._fieldNullable(col)
    return [
      { id: 'yes', label: 'yes — NULL allowed', checked: current },
      { id: 'no', label: 'no — NOT NULL', checked: !current },
    ]
  }

  // All of the engine's common types, the effective one check-marked (compared
  // by base name, so varchar(64) checks the varchar(255) template), plus a
  // Custom… escape hatch into the inline editor for anything else. A filter
  // (from Ctrl+Space) narrows by typed prefix; no match falls back to the lot.
  private _typeItems(col: InspectColumn, filter?: string): MenuItem[] {
    const base = (type: string) => abbreviateType(type, this.engine).replace(/\(.*/, '').trim()
    const current = base(this._fieldText(col, 'dataType'))
    const types = this.engine ? dialectFor(this.engine).commonColumnTypes : []
    const prefix = filter?.toLowerCase().replace(/\(.*/, '').trim() ?? ''
    const matches = prefix ? types.filter((type) => type.toLowerCase().startsWith(prefix)) : types
    return [
      ...(matches.length ? matches : types).map((type) => ({ id: `type:${type}`, label: type, checked: base(type) === current })),
      { id: 'custom', label: 'Custom…' },
    ]
  }

  // Template types — varchar(255), numeric(10,2) — open in the inline editor
  // with the parameters selected for adjustment; bare types commit directly.
  private _onCellMenuPick(menu: { col: InspectColumn; kind: 'nullable' | 'type' }, id: string) {
    if (menu.kind === 'nullable') return this._setNullable(menu.col, id === 'yes')
    if (id === 'custom') return this._startEdit(menu.col.name, 'dataType')
    const type = id.slice('type:'.length)
    if (type.includes('(')) return this._startEdit(menu.col.name, 'dataType', type)
    this._commitText(menu.col, 'dataType', type)
  }

  private _renderCellMenu() {
    const menu = this._cellMenu
    if (!menu) return ''
    const items = menu.kind === 'nullable' ? this._nullableItems(menu.col) : this._typeItems(menu.col, menu.filter)
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onCellMenuPick(menu, e.detail.id)}
        @menu-close=${() => (this._cellMenu = null)}
      ></context-menu>
    `
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }

      .scroll {
        height: 100%;
        overflow-y: auto;
        padding: 14px 18px 24px;
        box-sizing: border-box;
      }

      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }

      .head h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }

      .kind {
        padding: 1px 6px;
        border: 1px solid var(--border);
        border-radius: 3px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-3);
      }

      .refresh {
        display: inline-flex;
        padding: 3px;
        margin-left: auto;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .refresh:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      h4 {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 18px 0 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-2);
      }

      .count {
        font-weight: 400;
        color: var(--text-3);
      }

      .add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 1px;
        color: var(--on-accent);
        background: var(--accent);
        border: none;
        border-radius: 50%;
        cursor: pointer;
        letter-spacing: normal;
        line-height: 1;
      }

      .add-btn .codicon {
        font-size: 11px;
        margin: 1px 0 0 1px;
        -webkit-text-stroke: 0.6px currentColor;
      }

      .add-btn:hover {
        background: var(--accent-hover);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      td,
      th {
        padding: 3px 10px 3px 0;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle, var(--border));
        vertical-align: top;
      }

      th {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3);
      }

      .mono {
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      }

      .muted {
        color: var(--text-3);
      }

      .type {
        color: var(--text-2);
      }

      .icon-cell {
        width: 18px;
      }

      .icon-cell .pk {
        font-size: 12px;
        color: var(--status-dot-warning);
      }

      /* Fixed layout + a shared name-column width keeps every section's
         columns aligned with each other, however long one name gets. */
      .section-table,
      .columns-table {
        table-layout: fixed;
      }

      .icon-col {
        width: 18px;
      }

      .type-col {
        width: 140px;
      }

      .nullable-col {
        width: 70px;
      }

      .clip {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .name-col {
        width: 280px;
      }

      .name-cell {
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .def {
        color: var(--text-2);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .def .kw {
        font-weight: 600;
        /* The editor's keyword violet (sql-editor.ts softHighlightStyle), so
           definitions read as the same language as the editor. */
        color: #a163b5;
      }

      .hint {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
      }

      .error {
        margin: 10px 0;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--status-dot-error);
        white-space: pre-wrap;
      }

      td.editable:hover {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
      }

      /* Choice cells (type, nullable) keep a right gutter for the end arrow. */
      td.has-choices {
        position: relative;
        padding-right: 26px;
      }

      .choices-btn {
        position: absolute;
        top: 50%;
        right: 6px;
        transform: translateY(-50%);
        display: inline-flex;
        padding: 1px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-3);
        cursor: pointer;
        --codicon-size: 12px;
      }

      td.has-choices:hover .choices-btn {
        color: var(--text);
      }

      .choices-btn:hover {
        background: var(--list-hover);
      }

      /* Staged edit: the same amber pending tint the results grid uses for dirty
         cells, so a changed value reads consistently across both surfaces (and,
         like there, muted cells jump to full contrast). */
      td.edited,
      td.edited:hover {
        color: var(--text);
        background: color-mix(in srgb, var(--status-dot-warning) 14%, var(--editor-bg));
      }

      /* Overlays the cell padding (results-panel .cell-edit trick) so opening
         the editor never changes the row height or shifts content. */
      .cell-input {
        width: calc(100% + 5px);
        box-sizing: border-box;
        margin: -3px 0 -3px -5px;
        padding: 2px 4px;
        font: inherit;
        color: var(--text);
        background: var(--editor-bg);
        border: 1px solid var(--accent);
        border-radius: 3px;
        outline: none;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'table-inspect': TableInspect
  }
}
