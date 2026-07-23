import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, scrollbars, typography } from '../shared-styles'
import type { ColumnRef, DbObject, DbObjectKind, Engine, InspectColumn, ObjectDdlRef, TableInspection, TableRef } from '../electron'
import { dialectFor } from '../dialect'
import { cellsToTsv } from '../result-export'
import { buildCreateTable, canAddConstraint, type ColumnAdd, type ColumnAlter } from '../sql-write'
import './context-menu'
import './inspect-add-dialog'
import type { AddObjectDetail, AddObjectKind } from './inspect-add-dialog'
import type { MenuItem, MenuPickDetail } from './context-menu'
import { TABLE_KIND_ICONS, tableKindLabel } from '../table-kinds'
import {
  buildInspectOperation,
  canDropInspectObject,
  canRenameInspectObject,
  operationName,
  operationSection,
  operationSourceName,
  type InspectDropTarget,
  type InspectOperation,
} from '../inspect-operations'
import { t } from '../i18n'

// A column property the user can edit inline (click). Nullable is edited via a
// yes/no menu; primary key stays read-only. Capabilities come from the dialect.
type EditField = 'name' | 'dataType' | 'comment' | 'default'

// One column's staged edits — the fields that differ from what was loaded.
// `drop: true` stages removing the column and replaces any field edits.
type ColumnDiff = Partial<Omit<ColumnAlter, 'original'>> & { drop?: boolean }
type DraftSnapshot = { edits: Map<string, ColumnDiff>; operations: InspectOperation[]; tableName: string | null }

const draftCache = new Map<string, { snapshot: DraftSnapshot; history: DraftSnapshot[]; historyIndex: number; addSeq: number }>()

export const clearInspectDraftCache = () => draftCache.clear()
export const dropInspectDraft = (tabId: string) => draftCache.delete(tabId)

// Right-click menu state. `col`/`field` are set for the columns table (they
// gate the reset items); the section tables leave them undefined.
type RowMenu = {
  x: number
  y: number
  name: string
  definition: string | null
  col?: InspectColumn
  field?: EditField | 'nullable'
  section?: string
  operationIndex?: number
  readonly?: boolean
}

// Emitted on ⌘S / Save so the workbench routes the change through SchemaOps
// (build DDL → review dialog → runDdl). `onApplied` reloads this tab on success.
export type ColumnAlterEventDetail = {
  tabId: string
  profileId: string
  childDb: string | null
  table: TableRef
  engine: Engine
  edits: ColumnAlter[]
  additions: ColumnAdd[]
  operations: InspectOperation[]
  createTable?: boolean
  /** Original names of columns staged for DROP COLUMN. */
  drops: string[]
  onApplied: () => void
}

// New-column rows key off a NUL-prefixed sentinel (never a real identifier) so
// they live in `_edits` alongside real-column diffs and ride the same
// undo/redo, dirty, and reload machinery. The placeholder name/type keep a
// fresh row valid without forcing input.
const ADD_KEY_PREFIX = `${String.fromCharCode(0)}add:`
const NEW_COLUMN_NAME = 'new_column'

// Canonical table-inspect sections per engine, in display order — what a table
// *could* have, shown at 0 when empty so the section is still reachable.
const ENGINE_SECTIONS: Record<Engine, string[]> = {
  postgresql: ['Foreign Keys', 'Constraints', 'Indexes', 'Partitions', 'Triggers', 'Rules', 'Policies', 'Storage'],
  mysql: ['Foreign Keys', 'Constraints', 'Indexes', 'Partitions', 'Triggers'],
  sqlserver: ['Foreign Keys', 'Constraints', 'Indexes', 'Triggers'],
  sqlite: ['Foreign Keys', 'Constraints', 'Indexes', 'Triggers'],
}

// Never synthesized: their absence is a fact (not partitioned / no storage),
// not an empty list — and Partitions' + would emit invalid DDL if offered.
const PRESENT_ONLY_SECTIONS = new Set(['Partitions', 'Storage'])

/** Grid id of the columns table in cell selection; sections use their index. */
const COLUMNS_GRID = -1

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

// Cap on the inline-edit undo depth; the oldest steps fall off once past this so
// a long inspect session can't grow the snapshot stack without bound.
const MAX_EDIT_HISTORY = 100

// The Inspect tab's body: one table's structure — columns up top, then the
// engine's sections (foreign keys, constraints, indexes, partitions,
// triggers, rules, policies). Fetches its own data from the profile so the
// workbench only mounts it; re-fetches when retargeted to another table.
@customElement('table-inspect')
export class TableInspect extends LitElement {
  @property()
  tabId = ''

  @property()
  profileId = ''

  /** Child database this inspect tab belongs to (all-databases mode); null otherwise. */
  @property()
  childDb: string | null = null

  @property({ attribute: false })
  table: TableRef | null = null

  @property({ type: Boolean })
  createTable = false

  /** Alternative target: a schema object (function/type) instead of a table. */
  @property({ attribute: false })
  object: DbObject | null = null

  @property()
  objectKind: DbObjectKind | null = null

  @property()
  engine: Engine | null = null

  @property({ attribute: false })
  tables: TableRef[] = []

  @property({ attribute: false })
  referenceColumns: ColumnRef[] = []

  @property({ attribute: false })
  functions: DbObject[] = []

  @state()
  private _state: { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'done'; inspection: TableInspection } = {
    phase: 'loading',
  }

  @state()
  private _menu: RowMenu | null = null

  /** Open section add dialog (index/trigger/partition), if any. */
  @state()
  private _addDialog: AddObjectKind | null = null

  /** When the add dialog is editing a staged op, its index; null when adding. */
  @state()
  private _editOperationIndex: number | null = null

  @state()
  private _operations: InspectOperation[] = []

  /** Staged column edits, keyed by the column's original name. */
  @state()
  private _edits = new Map<string, ColumnDiff>()

  /** Undo/redo stack for the complete Inspect draft. */
  private _history: DraftSnapshot[] = [{ edits: new Map(), operations: [], tableName: null }]

  private _historyIndex = 0

  /** Monotonic counter for unique new-column keys; never reused so undo/redo can't collide. */
  private _addSeq = 0

  /** The cell in inline-edit mode; `seed` pre-fills the editor (type templates). */
  @state()
  private _editing: { col: string; field: EditField; seed?: string } | null = null

  @state()
  private _sectionEditing: {
    section: string
    from: string
    value: string
    operationIndex?: number
    seed?: string
  } | null = null

  @state()
  private _createName = ''

  @state()
  private _tableNameEditing = false

  /** Save-time validation failure (duplicate names); cleared by the next edit. */
  @state()
  private _saveError: string | null = null

  /** Selected cell rectangle (results-grid style): anchor (r0,c0) → focus
   * (r1,c1) within one grid — the columns table or one section table. */
  @state()
  private _sel: { grid: number; r0: number; c0: number; r1: number; c1: number } | null = null

  private _selDragging = false

  /** Whether the current press swept past its starting cell (a range gesture). */
  private _selDragMoved = false

  /** The option menu open on a nullable cell. Type choices use an input-anchored picker. */
  @state()
  private _cellMenu: { x: number; y: number; width: number; col: InspectColumn; kind: 'nullable'; active: number } | null = null

  /** Type autocomplete anchored below the inline type editor. */
  @state()
  private _typePicker: { x: number; y: number; width: number; col: InspectColumn; filter: string; active: number } | null = null

  /** Default expression suggestions anchored below the inline default editor. */
  @state()
  private _defaultPicker: { x: number; y: number; width: number; col: InspectColumn; filter: string; active: number } | null = null

  private _selectFirstTypeOption = false

  private _selectFirstDefaultOption = false

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('mousedown', this._onWindowMouseDown, true)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    // No stash here: every mutation already stashes, and re-stashing on unmount
    // would resurrect a draft the workbench just dropped when closing the tab.
    window.removeEventListener('mousedown', this._onWindowMouseDown, true)
    this._endSelDrag()
  }

  // Closes any open picker on an outside mousedown. The nullable cell is spared
  // so a click on it reaches its own toggle instead of being closed-then-reopened.
  private _onWindowMouseDown = (event: MouseEvent) => {
    const path = event.composedPath()
    const inside = (cls: string) => path.some((node) => node instanceof HTMLElement && node.classList.contains(cls))
    if (inside('type-picker') || inside('choices-btn') || inside('cell-input') || inside('nullable-cell')) return
    this._cellMenu = null
    this._typePicker = null
    this._defaultPicker = null
  }

  protected willUpdate(changed: PropertyValues) {
    if (
      changed.has('profileId') ||
      changed.has('childDb') ||
      changed.has('table') ||
      changed.has('object') ||
      changed.has('objectKind')
      || changed.has('createTable')
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
      else if (seed) input.setSelectionRange(seed.length, seed.length) // type-to-edit: keep typing after the seed char
      else input.select()
      if (this._editing.field === 'dataType' && this._selectFirstTypeOption) {
        const col = this._editingColumn()
        if (col) this._showTypePicker(input, col, '', 0)
        this._selectFirstTypeOption = false
      }
      if (this._editing.field === 'default' && this._selectFirstDefaultOption) {
        const col = this._editingColumn()
        if (col) this._showDefaultPicker(input, col, '', 0)
        this._selectFirstDefaultOption = false
      }
    }
    if (changed.has('_sectionEditing') && this._sectionEditing) {
      const input = this.renderRoot.querySelector<HTMLInputElement>('.object-name-input')
      if (input) {
        input.focus()
        if (this._sectionEditing.seed) input.setSelectionRange(input.value.length, input.value.length)
        else input.select()
      }
    }
    if (changed.has('_tableNameEditing') && this._tableNameEditing) {
      const input = this.renderRoot.querySelector<HTMLInputElement>('.table-name-input')
      input?.focus()
      input?.select()
    }
    // Surface the dirty state so the workbench can mark the tab (the • marker).
    if (changed.has('_edits') || changed.has('_operations')) {
      this.dispatchEvent(
        new CustomEvent('inspect-dirty', {
          detail: { tabId: this.tabId, dirty: this.hasPendingChanges() },
          bubbles: true,
          composed: true,
        }),
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
    this._restoreDraft()
    this._editing = null
    this._sectionEditing = null
    this._cellMenu = null
    this._typePicker = null
    this._defaultPicker = null
    this._saveError = null
    this._sel = null
    this._tableNameEditing = false
    this._closeAddDialog()
    if (this.createTable && table) {
      this._state = { phase: 'done', inspection: { columns: [], sections: [] } }
      return
    }
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

  private _restoreDraft() {
    const cached = this.tabId ? draftCache.get(this.tabId) : undefined
    if (cached) {
      this._edits = new Map(cached.snapshot.edits)
      this._operations = [...cached.snapshot.operations]
      this._createName = cached.snapshot.tableName ?? this.table?.name ?? ''
      this._history = cached.history.map((snapshot) => ({
        edits: new Map(snapshot.edits),
        operations: [...snapshot.operations],
        tableName: snapshot.tableName,
      }))
      this._historyIndex = cached.historyIndex
      this._addSeq = cached.addSeq
      return
    }
    this._createName = this.table?.name ?? ''
    this._edits = this.createTable ? this._seedCreateEdits() : new Map<string, ColumnDiff>()
    this._operations = []
    this._history = [{ edits: new Map(this._edits), operations: [], tableName: this.createTable ? this._createName : null }]
    this._historyIndex = 0
    this._addSeq = this.createTable ? 1 : 0
  }

  // A fresh create-table draft starts with one id column. SQLite needs a plain
  // INTEGER so a later PRIMARY KEY becomes a rowid alias; other engines use bigint.
  private _seedCreateEdits(): Map<string, ColumnDiff> {
    const dataType = this.engine === 'sqlite' ? 'integer' : 'bigint'
    return new Map<string, ColumnDiff>([[`${ADD_KEY_PREFIX}0`, { name: 'id', dataType, nullable: false }]])
  }

  private _stashDraft() {
    if (!this.tabId) return
    if (!this.hasPendingChanges()) {
      draftCache.delete(this.tabId)
      return
    }
    draftCache.set(this.tabId, {
      snapshot: { edits: new Map(this._edits), operations: [...this._operations], tableName: this.createTable ? this._createName : null },
      history: this._history.map((snapshot) => ({
        edits: new Map(snapshot.edits),
        operations: [...snapshot.operations],
        tableName: snapshot.tableName,
      })),
      historyIndex: this._historyIndex,
      addSeq: this._addSeq,
    })
  }

  render() {
    const target = this.object ?? this.table
    if (!target) return ''
    const label = target.schema ? `${target.schema}.${target.name}` : target.name
    const icon = this.object
      ? this.objectKind === 'function'
        ? 'icon-square-function'
        : this.object.detail === 'enum'
          ? 'icon-list'
          : 'icon-boxes'
      : (TABLE_KIND_ICONS[this.table!.kind] ?? 'icon-table')
    const badge = this.object
      ? this.objectKind === 'function'
        ? 'function'
        : this.object.detail
      : this.table!.kind !== 'table'
        ? tableKindLabel(this.table!.kind)
        : ''
    return html`
      <div class="scroll">
        <div class="head">
          <i class="icon ${icon}" aria-hidden="true"></i>
          <h3 class=${this.createTable ? 'create-table-name' : ''} @click=${() => {
            if (this.createTable) this._tableNameEditing = true
          }}>
            ${this.createTable && this._tableNameEditing
              ? html`<input
                  class="table-name-input"
                  .value=${this._createName}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      this._tableNameEditing = false
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      ;(event.currentTarget as HTMLInputElement).blur()
                    }
                  }}
                  @blur=${(event: FocusEvent) => this._commitCreateName((event.currentTarget as HTMLInputElement).value)}
                />`
              : this.createTable
                ? `${target.schema ? `${target.schema}.` : ''}${this._createName}`
                : label}
          </h3>
          ${badge ? html`<span class="kind">${badge}</span>` : ''}
          ${this.createTable
            ? html`<span class="head-spacer"></span>`
            : html`<button class="refresh" title=${t('inspect.reload')} aria-label=${t('inspect.reload')} @click=${() => void this._load()}>
                <i class="icon icon-refresh-cw" aria-hidden="true"></i>
              </button>`}
          ${this.hasPendingChanges()
            ? html`
                <button class="draft-action" @click=${this.discard}>${t('common.discard')}</button>
                <button class="draft-action primary" @click=${() => this.save()}>${t('common.save')}</button>
              `
            : ''}
        </div>
        ${this._renderBody()}
      </div>
      ${this._renderMenu()} ${this._renderCellMenu()} ${this._renderTypePicker()}
      ${this._renderDefaultPicker()} ${this._renderAddDialog()}
    `
  }

  private _renderAddDialog() {
    if (!this._addDialog || !this.table || !this.engine) return ''
    const table = this._effectiveTable()
    if (!table) return ''
    const editing = this._editOperationIndex != null ? this._operations[this._editOperationIndex] ?? null : null
    return html`
      <inspect-add-dialog
        .kind=${this._addDialog}
        .table=${table}
        .engine=${this.engine}
        .createTable=${this.createTable}
        .operation=${editing}
        .columns=${this._effectiveColumnNames()}
        .tables=${this.tables}
        .referenceColumns=${this._effectiveReferenceColumns()}
        .functions=${this.functions}
        @dialog-cancel=${this._closeAddDialog}
        @add-ddl=${this._onAddDdl}
      ></inspect-add-dialog>
    `
  }

  // Opens the add dialog pre-filled with a staged op so it can be edited in full.
  private _editOperation(index: number) {
    const operation = this._operations[index]
    if (!operation || operation.kind === 'drop' || operation.kind === 'rename') return
    this._editOperationIndex = index
    this._addDialog = operation.kind
  }

  private _closeAddDialog = () => {
    this._addDialog = null
    this._editOperationIndex = null
  }

  private _onAddDdl(event: CustomEvent<AddObjectDetail>) {
    event.stopPropagation()
    const index = this._editOperationIndex
    const operations = index != null
      ? this._operations.map((operation, position) => position === index ? event.detail.operation : operation)
      : [...this._operations, event.detail.operation]
    this._commitDraft(this._edits, operations)
    this._closeAddDialog()
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const items: MenuItem[] = [{ id: 'copy-name', label: t('inspect.copyName') }]
    if (menu.definition) items.push({ id: 'copy-definition', label: t('inspect.copyDefinition') })
    if (this._editableDdlRef()) items.push({ id: 'edit-ddl', label: t('inspect.editSource'), separatorBefore: true })
    const dropTarget = menu.section ? this._dropTarget(menu.section) : null
    if (menu.operationIndex !== undefined) {
      const staged = this._operations[menu.operationIndex]
      // Add-family staged ops (index/trigger/FK/constraint/partition) reopen their
      // full dialog to edit; a staged rename only re-edits its target name.
      if (staged && staged.kind !== 'drop' && staged.kind !== 'rename') {
        items.push({ id: 'edit-object', label: t('common.edit') })
      } else if (menu.section && this._canRenameSectionObject(menu.section, menu.operationIndex)) {
        items.push({ id: 'rename-object', label: t('common.rename') })
      }
      items.push({ id: 'remove-staged-operation', label: t('inspect.removeStaged') })
    } else if (dropTarget && !menu.readonly) {
      if (menu.section && this._canRenameSectionObject(menu.section)) {
        items.push({ id: 'rename-object', label: t('common.rename') })
      }
      const labels: Record<InspectDropTarget, string> = {
        index: t('inspect.dropIndex'),
        trigger: t('inspect.dropTrigger'),
        foreignKey: t('inspect.dropForeignKey'),
        constraint: t('inspect.dropConstraint'),
      }
      items.push({ id: 'drop-object', label: labels[dropTarget], danger: true })
    } else if (menu.col && this._isAddition(menu.col.name)) {
      items.push({ id: 'remove-column', label: t('inspect.removeColumn') })
    } else if (menu.col && this._isDropped(menu.col.name)) {
      items.push({ id: 'restore-column', label: t('inspect.restoreColumn') })
    } else {
      if (menu.col && menu.field && this._isEdited(menu.col.name, menu.field)) {
        items.push({ id: 'reset-field', label: t('inspect.resetTo', { value: this._resetLabel(menu.col, menu.field) }) })
      }
      if (menu.col && this._edits.has(menu.col.name)) items.push({ id: 'reset-row', label: t('inspect.resetRow') })
      if (menu.col && this._canDropColumn()) items.push({ id: 'drop-column', label: t('inspect.dropColumn') })
    }
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onMenuPick(e.detail.id, menu)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  // Label the reset item with the value the cell will snap back to, quoting the
  // empty case and clipping anything long enough to blow out the menu width.
  private _resetLabel(col: InspectColumn, field: EditField | 'nullable'): string {
    const original = field === 'nullable' ? t(col.nullable ? 'common.yes' : 'common.no') : this._fieldOriginal(col, field)
    if (original === '') return t('common.empty')
    return original.length > 32 ? `${original.slice(0, 32)}…` : original
  }

  // The function/view whose CREATE DDL the "Edit Source" action opens, or null
  // when the inspected target has no editable DDL (a plain table, a type, a new
  // table draft).
  private _editableDdlRef(): ObjectDdlRef | null {
    if (this.object && this.objectKind === 'function') {
      return { schema: this.object.schema, name: this.object.name, kind: 'function', detail: this.object.detail }
    }
    const table = this.table
    if (!this.createTable && table && (table.kind === 'view' || table.kind === 'matview')) {
      return { schema: table.schema, name: table.name, kind: table.kind, detail: null }
    }
    return null
  }

  private _onMenuPick(id: string, menu: RowMenu) {
    if (id === 'copy-name') return void window.sqlkit.writeClipboardText(menu.name)
    if (id === 'copy-definition') return void window.sqlkit.writeClipboardText(menu.definition ?? '')
    if (id === 'edit-ddl') {
      const ref = this._editableDdlRef()
      if (ref) this.dispatchEvent(new CustomEvent<{ ref: ObjectDdlRef }>('object-edit', { detail: { ref }, bubbles: true, composed: true }))
      return
    }
    if (id === 'edit-object' && menu.operationIndex !== undefined) return this._editOperation(menu.operationIndex)
    if (id === 'rename-object' && menu.section) return this._beginSectionRename(menu.section, menu.name)
    if (id === 'remove-staged-operation' && menu.operationIndex !== undefined) {
      this._commitDraft(this._edits, this._operations.filter((_, index) => index !== menu.operationIndex))
    } else if (id === 'drop-object' && menu.section) {
      const target = this._dropTarget(menu.section)
      if (target) this._commitDraft(this._edits, [...this._operations, { kind: 'drop', target, name: menu.name }])
    } else if (id === 'remove-column' && menu.col) this._removeAddition(menu.col.name)
    else if (id === 'drop-column' && menu.col) this._dropColumn(menu.col)
    else if (id === 'restore-column' && menu.col) this._resetRow(menu.col)
    else if (id === 'reset-field' && menu.col && menu.field) this._resetField(menu.col, menu.field)
    else if (id === 'reset-row' && menu.col) this._resetRow(menu.col)
  }

  private _onRowMenu(
    event: MouseEvent,
    name: string,
    definition: string | null = null,
    section?: string,
    operationIndex?: number,
    readonly = false,
  ) {
    event.preventDefault()
    // Same as the columns table: right-click lands the selection on the cell.
    const hit = this._cellAt(event.target as Element)
    if (hit && !this._isSelected(hit.grid, hit.row, hit.col)) {
      this._sel = { grid: hit.grid, r0: hit.row, c0: hit.col, r1: hit.row, c1: hit.col }
    }
    this._menu = { x: event.clientX, y: event.clientY, name, definition, section, operationIndex, readonly }
  }

  private _dropTarget(section: string): InspectDropTarget | null {
    const target = this._objectTarget(section)
    return target && this.engine && canDropInspectObject(target, this.engine) ? target : null
  }

  private _objectTarget(section: string): InspectDropTarget | null {
    const targets: Partial<Record<string, InspectDropTarget>> = {
      Indexes: 'index',
      Triggers: 'trigger',
      'Foreign Keys': 'foreignKey',
      Constraints: 'constraint',
    }
    return targets[section] ?? null
  }

  // An existing primary key is listed in Constraints for reference (like an FK),
  // but is managed through the columns, so its row is read-only — no drop/rename.
  // Staged PKs (operationIndex >= 0) stay editable while the draft is built.
  private _isReadonlyRow(section: string, definition: string | null, staged: boolean): boolean {
    return !staged && section === 'Constraints' && /^PRIMARY KEY\b/i.test(definition ?? '')
  }

  private _canRenameSectionObject(section: string, operationIndex = -1): boolean {
    const operation = operationIndex >= 0 ? this._operations[operationIndex] : undefined
    // A staged add carries its name on the pending spec — edit it in place, no
    // DDL rename, so the engine's rename capability doesn't gate it.
    if (operation && operation.kind !== 'rename' && operation.kind !== 'drop') return true
    const target = this._objectTarget(section)
    if (!target || !this.engine || !canRenameInspectObject(target, this.engine)) return false
    return operationIndex < 0 || operation?.kind === 'rename'
  }

  // The columns table's row menu is cell-aware: which <td> was right-clicked
  // (via data-field) decides whether a "Reset to …" item shows for that field.
  private _onColumnMenu(event: MouseEvent, col: InspectColumn) {
    event.preventDefault()
    const cell = (event.target as HTMLElement).closest<HTMLElement>('td')
    const field = cell?.dataset.field as EditField | 'nullable' | undefined
    // Right-click outside the current selection collapses it onto that cell.
    const hit = this._cellAt(event.target as Element)
    if (hit && !this._isSelected(hit.grid, hit.row, hit.col)) {
      this._sel = { grid: hit.grid, r0: hit.row, c0: hit.col, r1: hit.row, c1: hit.col }
    }
    // Copy the visible name (a staged rename or addition), not the original.
    const name = this._fieldText(col, 'name')
    this._menu = { x: event.clientX, y: event.clientY, name, definition: null, col, field }
  }

  // --- cell selection (results-grid style) ------------------------------------

  // The selection's coordinate space: loaded columns then staged additions (rows)
  // by the engine's visible fields (cols).
  private _gridRows(): InspectColumn[] {
    const columns = this._state.phase === 'done' ? this._state.inspection.columns : []
    return [...columns, ...this._additionColumns()]
  }

  private _effectiveColumnNames(): string[] {
    if (this._state.phase !== 'done') return []
    const loaded = this._state.inspection.columns
      .filter((column) => !this._isDropped(column.name))
      .map((column) => String(this._fieldText(column, 'name')).trim())
    const additions = this._additionColumns().map((column) => String(this._fieldText(column, 'name')).trim())
    return [...loaded, ...additions].filter(Boolean)
  }

  private _effectiveTable(): TableRef | null {
    if (!this.table) return null
    return this.createTable ? { ...this.table, name: this._createName.trim() } : this.table
  }

  private _effectiveReferenceColumns(): ColumnRef[] {
    if (!this.table || this._state.phase !== 'done') return this.referenceColumns
    const table = this._effectiveTable()!
    const sameTable = (column: ColumnRef) => column.table === table.name && column.schema === table.schema
    const others = this.referenceColumns.filter((column) => !sameTable(column))
    const current = this._gridRows()
      .filter((column) => !this._isDropped(column.name))
      .map((column) => ({
        schema: table.schema,
        table: table.name,
        name: String(this._fieldText(column, 'name')),
        dataType: String(this._fieldText(column, 'dataType')),
        nullable: this._fieldNullable(column),
        primaryKey: column.primaryKey,
        foreignKey: column.foreignKey ?? false,
      }))
    return [...others, ...current]
  }

  // A grid's cell fields, in column order. Section tables are name + definition.
  private _gridFields(grid: number): string[] {
    if (grid !== COLUMNS_GRID) return ['name', 'definition']
    const hasComments = this.engine ? dialectFor(this.engine).supportsColumnComments : false
    return hasComments ? ['name', 'dataType', 'nullable', 'default', 'comment'] : ['name', 'dataType', 'nullable', 'default']
  }

  // The sections as rendered (scaffold included): every grid index means this.
  private _sections(): TableInspection['sections'] {
    if (this._state.phase !== 'done') return []
    const sections = this._displaySections(this._state.inspection.sections).map((section) => ({
      ...section,
      rows: [...section.rows],
    }))
    if (!this.table || !this.engine) return sections
    const table = this._effectiveTable()!
    for (const operation of this._operations) {
      const title = operationSection(operation)
      let section = sections.find((candidate) => candidate.title === title)
      if (!section) {
        section = { title, rows: [] }
        sections.push(section)
      }
      const stagedRow = {
        name: operationName(operation),
        definition: buildInspectOperation(table, operation, this.engine, this.createTable),
      }
      const changedRow = operation.kind === 'drop' || operation.kind === 'rename'
        ? section.rows.findIndex((row) => row.name === operationSourceName(operation))
        : -1
      if (changedRow >= 0) section.rows[changedRow] = stagedRow
      else section.rows.push(stagedRow)
    }
    return sections
  }

  private _gridRowCount(grid: number): number {
    if (grid === COLUMNS_GRID) return this._gridRows().length
    return this._sections()[grid]?.rows.length ?? 0
  }

  private _stagedOperationIndex(section: string, rowName: string): number {
    return this._operations.findIndex((operation) => operationSection(operation) === section && operationName(operation) === rowName)
  }

  // The grid coordinate of a DOM node's cell; null off any grid (icon cell, header).
  private _cellAt(node: Element | null): { grid: number; row: number; col: number } | null {
    const cell = node?.closest<HTMLTableCellElement>('td[data-field]')
    const grid = Number(cell?.closest('table')?.dataset.grid ?? NaN)
    const row = Number(cell?.closest('tr')?.dataset.row ?? -1)
    if (!Number.isFinite(grid) || row < 0) return null
    const col = this._gridFields(grid).indexOf(cell?.dataset.field ?? '')
    return col >= 0 ? { grid, row, col } : null
  }

  private _isSelected(grid: number, row: number, col: number): boolean {
    const s = this._sel
    if (!s || s.grid !== grid) return false
    return row >= Math.min(s.r0, s.r1) && row <= Math.max(s.r0, s.r1) && col >= Math.min(s.c0, s.c1) && col <= Math.max(s.c0, s.c1)
  }

  // A press selects the cell; shift extends and press-and-drag sweeps a
  // rectangle. The follow-up click (below) opens the editor for a plain click.
  private _onGridPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.cell-input') || target.closest('button')) return
    const hit = this._cellAt(target)
    if (!hit) return
    ;(event.currentTarget as HTMLElement).focus()
    event.preventDefault() // keep focus on the table; no native text selection
    this._selDragMoved = false
    if (event.shiftKey && this._sel?.grid === hit.grid) {
      this._sel = { ...this._sel, r1: hit.row, c1: hit.col }
      return
    }
    this._sel = { grid: hit.grid, r0: hit.row, c0: hit.col, r1: hit.row, c1: hit.col }
    this._selDragging = true
    window.addEventListener('pointermove', this._onSelDragMove)
    window.addEventListener('pointerup', this._endSelDrag)
    window.addEventListener('pointercancel', this._endSelDrag)
  }

  private _onSelDragMove = (event: PointerEvent) => {
    if (!this._selDragging || !this._sel) return
    // elementFromPoint must go through the shadow root to see inside it; a drag
    // never crosses into another grid.
    const hit = this._cellAt(this.shadowRoot?.elementFromPoint(event.clientX, event.clientY) ?? null)
    if (!hit || hit.grid !== this._sel.grid || (hit.row === this._sel.r1 && hit.col === this._sel.c1)) return
    this._selDragMoved = true
    this._sel = { ...this._sel, r1: hit.row, c1: hit.col }
  }

  private _endSelDrag = () => {
    if (!this._selDragging) return
    this._selDragging = false
    window.removeEventListener('pointermove', this._onSelDragMove)
    window.removeEventListener('pointerup', this._endSelDrag)
    window.removeEventListener('pointercancel', this._endSelDrag)
  }

  // A completed plain click opens the cell's editor (the classic gesture);
  // shift-clicks and drags that swept past the starting cell stay selection-only.
  // In section grids, only supported object-name cells open an editor;
  // definitions and unsupported dialects remain selection-only.
  private _onGridClick = (event: MouseEvent) => {
    if (event.shiftKey || this._selDragMoved) return
    if ((event.target as HTMLElement).closest('.cell-input, button')) return
    const hit = this._cellAt(event.target as Element)
    if (hit?.grid === COLUMNS_GRID) this._editCell(hit.row, hit.col, null)
    else if (hit?.col === 0) this._editSectionCell(hit.grid, hit.row, null)
  }

  // Opens the editor (or the nullable picker) on a grid cell; `seed` carries a
  // type-to-edit char. Locked cells stay selectable/copyable but never edit.
  private _editCell(row: number, col: number, seed: string | null) {
    const column = this._gridRows()[row]
    const field = this._gridFields(COLUMNS_GRID)[col] as EditField | 'nullable' | undefined
    if (!column || !field || !this._canEdit(field, column)) return
    if (field === 'nullable') {
      if (seed) return
      const cell = this.shadowRoot?.querySelector<HTMLElement>(`tr[data-row="${row}"] td[data-field="nullable"]`)
      if (cell) this._openNullablePicker(cell, column)
      return
    }
    this._startEdit(column.name, field, seed ?? undefined)
  }

  private _onGridKeydown = (event: KeyboardEvent) => {
    // The inline editor's input lives inside the table; its keys are its own.
    if (this._editing || this._sectionEditing || (event.target as HTMLElement).closest('.cell-input')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      this._copySelection()
      return
    }
    if (event.key === 'Escape') {
      if (this._cellMenu) this._cellMenu = null
      else this._sel = null
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !this._sel) return
    const anchor = { row: Math.min(this._sel.r0, this._sel.r1), col: Math.min(this._sel.c0, this._sel.c1) }
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); return this._moveSel(1, 0, event.shiftKey)
      case 'ArrowUp': event.preventDefault(); return this._moveSel(-1, 0, event.shiftKey)
      case 'ArrowRight': event.preventDefault(); return this._moveSel(0, 1, event.shiftKey)
      case 'ArrowLeft': event.preventDefault(); return this._moveSel(0, -1, event.shiftKey)
      case 'Enter':
      case 'F2':
        event.preventDefault()
        if (this._sel.grid === COLUMNS_GRID) this._editCell(anchor.row, anchor.col, null)
        else if (anchor.col === 0) this._editSectionCell(this._sel.grid, anchor.row, null)
        return
      default:
        // Type-to-edit: a printable key opens the editor seeded with that char.
        if (event.key.length === 1) {
          event.preventDefault()
          if (this._sel.grid === COLUMNS_GRID) this._editCell(anchor.row, anchor.col, event.key)
          else if (anchor.col === 0) this._editSectionCell(this._sel.grid, anchor.row, event.key)
        }
    }
  }

  // Enters name-edit on a section row addressed by section + current name;
  // used by the row context menu's Rename item (clicking the cell is the other).
  private _beginSectionRename(section: string, name: string) {
    const sections = this._sections()
    const grid = sections.findIndex((candidate) => candidate.title === section)
    const row = grid >= 0 ? sections[grid]!.rows.findIndex((item) => item.name === name) : -1
    if (grid >= 0 && row >= 0) this._editSectionCell(grid, row, null)
  }

  private _editSectionCell(grid: number, row: number, seed: string | null) {
    const section = this._sections()[grid]
    const item = section?.rows[row]
    if (!section || !item) return
    const operationIndex = this._stagedOperationIndex(section.title, item.name)
    if (this._isReadonlyRow(section.title, item.definition, operationIndex >= 0)) return
    if (!this._canRenameSectionObject(section.title, operationIndex)) return
    this._flushEdit()
    const operation = operationIndex >= 0 ? this._operations[operationIndex] : undefined
    const value = item.name
    this._sectionEditing = {
      section: section.title,
      from: operation?.kind === 'rename' ? operation.from : value,
      value,
      operationIndex: operationIndex >= 0 ? operationIndex : undefined,
      seed: seed ?? undefined,
    }
  }

  private _commitSectionRename(raw: string) {
    const editing = this._sectionEditing
    if (!editing) return
    this._sectionEditing = null
    const to = raw.trim()
    if (!to || to === editing.value) return
    const section = this._sections().find((candidate) => candidate.title === editing.section)
    const duplicate = section?.rows.some((row) => {
      const name = row.name
      return name !== editing.value && name === to
    })
    if (duplicate) {
      this._saveError = `Duplicate ${editing.section.toLowerCase()} name "${to}" — choose another name.`
      return
    }
    // Renaming a staged add: rewrite the pending spec's name in place rather
    // than staging a DDL rename against an object that doesn't exist yet.
    if (editing.operationIndex !== undefined) {
      const staged = this._operations[editing.operationIndex]
      if (staged && staged.kind !== 'rename' && staged.kind !== 'drop') {
        const renamed = { ...staged, spec: { ...staged.spec, name: to } } as InspectOperation
        this._commitDraft(this._edits, this._operations.map((item, index) => index === editing.operationIndex ? renamed : item))
        return
      }
    }
    const target = this._objectTarget(editing.section)
    if (!target || !this.engine || !canRenameInspectObject(target, this.engine)) return
    const operation: InspectOperation = { kind: 'rename', target, from: editing.from, to }
    if (editing.operationIndex === undefined) {
      this._commitDraft(this._edits, [...this._operations, operation])
    } else if (to === editing.from) {
      this._commitDraft(this._edits, this._operations.filter((_, index) => index !== editing.operationIndex))
    } else {
      this._commitDraft(this._edits, this._operations.map((item, index) => index === editing.operationIndex ? operation : item))
    }
  }

  // Moves the focus cell by (dRow, dCol); shift keeps the anchor and grows the
  // rectangle, otherwise the selection collapses onto the new cell.
  private _moveSel(dRow: number, dCol: number, extend: boolean) {
    const s = this._sel
    const rows = s ? this._gridRowCount(s.grid) : 0
    const cols = s ? this._gridFields(s.grid).length : 0
    if (!s || !rows || !cols) return
    const r = Math.max(0, Math.min(rows - 1, s.r1 + dRow))
    const c = Math.max(0, Math.min(cols - 1, s.c1 + dCol))
    this._sel = extend ? { ...s, r1: r, c1: c } : { ...s, r0: r, c0: c, r1: r, c1: c }
    const cell = this.shadowRoot?.querySelector(
      `table[data-grid="${s.grid}"] tr[data-row="${r}"] td[data-field="${this._gridFields(s.grid)[c]}"]`,
    )
    // jsdom has no scrollIntoView; the guard keeps tests off the DOM shim.
    if (cell && typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest' })
  }

  // A grid cell's effective value for copying: staged column values in the
  // columns table, raw name/definition in the sections.
  private _cellValue(grid: number, row: number, field: string): string {
    if (grid !== COLUMNS_GRID) {
      const item = this._sections()[grid]?.rows[row]
      return (field === 'name' ? item?.name : item?.definition) ?? ''
    }
    const column = this._gridRows()[row]
    if (!column) return ''
    if (field === 'nullable') return t(this._fieldNullable(column) ? 'common.yes' : 'common.no')
    return this._fieldText(column, field as EditField)
  }

  // Copies the selected rectangle as TSV, or a single cell as its raw text.
  private _copySelection() {
    const s = this._sel
    if (!s) return
    const rowCount = this._gridRowCount(s.grid)
    const fields = this._gridFields(s.grid)
    if (!rowCount) return
    const r0 = Math.max(0, Math.min(s.r0, s.r1))
    const r1 = Math.min(rowCount - 1, Math.max(s.r0, s.r1))
    const c0 = Math.min(s.c0, s.c1)
    const c1 = Math.max(s.c0, s.c1)
    // A single-cell copy is a plain-text grab (e.g. a multi-line function body);
    // hand back the raw value. TSV field escaping only earns its keep across a
    // multi-cell rectangle, where a stray tab/newline would split the paste.
    if (r0 === r1 && c0 === c1) {
      const field = fields[c0]
      if (field) void window.sqlkit.writeClipboardText(this._cellValue(s.grid, r0, field))
      return
    }
    const cells: unknown[][] = []
    for (let r = r0; r <= r1; r += 1) {
      cells.push(fields.slice(c0, c1 + 1).map((field) => this._cellValue(s.grid, r, field)))
    }
    if (cells.length) void window.sqlkit.writeClipboardText(cellsToTsv(cells))
  }

  private _focusGrid() {
    this.shadowRoot?.querySelector<HTMLElement>('.columns-table')?.focus()
  }

  // --- column editing --------------------------------------------------------

  // Editability comes from the engine dialect's capabilities. Object attributes
  // (function/type inspections) aren't editable, nor is a row staged for drop.
  private _canEdit(field: EditField | 'nullable', col?: InspectColumn): boolean {
    if (this.object || !this.table || !this.engine) return false
    const dialect = dialectFor(this.engine)
    if (col && this._isDropped(col.name)) return false
    // A staged new column is fully definable on any engine that can ADD COLUMN;
    // only its comment needs engine support to be expressible in DDL.
    if (col && this._isAddition(col.name)) return field === 'comment' ? dialect.supportsColumnComments : true
    if (col?.generated && field !== 'name') return false
    if (field === 'name') return dialect.columnEdits.rename
    return dialect.columnEdits[field]
  }

  // Why a cell can't be edited on this engine; shown on hover instead of
  // leaving it silently inert.
  private _lockedTip(field: EditField | 'nullable'): string | null {
    if (this.object) return null
    if (this.engine === 'sqlite' && field !== 'name') return t('inspect.lockedSqlite')
    if (this.engine === 'mysql' && field !== 'name' && field !== 'default') {
      return t('inspect.lockedMysql')
    }
    if (this.engine === 'sqlserver' && field === 'default') return t('inspect.lockedSqlServerDefault')
    return null
  }

  // --- adding and dropping columns -------------------------------------------

  // Objects (function/type) never qualify; tables follow the engine capability.
  private _canAddColumn(): boolean {
    return !this.object && !!this.table && !!this.engine && dialectFor(this.engine).columnEdits.add
  }

  private _canDropColumn(): boolean {
    return !this.object && !!this.table && !!this.engine && dialectFor(this.engine).columnEdits.drop
  }

  private _isDropped(name: string): boolean {
    return !!this._edits.get(name)?.drop
  }

  // Staging a drop replaces the row's field edits with the drop marker — one
  // undo step brings them all back, since history snapshots the whole map.
  private _dropColumn(col: InspectColumn) {
    if (this._editing?.col === col.name) this._cancelEdit()
    if (this._cellMenu?.col.name === col.name) this._cellMenu = null
    this._applyEdit(col.name, { drop: true })
  }

  private _isAddition(name: string): boolean {
    return name.startsWith(ADD_KEY_PREFIX)
  }

  // The placeholder type a fresh row carries; `text` is deprecated on SQL Server.
  private _placeholderType(): string {
    return this.engine === 'sqlserver' ? 'nvarchar(255)' : 'text'
  }

  // Reconstructs the placeholder column behind an addition key: the defaults a
  // fresh row carries before any edit. The user-visible name/type live in the diff.
  private _syntheticColumn(key: string): InspectColumn {
    return { name: key, dataType: this._placeholderType(), nullable: true, default: null, primaryKey: false, comment: null }
  }

  // The staged new columns, in insertion order, as synthetic columns to render.
  private _additionColumns(): InspectColumn[] {
    return [...this._edits.keys()].filter((name) => this._isAddition(name)).map((key) => this._syntheticColumn(key))
  }

  // Appends a placeholder row and drops straight into editing its name so the
  // user can type over "new_column". Recorded on the undo stack like any edit.
  private _addColumn() {
    if (!this._canAddColumn()) return
    const key = `${ADD_KEY_PREFIX}${this._addSeq++}`
    const next = new Map(this._edits)
    next.set(key, { name: NEW_COLUMN_NAME })
    this._commitEdits(next)
    this._startEdit(key, 'name')
  }

  private _removeAddition(key: string) {
    if (this._editing?.col === key) this._editing = null
    const next = new Map(this._edits)
    next.delete(key)
    this._commitEdits(next)
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
    // Moving to a different cell commits the one being edited, so text typed into
    // it survives when a mousedown (e.g. another cell's chevron) suppresses blur.
    if (this._editing && (this._editing.col !== colName || this._editing.field !== field)) this._flushEdit()
    this._cellMenu = null
    this._typePicker = null
    this._defaultPicker = null
    this._editing = { col: colName, field, seed }
  }

  // Commits the cell being edited from the live input value; used before a
  // gesture (opening a picker, editing another cell) that would otherwise drop it.
  private _flushEdit() {
    if (!this._editing) return
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('.cell-input')
    const col = this._editingColumn()
    if (input && col) this._commitText(col, this._editing.field, input.value)
    else this._editing = null
  }

  private _cancelEdit() {
    this._editing = null
    this._typePicker = null
    this._defaultPicker = null
  }

  private _applyEdit(colName: string, edit: ColumnDiff) {
    const previousName = this._effectiveNameForKey(colName, this._edits.get(colName))
    const nextName = this._effectiveNameForKey(colName, edit)
    const next = new Map(this._edits)
    if (Object.keys(edit).length) next.set(colName, edit)
    else next.delete(colName)
    const operations = previousName !== nextName ? this._renameOperationColumn(previousName, nextName) : this._operations
    this._commitDraft(next, operations)
  }

  private _effectiveNameForKey(key: string, edit: ColumnDiff | undefined): string {
    return edit?.name ?? (this._isAddition(key) ? NEW_COLUMN_NAME : key)
  }

  // The single funnel for staging edits: swaps them in and records the step on
  // the (capped) undo stack, dropping the redo branch and no-op changes.
  private _commitEdits(next: Map<string, ColumnDiff>) {
    this._commitDraft(next, this._operations)
  }

  private _commitDraft(edits: Map<string, ColumnDiff>, operations: InspectOperation[], tableName = this._createName) {
    if (
      this._editsEqual(edits, this._edits)
      && JSON.stringify(operations) === JSON.stringify(this._operations)
      && (!this.createTable || tableName === this._createName)
    ) return
    this._saveError = null
    this._edits = new Map(edits)
    this._operations = [...operations]
    this._createName = tableName
    const snapshot = { edits: new Map(edits), operations: [...operations], tableName: this.createTable ? tableName : null }
    this._history = [...this._history.slice(0, this._historyIndex + 1), snapshot]
    if (this._history.length > MAX_EDIT_HISTORY) this._history = this._history.slice(this._history.length - MAX_EDIT_HISTORY)
    this._historyIndex = this._history.length - 1
    this._stashDraft()
  }

  private _commitCreateName(raw: string) {
    this._tableNameEditing = false
    const name = raw.trim()
    if (!name || name === this._createName) return
    this._commitDraft(this._edits, this._operations, name)
  }

  private _editsEqual(a: Map<string, ColumnDiff>, b: Map<string, ColumnDiff>): boolean {
    if (a.size !== b.size) return false
    for (const [name, ad] of a) {
      const bd = b.get(name)
      if (!bd) return false
      const keys = Object.keys(ad) as (keyof ColumnDiff)[]
      if (keys.length !== Object.keys(bd).length) return false
      for (const key of keys) if (ad[key] !== bd[key]) return false
    }
    return true
  }

  // Context-menu reset: drop one field's edit, or the whole row's, back to what
  // loaded. Both funnel through _applyEdit so undo/redo captures the reset too.
  private _resetField(col: InspectColumn, field: EditField | 'nullable') {
    const edit: ColumnDiff = { ...this._edits.get(col.name) }
    delete edit[field]
    this._applyEdit(col.name, edit)
  }

  private _resetRow(col: InspectColumn) {
    this._applyEdit(col.name, {})
  }

  // Steps the staged-edit history back/forward one commit. Returns false — so
  // the workbench leaves the browser's native input undo alone — while a cell
  // is mid-edit or there's nothing left to step to.
  undo(): boolean {
    if (this._editing || this._sectionEditing || this._tableNameEditing || this._addDialog || this._historyIndex <= 0) return false
    this._historyIndex--
    const snapshot = this._history[this._historyIndex]!
    this._edits = new Map(snapshot.edits)
    this._operations = [...snapshot.operations]
    this._createName = snapshot.tableName ?? this._createName
    this._stashDraft()
    return true
  }

  redo(): boolean {
    if (this._editing || this._sectionEditing || this._tableNameEditing || this._addDialog || this._historyIndex >= this._history.length - 1) return false
    this._historyIndex++
    const snapshot = this._history[this._historyIndex]!
    this._edits = new Map(snapshot.edits)
    this._operations = [...snapshot.operations]
    this._createName = snapshot.tableName ?? this._createName
    this._stashDraft()
    return true
  }

  // Records a text edit, dropping it back out of the staged set when the value
  // returns to the original. Name/type can't be blanked, so empty reverts;
  // an emptied comment or default means "drop it" and stays staged.
  private _commitText(col: InspectColumn, field: EditField, raw: string) {
    const value = field === 'comment' ? raw : raw.trim()
    const original = this._fieldOriginal(col, field)
    const edit: ColumnDiff = { ...this._edits.get(col.name) }
    // A new column's name is never dropped from its diff — an empty one would
    // fall through to the sentinel key — so it snaps back to the placeholder.
    if (this._isAddition(col.name) && field === 'name') edit.name = value || NEW_COLUMN_NAME
    else if (value === original || ((field === 'name' || field === 'dataType') && value === '')) delete edit[field]
    else edit[field] = value
    this._applyEdit(col.name, edit)
    this._editing = null
    this._typePicker = null
    this._defaultPicker = null
  }

  private _renameOperationColumn(from: string, to: string): InspectOperation[] {
    const rename = (columns: string[] | undefined) => columns?.map((column) => column === from ? to : column)
    return this._operations.map((operation) => {
      if (operation.kind === 'index') return { ...operation, spec: { ...operation.spec, columns: rename(operation.spec.columns) ?? [] } }
      if (operation.kind === 'foreignKey') return { ...operation, spec: { ...operation.spec, columns: rename(operation.spec.columns) ?? [] } }
      if (operation.kind === 'constraint' && (operation.spec.type === 'UNIQUE' || operation.spec.type === 'PRIMARY KEY')) {
        return { ...operation, spec: { ...operation.spec, columns: rename(operation.spec.columns) } }
      }
      return operation
    })
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
      if (field === 'dataType' && this._acceptTypePicker()) {
        if (!this._editing) this._focusGrid() // a template pick keeps editing
        return
      }
      if (field === 'default' && this._acceptDefaultPicker()) {
        this._focusGrid()
        return
      }
      this._commitText(col, field, (event.target as HTMLInputElement).value)
      this._focusGrid() // back to the grid so arrows keep working
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // With the completion menu open, Escape closes it and keeps editing.
      if (this._typePicker) this._typePicker = null
      else if (this._defaultPicker) this._defaultPicker = null
      else if (this._cellMenu) this._cellMenu = null
      else {
        this._cancelEdit()
        this._focusGrid()
      }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && field === 'dataType') {
      event.preventDefault()
      this._moveTypePicker(event.target as HTMLInputElement, col, event.key === 'ArrowDown' ? 1 : -1)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && field === 'default') {
      event.preventDefault()
      this._moveDefaultPicker(event.target as HTMLInputElement, col, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === ' ' && event.ctrlKey && field === 'dataType') {
      // Editor-style completion: the type choices anchored under the input,
      // narrowed by what's typed so far.
      event.preventDefault()
      const input = event.target as HTMLInputElement
      this._showTypePicker(input, col, input.value.trim(), 0)
    } else if (event.key === ' ' && event.ctrlKey && field === 'default') {
      event.preventDefault()
      const input = event.target as HTMLInputElement
      this._showDefaultPicker(input, col, input.value.trim(), 0)
    }
  }

  private _onEditInput(event: Event, col: InspectColumn, field: EditField) {
    const input = event.target as HTMLInputElement
    if (field === 'dataType' && this._typePicker) this._showTypePicker(input, col, input.value.trim(), -1)
    if (field === 'default' && this._defaultPicker) this._showDefaultPicker(input, col, input.value.trim(), -1)
  }

  private _editingColumn(): InspectColumn | null {
    if (!this._editing) return null
    if (this._isAddition(this._editing.col)) return this._syntheticColumn(this._editing.col)
    if (this._state.phase !== 'done') return null
    return this._state.inspection.columns.find((column) => column.name === this._editing?.col) ?? null
  }

  private _showTypePicker(input: HTMLInputElement, col: InspectColumn, filter: string, active: number) {
    const rect = input.getBoundingClientRect()
    this._typePicker = { x: rect.left, y: rect.bottom + 2, width: rect.width, col, filter, active }
  }

  private _moveTypePicker(input: HTMLInputElement, col: InspectColumn, step: 1 | -1) {
    if (!this._typePicker) this._showTypePicker(input, col, '', step > 0 ? -1 : 0)
    const picker = this._typePicker
    if (!picker) return
    const count = this._typeItems(picker.col, picker.filter).length
    if (!count) return
    const start = picker.active < 0 ? (step > 0 ? -1 : 0) : picker.active
    this._typePicker = { ...picker, active: (start + step + count) % count }
  }

  private _acceptTypePicker() {
    const picker = this._typePicker
    if (!picker || picker.active < 0) return false
    const item = this._typeItems(picker.col, picker.filter)[picker.active]
    if (!item) return false
    this._pickType(picker.col, item.id)
    return true
  }

  private _showDefaultPicker(input: HTMLInputElement, col: InspectColumn, filter: string, active: number) {
    const rect = input.getBoundingClientRect()
    this._defaultPicker = { x: rect.left, y: rect.bottom + 2, width: rect.width, col, filter, active }
  }

  private _moveDefaultPicker(input: HTMLInputElement, col: InspectColumn, step: 1 | -1) {
    if (!this._defaultPicker) this._showDefaultPicker(input, col, '', step > 0 ? -1 : 0)
    const picker = this._defaultPicker
    if (!picker) return
    const count = this._defaultItems(picker.col, picker.filter).length
    if (!count) return
    const start = picker.active < 0 ? (step > 0 ? -1 : 0) : picker.active
    this._defaultPicker = { ...picker, active: (start + step + count) % count }
  }

  private _acceptDefaultPicker() {
    const picker = this._defaultPicker
    if (!picker || picker.active < 0) return false
    const item = this._defaultItems(picker.col, picker.filter)[picker.active]
    if (!item) return false
    this._defaultPicker = null
    this._commitText(picker.col, 'default', item.id.slice('default:'.length))
    return true
  }

  /** Whether there are staged column edits. Read by the workbench close-confirm. */
  hasPendingChanges() {
    return this.createTable || this._edits.size > 0 || this._operations.length > 0
  }

  discard = () => {
    this._createName = this.table?.name ?? ''
    this._edits = this.createTable ? this._seedCreateEdits() : new Map<string, ColumnDiff>()
    this._operations = []
    this._history = [{ edits: new Map(this._edits), operations: [], tableName: this.createTable ? this._createName : null }]
    this._historyIndex = 0
    this._addSeq = this.createTable ? 1 : 0
    this._editing = null
    this._sectionEditing = null
    this._saveError = null
    if (this.tabId) draftCache.delete(this.tabId)
  }

  // Commits any focused editor, then emits the staged edits for the workbench to
  // review and apply. Called on ⌘S and the Save button; a no-op when nothing is
  // staged.
  save() {
    this.renderRoot.querySelectorAll<HTMLElement>('.cell-input, .table-name-input').forEach((input) => input.blur())
    if (this._state.phase !== 'done' || !this.hasPendingChanges() || !this.table || !this.engine) return
    const byName = new Map(this._state.inspection.columns.map((column) => [column.name, column]))
    const edits: ColumnAlter[] = []
    const additions: ColumnAdd[] = []
    const drops: string[] = []
    for (const [name, diff] of this._edits) {
      if (this._isAddition(name)) {
        additions.push(this._additionSpec(diff))
        continue
      }
      if (diff.drop) {
        drops.push(name)
        continue
      }
      const original = byName.get(name)
      if (original) edits.push({ original, ...diff })
    }
    if (!this.createTable && !edits.length && !additions.length && !drops.length && !this._operations.length) return
    const duplicate = this._duplicateName(edits, additions, drops)
    if (duplicate !== null) {
      this._saveError = t('inspect.duplicateColumn', { column: duplicate })
      return
    }
    const effectiveColumns = new Set(this._effectiveColumnNames())
    const table = this._effectiveTable()!
    try {
      for (const operation of this._operations) {
        const localColumns = operation.kind === 'drop' || operation.kind === 'rename'
          ? []
          : operation.kind === 'index' || operation.kind === 'foreignKey'
          ? operation.spec.columns
          : operation.kind === 'constraint' && (operation.spec.type === 'UNIQUE' || operation.spec.type === 'PRIMARY KEY')
            ? operation.spec.columns ?? []
            : []
        const missing = localColumns.find((column) => !effectiveColumns.has(column))
        if (missing) throw new Error(t('inspect.stagedMissingColumn', { kind: operation.kind, column: missing }))
        if (!this.createTable || (operation.kind !== 'constraint' && operation.kind !== 'foreignKey')) {
          buildInspectOperation(table, operation, this.engine)
        }
      }
      if (this.createTable) {
        const unsupported = this._operations.find((operation) =>
          operation.kind !== 'constraint' && operation.kind !== 'foreignKey' && operation.kind !== 'index' && operation.kind !== 'trigger')
        if (unsupported) throw new Error(t('inspect.unsupportedCreateOperation', { kind: unsupported.kind }))
        buildCreateTable(
          table,
          additions,
          this._operations.filter((operation) => operation.kind === 'constraint').map((operation) => operation.spec),
          this._operations.filter((operation) => operation.kind === 'foreignKey').map((operation) => operation.spec),
          this.engine,
        )
      }
    } catch (error) {
      this._saveError = (error as Error).message
      return
    }
    // The workbench reuses this element across tables; capture the target so a
    // slow DDL that resolves after a retarget can't clear the new table's edits.
    const target = { profileId: this.profileId, childDb: this.childDb, schema: this.table?.schema ?? null, name: this.table?.name ?? null }
    this.dispatchEvent(
      new CustomEvent<ColumnAlterEventDetail>('alter-columns', {
        bubbles: true,
        composed: true,
        detail: {
          tabId: this.tabId,
          profileId: this.profileId,
          childDb: this.childDb,
          table,
          engine: this.engine,
          edits,
          additions,
          drops,
          operations: [...this._operations],
          createTable: this.createTable,
          onApplied: () => {
            if (this.createTable) {
              if (this.tabId) draftCache.delete(this.tabId)
              return
            }
            if (
              this.profileId !== target.profileId
              || this.childDb !== target.childDb
              || (this.table?.schema ?? null) !== target.schema
              || (this.table?.name ?? null) !== target.name
            ) return
            this._edits = new Map()
            this._operations = []
            this._history = [{ edits: new Map(), operations: [], tableName: null }]
            this._historyIndex = 0
            this._addSeq = 0
            if (this.tabId) draftCache.delete(this.tabId)
            this._editing = null
            this._sectionEditing = null
            void this._load()
          },
        },
      }),
    )
  }

  // Save-time check: the final column names (after drops, renames, additions)
  // must be unique, or the DDL is guaranteed to fail at the server.
  private _duplicateName(edits: ColumnAlter[], additions: ColumnAdd[], drops: string[]): string | null {
    if (this._state.phase !== 'done') return null
    const dropped = new Set(drops)
    const renamed = new Map(edits.filter((edit) => edit.name !== undefined).map((edit) => [edit.original.name, edit.name!]))
    const finals = this._state.inspection.columns
      .filter((column) => !dropped.has(column.name))
      .map((column) => renamed.get(column.name) ?? column.name)
    finals.push(...additions.map((add) => add.name.trim()).filter(Boolean))
    const seen = new Set<string>()
    for (const name of finals) {
      if (seen.has(name)) return name
      seen.add(name)
    }
    return null
  }

  // Resolves a new column's diff to its effective spec, filling placeholder
  // defaults for anything the user left untouched.
  private _additionSpec(diff: ColumnDiff): ColumnAdd {
    return {
      name: diff.name ?? NEW_COLUMN_NAME,
      dataType: diff.dataType ?? this._placeholderType(),
      nullable: diff.nullable ?? true,
      default: diff.default != null && diff.default !== '' ? diff.default : null,
      comment: diff.comment != null && diff.comment !== '' ? diff.comment : null,
    }
  }

  // Which add dialog a section header offers; null hides the button. Partitions
  // only where a quick add exists (PG PARTITION OF / MySQL ADD PARTITION).
  private _sectionAddKind(title: string): AddObjectKind | null {
    if (!this.table || !this.engine) return null
    if (title === 'Indexes' && (this.table.kind === 'table' || this.table.kind === 'matview')) return 'index'
    if (this.table.kind !== 'table') return null
    if (title === 'Triggers') return 'trigger'
    if (!this.createTable && title === 'Partitions' && (this.engine === 'postgresql' || this.engine === 'mysql')) return 'partition'
    // Existing SQLite tables cannot add constraints, but create mode can place
    // foreign keys and CHECK/UNIQUE/PRIMARY KEY clauses inside CREATE TABLE.
    if (title === 'Foreign Keys' && (this.createTable || canAddConstraint(this.engine))) return 'foreignKey'
    if (title === 'Constraints' && (this.createTable || canAddConstraint(this.engine))) return 'constraint'
    return null
  }

  // Drivers omit empty sections; a real table instead shows its engine's full
  // canonical scaffold at 0, so every capability is visible and addable.
  private _displaySections(sections: TableInspection['sections']): TableInspection['sections'] {
    if (!this.table || !this.engine) return sections
    if (this.table.kind !== 'table') {
      // Views/matviews only gain what they can add (matview indexes).
      const missing = ['Indexes']
        .filter((title) => this._sectionAddKind(title) !== null && !sections.some((section) => section.title === title))
        .map((title) => ({ title, rows: [] }))
      return missing.length ? [...sections, ...missing] : sections
    }
    const canonical = this.createTable
      ? ['Foreign Keys', 'Constraints', 'Indexes', 'Triggers']
      : ENGINE_SECTIONS[this.engine]
    const scaffold = canonical
      .map((title) =>
        sections.find((section) => section.title === title)
          ?? (PRESENT_ONLY_SECTIONS.has(title) ? null : { title, rows: [] }))
      .filter((section): section is TableInspection['sections'][number] => section !== null)
    return [...scaffold, ...sections.filter((section) => !canonical.includes(section.title))]
  }

  // Empty-state copy per section: what the section is for, plus a nudge to the
  // + button when we can actually add one here.
  private _emptySectionText(title: string): string {
    const addable = this._sectionAddKind(title) !== null
    const blurbs: Record<string, string> = {
      Indexes: addable
        ? t('inspect.noIndexesAdd')
        : t('inspect.noIndexes'),
      Triggers: addable
        ? t('inspect.noTriggersAdd')
        : t('inspect.noTriggers'),
      Partitions: t('inspect.noPartitions'),
      'Foreign Keys': addable
        ? t('inspect.noForeignKeysAdd')
        : t('inspect.noForeignKeys'),
      Constraints: addable
        ? t('inspect.noConstraintsAdd')
        : t('inspect.noConstraints'),
      Rules: t('inspect.noRules'),
      Policies: t('inspect.noPolicies'),
    }
    return blurbs[title] ?? t('inspect.noSection', { section: this._sectionLabel(title).toLocaleLowerCase() })
  }

  private _sectionLabel(title: string): string {
    const known = {
      Indexes: 'inspect.sectionIndexes',
      Triggers: 'inspect.sectionTriggers',
      Partitions: 'inspect.sectionPartitions',
      'Foreign Keys': 'inspect.sectionForeignKeys',
      Constraints: 'inspect.sectionConstraints',
      Rules: 'inspect.sectionRules',
      Policies: 'inspect.sectionPolicies',
      Definition: 'inspect.sectionDefinition',
      Values: 'inspect.sectionValues',
      Storage: 'inspect.sectionStorage',
    } as const
    return title in known ? t(known[title as keyof typeof known]) : title
  }

  private _renderBody() {
    const state = this._state
    if (state.phase === 'loading') {
      return html`<p class="muted hint">
        <i class="icon icon-loader-circle icon-modifier-spin" aria-hidden="true"></i> ${t('inspect.loading')}
      </p>`
    }
    if (state.phase === 'error') return html`<pre class="error">${state.error}</pre>`

    const { columns } = state.inspection
    const sections = this._sections()
    return html`
      ${columns.length || this._additionColumns().length || this.createTable ? this._renderColumnsTable(columns) : ''}
      ${sections.map(
        (section, grid) => html`
          <h4>
            ${this._sectionLabel(section.title)} <span class="count">${section.rows.length}</span>
            ${this._sectionAddKind(section.title)
              ? html`
                  <button
                    class="add-btn"
                    type="button"
                    title=${t('inspect.addSection', { section: this._sectionLabel(section.title) })}
                    aria-label=${t('inspect.addSection', { section: this._sectionLabel(section.title) })}
                    @click=${() => { this._editOperationIndex = null; this._addDialog = this._sectionAddKind(section.title) }}
                  >
                    <i class="icon icon-plus" aria-hidden="true"></i>
                  </button>
                `
              : ''}
          </h4>
          ${!section.rows.length
            ? html`<p class="section-empty muted">${this._emptySectionText(section.title)}</p>`
            : html`<table
            class="section-table"
            data-grid=${grid}
            tabindex="0"
            @pointerdown=${this._onGridPointerDown}
            @click=${this._onGridClick}
            @keydown=${this._onGridKeydown}
          >
            <colgroup>
              <col class="name-col" />
              <col />
            </colgroup>
            <tbody>
              ${section.rows.map(
                (row, index) => {
                  const stagedIndex = this._stagedOperationIndex(section.title, row.name)
                  const objectEditing = this._sectionEditing
                  const rowName = row.name
                  const readonly = this._isReadonlyRow(section.title, row.definition, stagedIndex >= 0)
                  const editingName = objectEditing?.section === section.title
                    && objectEditing.operationIndex === (stagedIndex >= 0 ? stagedIndex : undefined)
                    && objectEditing.value === rowName
                  const stagedKind = stagedIndex >= 0
                    ? this._operations[stagedIndex]?.kind === 'drop'
                      ? 'staged-delete'
                      : this._operations[stagedIndex]?.kind === 'rename'
                        ? 'staged-edit'
                        : 'staged-add'
                    : ''
                  return html`
                  <tr
                    data-row=${index}
                    class=${stagedKind}
                    @contextmenu=${(event: MouseEvent) => this._onRowMenu(event, row.name, row.definition, section.title, stagedIndex >= 0 ? stagedIndex : undefined, readonly)}
                  >
                    <td
                      data-field="name"
                      class="mono name-cell${!editingName && !readonly && this._canRenameSectionObject(section.title, stagedIndex) ? ' editable' : ''}${!editingName && this._isSelected(grid, index, 0) ? ' selected' : ''}"
                      title=${row.name}
                    >
                      ${editingName
                        ? html`<input
                            class="cell-input object-name-input"
                            .value=${objectEditing.seed ?? objectEditing.value}
                            @keydown=${(event: KeyboardEvent) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                this._sectionEditing = null
                              } else if (event.key === 'Enter') {
                                event.preventDefault()
                                ;(event.currentTarget as HTMLInputElement).blur()
                              }
                            }}
                            @blur=${(event: FocusEvent) => {
                              if (this._sectionEditing !== objectEditing) return
                              this._commitSectionRename((event.currentTarget as HTMLInputElement).value)
                            }}
                          />`
                        : html`<span class="name-text">${row.name}</span>`}
                      ${stagedIndex >= 0
                        ? html`<button
                            class="remove-staged"
                            title=${t('inspect.removeStaged')}
                            aria-label=${t('inspect.removeStaged')}
                            @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
                            @click=${() => this._commitDraft(
                              this._edits,
                              this._operations.filter((_, operationIndex) => operationIndex !== stagedIndex),
                            )}
                          ><i class="icon icon-x" aria-hidden="true"></i></button>`
                        : ''}
                    </td>
                    <td data-field="definition" class="mono def${this._isSelected(grid, index, 1) ? ' selected' : ''}" title=${row.definition}
                      >${highlightDefinition(row.definition)}</td>
                  </tr>
                `},
              )}
            </tbody>
          </table>`}
        `,
      )}
      ${sections.length
        ? ''
        : this.object
          ? columns.length
            ? ''
            : html`<p class="muted hint">${t('inspect.nothing')}</p>`
          : html`<p class="muted hint">${t('inspect.noObjects')}</p>`}
    `
  }

  private _renderColumnsTable(columns: TableInspection['columns']) {
    const hasComments = this.engine ? dialectFor(this.engine).supportsColumnComments : false
    const additions = this._additionColumns()
    return html`
      <h4>
        ${t(this.object ? 'inspect.sectionAttributes' : 'inspect.sectionColumns')} <span class="count">${columns.length + additions.length}</span>
        ${this._canAddColumn()
          ? html`
              <button class="add-btn" type="button" title=${t('inspect.addColumn')} aria-label=${t('inspect.addColumn')} @click=${this._addColumn}>
                <i class="icon icon-plus" aria-hidden="true"></i>
              </button>
            `
          : ''}
      </h4>
      <table
        class="columns-table"
        data-grid=${COLUMNS_GRID}
        tabindex="0"
        @pointerdown=${this._onGridPointerDown}
        @click=${this._onGridClick}
        @keydown=${this._onGridKeydown}
      >
        <colgroup>
          <col class="icon-col${columns.some((column) => column.primaryKey && column.foreignKey) ? ' dual' : ''}" />
          <col class="name-col" />
          <col class="type-col" />
          <col class="nullable-col" />
          <col />
          ${hasComments ? html`<col />` : ''}
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>${t('inspect.columnName')}</th>
            <th>${t('inspect.columnType')}</th>
            <th>${t('inspect.nullable')}</th>
            <th>${t('inspect.default')}</th>
            ${hasComments ? html`<th>${t('inspect.comment')}</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${columns.map((column, index) => this._renderColumnRow(column, hasComments, false, index))}
          ${additions.map((column, index) => this._renderColumnRow(column, hasComments, true, columns.length + index))}
        </tbody>
      </table>
      ${this._saveError ? html`<p class="save-error">${this._saveError}</p>` : ''}
    `
  }

  // One columns-table row, shared by loaded columns and staged additions. An
  // addition trades the PK icon for a remove (✕) button and tints the row green;
  // a staged drop swaps in a restore (↩) button and tints it red.
  private _renderColumnRow(column: InspectColumn, hasComments: boolean, addition: boolean, row: number) {
    const dropped = !addition && this._isDropped(column.name)
    const effectiveName = String(this._fieldText(column, 'name'))
    const stagedPrimaryKey = this._operations.some((operation) =>
      operation.kind === 'constraint'
      && operation.spec.type === 'PRIMARY KEY'
      && operation.spec.columns?.includes(effectiveName))
    const stagedForeignKey = this._operations.some((operation) =>
      operation.kind === 'foreignKey' && operation.spec.columns.includes(effectiveName))
    const primaryKey = column.primaryKey || stagedPrimaryKey
    const foreignKey = column.foreignKey || stagedForeignKey
    return html`
      <tr
        data-row=${row}
        class=${addition ? 'added' : dropped ? 'dropped' : ''}
        @contextmenu=${(event: MouseEvent) => this._onColumnMenu(event, column)}
      >
        <td class="icon-cell">
          ${addition
            ? html`
                <button
                  class="remove-btn"
                  type="button"
                  title=${t('inspect.removeColumn')}
                  aria-label=${t('inspect.removeColumn')}
                  @click=${() => this._removeAddition(column.name)}
                >
                  <i class="icon icon-x" aria-hidden="true"></i>
                </button>
              `
            : dropped
              ? html`
                  <button
                    class="restore-btn"
                    type="button"
                    title=${t('inspect.restoreColumn')}
                    aria-label=${t('inspect.restoreColumn')}
                    @click=${() => this._resetRow(column)}
                  >
                    <i class="icon icon-undo-2" aria-hidden="true"></i>
                  </button>
                `
              : primaryKey || foreignKey
                ? html`<span class="key-icons">
                    ${primaryKey
                      ? html`<i class="icon icon-key pk" aria-hidden="true" title=${t('inspect.primaryKeyLabel')}></i>`
                      : ''}
                    ${foreignKey
                      ? html`<i class="icon icon-key fk" aria-hidden="true" title=${t('inspect.foreignKeyLabel')}></i>`
                      : ''}
                  </span>`
                : ''}
        </td>
        ${this._renderTextCell(column, 'name', 'mono clip', this._fieldText(column, 'name'), row)}
        ${this._renderTextCell(column, 'dataType', 'mono type clip', this._fieldText(column, 'dataType'), row)}
        ${this._renderNullableCell(column, row)}
        ${this._renderTextCell(column, 'default', 'mono muted clip', this._fieldText(column, 'default'), row)}
        ${hasComments ? this._renderTextCell(column, 'comment', 'muted clip', this._fieldText(column, 'comment'), row) : ''}
      </tr>
    `
  }

  private _renderTextCell(col: InspectColumn, field: EditField, cls: string, display: unknown, row: number) {
    const editable = this._canEdit(field, col)
    // A locked-cell tip only when the engine (not a staged drop) is the reason.
    const tip = editable || this._isDropped(col.name) ? null : this._lockedTip(field)
    const selected = this._isSelected(COLUMNS_GRID, row, this._gridFields(COLUMNS_GRID).indexOf(field)) ? ' selected' : ''
    const choices = (field === 'dataType' || field === 'default') && editable
    const choiceButton = choices
      ? html`
          <button
            class="choices-btn"
            title=${t(field === 'dataType' ? 'inspect.chooseType' : 'inspect.chooseDefault')}
            aria-label=${t(field === 'dataType' ? 'inspect.chooseType' : 'inspect.chooseDefault')}
            @mousedown=${(event: MouseEvent) => (field === 'dataType' ? this._openTypeMenu(event, col) : this._openDefaultMenu(event, col))}
            @click=${(event: MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <i class="icon icon-chevron-down" aria-hidden="true"></i>
          </button>
        `
      : ''
    const editing = this._editing
    if (editing?.col === col.name && editing.field === field) {
      return html`
        <td data-field=${field} class=${`${cls}${this._isEdited(col.name, field) ? ' edited' : ''}${choices ? ' has-choices' : ''}${selected}`}>
          <input
            class="cell-input"
            .value=${editing.seed ?? this._fieldText(col, field)}
            @keydown=${(event: KeyboardEvent) => this._onEditKeydown(event, col, field)}
            @input=${(event: Event) => this._onEditInput(event, col, field)}
            @blur=${(event: FocusEvent) => {
              if (this._editing !== editing) return
              this._commitText(col, field, (event.target as HTMLInputElement).value)
            }}
          />
          ${choiceButton}
        </td>
      `
    }
    const classes = `${cls}${this._isEdited(col.name, field) ? ' edited' : ''}${editable ? ' editable' : ''}${choices ? ' has-choices' : ''}${selected}`
    return html`
      <td data-field=${field} class=${classes} title=${tip ?? this._fieldText(col, field)}>
        <span class="cell-text">${display}</span>${choiceButton}
      </td>
    `
  }

  private _openTypeMenu(event: MouseEvent, col: InspectColumn) {
    event.preventDefault()
    event.stopPropagation() // the cell behind it would start an inline edit
    this._selectFirstTypeOption = true
    this._startEdit(col.name, 'dataType')
  }

  private _openDefaultMenu(event: MouseEvent, col: InspectColumn) {
    event.preventDefault()
    event.stopPropagation() // the cell behind it would start an inline edit
    this._selectFirstDefaultOption = true
    this._startEdit(col.name, 'default')
  }

  private _renderNullableCell(col: InspectColumn, row: number) {
    const editable = this._canEdit('nullable', col)
    const tip = editable || this._isDropped(col.name) ? null : this._lockedTip('nullable')
    const selected = this._isSelected(COLUMNS_GRID, row, this._gridFields(COLUMNS_GRID).indexOf('nullable')) ? ' selected' : ''
    const classes = `muted${this._isEdited(col.name, 'nullable') ? ' edited' : ''}${editable ? ' editable has-choices nullable-cell' : ''}${selected}`
    return html`
      <td data-field="nullable" class=${classes} title=${tip ?? ''}>
        <span class="cell-text">${t(this._fieldNullable(col) ? 'common.yes' : 'common.no')}</span>${editable
          ? html`
              <button
                class="choices-btn"
                tabindex="-1"
                title=${t('inspect.chooseNullability')}
                aria-label=${t('inspect.chooseNullability')}
                @mousedown=${(event: MouseEvent) => {
                  event.preventDefault()
                  event.stopPropagation()
                  this._openNullablePicker((event.currentTarget as HTMLElement).closest('td')!, col)
                }}
              >
                <i class="icon icon-chevron-down" aria-hidden="true"></i>
              </button>
            `
          : ''}
      </td>
    `
  }

  // Anchored on the given cell; a repeat call for the same column toggles it shut.
  private _openNullablePicker(cell: HTMLElement, col: InspectColumn) {
    this._flushEdit()
    this._typePicker = null
    this._defaultPicker = null
    if (this._cellMenu?.col.name === col.name) {
      this._cellMenu = null
      return
    }
    const rect = cell.getBoundingClientRect()
    this._cellMenu = { x: rect.left, y: rect.bottom + 2, width: rect.width, col, kind: 'nullable', active: this._fieldNullable(col) ? 0 : 1 }
  }

  private _nullableItems(col: InspectColumn): MenuItem[] {
    const current = this._fieldNullable(col)
    return [
      { id: 'yes', label: t('common.yes'), checked: current },
      { id: 'no', label: t('common.no'), checked: !current },
    ]
  }

  // All of the engine's common types, with exact text matches check-marked. A filter
  // narrows by typed prefix; no match leaves free text as the custom path.
  private _typeItems(col: InspectColumn, filter?: string): MenuItem[] {
    const current = this._fieldText(col, 'dataType').trim().toLowerCase()
    const types = this.engine ? dialectFor(this.engine).commonColumnTypes : []
    const prefix = filter?.toLowerCase().replace(/\(.*/, '').trim() ?? ''
    const matches = prefix ? types.filter((type) => type.toLowerCase().startsWith(prefix)) : types
    return matches.map((type) => ({ id: `type:${type}`, label: type, checked: type.toLowerCase() === current }))
  }

  private _defaultItems(col: InspectColumn, filter?: string): MenuItem[] {
    const current = this._fieldText(col, 'default').trim().toLowerCase()
    const values = this.engine ? dialectFor(this.engine).commonDefaultValues : []
    const prefix = filter?.toLowerCase().trim() ?? ''
    const matches = prefix ? values.filter((value) => value.toLowerCase().startsWith(prefix)) : values
    return matches.map((value) => ({ id: `default:${value}`, label: value, checked: value.toLowerCase() === current }))
  }

  // Template types — varchar(255), numeric(10,2) — open in the inline editor
  // with the parameters selected for adjustment; bare types commit directly.
  private _pickType(col: InspectColumn, id: string) {
    this._typePicker = null
    const type = id.slice('type:'.length)
    if (type.includes('(')) return this._startEdit(col.name, 'dataType', type)
    this._commitText(col, 'dataType', type)
  }

  private _renderCellMenu() {
    const menu = this._cellMenu
    if (!menu) return ''
    const items = this._nullableItems(menu.col)
    const active = menu.active >= items.length ? -1 : menu.active
    return html`
      <div
        class="type-picker"
        style="left: ${menu.x}px; top: ${menu.y}px; min-width: ${menu.width}px; max-height: calc(100vh - ${menu.y + 6}px)"
        role="listbox"
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
      >
        ${items.map(
          (item, index) => html`
            <button
              class="type-option ${index === active ? 'active' : ''}"
              role="option"
              aria-selected=${index === active ? 'true' : 'false'}
              @mousedown=${(event: MouseEvent) => {
                event.preventDefault()
                this._cellMenu = null
                this._setNullable(menu.col, item.id === 'yes')
              }}
            >
              <span class="type-label">${item.label}</span><span class="check">${item.checked ? '✓' : ''}</span>
            </button>
          `,
        )}
      </div>
    `
  }

  private _renderTypePicker() {
    const picker = this._typePicker
    if (!picker) return ''
    const items = this._typeItems(picker.col, picker.filter)
    if (!items.length) return ''
    const active = picker.active >= items.length ? -1 : picker.active
    return html`
      <div
        class="type-picker"
        style="left: ${picker.x}px; top: ${picker.y}px; min-width: ${picker.width}px; max-height: calc(100vh - ${picker.y + 6}px)"
        role="listbox"
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
      >
        ${items.map(
          (item, index) => html`
            <button
              class="type-option ${index === active ? 'active' : ''}"
              role="option"
              aria-selected=${index === active ? 'true' : 'false'}
              @mousedown=${(event: MouseEvent) => {
                event.preventDefault()
                this._pickType(picker.col, item.id)
              }}
            >
              <span class="type-label">${item.label}</span><span class="check">${item.checked ? '✓' : ''}</span>
            </button>
          `,
        )}
      </div>
    `
  }

  private _renderDefaultPicker() {
    const picker = this._defaultPicker
    if (!picker) return ''
    const items = this._defaultItems(picker.col, picker.filter)
    if (!items.length) return ''
    const active = picker.active >= items.length ? -1 : picker.active
    return html`
      <div
        class="type-picker"
        style="left: ${picker.x}px; top: ${picker.y}px; min-width: ${picker.width}px; max-height: calc(100vh - ${picker.y + 6}px)"
        role="listbox"
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
      >
        ${items.map(
          (item, index) => html`
            <button
              class="type-option ${index === active ? 'active' : ''}"
              role="option"
              aria-selected=${index === active ? 'true' : 'false'}
              @mousedown=${(event: MouseEvent) => {
                event.preventDefault()
                this._defaultPicker = null
                this._commitText(picker.col, 'default', item.id.slice('default:'.length))
              }}
            >
              <span class="type-label">${item.label}</span><span class="check">${item.checked ? '✓' : ''}</span>
            </button>
          `,
        )}
      </div>
    `
  }

  static styles = [
    typography,
    icons,
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
        min-height: 24px;
        margin-bottom: 4px;
      }

      .head h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }

      .create-table-name {
        min-width: 120px;
        cursor: text;
      }

      .table-name-input {
        width: min(320px, 40vw);
        box-sizing: border-box;
        padding: 2px 5px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--focus-border);
        border-radius: 3px;
        outline: none;
      }

      .head-spacer {
        margin-left: auto;
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

      .draft-action {
        box-sizing: border-box;
        height: 24px;
        padding: 0 9px;
        color: var(--text-2);
        background: var(--btn-secondary-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-size: var(--font-size-sm);
      }

      .draft-action.primary {
        color: var(--btn-fg);
        background: var(--btn-bg);
        border-color: var(--btn-bg);
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

      .add-btn .icon {
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
        font-family: var(--mono-font);
      }

      .muted {
        color: var(--text-3);
      }

      .type {
        color: var(--text-2);
      }

      .icon-cell {
        padding-right: 4px;
        vertical-align: middle;
      }

      .key-icons {
        display: flex;
        align-items: center;
        gap: 0;
      }

      .icon-cell .pk {
        font-size: 12px;
        color: var(--status-dot-warning);
      }

      .icon-cell .fk {
        font-size: 12px;
        color: var(--accent);
      }

      /* Fixed layout + a shared name-column width keeps every section's
         columns aligned with each other, however long one name gets. */
      .section-table,
      .columns-table {
        table-layout: fixed;
      }

      /* Columns-table rows are single-line, so center every cell — the
         remove (✕) and key icons then line up with the row's text. Section
         defs keep the global top-align since they can wrap. */
      .columns-table td {
        vertical-align: middle;
      }

      /* Focusable for keyboard nav/copy; drag-selection replaces text selection. */
      .columns-table,
      .section-table {
        user-select: none;
        outline: none;
      }

      .columns-table .cell-input {
        user-select: text;
      }

      .icon-col {
        width: 18px;
      }

      /* Only reserve room for two keys when a column actually carries both. */
      .icon-col.dual {
        width: 28px;
      }

      .type-col {
        width: 220px;
      }

      .nullable-col {
        width: 70px;
      }

      .clip {
        overflow: hidden;
        white-space: nowrap;
      }

      .cell-text {
        display: block;
        overflow: hidden;
        white-space: nowrap;
      }

      .name-col {
        width: 280px;
      }

      .name-cell {
        position: relative;
        color: var(--text);
        overflow: hidden;
      }

      /* Clamp a long object name to two lines instead of clipping it on one. */
      .name-text {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }

      .staged-add .name-cell,
      .staged-edit .name-cell,
      .staged-delete .name-cell {
        padding-right: 24px;
      }

      /* Definitions render verbatim; preserve the source's own newlines and
         indentation (function/trigger bodies) and wrap long single lines. */
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

      .staged-add td {
        background: var(--staged-add-bg);
      }

      .staged-add .name-cell {
        color: var(--staged-add-fg);
      }

      .staged-edit td {
        background: var(--staged-edit-bg);
      }

      .staged-edit .name-cell {
        color: var(--staged-edit-fg);
      }

      .staged-delete td {
        background: var(--staged-delete-bg);
      }

      .staged-delete .name-cell {
        color: var(--staged-delete-fg);
      }

      .remove-staged {
        position: absolute;
        top: 50%;
        right: 4px;
        transform: translateY(-50%);
        display: inline-flex;
        width: 16px;
        height: 16px;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        padding: 1px;
        line-height: 1;
        color: var(--text-3);
        background: transparent;
        border: 0;
        border-radius: 3px;
      }

      .remove-staged:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      .hint {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
      }

      .section-empty {
        margin: 2px 0 4px;
        line-height: 1.4;
      }

      .error {
        margin: 10px 0;
        font-family: var(--mono-font);
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
        padding-right: 34px;
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
        --icon-size: 12px;
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
        color: var(--staged-edit-fg);
        background: var(--staged-edit-bg);
      }

      td.edited:hover {
        background: var(--staged-edit-hover-bg);
      }

      /* Unsaved new columns: the same low-contrast green insert tint the results
         grid uses for draft rows. The td.edited rule below keeps green (not the
         amber edit tint) on a new row's changed cells at higher specificity. */
      tr.added td,
      tr.added td.edited {
        color: var(--staged-add-fg);
        background: var(--staged-add-bg);
      }

      tr.added:hover td:not(.editable):not(.icon-cell),
      tr.added td.editable:hover {
        background: var(--staged-add-hover-bg);
      }

      .remove-btn,
      .restore-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1px;
        line-height: 1;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        --icon-size: 12px;
      }

      .remove-btn:hover {
        color: var(--staged-delete-fg);
        background: var(--list-hover);
      }

      .restore-btn:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      /* Staged drop: red tint + strikethrough, the destructive counterpart of the
         green insert tint; cells lock (no .editable) until the row is restored. */
      tr.dropped td,
      tr.dropped td.edited {
        color: var(--staged-delete-fg);
        background: var(--staged-delete-bg);
      }

      tr.dropped .cell-text {
        text-decoration: line-through;
      }

      .save-error {
        margin: 6px 0 0;
        font-size: 12px;
        color: var(--status-dot-error);
      }

      /* Cell selection — the results grid's tint; the selector list out-ranks
         every row tint and hover rule above so selection always reads. */
      td.selected,
      td.edited.selected,
      td.editable.selected:hover,
      tr.added td.selected,
      tr.added td.editable.selected:hover,
      tr.added:hover td.selected:not(.editable):not(.icon-cell),
      tr.dropped td.selected {
        background: var(--grid-selection-bg);
        color: var(--text);
      }

      td.edited.selected,
      td.edited.selected:hover,
      .staged-edit td.selected {
        background: var(--staged-edit-selection-bg);
        color: var(--staged-edit-fg);
      }

      tr.added td.selected,
      tr.added td.editable.selected:hover,
      tr.added:hover td.selected:not(.editable):not(.icon-cell),
      .staged-add td.selected {
        background: var(--staged-add-selection-bg);
        color: var(--staged-add-fg);
      }

      tr.dropped td.selected,
      .staged-delete td.selected {
        background: var(--staged-delete-selection-bg);
        color: var(--staged-delete-fg);
      }

      .staged-edit td:hover:not(.selected) {
        background: var(--staged-edit-hover-bg);
      }

      .staged-add td:hover:not(.selected) {
        background: var(--staged-add-hover-bg);
      }

      .staged-delete td:hover:not(.selected),
      tr.dropped td:hover:not(.selected) {
        background: var(--staged-delete-hover-bg);
      }

      .staged-edit .name-cell:hover,
      .staged-edit .name-cell.selected {
        color: var(--staged-edit-fg);
      }

      .staged-add .name-cell:hover,
      .staged-add .name-cell.selected {
        color: var(--staged-add-fg);
      }

      .staged-delete .name-cell:hover,
      .staged-delete .name-cell.selected {
        color: var(--staged-delete-fg);
      }

      /* The input focus border replaces cell-selection blue while editing. */
      td.selected:has(.cell-input) {
        background: var(--editor-bg);
        color: var(--text);
      }

      td.edited.selected:has(.cell-input),
      .staged-edit td.selected:has(.cell-input) {
        background: var(--staged-edit-bg);
        color: var(--staged-edit-fg);
      }

      tr.added td.selected:has(.cell-input),
      .staged-add td.selected:has(.cell-input) {
        background: var(--staged-add-bg);
        color: var(--staged-add-fg);
      }

      /* Overlays the cell padding (results-panel .cell-edit trick) so opening
         the editor never changes the row height or shifts content. */
      .cell-input {
        width: calc(100% + 6px);
        box-sizing: border-box;
        margin: -3px 0 -3px -3px;
        padding: 2px 3px;
        font: inherit;
        color: var(--text);
        background: var(--editor-bg);
        border: none;
        border-radius: 0;
        outline: none;
      }

      .type-picker {
        position: fixed;
        z-index: 92;
        box-sizing: border-box;
        max-width: min(320px, calc(100vw - 8px));
        overflow-y: auto;
        padding: 2px 0;
        display: flex;
        flex-direction: column;
        background: var(--sidebar-bg);
        border: none;
        border-radius: 4px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
      }

      .type-option {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 2px 8px;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--text);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .type-option:hover,
      .type-option.active {
        background: var(--list-selection);
        color: var(--list-selection-fg);
      }

      .type-option .type-label {
        overflow: hidden;
        white-space: nowrap;
      }

      .type-option .check {
        flex: 0 0 14px;
        margin-left: auto;
        text-align: right;
        color: var(--accent);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'table-inspect': TableInspect
  }
}
