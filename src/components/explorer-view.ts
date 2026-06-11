import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, typography } from '../shared-styles'
import { mod } from '../platform'
import type { FileInfo, TableRef } from '../electron'
import './file-tree'

export const tableKey = (profileId: string, table: TableRef) => `${profileId}:${table.schema ?? ''}:${table.name}`

export const tableLabel = (table: TableRef) => (table.schema ? `${table.schema}.${table.name}` : table.name)

export type TableSelectDetail = { key: string }
export type TableBrowseDetail = { table: TableRef }

// The Explorer sidebar view, scoped to the in-use database context (⌘K):
// VS Code-style Files/Tables split where each section is a flex region with
// its own scrolling body, a draggable 1px divider between them (double-click
// resets), and a collapsed Tables header that pins to the bottom. File events
// bubble through from <file-tree>; tables dispatch `table-select` /
// `table-browse`.
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

  /** Tables of the connected context; null while it is not connected. */
  @property({ attribute: false })
  tables: TableRef[] | null = null

  @property()
  selectedTable: string | null = null

  @state()
  private _filesCollapsed = false

  @state()
  private _tablesCollapsed = false

  // null = the default even split; a number pins the Files section height.
  @state()
  private _filesSectionHeight: number | null = null

  @state()
  private _sectionResizing: { startY: number; startHeight: number } | null = null

  protected willUpdate(changed: PropertyValues) {
    // A selection arriving from outside (⌘P table pick) must be visible.
    if (changed.has('selectedTable') && this.selectedTable) this._tablesCollapsed = false
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
        <button class="section-head-row" @click=${() => (this._tablesCollapsed = !this._tablesCollapsed)}>
          <i class="codicon codicon-chevron-right chevron ${this._tablesCollapsed ? '' : 'expanded'}" aria-hidden="true"></i>
          <span>Tables</span>
          ${this.tables !== null && this.contextName ? html`<span class="section-detail">${this.contextName}</span>` : ''}
        </button>
        ${this._tablesCollapsed ? '' : html`<div class="section-body">${this._renderTables()}</div>`}
      </div>
    `
  }

  private _renderTables() {
    if (this.tables === null || !this.profileId) {
      return html`<p class="muted hint">Connect a database to see tables (${mod('K')}).</p>`
    }
    if (!this.tables.length) return html`<p class="muted hint">No tables.</p>`
    const profileId = this.profileId
    return html`
      <div class="etable-list">
        ${this.tables.map((table) => {
          const key = tableKey(profileId, table)
          return html`
            <div
              class="etable-row ${this.selectedTable === key ? 'selected' : ''}"
              title="${tableLabel(table)} — double-click to browse"
              @click=${() => this._select(key)}
              @dblclick=${() => this._browse(table)}
            >
              <i class="codicon codicon-table" aria-hidden="true"></i>
              <span>${tableLabel(table)}</span>
            </div>
          `
        })}
      </div>
    `
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

      .etable-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px 3px 24px;
        font-size: var(--font-size);
        color: var(--text);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
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
