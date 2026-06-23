import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { isMac } from '../platform'
import type { QueryResult } from '../electron'
import { cellToTsv, cellsToTsv, rowToTsv, toDelimited, toJson } from '../result-export'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './export-dialog'
import type { ExportConfirmDetail } from './export-dialog'

/** What the results panel is currently showing. */
export type QueryRun =
  | { phase: 'idle' }
  | { phase: 'running'; note?: string }
  | { phase: 'done'; result: QueryResult; sql?: string }
  | { phase: 'error'; error: string }

export type CellCoord = { row: number; col: number }

const NUM_COL_MIN_WIDTH = 30
const NUM_COL_MAX_WIDTH = 96
// Rows rendered beyond the viewport on each side — covers fast scrolls and the
// sticky header's overlap without exact offset math.
const OVERSCAN = 8
// Row height used before the first real row is measured (rows are uniform).
const ESTIMATED_ROW_HEIGHT = 22

const formatCell = (value: unknown) => {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

const numberColumnWidth = (result: QueryResult) => {
  const maxRow = Math.max(1, result.bufferedRowCount ?? result.rowCount ?? result.rows.length)
  return Math.min(NUM_COL_MAX_WIDTH, Math.max(NUM_COL_MIN_WIDTH, String(maxRow).length * 8 + 20))
}

// Results-table column sizing (reference approach): measure the header and
// the displayed rows once per result set, clamp, and pin the widths through
// table-layout: fixed — so columns never reflow while scrolling. min-width:
// 100% lets the fixed layout stretch the columns proportionally when they
// don't fill the panel.
function measureColumnWidths(columns: string[], rows: unknown[][]): number[] {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return columns.map(() => 120)

  // Mirrors the table CSS: 11px uppercase semibold UI headers, 12px mono cells.
  const headerFont = `600 11px ${getComputedStyle(document.body).fontFamily}`
  const bodyFont = "12px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
  const MIN_WIDTH = 60
  const MAX_WIDTH = 320
  const PADDING = 22
  const HEADER_SLACK = 1.08

  return columns.map((column, index) => {
    ctx.font = headerFont
    let max = ctx.measureText(column.toUpperCase()).width * HEADER_SLACK

    ctx.font = bodyFont
    for (const row of rows) {
      const value = row[index]
      const text = value === null || value === undefined ? 'NULL' : formatCell(value)
      if (text.length > 80) {
        max = MAX_WIDTH
        break
      }
      const width = ctx.measureText(text).width
      if (width > max) max = width
    }

    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(max) + PADDING))
  })
}

// The panel under the SQL editor: header with row count + timing, body
// showing the latest run (hint, spinner, error, or the results grid). The
// host sets the panel's height; everything inside is this component's.
@customElement('results-panel')
export class ResultsPanel extends LitElement {
  @property({ attribute: false })
  run: QueryRun = { phase: 'idle' }

  /** Whether the active connection's engine supports cancelling a run. */
  @property({ attribute: false })
  canCancel = false

  /** When true, double-clicking a cell opens inline editing for text selection/copy.
   * The owner may reject impossible writes after a changed value is submitted. */
  @property({ attribute: false })
  editable = false

  /** Row-level toolbar actions need one unambiguous source table for the whole result. */
  @property({ attribute: false })
  rowEditable = false

  /** Collapsed to just this head; the owner shrinks the host height to match. */
  @property({ attribute: false })
  collapsed = false

  /** The cell currently being edited inline (absolute data indices). */
  @state()
  private _editing: { row: number; col: number } | null = null

  /** Cell the context menu was opened on: row/col index into the result
   * (col -1 on the # column, row -1 on the header row). */
  @state()
  private _menu: { x: number; y: number; row: number; col: number } | null = null

  @state()
  private _exportOpen = false

  /** Selected cell rectangle: anchor (r0,c0) → focus (r1,c1), 0-based data
   * indices. A single cell when anchor === focus; null when nothing selected. */
  @state()
  private _sel: { r0: number; c0: number; r1: number; c1: number } | null = null

  // Virtualization: only rows in [first, last) of the loaded set are in the DOM.
  @state() private _scrollTop = 0
  @state() private _viewportH = 0
  @state() private _viewportW = 0
  @state() private _rowHeight = 0 // measured from the first real row; 0 = estimate

  // Identity of the shown result, so a new query (reset scroll + selection) is
  // told apart from a lazy append (which keeps both). sessionId is stable across
  // a result's pages; a fresh query gets a new one.
  private _lastKey: unknown = null
  private _resetScroll = false
  private _scrollRaf = 0
  private _resizeObs: ResizeObserver | null = null
  private _dragging = false
  private _editFocusPending = false

  // Widths measured once per result, keyed by session so appends don't reflow.
  private _widthsCache: { key: unknown; widths: number[] } | null = null

  protected willUpdate(changed: PropertyValues) {
    if (!changed.has('run')) return
    const key = this.run.phase === 'done' ? (this.run.result.sessionId ?? this.run.result) : this.run.phase
    if (key === this._lastKey) return // an append to the same result, not a new one
    this._lastKey = key
    this._sel = null
    this._editing = null
    this._scrollTop = 0
    this._resetScroll = true
  }

  firstUpdated() {
    const body = this._bodyEl()
    if (!body) return
    this._viewportH = body.clientHeight
    this._viewportW = body.clientWidth
    // The panel height changes when the user drags the results divider.
    this._resizeObs = new ResizeObserver(() => {
      this._viewportH = body.clientHeight
      this._viewportW = body.clientWidth
      this._maybeLoadMore()
    })
    this._resizeObs.observe(body)
  }

  protected updated() {
    if (this._resetScroll) {
      this._resetScroll = false
      const body = this._bodyEl()
      if (body) body.scrollTop = 0
    }
    if (this._editFocusPending) {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.cell-edit')
      if (input) {
        this._editFocusPending = false
        input.focus()
        input.select()
      }
    }
    this._measureRowHeight()
    this._maybeLoadMore()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._resizeObs?.disconnect()
    if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf)
    this._endDrag()
  }

  private _bodyEl() {
    return this.shadowRoot?.querySelector<HTMLElement>('.body') ?? null
  }

  // Rows are uniform height; measure one real row, then reuse it.
  private _measureRowHeight() {
    if (this._rowHeight) return
    const height = this.shadowRoot?.querySelector<HTMLElement>('tbody tr[data-row]')?.offsetHeight ?? 0
    if (height > 0) this._rowHeight = height
  }

  // The slice of loaded rows to render for the current scroll position.
  private _window() {
    const loaded = this.run.phase === 'done' ? this.run.result.rows.length : 0
    const rowH = this._rowHeight || ESTIMATED_ROW_HEIGHT
    const viewport = this._viewportH || 400
    const first = Math.max(0, Math.floor(this._scrollTop / rowH) - OVERSCAN)
    const last = Math.min(loaded, Math.ceil((this._scrollTop + viewport) / rowH) + OVERSCAN)
    return { first, last, rowH, loaded }
  }

  private _onScroll = () => {
    if (this._scrollRaf) return
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0
      const body = this._bodyEl()
      if (!body) return
      this._scrollTop = body.scrollTop
      this._viewportH = body.clientHeight
      this._viewportW = body.clientWidth
      this._maybeLoadMore()
    })
  }

  // Asks the owner for the next page once the window reaches the end of what's
  // loaded and the main-process buffer still has more.
  private _maybeLoadMore() {
    if (this.run.phase !== 'done') return
    const { result } = this.run
    if (result.sessionId === undefined || result.bufferedRowCount === undefined) return
    if (result.rows.length >= result.bufferedRowCount) return
    if (this._window().last >= result.rows.length) {
      this.dispatchEvent(new CustomEvent('load-more', { bubbles: true, composed: true }))
    }
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('cancel-query', { bubbles: true, composed: true }))
  }

  private _addRow = () => {
    this.dispatchEvent(new CustomEvent('add-row', { bubbles: true, composed: true }))
  }

  private _deleteRows(rows: number[]) {
    if (!rows.length) return
    this.dispatchEvent(new CustomEvent('delete-rows', { detail: { rows }, bubbles: true, composed: true }))
  }

  private _toggleCollapse = () => {
    this.dispatchEvent(new CustomEvent('toggle-collapse', { bubbles: true, composed: true }))
  }

  render() {
    const exportable = this.run.phase === 'done' && this.run.result.columns.length > 0
    const showRowTools = this.rowEditable && exportable
    const selectedRows = showRowTools ? this._selectedRows() : []
    return html`
      <div class="head">
        <span>Results</span>
        ${showRowTools
          ? html`
              <div class="toolbar" aria-label="Result row actions">
                <button class="head-action" title="Add row" aria-label="Add row" @click=${this._addRow}>
                  <i class="codicon codicon-add" aria-hidden="true"></i>
                </button>
                <button
                  class="head-action danger"
                  title="Delete selected rows"
                  aria-label="Delete selected rows"
                  ?disabled=${selectedRows.length === 0}
                  @click=${() => this._deleteRows(selectedRows)}
                >
                  <i class="codicon codicon-remove" aria-hidden="true"></i>
                </button>
              </div>
            `
          : ''}
        <span class="status">${this._status()}</span>
        ${exportable
          ? html`
              <button
                class="head-action"
                title="Export results…"
                aria-label="Export results"
                @click=${() => (this._exportOpen = true)}
              >
                <i class="codicon codicon-download" aria-hidden="true"></i>
              </button>
            `
          : ''}
        <button
          class="head-action"
          title=${this.collapsed ? 'Expand results panel' : 'Collapse results panel'}
          aria-label=${this.collapsed ? 'Expand results panel' : 'Collapse results panel'}
          aria-expanded=${!this.collapsed}
          @click=${this._toggleCollapse}
        >
          <i class="codicon codicon-chevron-${this.collapsed ? 'up' : 'down'}" aria-hidden="true"></i>
        </button>
      </div>
      <div class="body" @scroll=${this._onScroll}>${this._renderBody()}</div>
      ${this._renderMenu()}
      ${this._exportOpen && this.run.phase === 'done'
        ? html`
            <export-dialog
              .total=${this.run.result.bufferedRowCount ?? this.run.result.rows.length}
              .truncated=${this.run.result.truncated ?? false}
              @dialog-cancel=${() => (this._exportOpen = false)}
              @export-confirm=${this._onExportConfirm}
            ></export-dialog>
          `
        : ''}
    `
  }

  private _onExportConfirm = async (event: CustomEvent<ExportConfirmDetail>) => {
    this._exportOpen = false
    if (this.run.phase !== 'done') return
    const { format, rows } = event.detail
    const { result } = this.run
    const slice = (await this._allRows(result, rows)).slice(0, rows)
    const content =
      format === 'json' ? toJson(result.columns, slice) : toDelimited(result.columns, slice, format === 'tsv' ? '\t' : ',')
    void window.sqlkit.exportFile(`results.${format}`, content)
  }

  // Buffered rows up to `limit` (default: all) — the loaded prefix plus
  // whatever pages haven't been scrolled into yet — so export / copy-all aren't
  // limited to what's on screen. Exporting N rows only pulls N, not the whole
  // buffer. Falls back to the loaded rows if the buffer has expired.
  private async _allRows(result: QueryResult, limit?: number): Promise<unknown[][]> {
    const total = result.bufferedRowCount ?? result.rows.length
    const need = Math.min(limit ?? total, total)
    if (result.sessionId === undefined || result.rows.length >= need) return result.rows
    const response = await window.sqlkit.fetchRows(result.sessionId, 0, need)
    return response.success ? response.rows : result.rows
  }

  // One delegated listener instead of one per cell. The data row index is read
  // from the row's data-row (sectionRowIndex would be wrong under windowing);
  // the # column shifts data columns right by one.
  private _onTableContextMenu(event: MouseEvent) {
    if (this.run.phase !== 'done') return
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('td, th')
    if (!cell) return
    event.preventDefault()
    const dataRow = cell.closest('tr')?.getAttribute('data-row')
    const row = cell.tagName === 'TH' || dataRow === null || dataRow === undefined ? -1 : Number(dataRow)
    const col = cell.cellIndex - 1
    if (row >= 0 && col >= 0 && !this._isSelected(row, col)) this._sel = { r0: row, c0: col, r1: row, c1: col }
    this._menu = { x: event.clientX, y: event.clientY, row, col }
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu || this.run.phase !== 'done') return ''
    const { result } = this.run
    const editCells = this.editable ? this._cellsForMenu(menu) : []
    const items: MenuItem[] = [
      ...(editCells.length
        ? [{ id: 'edit-cells', label: editCells.length === 1 ? 'Edit Cell…' : `Edit ${editCells.length} Selected Cells…` }]
        : []),
      ...(menu.row >= 0 && menu.col >= 0 ? [{ id: 'copy-cell', label: 'Copy Cell' }] : []),
      ...(menu.row >= 0 ? [{ id: 'copy-row', label: 'Copy Row' }] : []),
      ...(menu.col >= 0 ? [{ id: 'copy-column-name', label: 'Copy Column Name' }] : []),
      { id: 'copy-csv', label: 'Copy All as CSV' },
      { id: 'copy-tsv', label: 'Copy All as TSV' },
      { id: 'copy-json', label: 'Copy All as JSON' },
      { id: 'export', label: 'Export…' },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => void this._onMenuPick(e.detail.id, result, menu)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private async _onMenuPick(action: string, result: QueryResult, at: { row: number; col: number }) {
    const copy = (text: string) => void navigator.clipboard.writeText(text)
    if (action === 'copy-cell') copy(cellToTsv(result.rows[at.row]?.[at.col]))
    if (action === 'copy-row') copy(rowToTsv(result.rows[at.row] ?? []))
    if (action === 'copy-column-name') copy(cellToTsv(result.columns[at.col] ?? ''))
    // Copy-all / export cover every buffered row, not just what's loaded on screen.
    if (action === 'copy-csv') copy(toDelimited(result.columns, await this._allRows(result), ','))
    if (action === 'copy-tsv') copy(toDelimited(result.columns, await this._allRows(result), '\t'))
    if (action === 'copy-json') copy(toJson(result.columns, await this._allRows(result)))
    if (action === 'export') this._exportOpen = true
    if (action === 'edit-cells') {
      const cells = this._cellsForMenu(at)
      if (cells.length) {
        this.dispatchEvent(new CustomEvent('cells-edit', { detail: { cells }, bubbles: true, composed: true }))
      }
    }
  }

  // --- cell selection ---------------------------------------------------------

  // Data-cell coordinates for a DOM node: the absolute row from data-row (not
  // sectionRowIndex, which shifts with windowing's spacer rows), null for the
  // # column / header / spacers.
  private _dataCellAt(node: Element | null): { row: number; col: number } | null {
    const cell = node?.closest<HTMLTableCellElement>('td')
    if (!cell || cell.classList.contains('num')) return null
    const dataRow = cell.closest('tr')?.getAttribute('data-row')
    if (dataRow === null || dataRow === undefined) return null
    const col = cell.cellIndex - 1
    if (col < 0) return null
    return { row: Number(dataRow), col }
  }

  private _isSelected(row: number, col: number): boolean {
    const s = this._sel
    if (!s) return false
    return (
      row >= Math.min(s.r0, s.r1) &&
      row <= Math.max(s.r0, s.r1) &&
      col >= Math.min(s.c0, s.c1) &&
      col <= Math.max(s.c0, s.c1)
    )
  }

  private _cellsForMenu(at: { row: number; col: number }): CellCoord[] {
    if (this.run.phase !== 'done' || at.row < 0 || at.col < 0) return []
    const { rows, columns } = this.run.result
    const bounds = this._sel && this._isSelected(at.row, at.col) ? this._sel : { r0: at.row, c0: at.col, r1: at.row, c1: at.col }
    const r0 = Math.max(0, Math.min(bounds.r0, bounds.r1))
    const r1 = Math.min(rows.length - 1, Math.max(bounds.r0, bounds.r1))
    const c0 = Math.max(0, Math.min(bounds.c0, bounds.c1))
    const c1 = Math.min(columns.length - 1, Math.max(bounds.c0, bounds.c1))
    const cells: CellCoord[] = []
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) cells.push({ row, col })
    }
    return cells
  }

  private _selectedRows(): number[] {
    if (this.run.phase !== 'done' || !this._sel) return []
    const max = this.run.result.rows.length - 1
    const r0 = Math.max(0, Math.min(this._sel.r0, this._sel.r1))
    const r1 = Math.min(max, Math.max(this._sel.r0, this._sel.r1))
    const rows: number[] = []
    for (let row = r0; row <= r1; row += 1) rows.push(row)
    return rows
  }

  private _onCellPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return // leave right-click to the context menu
    // Clicking inside the inline editor must not re-select or steal its focus.
    if ((event.target as HTMLElement).closest('.cell-edit')) return
    const hit = this._dataCellAt(event.target as Element)
    if (!hit) return
    ;(event.currentTarget as HTMLElement).focus() // so Cmd/Ctrl-C reaches us

    // Shift-click extends the rectangle from the anchor; a plain press starts a
    // drag. Both just set _sel — only the ~viewport rows re-render, so it's
    // cheap and stays declarative (the cell class is bound to _isSelected).
    if (event.shiftKey && this._sel) {
      this._sel = { ...this._sel, r1: hit.row, c1: hit.col }
      return
    }
    this._sel = { r0: hit.row, c0: hit.col, r1: hit.row, c1: hit.col }
    this._dragging = true
    window.addEventListener('pointermove', this._onDragMove)
    window.addEventListener('pointerup', this._endDrag)
    window.addEventListener('pointercancel', this._endDrag)
  }

  private _onDragMove = (event: PointerEvent) => {
    if (!this._dragging || !this._sel) return
    // elementFromPoint must go through the shadow root to see inside it.
    const hit = this._dataCellAt(this.shadowRoot?.elementFromPoint(event.clientX, event.clientY) ?? null)
    if (!hit || (hit.row === this._sel.r1 && hit.col === this._sel.c1)) return
    this._sel = { ...this._sel, r1: hit.row, c1: hit.col }
  }

  private _endDrag = () => {
    if (!this._dragging) return
    this._dragging = false
    window.removeEventListener('pointermove', this._onDragMove)
    window.removeEventListener('pointerup', this._endDrag)
    window.removeEventListener('pointercancel', this._endDrag)
  }

  // --- cell editing -----------------------------------------------------------

  private _onCellDblClick = (event: MouseEvent) => {
    if (!this.editable) return
    // Double-clicking inside the editor (e.g. to select a word) must not reset it.
    if ((event.target as HTMLElement).closest('.cell-edit')) return
    const hit = this._dataCellAt(event.target as Element)
    if (!hit) return
    this._editing = hit
    this._editFocusPending = true
  }

  private _onEditKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      this._commitEdit(event.target as HTMLInputElement)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this._editing = null
    }
    // Don't let Cmd/Ctrl-C etc. bubble to the grid's copy handler while typing.
    event.stopPropagation()
  }

  // Enter commits: emit the new value for the owner to turn into an UPDATE (it
  // pops the review dialog). Unchanged values are a no-op.
  private _commitEdit(input: HTMLInputElement) {
    const editing = this._editing
    this._editing = null
    if (!editing || this.run.phase !== 'done') return
    const original = this.run.result.rows[editing.row]?.[editing.col]
    const originalText = original === null || original === undefined ? '' : formatCell(original)
    if (input.value === originalText) return
    this.dispatchEvent(
      new CustomEvent('cell-edit', {
        detail: { row: editing.row, col: editing.col, value: input.value },
        bubbles: true,
        composed: true,
      }),
    )
  }

  private _cancelEdit = () => {
    this._editing = null
  }

  private _onGridKeydown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      if (!this._sel || this.run.phase !== 'done') return
      event.preventDefault()
      const { rows } = this.run.result
      const s = this._sel
      const selected: unknown[][] = []
      for (let r = Math.min(s.r0, s.r1); r <= Math.max(s.r0, s.r1); r += 1) {
        const cells: unknown[] = []
        for (let c = Math.min(s.c0, s.c1); c <= Math.max(s.c0, s.c1); c += 1) cells.push(rows[r]?.[c])
        selected.push(cells)
      }
      // cellsToTsv applies full TSV field escaping: an embedded tab/newline is
      // quoted (stays one cell) and a formula-leading cell is neutralized.
      void navigator.clipboard.writeText(cellsToTsv(selected))
    }
  }

  private _status() {
    if (this.run.phase !== 'done') return ''
    const { result } = this.run
    const buffered = result.bufferedRowCount
    // A truncated result whose driver couldn't report the true total (sqlite,
    // which would have to scan every row) shows the loaded count as a floor
    // ("N+ rows"); when the total is known (postgres) show it with a caveat.
    const totalKnown = !result.truncated || buffered === undefined || result.rowCount > buffered
    const rows = totalKnown
      ? `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? '' : 's'}`
      : `${buffered.toLocaleString()}+ rows`
    // Only a result past the buffer cap is partial; everything else is fully
    // scrollable (paged in on demand), so no "showing first N" caveat.
    const capped =
      result.truncated && totalKnown && buffered !== undefined ? ` · first ${buffered.toLocaleString()} loaded` : ''
    const pace = result.durationMs < 500 ? 'fast' : result.durationMs < 2000 ? 'medium' : 'slow'
    return html`${rows}${capped} · <span class="duration ${pace}">${Math.max(1, Math.round(result.durationMs))} ms</span>`
  }

  private _renderBody() {
    const run = this.run
    if (run.phase === 'idle') {
      return html`<p class="hint">Run a query with ${isMac ? '⌘↵' : 'Ctrl+↵'}; selection runs alone, otherwise nearest block.</p>`
    }
    if (run.phase === 'running') {
      // A note means connecting, which has no backend to cancel yet.
      const cancellable = !run.note && this.canCancel
      return html`
        <p class="hint">
          <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
          ${run.note ?? 'Running…'}
          ${cancellable ? html`<button class="stop" @click=${this._cancel}>Stop</button>` : ''}
        </p>
      `
    }
    if (run.phase === 'error') {
      return html`<pre class="error">${run.error}</pre>`
    }

    const { result } = run
    if (!result.columns.length) {
      return html`<p class="hint">OK — ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected.</p>`
    }
    const widths = this._columnWidths(result)
    // table-layout: fixed only engages with a definite width; with width:
    // auto the browser falls back to AUTO layout and the colgroup widths
    // become minimums a long nowrap cell can blow past. min-width: 100% in
    // the CSS still stretches the columns when they underfill the panel.
    const numColWidth = numberColumnWidth(result)
    const viewportWidth = Math.max(0, this._viewportW - 1)
    const baseTableWidth = numColWidth + widths.reduce((sum, width) => sum + width, 0)
    const fill = widths.length && viewportWidth > baseTableWidth ? viewportWidth - baseTableWidth : 0
    const tableWidth = baseTableWidth + fill
    const displayWidths = fill ? widths.map((width, index) => (index === widths.length - 1 ? width + fill : width)) : widths
    // Only the visible window of loaded rows is in the DOM; spacer rows above
    // and below stand in for the rest so the scrollbar reflects the full set.
    const { first, last, rowH } = this._window()
    const colSpan = result.columns.length + 1
    const topPad = first * rowH
    const bottomPad = Math.max(0, (result.rows.length - last) * rowH)
    return html`
      <table
        style="width: ${tableWidth}px"
        tabindex="0"
        @contextmenu=${this._onTableContextMenu}
        @pointerdown=${this._onCellPointerDown}
        @dblclick=${this._onCellDblClick}
        @keydown=${this._onGridKeydown}
      >
        <colgroup>
          <col style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px" />
          ${displayWidths.map((width) => html`<col style="width: ${width}px" />`)}
        </colgroup>
        <thead>
          <tr>
            <th class="num" style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px">#</th>
            ${result.columns.map((column) => html`<th>${column}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${topPad > 0 ? html`<tr class="spacer" style="height: ${topPad}px"><td colspan=${colSpan}></td></tr>` : ''}
          ${result.rows.slice(first, last).map((row, i) => {
            const absRow = first + i
            return html`
              <tr data-row=${absRow} class=${absRow % 2 ? 'alt' : ''}>
                <td class="num" style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px">${absRow + 1}</td>
                ${row.map((cell, col) => {
                  const sel = this._isSelected(absRow, col) ? 'selected' : ''
                  if (this._editing?.row === absRow && this._editing.col === col) {
                    const initial = cell === null || cell === undefined ? '' : formatCell(cell)
                    return html`<td class=${sel}>
                      <input
                        class="cell-edit"
                        .value=${initial}
                        @keydown=${this._onEditKeydown}
                        @blur=${this._cancelEdit}
                      />
                    </td>`
                  }
                  if (cell === null || cell === undefined) return html`<td class=${sel}><span class="null">NULL</span></td>`
                  const text = formatCell(cell)
                  return html`<td class=${sel} title=${text}>${text}</td>`
                })}
              </tr>
            `
          })}
          ${bottomPad > 0 ? html`<tr class="spacer" style="height: ${bottomPad}px"><td colspan=${colSpan}></td></tr>` : ''}
        </tbody>
      </table>
    `
  }

  // Measured once per result (keyed by session so lazily-appended pages reuse
  // the widths rather than reflowing). The first page is a fair sample.
  private _columnWidths(result: QueryResult): number[] {
    const key = result.sessionId ?? result
    if (this._widthsCache?.key !== key) {
      this._widthsCache = { key, widths: measureColumnWidths(result.columns, result.rows) }
    }
    return this._widthsCache.widths
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--editor-bg);
      }

      .head {
        height: 28px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 12px;
        font-size: var(--font-size-sm);
        font-weight: 700;
        color: var(--text-2);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-bottom: 1px solid var(--border-subtle);
        user-select: none;
      }

      .head-action {
        display: inline-flex;
        flex-shrink: 0;
        padding: 3px;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .head-action:hover:not(:disabled) {
        color: var(--text);
        background: var(--list-hover);
      }

      .head-action.danger:hover:not(:disabled) {
        color: var(--status-dot-error);
      }

      .head-action:disabled {
        opacity: 0.45;
        cursor: default;
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .status {
        margin-left: auto;
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
        color: var(--text-3);
      }

      /* Timing at a glance: green under 500 ms, orange under 2 s, red above. */
      .duration.fast {
        color: var(--status-dot-connected);
      }

      .duration.medium {
        color: var(--status-dot-warning);
      }

      .duration.slow {
        color: var(--status-dot-error);
      }

      .body {
        flex: 1;
        overflow: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .hint {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px 12px;
        color: var(--text-3);
      }

      .stop {
        padding: 2px 10px;
        font: inherit;
        font-size: 11px;
        color: var(--status-dot-error);
        background: transparent;
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        cursor: pointer;
      }

      .stop:hover {
        border-color: var(--status-dot-error);
      }

      .error {
        margin: 0;
        padding: 10px 12px;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--status-dot-error);
        white-space: pre-wrap;
      }

      /* Reference-style grid: fixed layout with measured colgroup widths,
         uppercase UI-font headers, mono cells, zebra rows, row hover. */
      table {
        border-collapse: collapse;
        table-layout: fixed;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
        /* Selection is cell-based (drag a rectangle); suppress native text
           selection, which spans whole rows. */
        user-select: none;
      }

      table:focus {
        outline: none;
      }

      th,
      td {
        padding: 3px 10px;
        text-align: left;
        border-bottom: 1px solid var(--grid-border);
        border-right: 1px solid var(--grid-border);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 4px 10px;
        background: var(--header-bg);
        color: var(--text-2);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      td {
        color: var(--text);
      }

      /* Zebra by absolute row index (set as a class) — nth-child would flip
         parity as the windowing spacer rows come and go. */
      tbody tr.alt td {
        background: var(--row-alt);
      }

      /* Windowing spacers stand in for off-screen rows: no grid lines, inert. */
      tbody tr.spacer td {
        padding: 0;
        border: 0;
        pointer-events: none;
      }

      /* Hover highlights the single cell under the pointer, not the whole row. */
      tbody tr:not(.spacer) td:not(.num):hover {
        background: var(--row-hover);
      }

      .num {
        color: var(--text-3);
        text-align: right;
        font-size: var(--font-size-sm);
        user-select: none;
      }

      td.num {
        background: var(--row-num-bg);
      }

      .null {
        color: var(--text-3);
        font-style: italic;
      }

      /* Inline cell editor: fills the cell so editing feels in-place. */
      .cell-edit {
        width: calc(100% + 12px);
        box-sizing: border-box;
        margin: -3px -6px;
        padding: 2px 4px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--focus-border);
        border-radius: 2px;
        outline: none;
      }

      /* Cell selection — wins over zebra striping and cell hover. */
      tbody tr td.selected,
      tbody tr:hover td.selected {
        background: color-mix(in srgb, var(--accent) 28%, transparent);
        color: var(--text);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'results-panel': ResultsPanel
  }
}
