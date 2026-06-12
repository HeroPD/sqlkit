import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { mod } from '../platform'
import { abbreviateType } from '../sql-types'
import type { ColumnRef, Engine, FileInfo, TableRef } from '../electron'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './file-tree'

export const tableKey = (profileId: string, table: TableRef) => `${profileId}:${table.schema ?? ''}:${table.name}`

export const tableLabel = (table: TableRef) => (table.schema ? `${table.schema}.${table.name}` : table.name)

export type TableSelectDetail = { key: string }
export type TableBrowseDetail = { table: TableRef }

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

  /** Active child database (all-databases mode), shown in the Tables header. */
  @property()
  activeChildName: string | null = null

  @property()
  selectedTable: string | null = null

  @state()
  private _filesCollapsed = false

  @state()
  private _tablesCollapsed = false

  /** Collapsed schema groups, keyed `profileId:schema` so state is per profile. */
  @state()
  private _collapsedSchemas = new Set<string>()

  /** Expanded tables (showing columns), keyed like selectedTable. */
  @state()
  private _expandedTables = new Set<string>()

  // Columns grouped per table, rebuilt only when the columns array changes.
  private _columnsByTable: { source: ColumnRef[] | null; map: Map<string, ColumnRef[]> } | null = null

  // null = the default even split; a number pins the Files section height.
  @state()
  private _filesSectionHeight: number | null = null

  @state()
  private _sectionResizing: { startY: number; startHeight: number } | null = null

  @state()
  private _tableMenu: { x: number; y: number; table: TableRef } | null = null

  protected willUpdate(changed: PropertyValues) {
    // A selection arriving from outside (⌘P table pick) must be visible:
    // expand the Tables section and the schema group holding it.
    if (changed.has('selectedTable') && this.selectedTable) {
      this._tablesCollapsed = false
      const [profileId, schema] = this.selectedTable.split(':')
      const groupKey = `${profileId}:${schema}`
      if (this._collapsedSchemas.has(groupKey)) {
        const next = new Set(this._collapsedSchemas)
        next.delete(groupKey)
        this._collapsedSchemas = next
      }
    }
  }

  render() {
    const filesStyle =
      !this._filesCollapsed && this._filesSectionHeight !== null ? `flex: 0 0 ${this._filesSectionHeight}px` : ''

    return html`
      <div class="x-section ${this._filesCollapsed ? 'collapsed' : ''}" style=${filesStyle}>
        <button class="section-head-row" @click=${() => (this._filesCollapsed = !this._filesCollapsed)}>
          <i class="codicon codicon-chevron-right chevron ${this._filesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
          <span>Files</span>
          ${this.contextName ? html`<span class="section-detail">${this.contextName}</span>` : ''}
        </button>
        ${this._filesCollapsed
          ? ''
          : html`
              <div class="section-body">
                ${this.contextName
                  ? html`<file-tree .files=${this.files} .activePath=${this.activePath}></file-tree>`
                  : html`<p class="muted hint">Add a database to get its files folder.</p>`}
              </div>
            `}
      </div>

      ${!this._filesCollapsed && !this._tablesCollapsed
        ? html`
            <div
              class="x-resize ${this._sectionResizing ? 'active' : ''}"
              role="separator"
              aria-label="Resize Files and Tables"
              title="Resize Files and Tables"
              @pointerdown=${this._onResizeStart}
              @pointermove=${this._onResizeMove}
              @pointerup=${this._onResizeEnd}
              @pointercancel=${this._onResizeEnd}
              @dblclick=${() => (this._filesSectionHeight = null)}
            ></div>
          `
        : ''}

      <div
        class="x-section ${this._tablesCollapsed ? 'collapsed' : ''} ${this._tablesCollapsed && !this._filesCollapsed ? 'pin-bottom' : ''}"
      >
        <div class="section-head">
          <button class="section-head-row" @click=${() => (this._tablesCollapsed = !this._tablesCollapsed)}>
            <i class="codicon codicon-chevron-right chevron ${this._tablesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
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
        ${this._tablesCollapsed ? '' : html`<div class="section-body">${this._renderTables()}</div>`}
      </div>
      ${this._renderTableMenu()}
    `
  }

  private _renderTableMenu() {
    const menu = this._tableMenu
    if (!menu) return ''
    const items: MenuItem[] = [
      { id: 'browse', label: 'Browse Data' },
      { id: 'copy-name', label: 'Copy Name' },
      { id: 'copy-select', label: 'Copy SELECT' },
      { id: 'refresh', label: 'Refresh Tables' },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onTableMenuPick(e.detail.id, menu.table)}
        @menu-close=${() => (this._tableMenu = null)}
      ></context-menu>
    `
  }

  private _onTableMenuPick(id: string, table: TableRef) {
    if (id === 'browse') this._browse(table)
    if (id === 'copy-name') void navigator.clipboard.writeText(tableLabel(table))
    if (id === 'copy-select') void navigator.clipboard.writeText(`select * from ${tableLabel(table)} limit 100;`)
    if (id === 'refresh') this._refresh()
  }

  private _renderTables() {
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
      return html`
        <div class="etable-list">${this.tables.map((table) => this._renderTableRow(profileId, table, false))}</div>
      `
    }
    return html`
      <div class="etable-list">
        ${[...groups.entries()].map(([schema, tables]) => {
          const groupKey = `${profileId}:${schema}`
          const collapsed = this._collapsedSchemas.has(groupKey)
          return html`
            <button class="schema-row" @click=${() => this._toggleSchema(groupKey)}>
              <i class="codicon codicon-chevron-right chevron ${collapsed ? '' : 'expanded'}" aria-hidden="true"></i>
              <span>${schema}</span>
              <span class="schema-count">${tables.length}</span>
            </button>
            ${collapsed ? '' : tables.map((table) => this._renderTableRow(profileId, table, true))}
          `
        })}
      </div>
    `
  }

  private _renderTableRow(profileId: string, table: TableRef, nested: boolean) {
    const key = tableKey(profileId, table)
    const expanded = this._expandedTables.has(key)
    return html`
      <div
        class="etable-row ${nested ? 'nested' : ''} ${this.selectedTable === key ? 'selected' : ''}"
        title="${tableLabel(table)} — double-click to browse"
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
        <i class="codicon codicon-table" aria-hidden="true"></i>
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
    const next = new Set(this._expandedTables)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this._expandedTables = next
  }

  private _refresh() {
    this.dispatchEvent(new CustomEvent('tables-refresh', { bubbles: true, composed: true }))
  }

  private _toggleSchema(groupKey: string) {
    const next = new Set(this._collapsedSchemas)
    if (next.has(groupKey)) next.delete(groupKey)
    else next.add(groupKey)
    this._collapsedSchemas = next
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
    this._tableMenu = { x: event.clientX, y: event.clientY, table }
  }

  private _onResizeStart(event: PointerEvent) {
    const files = this.shadowRoot?.querySelector<HTMLElement>('.x-section')
    if (!files) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this._sectionResizing = { startY: event.clientY, startHeight: files.offsetHeight }
    event.preventDefault()
  }

  private _onResizeMove(event: PointerEvent) {
    if (!this._sectionResizing) return

    // Keep at least a header-plus-a-few-rows visible on both sides.
    const minSection = 72
    const max = Math.max(minSection, this.clientHeight - 1 - minSection)
    const raw = this._sectionResizing.startHeight + (event.clientY - this._sectionResizing.startY)
    this._filesSectionHeight = Math.max(minSection, Math.min(max, raw))
  }

  private _onResizeEnd(event: PointerEvent) {
    if (!this._sectionResizing) return
    this._sectionResizing = null
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
