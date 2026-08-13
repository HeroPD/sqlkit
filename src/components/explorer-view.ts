import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, popover, scrollbars, typography } from '../shared-styles'
import { mod } from '../platform'
import { abbreviateType } from '../sql-types'
import { TABLE_KIND_ICONS, tableKindLabel } from '../table-kinds'
import type { ColumnRef, DbObject, DbObjectKind, DbObjects, Engine, FileInfo, ObjectDdlRef, TableRef, TableStat } from '../electron'
import { dialectFor } from '../dialect'
import { quoteQualified } from '../sql-write'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './file-tree'
import { formatBytes, t } from '../i18n'

export const tableKey = (profileId: string, table: TableRef) => `${profileId}:${table.schema ?? ''}:${table.name}`

export const tableLabel = (table: TableRef) => (table.schema ? `${table.schema}.${table.name}` : table.name)

const objectIcon = (label: 'Functions' | 'Types', object: DbObject) =>
  label === 'Functions' ? 'icon-square-function' : object.detail === 'enum' ? 'icon-list' : 'icon-boxes'

// Object kinds the Tables list can be filtered by. Persisted globally, but the
// selection resets when the connection changes so a hidden kind never reads as
// "my tables are gone" on a different database.
type FilterKind = TableRef['kind'] | DbObjectKind
const FILTER_KINDS: FilterKind[] = ['table', 'view', 'matview', 'foreign', 'function', 'type']
const FILTER_STORAGE_KEY = 'sqlkit-explorer-hidden-kinds'
const SORT_STORAGE_KEY = 'sqlkit-explorer-table-sort'
const filterKindLabel = (kind: FilterKind) =>
  kind === 'function' ? t('explorer.functions') : kind === 'type' ? t('explorer.types') : tableKindLabel(kind)
type TableSort = 'name' | 'size'
const statKey = (schema: string | null, name: string) => `${schema ?? ''}:${name}`

export type TableSelectDetail = { key: string }
export type ObjectInspectDetail = { object: DbObject; objectKind: DbObjectKind }
export type ObjectEditDetail = { ref: ObjectDdlRef }
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

  /** Refreshable allocated sizes; null while unavailable or loading. */
  @property({ attribute: false })
  tableStats: TableStat[] | null = null

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

  /** Object kinds hidden from the Tables list; persisted globally. */
  @state()
  private _hiddenKinds = new Set<FilterKind>()

  @state()
  private _tableSort: TableSort = 'name'

  /** Anchor position of the open kind-filter popover, or null when closed. */
  @state()
  private _filterMenu: { right: number; top: number } | null = null

  /** Last connection seen, so a connection switch can reset the filter. */
  private _lastProfileId: string | null = null

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onFilterKeydown)
    try {
      const raw = localStorage.getItem(FILTER_STORAGE_KEY)
      if (raw) this._hiddenKinds = new Set((JSON.parse(raw) as FilterKind[]).filter((k) => FILTER_KINDS.includes(k)))
      // Persisted next to the filter it shares a popover with: a sort that
      // reset every launch while the filter survived would read as a bug.
      const sort = localStorage.getItem(SORT_STORAGE_KEY)
      if (sort === 'name' || sort === 'size') this._tableSort = sort
    } catch {
      // A corrupt value just means no filter.
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onFilterKeydown)
  }

  @state()
  private _layout: SectionLayout = { filesCollapsed: false, tablesCollapsed: false, filesHeight: null, resizing: null }

  @state()
  private _menu: ExplorerMenu | null = null

  // Columns grouped per table, rebuilt only when the columns array changes.
  private _columnsByTable: { source: ColumnRef[] | null; map: Map<string, ColumnRef[]> } | null = null
  private _statsByTable: { source: TableStat[] | null; map: Map<string, TableStat> } | null = null

  private _patchTree(partial: Partial<TreeState>) {
    this._tree = { ...this._tree, ...partial }
  }

  private _patchLayout(partial: Partial<SectionLayout>) {
    this._layout = { ...this._layout, ...partial }
  }

  protected willUpdate(changed: PropertyValues) {
    // Switching to a different connection clears the kind filter — a persisted
    // filter carried into another database could hide kinds and read as missing
    // tables. The first connection (null → id) keeps the loaded filter.
    if (changed.has('profileId') && this.profileId) {
      if (this._lastProfileId && this._lastProfileId !== this.profileId && this._hiddenKinds.size) {
        this._hiddenKinds = new Set()
        this._persistHiddenKinds()
        this._filterMenu = null
      }
      this._lastProfileId = this.profileId
    }
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

  private _persistHiddenKinds() {
    try {
      if (this._hiddenKinds.size) localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...this._hiddenKinds]))
      else localStorage.removeItem(FILTER_STORAGE_KEY)
    } catch {
      // Blocked storage still leaves the filter working for the session.
    }
  }

  private _setTableSort(sort: TableSort) {
    this._tableSort = sort
    try {
      if (sort === 'name') localStorage.removeItem(SORT_STORAGE_KEY)
      else localStorage.setItem(SORT_STORAGE_KEY, sort)
    } catch {
      // Blocked storage still leaves the sort working for the session.
    }
  }

  // Kinds actually present in the current metadata — no empty toggles.
  private _presentKinds(): FilterKind[] {
    const present = new Set<FilterKind>()
    for (const table of this.tables ?? []) present.add(table.kind)
    if (this.objects?.functions.length) present.add('function')
    if (this.objects?.types.length) present.add('type')
    return FILTER_KINDS.filter((kind) => present.has(kind))
  }

  private _kindCount(kind: FilterKind): number {
    if (kind === 'function') return this.objects?.functions.length ?? 0
    if (kind === 'type') return this.objects?.types.length ?? 0
    return (this.tables ?? []).filter((table) => table.kind === kind).length
  }

  private _toggleKind(kind: FilterKind) {
    const next = new Set(this._hiddenKinds)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    this._hiddenKinds = next
    this._persistHiddenKinds()
  }

  private _toggleFilterMenu(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    this._filterMenu = this._filterMenu ? null : { right: window.innerWidth - rect.right, top: rect.bottom + 4 }
  }

  private _onFilterKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this._filterMenu) {
      event.preventDefault()
      this._filterMenu = null
    }
  }

  private _renderFilterMenu() {
    const menu = this._filterMenu
    if (!menu) return ''
    const kinds = this._presentKinds()
    return html`
      <div class="pop-backdrop" @mousedown=${() => (this._filterMenu = null)}></div>
      <div class="pop kinds" style="right: ${menu.right}px; top: ${menu.top}px" role="menu" aria-label=${t('explorer.tableOptions')}>
        ${kinds.map(
          (kind) => html`
            <button
              class="pop-item"
              role="menuitemcheckbox"
              aria-checked=${this._hiddenKinds.has(kind) ? 'false' : 'true'}
              @mousedown=${(event: MouseEvent) => event.preventDefault()}
              @click=${() => this._toggleKind(kind)}
            >
              <i
                class="icon check ${this._hiddenKinds.has(kind) ? 'icon-square' : 'icon-square-check'}"
                aria-hidden="true"
              ></i>
              <span class="label">${filterKindLabel(kind)}</span>
              <span class="meta">${this._kindCount(kind)}</span>
            </button>
          `,
        )}
        ${this._hasSizes()
          ? html`
              <div class="pop-separator" role="separator"></div>
              ${(['name', 'size'] as const).map(
                (sort) => html`
                  <button
                    class="pop-item"
                    role="menuitemradio"
                    aria-checked=${this._tableSort === sort ? 'true' : 'false'}
                    @mousedown=${(event: MouseEvent) => event.preventDefault()}
                    @click=${() => this._setTableSort(sort)}
                  >
                    <i class="icon check ${this._tableSort === sort ? 'icon-check' : ''}" aria-hidden="true"></i>
                    <span class="label">${t(sort === 'name' ? 'explorer.sortName' : 'explorer.sortSize')}</span>
                  </button>
                `,
              )}
            `
          : ''}
      </div>
    `
  }

  render() {
    const { filesCollapsed, tablesCollapsed, filesHeight, resizing } = this._layout
    const filesStyle = !filesCollapsed && filesHeight !== null ? `flex: 0 0 ${filesHeight}px` : ''

    return html`
      <div class="x-section ${filesCollapsed ? 'collapsed' : ''}" style=${filesStyle}>
        <button class="section-head-row" @click=${() => this._patchLayout({ filesCollapsed: !filesCollapsed })}>
          <i class="icon icon-chevron-right chevron ${filesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
          <span>${t('explorer.files')}</span>
          ${this.contextName ? html`<span class="section-detail">${this.contextName}</span>` : ''}
        </button>
        ${filesCollapsed
          ? ''
          : html`
              <div class="section-body">
                ${this.contextName
                  ? html`<file-tree .files=${this.files} .activePath=${this.activePath}></file-tree>`
                  : html`<p class="muted hint">${t('explorer.addDatabaseForFiles')}</p>`}
              </div>
            `}
      </div>

      ${!filesCollapsed && !tablesCollapsed
        ? html`
            <div
              class="x-resize ${resizing ? 'active' : ''}"
              role="separator"
              aria-label=${t('explorer.resize')}
              title=${t('explorer.resize')}
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
            <i class="icon icon-chevron-right chevron ${tablesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
            <span>${t('explorer.tables')}</span>
          </button>
          ${this.tables !== null
            ? html`
                <button
                  class="head-action ${this._hiddenKinds.size ? 'filtered' : ''}"
                  title=${t('explorer.tableOptions')}
                  aria-label=${t('explorer.tableOptions')}
                  aria-haspopup="menu"
                  aria-expanded=${this._filterMenu ? 'true' : 'false'}
                  @click=${this._toggleFilterMenu}
                >
                  <i class="icon icon-filter" aria-hidden="true"></i>
                </button>
                <button
                  class="head-action"
                  title=${t('explorer.refreshMetadata')}
                  aria-label=${t('explorer.refreshMetadata')}
                  @click=${this._refresh}
                >
                  <i class="icon icon-refresh-cw" aria-hidden="true"></i>
                </button>
              `
            : ''}
        </div>
        ${tablesCollapsed
          ? ''
          : html`<div class="section-body" @contextmenu=${(event: MouseEvent) => this._onTablesMenu(event, this._defaultCreateSchema())}>${this._renderTables()}</div>`}
      </div>
      ${this._renderTableMenu()} ${this._renderObjectMenu()} ${this._renderFilterMenu()}
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
            { id: 'create', label: t('explorer.createTable') },
            ...(this.tables !== null ? [{ id: 'refresh', label: t('explorer.refreshTables') }] : []),
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
    const dropLabel = tableKindLabel(kind).replace(/\b\w/g, (c) => c.toUpperCase())
    const items: MenuItem[] = [
      { id: 'create', label: t('explorer.createTable') },
      { id: 'browse', label: t('explorer.browseData'), separatorBefore: true },
      { id: 'inspect', label: t('explorer.inspectTable') },
      ...(kind === 'view' || kind === 'matview' ? [{ id: 'edit', label: t('explorer.editSource') }] : []),
      ...(kind === 'table' ? [{ id: 'import', label: t('explorer.importCsv') }] : []),
      ...(kind === 'matview' ? [{ id: 'refresh-matview', label: t('explorer.refreshMaterializedView') }] : []),
      { id: 'copy-name', label: t('explorer.copyName'), separatorBefore: true },
      { id: 'copy-select', label: t('explorer.copySelect') },
      { id: 'refresh', label: t('explorer.refreshTables'), separatorBefore: true },
      ...(kind === 'table' ? [{ id: 'truncate', label: t('explorer.truncateTable'), danger: true, separatorBefore: true }] : []),
      { id: 'drop', label: t('explorer.dropObject', { kind: dropLabel }), danger: true, separatorBefore: kind !== 'table' },
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
    if (id === 'import') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('table-import', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'refresh-matview') {
      this.dispatchEvent(
        new CustomEvent<TableBrowseDetail>('matview-refresh', { detail: { table }, bubbles: true, composed: true }),
      )
    }
    if (id === 'edit' && (table.kind === 'view' || table.kind === 'matview')) {
      this._editObject({ schema: table.schema, name: table.name, kind: table.kind, detail: null })
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
      return html`<p class="muted hint">${t('explorer.selectDatabase', { shortcut: mod('K') })}</p>`
    }
    // Stating the fact, not pointing anywhere: the titlebar's connection
    // button is the verb, and it is visible from every view.
    if (this.tables === null || !this.profileId) {
      return html`<p class="muted hint">${t('explorer.notConnected')}</p>`
    }
    if (!this.tables.length) return html`<p class="muted hint">${t('explorer.noTables')}</p>`
    const profileId = this.profileId

    // Kind filter: hide rows of hidden kinds. If it empties the whole list, say
    // so — the accented funnel plus this hint keep it from looking like data loss.
    const visibleTables = this._sortTables(this.tables.filter((table) => !this._hiddenKinds.has(table.kind)))
    if (!visibleTables.length && !this._anyObjectsVisible(null)) {
      return html`<p class="muted hint">${this._hiddenKinds.size ? t('explorer.allHidden') : t('explorer.noTables')}</p>`
    }

    // Group by schema, in the driver's order; the tables inside each group are
    // then sorted by _sortTables. With one schema (or none — SQLite) the list
    // stays flat: a lone group header is just noise.
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
          ${visibleTables.map((table) => this._renderTableRow(profileId, table, false))}
        </div>
      `
    }
    return html`
      <div class="etable-list">
        ${[...groups.entries()].map(([schema, tables]) => {
          const visible = this._sortTables(tables.filter((table) => !this._hiddenKinds.has(table.kind)))
          // Drop a schema group only when the filter leaves it nothing at all.
          if (!visible.length && !this._anyObjectsVisible(schema)) return ''
          const groupKey = `${profileId}:${schema}`
          const collapsed = this._tree.collapsedSchemas.has(groupKey)
          return html`
            <button
              class="schema-row"
              @click=${() => this._toggleSchema(groupKey)}
              @contextmenu=${(event: MouseEvent) => this._onTablesMenu(event, schema)}
            >
              <i class="icon icon-chevron-right chevron ${collapsed ? '' : 'expanded'}" aria-hidden="true"></i>
              <span>${schema}</span>
              <span class="schema-count">${visible.length}</span>
            </button>
            ${collapsed ? '' : this._renderObjectGroups(profileId, schema, true)}
            ${collapsed ? '' : visible.map((table) => this._renderTableRow(profileId, table, true))}
          `
        })}
      </div>
    `
  }

  // Whether any function/type group would render for a schema (null = any
  // schema) given the current kind filter — used to decide if a group is empty.
  private _anyObjectsVisible(schema: string | null): boolean {
    if (!this.objects) return false
    const inSchema = (object: DbObject) => schema === null || (object.schema ?? '') === (schema ?? '')
    const functions = !this._hiddenKinds.has('function') && this.objects.functions.some(inSchema)
    const types = !this._hiddenKinds.has('type') && this.objects.types.some(inSchema)
    return functions || types
  }

  // Functions/Types as collapsed group rows under the schema's tables, the
  // count visible without expanding; groups with nothing in them are omitted.
  private _renderObjectGroups(profileId: string, schema: string | null, nested: boolean) {
    if (!this.objects) return ''
    const match = (object: DbObject) => (object.schema ?? '') === (schema ?? '')
    return html`
      ${this._hiddenKinds.has('function') ? '' : this._renderObjectGroup(profileId, schema, 'Functions', this.objects.functions.filter(match), nested)}
      ${this._hiddenKinds.has('type') ? '' : this._renderObjectGroup(profileId, schema, 'Types', this.objects.types.filter(match), nested)}
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
        <i class="icon icon-chevron-right chevron ${expanded ? 'expanded' : ''}" aria-hidden="true"></i>
        <span>${t(label === 'Functions' ? 'explorer.functions' : 'explorer.types')}</span>
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
                  : `${item.name} · ${item.detail}`} — ${t('explorer.doubleClickInspect')}"
                @dblclick=${() => this._inspectObject(item, objectKind)}
                @contextmenu=${(event: MouseEvent) => {
                  event.preventDefault()
                  event.stopPropagation()
                  this._menu = { kind: 'object', x: event.clientX, y: event.clientY, object: item, objectKind }
                }}
              >
                <i class="icon ${objectIcon(label, item)}" aria-hidden="true"></i>
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
      { id: 'inspect', label: t('explorer.inspect') },
      ...(menu.objectKind === 'function' ? [{ id: 'edit', label: t('explorer.editSource') }] : []),
      { id: 'copy-name', label: t('explorer.copyName') },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => {
          if (e.detail.id === 'inspect') this._inspectObject(menu.object, menu.objectKind)
          if (e.detail.id === 'edit') {
            this._editObject({ schema: menu.object.schema, name: menu.object.name, kind: 'function', detail: menu.object.detail })
          }
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

  private _editObject(ref: ObjectDdlRef) {
    this.dispatchEvent(
      new CustomEvent<ObjectEditDetail>('object-edit', { detail: { ref }, bubbles: true, composed: true }),
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
    const stat = this._tableStat(table)
    const sizeTitle = stat
      ? t(stat.approximate ? 'explorer.approximateSize' : 'explorer.totalSize', { size: formatBytes(stat.totalBytes) })
      : ''
    return html`
      <div
        class="etable-row ${nested ? 'nested' : ''} ${this.selectedTable === key ? 'selected' : ''}"
        title="${tableLabel(table)}${table.kind !== 'table' ? ` · ${tableKindLabel(table.kind)}` : ''}${sizeTitle ? ` · ${sizeTitle}` : ''} — ${t('explorer.doubleClickBrowse')}"
        @click=${() => this._select(key)}
        @dblclick=${() => this._browse(table)}
        @contextmenu=${(event: MouseEvent) => this._onTableMenu(event, table)}
      >
        <i
          class="icon icon-chevron-right chevron ${expanded ? 'expanded' : ''}"
          aria-hidden="true"
          @click=${(event: Event) => this._toggleTable(event, key)}
          @dblclick=${(event: Event) => event.stopPropagation()}
        ></i>
        <i class="icon ${TABLE_KIND_ICONS[table.kind] ?? 'icon-table'}" aria-hidden="true"></i>
        <span class="table-name">${table.name}</span>
        ${this._hasSizes()
          ? html`<span class="table-size" title=${sizeTitle || nothing}
              >${stat ? `${stat.approximate ? '~' : ''}${formatBytes(stat.totalBytes)}` : '—'}</span
            >`
          : ''}
      </div>
      ${expanded ? this._renderColumns(table, nested) : ''}
    `
  }

  /** Whether this connection reports sizes at all — SQLite and a refused read
   * report none, and a size column of nothing but dashes is worse than none. */
  private _hasSizes(): boolean {
    return this.tableStats !== null
  }

  private _tableStat(table: TableRef): TableStat | undefined {
    if (this._statsByTable?.source !== this.tableStats) {
      this._statsByTable = {
        source: this.tableStats,
        map: new Map((this.tableStats ?? []).map((stat) => [statKey(stat.schema, stat.name), stat])),
      }
    }
    return this._statsByTable.map.get(statKey(table.schema, table.name))
  }

  private _sortTables(tables: TableRef[]): TableRef[] {
    return [...tables].sort((a, b) => {
      if (this._tableSort === 'size') {
        const aSize = this._tableStat(a)?.totalBytes
        const bSize = this._tableStat(b)?.totalBytes
        if (aSize !== undefined || bSize !== undefined) {
          if (aSize === undefined) return 1
          if (bSize === undefined) return -1
          if (aSize !== bSize) return bSize - aSize
        }
      }
      return a.name.localeCompare(b.name)
    })
  }

  private _renderColumns(table: TableRef, nested: boolean) {
    const columns = this._tableColumns(table)
    if (!columns) return html`<p class="muted hint col-hint">${t('explorer.loadingColumns')}</p>`
    if (!columns.length) return html`<p class="muted hint col-hint">${t('explorer.noColumns')}</p>`
    return columns.map(
      (column) => html`
        <div
          class="ecol-row ${nested ? 'nested' : ''}"
          title="${column.name} · ${column.dataType}${column.nullable ? '' : ` · ${t('explorer.notNull')}`}${column.foreignKey ? ` · ${t('explorer.foreignKey')}` : ''}"
        >
          <i
            class="icon ${column.primaryKey || column.foreignKey ? 'icon-key' : 'icon-rectangle-ellipsis'} ${column.primaryKey ? 'pk' : column.foreignKey ? 'fk' : ''}"
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
    icons,
    popover,
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
        --icon-size: 14px;
      }

      .head-action:hover {
        background: var(--list-hover);
        color: var(--text);
      }

      /* Accent the funnel while a kind filter is active. */
      .head-action.filtered,
      .head-action.filtered:hover {
        color: var(--accent);
      }

      /* Kind labels read as "Table"/"View"/… regardless of the driver's casing. */
      .pop.kinds .label {
        text-transform: capitalize;
      }

      /* Plain-menu aesthetic (16px icon column, 14px icons) but keeping the
         third column for per-kind counts. */
      .pop.kinds .pop-item {
        grid-template-columns: 20px minmax(0, 1fr) auto;
        --icon-size: 14px;
      }

      /* Filter toggles read as checkboxes. The outline square is inset in its
         em box, so oversize it a few px to match the visual weight of other icons. */
      .pop.kinds .check {
        font-size: calc(var(--icon-size) + 4px);
        color: var(--text-2);
      }

      .pop-separator {
        height: 1px;
        margin: 4px 6px;
        background: var(--border-subtle);
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

      .object-row .icon {
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
        --icon-size: 13px;
      }

      .ecol-row.nested {
        padding-left: 42px;
      }

      .ecol-row .icon {
        flex-shrink: 0;
        color: var(--text-3);
      }

      .ecol-row .icon.pk {
        color: var(--status-dot-warning);
      }

      .ecol-row .icon.fk {
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

      .etable-row .icon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .etable-row.selected .icon {
        color: var(--list-selection-fg);
      }

      .etable-row span {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .table-name {
        min-width: 0;
      }

      .etable-row .table-size {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
        font-size: var(--font-size-sm);
        font-variant-numeric: tabular-nums;
      }

      .etable-row.selected .table-size {
        color: color-mix(in srgb, var(--list-selection-fg) 72%, transparent);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'explorer-view': ExplorerView
  }
}
