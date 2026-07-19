import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { mod } from '../platform'
import { abbreviateType } from '../sql-types'
import { TABLE_KIND_ICONS, TABLE_KIND_LABELS } from '../table-kinds'
import type { ColumnRef, DbObject, DbObjectKind, DbObjects, Engine, FileInfo, TableRef } from '../electron'
import { dialectFor } from '../dialect'
import { quoteQualified } from '../sql-write'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './file-tree'

export const tableKey = (profileId: string, table: TableRef) => `${profileId}:${table.schema ?? ''}:${table.name}`

export const tableLabel = (table: TableRef) => (table.schema ? `${table.schema}.${table.name}` : table.name)

const objectIcon = (label: 'Functions' | 'Types', object: DbObject) =>
  label === 'Functions' ? 'codicon-symbol-method' : object.detail === 'enum' ? 'codicon-symbol-enum' : 'codicon-symbol-structure'

export type TableSelectDetail = { key: string }
export type ObjectInspectDetail = { object: DbObject; objectKind: DbObjectKind }
export type TableBrowseDetail = { table: TableRef }
export type TableCreateDetail = { schema: string | null }

// Expand/collapse of tree rows; every key is prefixed with its profile id so
// state for removed profiles can be pruned.
type TreeState = {
  collapsedSchemas: Set<string>
  expandedTables: Set<string>
  expandedObjectGroups: Set<string>
}

// Section chrome: collapsed headers, the pinned Files height (null = even
// split), and an in-flight divider drag.
type SectionLayout = {
  filesCollapsed: boolean
  tablesCollapsed: boolean
  filesHeight: number | null
  resizing: { startY: number; startHeight: number } | null
}

// The open context menu; table and object menus are mutually exclusive.
type ExplorerMenu = { x: number; y: number } & (
  | { kind: 'table'; table: TableRef }
  | { kind: 'tables'; schema: string | null }
  | { kind: 'object'; object: DbObject; objectKind: DbObjectKind }
)

// The Explorer sidebar view, scoped to the in-use database context (⌘K):
// VS Code-style Files/Tables split where each section is a flex region with
// its own scrolling body, a draggable 1px divider between them (double-click
// resets), and a collapsed Tables header that pins to the bottom. Tables
// group under collapsible schema headers when the database has more than one
// schema. File events bubble through from <file-tree>; tables dispatch
// `table-select` / `table-browse`.
@customElement('explorer-view')
export class ExplorerView extends LitElement {
  @property({ attribute: false })
  files: FileInfo[] = []

  /** Absolute path of the file open in the active tab, if any. */
  @property()
  activePath: string | null = null

  /** The in-use context; null shows the add-a-database hint. */
  @property()
  contextName: string | null = null

  @property()
  profileId: string | null = null

  /** Engine of the in-use context; drives type-name abbreviation. */
  @property()
  engine: Engine | null = null

  /** Tables of the connected context; null while it is not connected. */
  @property({ attribute: false })
  tables: TableRef[] | null = null

  /** Columns of every context table; tables expand to show theirs. */
  @property({ attribute: false })
  columns: ColumnRef[] | null = null

  /** Schema objects (functions, types), shown as collapsed groups. */
  @property({ attribute: false })
  objects: DbObjects | null = null

  /** Active child database (all-databases mode), shown in the Tables header. */
  @property()
  activeChildName: string | null = null

  /** Connected all-databases profile with no child selected in the UI yet. */
  @property({ type: Boolean })
  awaitingDatabaseSelection = false

  @property()
  selectedTable: string | null = null

  /** Every known connection id; removed profiles' collapse/expand state is pruned. */
  @property({ attribute: false })
  profileIds: string[] = []

  /** Tables expanded to show columns are keyed like selectedTable; function/type groups start collapsed. */
  @state()
  private _tree: TreeState = { collapsedSchemas: new Set(), expandedTables: new Set(), expandedObjectGroups: new Set() }

  @state()
  private _layout: SectionLayout = { filesCollapsed: false, tablesCollapsed: false, filesHeight: null, resizing: null }

  @state()
  private _menu: ExplorerMenu | null = null

  // Columns grouped per table, rebuilt only when the columns array changes.
  private _columnsByTable: { source: ColumnRef[] | null; map: Map<string, ColumnRef[]> } | null = null

  private _patchTree(partial: Partial<TreeState>) {
    this._tree = { ...this._tree, ...partial }
  }

  private _patchLayout(partial: Partial<SectionLayout>) {
    this._layout = { ...this._layout, ...partial }
  }

  protected willUpdate(changed: PropertyValues) {
    // Drop collapse/expand state for profiles that no longer exist — every key
    // is prefixed with its profile id, which is a colon-free UUID.
    if (changed.has('profileIds')) {
      const valid = new Set(this.profileIds)
      const prune = (keys: Set<string>) => new Set([...keys].filter((key) => valid.has(key.split(':')[0] ?? '')))
      const pruned: TreeState = {
        collapsedSchemas: prune(this._tree.collapsedSchemas),
        expandedTables: prune(this._tree.expandedTables),
        expandedObjectGroups: prune(this._tree.expandedObjectGroups),
      }
      const dropped =
        pruned.collapsedSchemas.size !== this._tree.collapsedSchemas.size ||
        pruned.expandedTables.size !== this._tree.expandedTables.size ||
        pruned.expandedObjectGroups.size !== this._tree.expandedObjectGroups.size
      if (dropped) this._tree = pruned
    }
    // A selection arriving from outside (⌘P table pick) must be visible:
    // expand the Tables section and the schema group holding it.
    if (changed.has('selectedTable') && this.selectedTable) {
      if (this._layout.tablesCollapsed) this._patchLayout({ tablesCollapsed: false })
      const [profileId, schema] = this.selectedTable.split(':')
      const groupKey = `${profileId}:${schema}`
      if (this._tree.collapsedSchemas.has(groupKey)) {
        const collapsedSchemas = new Set(this._tree.collapsedSchemas)
        collapsedSchemas.delete(groupKey)
        this._patchTree({ collapsedSchemas })
      }
    }
  }

  render() {
    const { filesCollapsed, tablesCollapsed, filesHeight, resizing } = this._layout
    const filesStyle = !filesCollapsed && filesHeight !== null ? `flex: 0 0 ${filesHeight}px` : ''

    return html`
      <div class="x-section ${filesCollapsed ? 'collapsed' : ''}" style=${filesStyle}>
        <button class="section-head-row" @click=${() => this._patchLayout({ filesCollapsed: !filesCollapsed })}>
          <i class="codicon codicon-chevron-right chevron ${filesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
          <span>Files</span>
          ${this.contextName ? html`<span class="section-detail">${this.contextName}</span>` : ''}
        </button>
        ${filesCollapsed
          ? ''
          : html`
              <div class="section-body">
                ${this.contextName
                  ? html`<file-tree .files=${this.files} .activePath=${this.activePath}></file-tree>`
                  : html`<p class="muted hint">Add a database to get its files folder.</p>`}
              </div>
            `}
      </div>

      ${!filesCollapsed && !tablesCollapsed
        ? html`
            <div
              class="x-resize ${resizing ? 'active' : ''}"
              role="separator"
              aria-label="Resize Files and Tables"
              title="Resize Files and Tables"
              @pointerdown=${this._onResizeStart}
              @pointermove=${this._onResizeMove}
              @pointerup=${this._onResizeEnd}
              @pointercancel=${this._onResizeEnd}
              @dblclick=${() => this._patchLayout({ filesHeight: null })}
            ></div>
          `
        : ''}

      <div
        class="x-section ${tablesCollapsed ? 'collapsed' : ''} ${tablesCollapsed && !filesCollapsed ? 'pin-bottom' : ''}"
      >
        <div class="section-head">
          <button class="section-head-row" @click=${() => this._patchLayout({ tablesCollapsed: !tablesCollapsed })}>
            <i class="codicon codicon-chevron-right chevron ${tablesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
            <span>Tables</span>
          </button>
          ${this.tables !== null
            ? html`
                <button
                  class="head-action"
                  title="Refresh tables and columns"
                  aria-label="Refresh tables and columns"
                  @click=${this._refresh}
                >
                  <i class="codicon codicon-refresh" aria-hidden="true"></i>
                </button>
              `
            : ''}
        </div>
        ${tablesCollapsed
          ? ''
          : html`<div class="section-body" @contextmenu=${(event: MouseEvent) => this._onTablesMenu(event, this._defaultCreateSchema())}>${this._renderTables()}</div>`}
      </div>
      ${this._renderTableMenu()} ${this._renderObjectMenu()}
    `
  }

  private _renderTableMenu() {
    const menu = this._menu?.kind === 'table' || this._menu?.kind === 'tables' ? this._menu : null
    if (!menu) return ''
    if (menu.kind === 'tables') {
      return html`
        <context-menu
          .x=${menu.x}
          .y=${menu.y}
          .items=${[
            { id: 'create', label: 'Create Table…' },
            ...(this.tables !== null ? [{ id: 'refresh', label: 'Refresh Tables' }] : []),
          ]}
          @menu-pick=${(e: CustomEvent<MenuPickDetail>) => {
            if (e.detail.id === 'create') this._createTable(menu.schema)
            if (e.detail.id === 'refresh') this._refresh()
          }}
          @menu-close=${() => (this._menu = null)}
        ></context-menu>
      `
    }
    const kind = menu.table.kind
    const dropLabel = TABLE_KIND_LABELS[kind].replace(/\b\w/g, (c) => c.toUpperCase())
    const items: MenuItem[] = [
      { id: 'create', label: 'Create Table…' },
      { id: 'browse', label: 'Browse Data' },
      { id: 'inspect', label: 'Inspect Table' },
      ...(kind === 'matview' ? [{ id: 'refresh-matview', label: 'Refresh Materialized View' }] : []),
      { id: 'copy-name', label: 'Copy Name' },
      { id: 'copy-select', label: 'Copy SELECT' },
      { id: 'refresh', label: 'Refresh Tables' },
      ...(kind === 'table' ? [{ id: 'truncate', label: 'Truncate Table…', danger: true }] : []),
      { id: 'drop', label: `Drop ${dropLabel}…`, danger: true },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onTableMenuPick(e.detail.id, menu.table)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _onTableMenuPick(id: string, table: TableRef) {
    if (id === 'create') this._createTable(table.schema)
    if (id === 'browse') this._browse(table)
    if (id === 'inspect') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('table-inspect', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'refresh-matview') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('matview-refresh', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'truncate') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('table-truncate', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'drop') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('table-drop', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'copy-name') void navigator.clipboard.writeText(tableLabel(table))
    if (id === 'copy-select' && this.engine) {
      const dialect = dialectFor(this.engine)
      void navigator.clipboard.writeText(`${dialect.browseTable(quoteQualified(table, dialect), 100)};`)
    }
    if (id === 'refresh') this._refresh()
  }

  private _createTable(schema: string | null) {
    this.dispatchEvent(
      new CustomEvent<TableCreateDetail>('table-create', { detail: { schema }, bubbles: true, composed: true }),
    )
  }

  private _defaultCreateSchema(): string | null {
    const schemas = new Set((this.tables ?? []).map((table) => table.schema))
    return schemas.size === 1 ? [...schemas][0] ?? null : null
  }

  private _renderTables() {
    if (this.awaitingDatabaseSelection) {
      return html`<p class="muted hint">Select a database to see its tables (${mod('K')}).</p>`
    }
    if (this.tables === null || !this.profileId) {
      return html`<p class="muted hint">Connect a database to see tables (${mod('K')}).</p>`
    }
    if (!this.tables.length) return html`<p class="muted hint">No tables.</p>`
    const profileId = this.profileId

    // Group by schema, preserving the driver's order. With one schema (or
    // none — SQLite) the list stays flat: a lone group header is just noise.
    const groups = new Map<string, TableRef[]>()
    for (const table of this.tables) {
      const schema = table.schema ?? ''
      const list = groups.get(schema)
      if (list) list.push(table)
      else groups.set(schema, [table])
    }
    if (groups.size < 2) {
      const schema = this.tables[0]?.schema ?? null
      return html`
        <div class="etable-list">
          ${this._renderObjectGroups(profileId, schema, false)}
          ${this.tables.map((table) => this._renderTableRow(profileId, table, false))}
        </div>
      `
    }
    return html`
      <div class="etable-list">
        ${[...groups.entries()].map(([schema, tables]) => {
          const groupKey = `${profileId}:${schema}`
          const collapsed = this._tree.collapsedSchemas.has(groupKey)
          return html`
            <button
              class="schema-row"
              @click=${() => this._toggleSchema(groupKey)}
              @contextmenu=${(event: MouseEvent) => this._onTablesMenu(event, schema)}
            >
              <i class="codicon codicon-chevron-right chevron ${collapsed ? '' : 'expanded'}" aria-hidden="true"></i>
              <span>${schema}</span>
              <span class="schema-count">${tables.length}</span>
            </button>
            ${collapsed ? '' : this._renderObjectGroups(profileId, schema, true)}
            ${collapsed ? '' : tables.map((table) => this._renderTableRow(profileId, table, true))}
          `
        })}
      </div>
    `
  }

  // Functions/Types as collapsed group rows under the schema's tables, the
  // count visible without expanding; groups with nothing in them are omitted.
  private _renderObjectGroups(profileId: string, schema: string | null, nested: boolean) {
    if (!this.objects) return ''
    const match = (object: DbObject) => (object.schema ?? '') === (schema ?? '')
    return html`
      ${this._renderObjectGroup(profileId, schema, 'Functions', this.objects.functions.filter(match), nested)}
      ${this._renderObjectGroup(profileId, schema, 'Types', this.objects.types.filter(match), nested)}
    `
  }

  private _renderObjectGroup(
    profileId: string,
    schema: string | null,
    label: 'Functions' | 'Types',
    items: DbObject[],
    nested: boolean,
  ) {
    if (!items.length) return ''
    const key = `${profileId}:${schema ?? ''}:${label}`
    const expanded = this._tree.expandedObjectGroups.has(key)
    return html`
      <button class="object-group ${nested ? 'nested' : ''}" @click=${() => this._toggleObjectGroup(key)}>
        <i class="codicon codicon-chevron-right chevron ${expanded ? 'expanded' : ''}" aria-hidden="true"></i>
        <span>${label}</span>
        <span class="schema-count">${items.length}</span>
      </button>
      ${expanded
        ? items.map((item) => {
            const objectKind: DbObjectKind = label === 'Functions' ? 'function' : 'type'
            return html`
              <div
                class="object-row ${nested ? 'nested' : ''}"
                title="${label === 'Functions'
                  ? `${item.name}(${item.detail})`
                  : `${item.name} · ${item.detail}`} — double-click to inspect"
                @dblclick=${() => this._inspectObject(item, objectKind)}
                @contextmenu=${(event: MouseEvent) => {
                  event.preventDefault()
                  event.stopPropagation()
                  this._menu = { kind: 'object', x: event.clientX, y: event.clientY, object: item, objectKind }
                }}
              >
                <i class="codicon ${objectIcon(label, item)}" aria-hidden="true"></i>
                <span class="object-name">${item.name}</span>
              </div>
            `
          })
        : ''}
    `
  }

  private _renderObjectMenu() {
    const menu = this._menu?.kind === 'object' ? this._menu : null
    if (!menu) return ''
    const items: MenuItem[] = [
      { id: 'inspect', label: 'Inspect' },
      { id: 'copy-name', label: 'Copy Name' },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => {
          if (e.detail.id === 'inspect') this._inspectObject(menu.object, menu.objectKind)
          if (e.detail.id === 'copy-name') {
            void navigator.clipboard.writeText(
              menu.object.schema ? `${menu.object.schema}.${menu.object.name}` : menu.object.name,
            )
          }
        }}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _inspectObject(object: DbObject, objectKind: DbObjectKind) {
    this.dispatchEvent(
      new CustomEvent<ObjectInspectDetail>('object-inspect', {
        detail: { object, objectKind },
        bubbles: true,
        composed: true,
      }),
    )
  }

  private _toggleObjectGroup(key: string) {
    const expandedObjectGroups = new Set(this._tree.expandedObjectGroups)
    if (!expandedObjectGroups.delete(key)) expandedObjectGroups.add(key)
    this._patchTree({ expandedObjectGroups })
  }

  private _renderTableRow(profileId: string, table: TableRef, nested: boolean) {
    const key = tableKey(profileId, table)
    const expanded = this._tree.expandedTables.has(key)
    return html`
      <div
        class="etable-row ${nested ? 'nested' : ''} ${this.selectedTable === key ? 'selected' : ''}"
        title="${tableLabel(table)}${table.kind !== 'table' ? ` · ${TABLE_KIND_LABELS[table.kind]}` : ''} — double-click to browse"
        @click=${() => this._select(key)}
        @dblclick=${() => this._browse(table)}
        @contextmenu=${(event: MouseEvent) => this._onTableMenu(event, table)}
      >
        <i
          class="codicon codicon-chevron-right chevron ${expanded ? 'expanded' : ''}"
          aria-hidden="true"
          @click=${(event: Event) => this._toggleTable(event, key)}
          @dblclick=${(event: Event) => event.stopPropagation()}
        ></i>
        <i class="codicon ${TABLE_KIND_ICONS[table.kind] ?? 'codicon-table'}" aria-hidden="true"></i>
        <span>${table.name}</span>
      </div>
      ${expanded ? this._renderColumns(table, nested) : ''}
    `
  }

  private _renderColumns(table: TableRef, nested: boolean) {
    const columns = this._tableColumns(table)
    if (!columns) return html`<p class="muted hint col-hint">Loading columns…</p>`
    if (!columns.length) return html`<p class="muted hint col-hint">No columns.</p>`
    return columns.map(
      (column) => html`
        <div
          class="ecol-row ${nested ? 'nested' : ''}"
          title="${column.name} · ${column.dataType}${column.nullable ? '' : ' · not null'}${column.foreignKey ? ' · foreign key' : ''}"
        >
          <i
            class="codicon ${column.primaryKey || column.foreignKey ? 'codicon-key' : 'codicon-symbol-field'} ${column.primaryKey ? 'pk' : column.foreignKey ? 'fk' : ''}"
            aria-hidden="true"
          ></i>
          <span class="col-name">${column.name}</span>
          <span class="col-type">${abbreviateType(column.dataType, this.engine)}</span>
        </div>
      `,
    )
  }

  private _tableColumns(table: TableRef): ColumnRef[] | null {
    if (this.columns === null) return null
    if (this._columnsByTable?.source !== this.columns) {
      const map = new Map<string, ColumnRef[]>()
      for (const column of this.columns) {
        const key = `${column.schema ?? ''}:${column.table}`
        const list = map.get(key)
        if (list) list.push(column)
        else map.set(key, [column])
      }
      this._columnsByTable = { source: this.columns, map }
    }
    return this._columnsByTable.map.get(`${table.schema ?? ''}:${table.name}`) ?? []
  }

  private _toggleTable(event: Event, key: string) {
    event.stopPropagation() // the row click selects; the chevron only expands
    const expandedTables = new Set(this._tree.expandedTables)
    if (!expandedTables.delete(key)) expandedTables.add(key)
    this._patchTree({ expandedTables })
  }

  private _refresh() {
    this.dispatchEvent(new CustomEvent('tables-refresh', { bubbles: true, composed: true }))
  }

  private _toggleSchema(groupKey: string) {
    const collapsedSchemas = new Set(this._tree.collapsedSchemas)
    if (!collapsedSchemas.delete(groupKey)) collapsedSchemas.add(groupKey)
    this._patchTree({ collapsedSchemas })
  }

  private _select(key: string) {
    this.dispatchEvent(
      new CustomEvent<TableSelectDetail>('table-select', { detail: { key }, bubbles: true, composed: true }),
    )
  }

  private _browse(table: TableRef) {
    this.dispatchEvent(
      new CustomEvent<TableBrowseDetail>('table-browse', { detail: { table }, bubbles: true, composed: true }),
    )
  }

  private _onTableMenu(event: MouseEvent, table: TableRef) {
    event.preventDefault()
    event.stopPropagation()
    this._menu = { kind: 'table', x: event.clientX, y: event.clientY, table }
  }

  private _onTablesMenu(event: MouseEvent, schema: string | null) {
    event.preventDefault()
    event.stopPropagation()
    if (!this.profileId || this.tables === null || this.awaitingDatabaseSelection) return
    this._menu = { kind: 'tables', x: event.clientX, y: event.clientY, schema }
  }

  private _onResizeStart(event: PointerEvent) {
    const files = this.shadowRoot?.querySelector<HTMLElement>('.x-section')
    if (!files) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._patchLayout({ resizing: { startY: event.clientY, startHeight: files.offsetHeight } })
    event.preventDefault()
  }

  private _onResizeMove(event: PointerEvent) {
    const resizing = this._layout.resizing
    if (!resizing) return

    // Keep at least a header-plus-a-few-rows visible on both sides.
    const minSection = 72
    const max = Math.max(minSection, this.clientHeight - 1 - minSection)
    const raw = resizing.startHeight + (event.clientY - resizing.startY)
    this._patchLayout({ filesHeight: Math.max(minSection, Math.min(max, raw)) })
  }

  private _onResizeEnd(event: PointerEvent) {
    if (!this._layout.resizing) return
    this._patchLayout({ resizing: null })
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  }

  static styles = [
    typography,
    codicons,
    // The scroll containers in this root include the <file-tree> host itself;
    // its scrollbar is styled from here, not from its own stylesheet.
    scrollbars,
    css`
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      :host(:has(.x-resize.active)) {
        cursor: row-resize;
        user-select: none;
      }

      .hint {
        padding: 0 20px;
      }

      /* Expanded sections split the height evenly (or per the dragged
         divider) and never grow past it: their bodies scroll instead. */
      .x-section {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 72px;
      }

      .x-section.collapsed {
        flex: 0 0 auto;
        min-height: 0;
      }

      .x-section.pin-bottom {
        margin-top: auto;
      }

      .section-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
      }

      .section-body > file-tree,
      .section-body > .etable-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .x-resize {
        height: 1px;
        flex-shrink: 0;
        cursor: row-resize;
        background: var(--border-subtle);
        position: relative;
        z-index: 10;
        touch-action: none;
      }

      /* Wider invisible hit area than the 1px visible line. */
      .x-resize::after {
        content: '';
        position: absolute;
        inset: -2px 0;
      }

      .x-resize:hover,
      .x-resize.active {
        background: var(--resize-hover);
      }

      .section-head {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .section-head .section-head-row {
        flex: 1;
        min-width: 0;
      }

      .head-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin-right: 4px;
        padding: 0;
        flex-shrink: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
        --codicon-size: 14px;
      }

      .head-action:hover {
        background: var(--list-hover);
        color: var(--text);
      }

      .section-head-row {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 4px 10px;
        border: none;
        background: transparent;
        color: var(--text);
        font-family: inherit;
        font-size: var(--font-size-sm);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        text-align: left;
        cursor: pointer;
        flex-shrink: 0;
      }

      .section-head-row:hover {
        background: var(--list-hover);
      }

      .section-head-row .chevron {
        font-size: 14px;
        transition: transform 0.1s ease;
      }

      .section-head-row .chevron.expanded {
        transform: rotate(90deg);
      }

      .section-detail {
        margin-left: auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-3);
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
      }

      .etable-list {
        display: flex;
        flex-direction: column;
      }

      .schema-row {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 2px 10px 2px 14px;
        border: none;
        background: transparent;
        color: var(--text-2);
        font-family: inherit;
        font-size: var(--font-size);
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
      }

      .schema-row:hover {
        background: var(--list-hover);
      }

      .schema-row .chevron {
        font-size: 14px;
        flex-shrink: 0;
        transition: transform 0.1s ease;
      }

      .schema-row .chevron.expanded {
        transform: rotate(90deg);
      }

      .schema-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .schema-count {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .etable-row.nested {
        padding-left: 24px;
      }

      .etable-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px 3px 8px;
        font-size: var(--font-size);
        color: var(--text);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .etable-row .chevron {
        flex-shrink: 0;
        color: var(--text-3);
        transition: transform 0.1s ease;
      }

      .etable-row .chevron.expanded {
        transform: rotate(90deg);
      }

      /* Function/type groups sit at table level; their item rows at column
         level — same indentation rhythm as tables and their columns. */
      .object-group {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 3px 10px 3px 8px;
        border: none;
        background: transparent;
        color: var(--text-2);
        font-family: inherit;
        font-size: var(--font-size);
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
      }

      .object-group.nested {
        padding-left: 24px;
      }

      .object-group:hover {
        background: var(--list-hover);
      }

      /* Function/type names are navigation targets like table names — full
         text color and size, not the muted column-row treatment. */
      .object-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 30px;
        font-size: var(--font-size);
        color: var(--text);
        white-space: nowrap;
        user-select: none;
      }

      .object-row.nested {
        padding-left: 46px;
      }

      .object-row:hover {
        background: var(--list-hover);
      }

      .object-row .codicon {
        flex-shrink: 0;
        color: var(--text-3);
      }

      .object-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ecol-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 30px;
        font-size: var(--font-size-sm);
        color: var(--text-2);
        white-space: nowrap;
        user-select: none;
        --codicon-size: 13px;
      }

      .ecol-row.nested {
        padding-left: 42px;
      }

      .ecol-row .codicon {
        flex-shrink: 0;
        color: var(--text-3);
      }

      .ecol-row .codicon.pk {
        color: var(--status-dot-warning);
      }

      .ecol-row .codicon.fk {
        color: var(--accent);
      }

      .col-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .col-type {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
      }

      .col-hint {
        padding: 2px 10px 2px 30px;
        font-size: var(--font-size-sm);
      }

      .etable-row:hover {
        background: var(--list-hover);
      }

      .etable-row.selected {
        background: var(--list-selection);
        color: var(--list-selection-fg);
      }

      .etable-row .codicon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .etable-row.selected .codicon {
        color: var(--list-selection-fg);
      }

      .etable-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'explorer-view': ExplorerView
  }
}
