import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { isMac } from '../platform'
import type { Engine, QueryResult, QuerySort } from '../electron'
import { activeSort, isReorderableQuery, type SortDir } from '../sql-order'
import { MAX_FETCH_ROWS } from '../result-limits'
import { cellToTsv, cellsToTsv, parseClipboardTsv, toDelimited, toJson, type ExportFormat } from '../result-export'
import { SQL_NULL, isSqlNull, type CellInput } from '../sql-write'
import { isFilterableQuery } from '../sql-filter'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './export-dialog'
import type { ExportConfirmDetail } from './export-dialog'
import './sql-expression-editor'
import type { SqlExpressionEditor } from './sql-expression-editor'
import { formatInteger, rowWord, t } from '../i18n'

/** What the results panel is currently showing. */
export type QueryRun =
  | { phase: 'idle' }
  | { phase: 'running'; executionId: string; profileId: string; note?: string }
  | { phase: 'done'; result: QueryResult; sql?: string; params?: unknown[] }
  | { phase: 'error'; error: string; sql?: string; params?: unknown[] }

export type CellCoord = { row: number; col: number }

// A header sort button click: re-sort by `column`, or clear the sort (null).
export type SortColumnDetail = { columnIndex: number; direction: SortDir | null }

// A row in the displayed grid: a result row (by data index) or a staged new row
// (by draft array index). The grid lays these out in one interleaved sequence,
// so selection/navigation work in a single "display row" coordinate space.
type RowRef = { kind: 'result'; row: number } | { kind: 'draft'; index: number }

const NUM_COL_MIN_WIDTH = 30
const NUM_COL_MAX_WIDTH = 96
// Floor a column can be dragged to, so a header stays grabbable.
const MIN_COL_WIDTH = 48
// Pointer travel before a grip press counts as a drag, so a plain click never
// freezes or persists column widths.
const RESIZE_DRAG_THRESHOLD = 3
// Rows rendered beyond the viewport on each side — covers fast scrolls and the
// sticky header's overlap without exact offset math.
const OVERSCAN = 8
// Row height used before the first real row is measured; matches the pinned
// cell height in CSS (tbody tr td height) so rows stay uniform.
const ESTIMATED_ROW_HEIGHT = 25
const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value

const formatCell = (value: unknown): string => {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value, bigintReplacer) ?? '[unserializable value]'
    } catch {
      return '[unserializable value]'
    }
  }
  return String(value)
}

const inputText = (value: CellInput): string => isSqlNull(value) ? '' : value
const sameInput = (left: CellInput, right: CellInput): boolean =>
  isSqlNull(left) ? isSqlNull(right) : !isSqlNull(right) && left === right

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

  // Mirror the rendered typography so changing the shared type scale cannot
  // make measured header labels narrower than their displayed text.
  const bodyStyle = getComputedStyle(document.body)
  const smallFontSize = getComputedStyle(document.documentElement).getPropertyValue('--font-size-sm').trim() || '12px'
  const headerFont = `600 ${smallFontSize} ${bodyStyle.fontFamily}`
  const bodyFont = `400 13px ${bodyStyle.fontFamily}`
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

function measureRecordColumnWidth(columns: string[]): number {
  const ctx = document.createElement('canvas').getContext('2d')
  const fallback = Math.max(...columns.map((column) => column.length), 1) * 7 + 28
  if (!ctx) return Math.min(360, Math.max(120, fallback))
  const bodyStyle = getComputedStyle(document.body)
  ctx.font = `400 13px ${bodyStyle.fontFamily}`
  const width = Math.max(...columns.map((column) => ctx.measureText(column).width), 0) + 28
  return Math.min(360, Math.max(120, Math.ceil(width)))
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

  /** Unsaved new rows interleaved into the grid: `after` is the result row each
   * one renders below (-1 = above the first row); `cells` align to result columns. */
  @property({ attribute: false })
  drafts: Array<{ after: number; cells: Array<CellInput | null> }> = []

  /** Staged result-cell edits, keyed "row:col" → new value, shown until saved. */
  @property({ attribute: false })
  edits: ReadonlyMap<string, CellInput> = new Map()

  /** The grid-injected column sort, so the header shows the active direction. */
  @property({ attribute: false })
  sort: QuerySort | null = null

  /** The condition injected into the current result query, without WHERE. */
  @property({ attribute: false })
  filter: string | null = null

  /** Dialect used by filter highlighting, completion, and identifier quoting. */
  @property()
  engine: Engine = 'postgresql'

  /** Persisted per-tab column widths (col index → px), adopted when a result
   * loads; the grid emits `resize-columns` to write dragged widths back. */
  @property({ attribute: false })
  columnWidths: ReadonlyMap<number, number> = new Map()

  /** The current run is a read-only query, so the export dialog can offer a full
   * streamed export (re-runs past the buffered rows). The owner handles it. */
  @property({ attribute: false })
  streamExportAvailable = false

  /** The cell being edited inline, by row reference. `seed` is the character that
   * started a type-to-edit (replaces the value); null edits the existing value.
   * `sel` snapshots the selection at edit start so the committed value fills it. */
  @state()
  private _editing: { ref: RowRef; col: number; seed: string | null; sel: { r0: number; c0: number; r1: number; c1: number } | null } | null = null

  /** Cell the context menu was opened on: row/col index into the result
   * (col -1 on the # column, row -1 on the header row). `sortOnly` is set when
   * a left-click on a header opened a sort-only menu (no copy/export items). */
  @state()
  private _menu: { x: number; y: number; row: number; col: number; sortOnly?: boolean } | null = null

  @state()
  private _exportOpen = false

  @state()
  private _resultSetIndex = 0

  @state()
  private _record: { ref: RowRef; col: number } | null = null

  @state() private _filterOpen = false
  @state() private _filterDraft = ''
  private _filterFocusPending = false
  private _filterColumns: string[] = []

  /** Selected cell rectangle in display-row space: anchor (r0,c0) → focus (r1,c1).
   * Rows are display indices (result rows and staged rows share one numbering),
   * so a selection can span both. A single cell when anchor === focus. */
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

  // Columns the user has dragged to a custom width (index → px). Cleared on a
  // new result; once any exists, auto-fill stops so the widths stay exact.
  private _widthOverrides = new Map<number, number>()

  @state() private _resizing: { col: number; startX: number; startWidth: number; moved: boolean } | null = null

  // Non-null while export/copy-all pages the buffer out of the main process;
  // rendered in the status span so a long drain doesn't look like a dead click.
  @state() private _draining: { done: number; total: number } | null = null

  // Rendered column geometry (leading # column + each data column's width), so
  // keyboard nav can scroll a selected column into view without re-measuring.
  private _colLayout: { numColWidth: number; widths: number[] } | null = null

  // Display-order map (result rows + interleaved drafts), rebuilt when the rows
  // or drafts arrays change. Lets selection work in one coordinate space.
  private _displayCache: { rows: unknown; drafts: unknown; order: RowRef[]; resultToDisplay: number[]; draftToDisplay: number[] } | null = null
  // A freshly-added draft to select once it arrives via the drafts property.
  private _pendingSelectDraft: number | null = null
  // First of a double-Esc: a second consecutive Escape discards staged changes.
  private _escArmed = false
  // Refocus the grid after a toolbar action so keyboard work keeps flowing.
  private _focusGridPending = false
  // Focus the record view after switching away from the grid table.
  private _recordFocusPending = false

  private _shownResult(): QueryResult | null {
    if (this.run.phase !== 'done') return null
    const base = this.run.result
    const sets = base.resultSets
    if (!sets?.length || this._resultSetIndex >= sets.length - 1) return base
    const selected = sets[Math.max(0, this._resultSetIndex)]!
    return { ...selected, durationMs: base.durationMs }
  }

  private _canEditShownResult() {
    if (this.run.phase !== 'done') return false
    const sets = this.run.result.resultSets
    return !sets?.length || this._resultSetIndex === sets.length - 1
  }

  private _selectResultSet = (event: Event) => {
    this._resultSetIndex = Number((event.target as HTMLSelectElement).value)
    this._sel = null
    this._editing = null
    this._record = null
    this._displayCache = null
    this._widthsCache = null
    // Dragged widths belong to the last set (the one persistence tracks); other
    // sets auto-measure, and switching back re-adopts the tab's saved widths.
    this._widthOverrides = this._canEditShownResult() ? new Map(this.columnWidths) : new Map<number, number>()
    this._colLayout = null
    this._scrollTop = 0
    this._resetScroll = true
    this.requestUpdate()
    requestAnimationFrame(() => this._maybeLoadMore())
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('filter')) this._filterDraft = this.filter ?? ''
    if (changed.has('drafts')) {
      // Select a just-added draft once it lands in the property.
      if (this._pendingSelectDraft !== null) {
        const display = this._display().draftToDisplay[this._pendingSelectDraft]
        if (display !== undefined) this._sel = { r0: display, c0: 0, r1: display, c1: 0 }
        this._pendingSelectDraft = null
        this._focusGridPending = true
      }
      if (this._record?.ref.kind === 'draft' && !this.drafts[this._record.ref.index]) this._record = null
      // Keep the selection within the grid if drafts were removed.
      const len = this._display().order.length
      if (this._sel && (this._sel.r1 >= len || this._sel.r0 >= len)) this._sel = null
    }
    if (!changed.has('run')) return
    const key = this.run.phase === 'done' ? (this.run.result.sessionId ?? this.run.result) : this.run.phase
    if (key === this._lastKey) return // an append to the same result, not a new one
    this._lastKey = key
    this._resultSetIndex = this.run.phase === 'done' ? Math.max(0, (this.run.result.resultSets?.length ?? 1) - 1) : 0
    const shown = this._shownResult()
    if (shown) this._filterColumns = shown.columns
    // Adopt this tab's persisted widths (empty for a new result shape, which
    // then auto-measures). Local overrides drive rendering; drags write back.
    this._widthOverrides = new Map(this.columnWidths)
    this._resizing = null
    // Land the selection on the first cell of a fresh result, so keyboard work
    // and "add row below" have a defined anchor without a click.
    this._sel =
      shown?.rows.length && shown.columns.length
        ? { r0: 0, c0: 0, r1: 0, c1: 0 }
        : null
    this._editing = null
    this._record = null
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
        // Type-to-edit (seed) keeps the typed char and puts the caret at the end;
        // a plain edit selects all so the first keystroke replaces.
        if (this._editing?.seed != null) input.setSelectionRange(input.value.length, input.value.length)
        else input.select()
      }
    }
    if (this._focusGridPending) {
      const table = this.shadowRoot?.querySelector<HTMLElement>('table')
      if (table) {
        this._focusGridPending = false
        table.focus()
      }
    }
    if (this._recordFocusPending) {
      const record = this.shadowRoot?.querySelector<HTMLElement>('.record-view')
      if (record) {
        this._recordFocusPending = false
        record.focus()
      }
    }
    if (this._filterFocusPending) {
      const editor = this.shadowRoot?.querySelector<SqlExpressionEditor>('.filter-input')
      if (editor) {
        this._filterFocusPending = false
        editor.focusEditor()
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
    this._endColResize()
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
    const loaded = this._shownResult()?.rows.length ?? 0
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
    const result = this._shownResult()
    if (!result) return
    if (result.sessionId === undefined || result.bufferedRowCount === undefined) return
    if (result.rows.length >= result.bufferedRowCount) return
    if (this._window().last >= result.rows.length) {
      this.dispatchEvent(new CustomEvent('load-more', {
        detail: { resultSetIndex: this._resultSetIndex },
        bubbles: true,
        composed: true,
      }))
    }
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('cancel-query', { bubbles: true, composed: true }))
  }

  // --- display-row mapping (result rows + interleaved drafts) -----------------

  // The interleaved display order and the index of each result/draft row within
  // it. Rebuilt only when the rows or drafts arrays change.
  private _display() {
    const result = this._shownResult()
    const rows = result?.rows
    if (!rows) return { order: [] as RowRef[], resultToDisplay: [] as number[], draftToDisplay: [] as number[] }
    const drafts = this.drafts
    if (this._displayCache && this._displayCache.rows === rows && this._displayCache.drafts === drafts) return this._displayCache
    const lastRow = rows.length - 1
    const byAnchor = new Map<number, number[]>()
    drafts.forEach((draft, i) => {
      const anchor = draft.after < 0 ? -1 : Math.min(draft.after, lastRow)
      const list = byAnchor.get(anchor) ?? []
      list.push(i)
      byAnchor.set(anchor, list)
    })
    const order: RowRef[] = []
    const resultToDisplay = new Array<number>(rows.length)
    const draftToDisplay = new Array<number>(drafts.length)
    for (const i of byAnchor.get(-1) ?? []) {
      draftToDisplay[i] = order.length
      order.push({ kind: 'draft', index: i })
    }
    for (let r = 0; r < rows.length; r += 1) {
      resultToDisplay[r] = order.length
      order.push({ kind: 'result', row: r })
      for (const i of byAnchor.get(r) ?? []) {
        draftToDisplay[i] = order.length
        order.push({ kind: 'draft', index: i })
      }
    }
    this._displayCache = { rows, drafts, order, resultToDisplay, draftToDisplay }
    return this._displayCache
  }

  private _refAt(display: number): RowRef | null {
    return this._display().order[display] ?? null
  }

  // The result-row index to scroll to so a display row is visible (a draft's
  // anchor for drafts), used by keyboard navigation.
  private _anchorRowOf(ref: RowRef): number {
    if (ref.kind === 'result') return ref.row
    const after = this.drafts[ref.index]?.after ?? -1
    return Math.max(0, after)
  }

  // Values of a display row's cells, for copy. Drafts expose their staged cells;
  // untouched draft cells read as null.
  private _rowValuesAt(ref: RowRef): unknown[] {
    if (this.run.phase !== 'done') return []
    if (ref.kind === 'result') {
      const columns = this._shownResult()?.columns.length ?? 0
      return Array.from({ length: columns }, (_, col) => this._recordValue(ref, col))
    }
    return (this.drafts[ref.index]?.cells ?? []).map((cell) => (isSqlNull(cell) ? null : cell))
  }

  private _addRow = () => {
    // The new row renders below the focused cell's row: under the focused draft
    // (same anchor, stacked after it), else under the focused result row.
    let after = -1
    let index: number | undefined
    const ref = this._sel ? this._refAt(this._sel.r1) : null
    if (ref?.kind === 'draft') {
      after = this.drafts[ref.index]?.after ?? -1
      index = ref.index + 1
    } else if (ref?.kind === 'result') {
      after = ref.row
    }
    this.dispatchEvent(new CustomEvent('add-row', { detail: { after, index }, bubbles: true, composed: true }))
    // Select the new row once it arrives (it lands at `index`, or appended).
    this._pendingSelectDraft = index ?? this.drafts.length
  }

  private _duplicateSelection = () => {
    if (this.run.phase !== 'done') return
    const { results } = this._selectedRefs()
    if (!results.length) return
    // Duplication rebinds values through editor text. Binary/structured cells
    // and truncated results would silently insert different data, so refuse
    // (validated here, on click, so rendering never scans the selection).
    const result = this._shownResult()
    if (!result || result.truncated || !results.every((row) => result.rows[row]?.every((value) =>
      value === null || value === undefined || ['string', 'number', 'bigint', 'boolean'].includes(typeof value),
    ))) {
      this.dispatchEvent(new CustomEvent('grid-notice', {
        detail: {
          title: t('results.cannotDuplicateTitle'),
          detail: t('results.cannotDuplicateDetail'),
        },
        bubbles: true,
        composed: true,
      }))
      return
    }
    // Stack every duplicate below the last selected row, in selection order,
    // rather than interleaving each copy under its own source row.
    const after = Math.max(...results)
    const drafts = results.map((row) => ({ after, cells: this._duplicateCells(row) }))
    this.dispatchEvent(new CustomEvent('duplicate-rows', { detail: { drafts }, bubbles: true, composed: true }))
    this._pendingSelectDraft = this.drafts.length
  }

  private _duplicateCells(row: number): Array<CellInput | null> {
    if (this.run.phase !== 'done') return []
    const result = this._shownResult()
    if (!result) return []
    return result.columns.map((_, col) => {
      const pending = this.edits.get(`${row}:${col}`)
      if (pending !== undefined) return pending
      const value = result.rows[row]?.[col]
      return value === null || value === undefined ? SQL_NULL : formatCell(value)
    })
  }

  private _setSelectionNull = () => {
    const targets = this._selectedCellTargets()
    if (targets.length) this._commitFill(targets, SQL_NULL)
  }

  private _setSelectionEmpty = () => {
    const targets = this._selectedCellTargets()
    if (targets.length) this._commitFill(targets, '')
  }

  // Cells of the live selection, for the NULL/'' toolbar actions. Called from
  // click handlers only — never from render, where an O(selection) walk on a
  // large grid would run on every pointer-move repaint.
  private _selectedCellTargets(): Array<{ ref: RowRef; col: number }> {
    if (!this._sel) return []
    const { order } = this._display()
    const targets: Array<{ ref: RowRef; col: number }> = []
    const r0 = Math.max(0, Math.min(this._sel.r0, this._sel.r1))
    const r1 = Math.min(order.length - 1, Math.max(this._sel.r0, this._sel.r1))
    const c0 = Math.min(this._sel.c0, this._sel.c1)
    const c1 = Math.max(this._sel.c0, this._sel.c1)
    for (let row = r0; row <= r1; row += 1) {
      const ref = order[row]
      if (!ref) continue
      for (let col = c0; col <= c1; col += 1) targets.push({ ref, col })
    }
    return targets
  }

  private _saveRows = () => {
    if (!this._hasPending()) return
    this.dispatchEvent(new CustomEvent('save-rows', { bubbles: true, composed: true }))
  }

  private _hasPending() {
    return this.drafts.length > 0 || this.edits.size > 0
  }

  // Throws away every staged edit and new row (no DB write to undo).
  private _discardChanges = () => {
    this._escArmed = false
    if (!this._hasPending()) return
    this._editing = null
    this.dispatchEvent(new CustomEvent('discard-changes', { bubbles: true, composed: true }))
  }

  private _removeDraft(indexes: number[]) {
    if (!indexes.length) return
    this.dispatchEvent(new CustomEvent('draft-remove', { detail: { indexes }, bubbles: true, composed: true }))
  }

  // Delete acts on the unified selection: result rows go through the DELETE
  // review; staged draft rows are just discarded (nothing to confirm).
  private _deleteSelection() {
    const { results, drafts } = this._selectedRefs()
    if (results.length) this.dispatchEvent(new CustomEvent('delete-rows', { detail: { rows: results }, bubbles: true, composed: true }))
    this._removeDraft(drafts)
  }

  // Result-row data indices and draft array indices covered by the selection.
  private _selectedRefs(): { results: number[]; drafts: number[] } {
    const results: number[] = []
    const drafts: number[] = []
    if (!this._sel) return { results, drafts }
    const { order } = this._display()
    const r0 = Math.max(0, Math.min(this._sel.r0, this._sel.r1))
    const r1 = Math.min(order.length - 1, Math.max(this._sel.r0, this._sel.r1))
    for (let d = r0; d <= r1; d += 1) {
      const ref = order[d]
      if (ref?.kind === 'result') results.push(ref.row)
      else if (ref?.kind === 'draft') drafts.push(ref.index)
    }
    return { results, drafts }
  }

  private _toggleCollapse = () => {
    this.dispatchEvent(new CustomEvent('toggle-collapse', { bubbles: true, composed: true }))
  }

  private _toggleFilter = () => {
    this._filterOpen = !this._filterOpen
    if (this._filterOpen) {
      this._filterDraft = this.filter ?? ''
      this._filterFocusPending = true
    }
  }

  private _applyFilter = (event: Event) => {
    event.preventDefault()
    const condition = this._filterDraft.trim()
    if (condition === (this.filter ?? '')) return
    this.dispatchEvent(new CustomEvent<{ condition: string | null }>('filter-condition', {
      detail: { condition: condition || null },
      bubbles: true,
      composed: true,
    }))
  }

  private _clearFilter = () => {
    this._filterDraft = ''
    if (this.filter !== null) {
      this.dispatchEvent(new CustomEvent<{ condition: null }>('filter-condition', {
        detail: { condition: null },
        bubbles: true,
        composed: true,
      }))
    }
  }

  private _closeFilter = (event: Event) => {
    event.preventDefault()
    this._filterDraft = this.filter ?? ''
    this._filterOpen = false
  }

  render() {
    const result = this._shownResult()
    const exportable = !!result?.columns.length
    const canEditResult = this._canEditShownResult()
    const pendingCount = this.drafts.length + this.edits.size
    const showWriteTools = exportable && canEditResult && (this.rowEditable || pendingCount > 0)
    const canToggleRecord = exportable && (this._record !== null || (this._sel ? this._refAt(this._sel.r1) !== null : false))
    const runSql = this.run.phase === 'done' || this.run.phase === 'error' ? this.run.sql : undefined
    const canFilter = !!runSql && isFilterableQuery(runSql)
    const selected = this.rowEditable && canEditResult ? this._selectedRefs() : { results: [], drafts: [] }
    const hasDeletable = selected.results.length > 0 || selected.drafts.length > 0
    return html`
      <div class="head">
        <span>${t('results.title')}</span>
        ${this.run.phase === 'done' && (this.run.result.resultSets?.length ?? 0) > 1
          ? html`
              <select class="result-set-select" aria-label=${t('results.resultSet')} @change=${this._selectResultSet} .value=${String(this._resultSetIndex)}>
                ${this.run.result.resultSets!.map((set, index) =>
                  html`<option value=${index}>${t('results.resultOption', {
                    index: index + 1,
                    count: formatInteger(set.rowCount),
                    approximate: set.rowCountExact === false ? '+' : '',
                    rows: rowWord(set.rowCount),
                  })}</option>`,
                )}
              </select>
            `
          : ''}
        ${showWriteTools
          ? html`
              <div class="toolbar" aria-label=${t('results.editActions')}>
                ${this.rowEditable && canEditResult
                  ? html`
                      <button class="head-action" data-tooltip=${t('results.addRow')} aria-label=${t('results.addRow')} @click=${this._addRow}>
                        <i class="codicon codicon-add" aria-hidden="true"></i>
                      </button>
                      <button
                        class="head-action danger"
                        data-tooltip=${t('results.deleteRows')}
                        aria-label=${t('results.deleteRows')}
                        ?disabled=${!hasDeletable}
                        @click=${() => this._deleteSelection()}
                      >
                        <i class="codicon codicon-remove" aria-hidden="true"></i>
                      </button>
                      <button
                        class="head-action"
                        data-tooltip=${t('results.duplicateRowsShortcut', { shortcut: isMac ? '⌘D' : 'Ctrl+D' })}
                        aria-label=${t('results.duplicateRows')}
                        ?disabled=${selected.results.length === 0 || !!result?.truncated}
                        @click=${this._duplicateSelection}
                      >
                        <i class="codicon codicon-copy" aria-hidden="true"></i>
                      </button>
                    `
                  : ''}
                <button
                  class="head-action"
                  data-tooltip=${t('results.savePending', {
                    count: pendingCount,
                    changes: t(pendingCount === 1 ? 'results.pendingChange' : 'results.pendingChanges'),
                    shortcut: isMac ? '⌘S' : 'Ctrl+S',
                  })}
                  aria-label=${t('results.saveChanges')}
                  ?disabled=${pendingCount === 0}
                  @click=${this._saveRows}
                >
                  <i class="codicon codicon-save" aria-hidden="true"></i>
                </button>
                <button
                  class="head-action"
                  data-tooltip=${t('results.discardAllShortcut', { shortcut: 'Esc Esc' })}
                  aria-label=${t('results.discardChanges')}
                  ?disabled=${pendingCount === 0}
                  @click=${this._discardChanges}
                >
                  <i class="codicon codicon-discard" aria-hidden="true"></i>
                </button>
              </div>
            `
          : ''}
        ${canFilter
          ? html`
              <button
                class="head-action ${this.filter !== null || this._filterOpen ? 'active' : ''}"
                data-tooltip=${t('results.filter')}
                aria-label=${t('results.filter')}
                aria-expanded=${this._filterOpen}
                @click=${this._toggleFilter}
              >
                <i class="codicon codicon-filter" aria-hidden="true"></i>
              </button>
            `
          : ''}
        ${exportable
          ? html`
              <div class="toolbar view-toolbar" aria-label=${t('results.viewActions')}>
                <button
                  class="head-action"
                  data-tooltip=${t('results.viewShortcut', {
                    view: this._record ? t('results.gridView') : t('results.listView'),
                    shortcut: 'Tab',
                  })}
                  aria-label=${this._record ? t('results.gridView') : t('results.listView')}
                  ?disabled=${!canToggleRecord}
                  @click=${this._toggleRecordView}
                >
                  <i class="codicon codicon-${this._record ? 'table' : 'list-selection'}" aria-hidden="true"></i>
                </button>
              </div>
            `
          : ''}
        <span class="status">${this._status()}</span>
        ${exportable
          ? html`
              <button
                class="head-action"
                data-tooltip=${t('results.export')}
                aria-label=${t('results.export')}
                @click=${() => (this._exportOpen = true)}
              >
                <i class="codicon codicon-download" aria-hidden="true"></i>
              </button>
            `
          : ''}
        <button
          class="head-action"
          data-tooltip=${this.collapsed ? t('results.expand') : t('results.collapse')}
          aria-label=${this.collapsed ? t('results.expand') : t('results.collapse')}
          aria-expanded=${!this.collapsed}
          @click=${this._toggleCollapse}
        >
          <i class="codicon codicon-chevron-${this.collapsed ? 'up' : 'down'}" aria-hidden="true"></i>
        </button>
      </div>
      ${this._filterOpen && canFilter && !this.collapsed
        ? html`
            <div class="filter-bar">
              <i class="codicon codicon-filter" aria-hidden="true"></i>
              <sql-expression-editor
                class="filter-input"
                aria-label=${t('results.filter')}
                .value=${this._filterDraft}
                .engine=${this.engine}
                .columns=${result?.columns ?? this._filterColumns}
                .compact=${true}
                .submitOnEnter=${true}
                .placeholderText=${t('results.filterPlaceholder')}
                @expression-change=${(event: CustomEvent<{ value: string }>) => (this._filterDraft = event.detail.value)}
                @expression-submit=${this._applyFilter}
                @expression-cancel=${this._closeFilter}
              ></sql-expression-editor>
              <button
                class="filter-action filter-apply"
                type="button"
                data-tooltip=${t('results.applyFilter')}
                aria-label=${t('results.applyFilter')}
                ?disabled=${!this._filterDraft.trim() || this._filterDraft.trim() === (this.filter ?? '')}
                @click=${this._applyFilter}
              >
                <i class="codicon codicon-check" aria-hidden="true"></i>
              </button>
              <button
                class="filter-action filter-clear"
                type="button"
                data-tooltip=${t('results.clearFilter')}
                aria-label=${t('results.clearFilter')}
                ?disabled=${!this._filterDraft && this.filter === null}
                @click=${this._clearFilter}
              >
                <i class="codicon codicon-close" aria-hidden="true"></i>
              </button>
            </div>
          `
        : ''}
      <div class="body" @scroll=${this._onScroll}>${this._renderBody()}</div>
      ${this._renderMenu()}
      ${this._exportOpen && this.run.phase === 'done'
        ? html`
            <export-dialog
              .total=${result?.bufferedRowCount ?? result?.rows.length ?? 0}
              .truncated=${result?.truncated ?? false}
              .streamable=${this.streamExportAvailable}
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
    const { format, rows, stream } = event.detail
    // A full streamed export re-runs the query in the main process; the owner
    // has the query context (profile/child/sort) to drive it.
    if (stream) {
      this.dispatchEvent(new CustomEvent<{ format: ExportFormat }>('stream-export', { detail: { format }, bubbles: true, composed: true }))
      return
    }
    const result = this._shownResult()
    if (!result) return
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
    const rows: unknown[][] = []
    this._draining = { done: 0, total: need }
    try {
      while (rows.length < need) {
        // Pages stay byte-capped main-side, so a short return just loops again.
        const response = await window.sqlkit.fetchRows(result.sessionId, rows.length, Math.min(MAX_FETCH_ROWS, need - rows.length))
        if (!response.success) return result.rows.slice(0, need)
        if (response.rows.length === 0) break
        rows.push(...response.rows)
        this._draining = { done: rows.length, total: need }
      }
      return rows
    } finally {
      this._draining = null
    }
  }

  // One delegated listener instead of one per cell. The data row index is read
  // from the row's data-row (sectionRowIndex would be wrong under windowing);
  // the # column shifts data columns right by one.
  private _onTableContextMenu(event: MouseEvent) {
    if (this.run.phase !== 'done') return
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('td, th')
    if (!cell) return
    // Draft rows aren't part of the result; no copy/edit menu for them.
    if (cell.closest('tr')?.hasAttribute('data-draft')) return
    event.preventDefault()
    const dataRow = cell.closest('tr')?.getAttribute('data-row')
    const row = cell.tagName === 'TH' || dataRow === null || dataRow === undefined ? -1 : Number(dataRow)
    const col = cell.cellIndex - 1
    if (row >= 0 && col < 0) {
      this._selectRowsForCopy(row)
    } else if (row >= 0) {
      const display = this._displayIndexOfRef({ kind: 'result', row })
      if (!this._isSelectedDisplay(display, col)) this._sel = { r0: display, c0: col, r1: display, c1: col }
    }
    this._menu = { x: event.clientX, y: event.clientY, row, col }
  }

  private _selectRowsForCopy(row: number) {
    const lastCol = (this._shownResult()?.columns.length ?? 0) - 1
    if (lastCol < 0) return
    const display = this._displayIndexOfRef({ kind: 'result', row })
    const selection = this._sel
    const selectedStart = selection ? Math.min(selection.r0, selection.r1) : display
    const selectedEnd = selection ? Math.max(selection.r0, selection.r1) : display
    const insideSelection = display >= selectedStart && display <= selectedEnd
    this._sel = {
      r0: insideSelection ? selectedStart : display,
      c0: 0,
      r1: insideSelection ? selectedEnd : display,
      c1: lastCol,
    }
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu || this.run.phase !== 'done') return ''
    const result = this._shownResult()
    if (!result) return ''
    const canEdit = this.editable && this._canEditShownResult() && menu.row >= 0 && menu.col >= 0
    const selectedRowCount = this._sel ? Math.abs(this._sel.r1 - this._sel.r0) + 1 : 1
    // Header right-click (no row): DBeaver-style explicit sort, with a check on
    // the active direction. The trailing copy items get a separator to divide them.
    const sortItems: MenuItem[] = []
    if (menu.row < 0 && menu.col >= 0) {
      const { sortable, current } = this._sortState(result)
      if (sortable) {
        const dir = current?.columnIndex === menu.col ? current.direction : null
        sortItems.push(
          { id: 'sort-asc', label: t('results.sortAscending'), checked: dir === 'asc' },
          { id: 'sort-desc', label: t('results.sortDescending'), checked: dir === 'desc' },
          { id: 'sort-clear', label: t('results.clearSort'), checked: false },
        )
      }
    }
    // A left-click sort menu shows only the sort actions; if the column can't be
    // sorted there's nothing to show, so skip the menu entirely.
    if (menu.sortOnly) {
      if (!sortItems.length) return ''
      return html`
        <context-menu
          .x=${menu.x}
          .y=${menu.y}
          .items=${sortItems}
          @menu-pick=${(e: CustomEvent<MenuPickDetail>) => void this._onMenuPick(e.detail.id, result, menu)}
          @menu-close=${() => (this._menu = null)}
        ></context-menu>
      `
    }
    const items: MenuItem[] = [
      ...sortItems,
      ...(menu.row >= 0 && menu.col >= 0 ? [{ id: 'view-record', label: t('results.viewRecord'), shortcut: 'Tab' }] : []),
      ...(canEdit
        ? [
            { id: 'edit-cell', label: t('results.editCell'), shortcut: 'Enter' },
            { id: 'paste-cell', label: t('results.paste'), shortcut: isMac ? '⌘V' : 'Ctrl+V' },
            { id: 'set-null', label: t('results.setNull') },
            { id: 'set-empty', label: t('results.setEmptyString') },
          ]
        : []),
      ...(menu.row >= 0 && menu.col >= 0
        ? [{ id: 'copy-cell', label: t('results.copyCell'), shortcut: isMac ? '⌘C' : 'Ctrl+C', separatorBefore: canEdit }]
        : []),
      ...(menu.row >= 0
        ? [{ id: 'copy-row', label: t(selectedRowCount > 1 ? 'results.copySelectedRows' : 'results.copyRow') }]
        : []),
      ...(menu.col >= 0 ? [{ id: 'copy-column-name', label: t('results.copyColumnName'), separatorBefore: sortItems.length > 0 }] : []),
      { id: 'copy-csv', label: t('results.copyAllCsv'), separatorBefore: true },
      { id: 'copy-tsv', label: t('results.copyAllTsv') },
      { id: 'copy-json', label: t('results.copyAllJson') },
      { id: 'export', label: t('results.export'), separatorBefore: true },
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
    const copy = (text: string) => void window.sqlkit.writeClipboardText(text)
    if (action === 'copy-cell') copy(cellToTsv(this._recordValue({ kind: 'result', row: at.row }, at.col)))
    if (action === 'copy-row') {
      this._selectRowsForCopy(at.row)
      this._copySelection()
    }
    if (action === 'copy-column-name') copy(cellToTsv(result.columns[at.col] ?? ''))
    if (action === 'sort-asc') this._setSort(at.col, 'asc')
    if (action === 'sort-desc') this._setSort(at.col, 'desc')
    if (action === 'sort-clear') this._setSort(at.col, null)
    // Copy-all / export cover every buffered row, not just what's loaded on screen.
    if (action === 'copy-csv') copy(toDelimited(result.columns, await this._allRows(result), ','))
    if (action === 'copy-tsv') copy(toDelimited(result.columns, await this._allRows(result), '\t'))
    if (action === 'copy-json') copy(toJson(result.columns, await this._allRows(result)))
    if (action === 'export') this._exportOpen = true
    if (action === 'view-record' && at.row >= 0 && at.col >= 0) this._openRecord({ kind: 'result', row: at.row }, at.col)
    // Edit opens the inline editor on the clicked cell; if it's inside a
    // multi-cell selection, the committed value fills the whole selection.
    if (action === 'edit-cell' && at.row >= 0 && at.col >= 0) this._beginEdit({ kind: 'result', row: at.row }, at.col, null)
    if (action === 'paste-cell') this._pasteText(await window.sqlkit.readClipboardText())
    // Fills the whole selection (the right-click reduced it to the clicked
    // cell when it was outside), same as a committed edit would.
    if (action === 'set-null') this._setSelectionNull()
    if (action === 'set-empty') this._setSelectionEmpty()
  }

  private _renderRecordView() {
    const record = this._record
    if (!record || this.run.phase !== 'done') return ''
    const columns = this._shownResult()?.columns ?? []
    const rowLabel = t(record.ref.kind === 'result' ? 'results.rowLabel' : 'results.newRowLabel', {
      index: (record.ref.kind === 'result' ? record.ref.row : record.ref.index) + 1,
    })
    return html`
      <section
        class="record-view"
        role="region"
        aria-label=${t('results.recordView')}
        tabindex="0"
        style="--record-column-w: ${measureRecordColumnWidth(columns)}px"
        @keydown=${this._onRecordKeydown}
      >
        <div class="record-grid">
          <div class="record-field record-header-row">
            <div class="record-column" aria-hidden="true"></div>
            <div class="record-value record-row-label">${rowLabel}</div>
          </div>
          ${columns.map((column, col) => {
            const value = this._recordValue(record.ref, col)
            const pending = record.ref.kind === 'result' && this.edits.has(`${record.ref.row}:${col}`)
            const selected = col === record.col
            return html`
              <div class="record-field ${selected ? 'active' : ''} ${pending ? 'dirty-record' : ''}">
                <div class="record-column" title=${column}>${column}</div>
                <textarea
                  class="record-value ${value === null || value === undefined || isSqlNull(value) ? 'null-value' : ''}"
                  data-col=${col}
                  rows="1"
                  placeholder="NULL"
                  .value=${this._recordEditText(value)}
                  ?readonly=${!this._recordCellEditable(record.ref)}
                  @focus=${() => this._focusRecordField(col)}
                  @blur=${this._onRecordValueBlur}
                ></textarea>
              </div>
            `
          })}
        </div>
      </section>
    `
  }

  private _recordValue(ref: RowRef, col: number): unknown {
    if (ref.kind === 'draft') return this.drafts[ref.index]?.cells[col] ?? null
    const key = `${ref.row}:${col}`
    return this.edits.has(key) ? this.edits.get(key) : (this._shownResult()?.rows[ref.row]?.[col] ?? null)
  }

  private _recordEditText(value: unknown): string {
    if (value === null || value === undefined || isSqlNull(value)) return ''
    return formatCell(value)
  }

  private _recordCellEditable(ref: RowRef): boolean {
    return ref.kind === 'draft' || (this.editable && this._canEditShownResult())
  }

  private _focusRecordField(col: number) {
    if (this._record) this._record = { ...this._record, col }
  }

  private _onRecordValueBlur = (event: FocusEvent) => {
    this._commitRecordEdit(event.target as HTMLTextAreaElement)
  }

  private _commitRecordEdit(input: HTMLTextAreaElement) {
    const record = this._record
    const col = Number(input.dataset.col)
    if (!record || !Number.isFinite(col)) return
    const value = input.value
    if (record.ref.kind === 'draft') {
      const current = this.drafts[record.ref.index]?.cells[col]
      // A NULL cell renders as empty text; leaving it empty must not silently
      // convert NULL to ''. The '' toolbar action sets an empty string explicitly.
      if ((current === null || current === undefined || isSqlNull(current)) && value === '') return
      if (current === null || current === undefined || !sameInput(value, current)) {
        this.dispatchEvent(new CustomEvent('draft-edit', { detail: { index: record.ref.index, col, value }, bubbles: true, composed: true }))
      }
      return
    }
    if (!this.editable || !this._canEditShownResult() || this.run.phase !== 'done') return
    const original = this._shownResult()?.rows[record.ref.row]?.[col]
    const originalInput: CellInput = original === null || original === undefined ? SQL_NULL : formatCell(original)
    const key = `${record.ref.row}:${col}`
    const pending = this.edits.get(key)
    const current = pending ?? originalInput
    if (sameInput(value, current)) return
    // Same NULL-renders-empty rule for result cells: blur alone stages nothing.
    if (value === '' && isSqlNull(current)) return
    if (pending !== undefined && sameInput(value, originalInput)) {
      this.dispatchEvent(new CustomEvent('cell-edit-clear', { detail: { row: record.ref.row, col }, bubbles: true, composed: true }))
    } else {
      this.dispatchEvent(new CustomEvent('cell-edit', { detail: { row: record.ref.row, col, value }, bubbles: true, composed: true }))
    }
  }

  // --- cell selection ---------------------------------------------------------

  // The display index of a row reference (result or draft) in the interleaved order.
  private _displayIndexOfRef(ref: RowRef): number {
    const map = this._display()
    return (ref.kind === 'result' ? map.resultToDisplay[ref.row] : map.draftToDisplay[ref.index]) ?? 0
  }

  // The cell a DOM node sits in, as a row reference + column; null for the #
  // column, header, or windowing spacers. Handles both result and draft rows.
  private _cellRefAt(node: Element | null): { ref: RowRef; col: number } | null {
    const cell = node?.closest<HTMLTableCellElement>('td')
    if (!cell || cell.classList.contains('num')) return null
    const tr = cell.closest('tr')
    const col = cell.cellIndex - 1
    if (!tr || col < 0) return null
    const draftIndex = tr.getAttribute('data-draft')
    if (draftIndex !== null) return { ref: { kind: 'draft', index: Number(draftIndex) }, col }
    const dataRow = tr.getAttribute('data-row')
    if (dataRow !== null) return { ref: { kind: 'result', row: Number(dataRow) }, col }
    return null
  }

  private _isSelectedDisplay(display: number, col: number): boolean {
    const s = this._sel
    if (!s) return false
    return (
      display >= Math.min(s.r0, s.r1) &&
      display <= Math.max(s.r0, s.r1) &&
      col >= Math.min(s.c0, s.c1) &&
      col <= Math.max(s.c0, s.c1)
    )
  }

  private _onCellPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return // leave right-click to the context menu
    this._escArmed = false // a click breaks a pending double-Esc
    // Clicking inside the inline editor must not re-select or steal its focus.
    if ((event.target as HTMLElement).closest('.cell-edit')) return
    const hit = this._cellRefAt(event.target as Element)
    if (!hit) return
    ;(event.currentTarget as HTMLElement).focus() // so keyboard nav / copy reach us
    const display = this._displayIndexOfRef(hit.ref)

    // Shift-click extends the rectangle from the anchor; a plain press starts a
    // drag. Both just set _sel — only the ~viewport rows re-render, so it's cheap.
    if (event.shiftKey && this._sel) {
      this._sel = { ...this._sel, r1: display, c1: hit.col }
      return
    }
    this._sel = { r0: display, c0: hit.col, r1: display, c1: hit.col }
    this._dragging = true
    window.addEventListener('pointermove', this._onDragMove)
    window.addEventListener('pointerup', this._endDrag)
    window.addEventListener('pointercancel', this._endDrag)
  }

  private _onDragMove = (event: PointerEvent) => {
    if (!this._dragging || !this._sel) return
    // elementFromPoint must go through the shadow root to see inside it.
    const hit = this._cellRefAt(this.shadowRoot?.elementFromPoint(event.clientX, event.clientY) ?? null)
    if (!hit) return
    const display = this._displayIndexOfRef(hit.ref)
    if (display === this._sel.r1 && hit.col === this._sel.c1) return
    this._sel = { ...this._sel, r1: display, c1: hit.col }
  }

  private _endDrag = () => {
    if (!this._dragging) return
    this._dragging = false
    window.removeEventListener('pointermove', this._onDragMove)
    window.removeEventListener('pointerup', this._endDrag)
    window.removeEventListener('pointercancel', this._endDrag)
  }

  // --- keyboard navigation (DBeaver-style) ------------------------------------

  // Moves the focus cell by (dRow, dCol); without shift the whole selection
  // collapses onto it, with shift the anchor stays and the rectangle grows.
  private _moveFocus(dRow: number, dCol: number, extend: boolean) {
    const s = this._sel
    if (!s || this.run.phase !== 'done') return
    const len = this._display().order.length
    const cols = this._shownResult()?.columns.length ?? 0
    const r = Math.max(0, Math.min(len - 1, s.r1 + dRow))
    const c = Math.max(0, Math.min(cols - 1, s.c1 + dCol))
    this._sel = extend ? { ...s, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c }
    this._scrollCellIntoView(r, c)
  }

  // In the inline editor, Tab/Shift-Tab moves one cell horizontally, wrapping to
  // the next/previous row. On the grid itself, Tab opens the row record view.
  private _moveTab(forward: boolean) {
    const s = this._sel
    if (!s || this.run.phase !== 'done') return
    const len = this._display().order.length
    const cols = this._shownResult()?.columns.length ?? 0
    let r = s.r1
    let c = s.c1 + (forward ? 1 : -1)
    if (c >= cols) {
      c = 0
      r = Math.min(len - 1, r + 1)
    } else if (c < 0) {
      c = cols - 1
      r = Math.max(0, r - 1)
    }
    this._sel = { r0: r, c0: c, r1: r, c1: c }
    this._scrollCellIntoView(r, c)
  }

  private _openRecordAtSelection() {
    if (!this._sel) return
    const ref = this._refAt(this._sel.r1)
    if (ref) this._openRecord(ref, this._sel.c1)
  }

  private _openRecord(ref: RowRef, col: number) {
    this._record = { ref, col }
    this._recordFocusPending = true
  }

  private _toggleRecordView = () => {
    if (this._record) this._closeRecord()
    else this._openRecordAtSelection()
  }

  private _closeRecord = () => {
    this._record = null
    this._focusGridPending = true
  }

  private _onRecordKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      if (event.target instanceof HTMLTextAreaElement) this._commitRecordEdit(event.target)
      this._closeRecord()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this._closeRecord()
    }
  }

  // Keeps the focused cell in view as the selection moves; `col < 0` skips the
  // x-axis. Vertical uses the row/header heights, horizontal the rendered column widths.
  private _scrollCellIntoView(display: number, col: number) {
    const ref = this._refAt(display)
    const body = this._bodyEl()
    if (!ref || !body) return
    const rowH = this._rowHeight || ESTIMATED_ROW_HEIGHT
    const headerH = this.shadowRoot?.querySelector<HTMLElement>('thead')?.offsetHeight ?? 0
    const top = headerH + this._anchorRowOf(ref) * rowH
    const bottom = top + rowH
    // The sticky header covers the top of the scrollport. Keep the focused row
    // below it instead of merely inside the body's raw scroll coordinates.
    if (top < body.scrollTop + headerH) body.scrollTop = Math.max(0, top - headerH)
    else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight

    const layout = this._colLayout
    if (!layout || col < 0 || col >= layout.widths.length) return
    let left = layout.numColWidth
    for (let i = 0; i < col; i += 1) left += layout.widths[i] ?? 0
    const right = left + (layout.widths[col] ?? 0)
    if (left < body.scrollLeft) body.scrollLeft = left
    else if (right > body.scrollLeft + body.clientWidth) body.scrollLeft = right - body.clientWidth
  }

  private _copySelection() {
    if (!this._sel || this.run.phase !== 'done') return
    const { order } = this._display()
    const r0 = Math.max(0, Math.min(this._sel.r0, this._sel.r1))
    const r1 = Math.min(order.length - 1, Math.max(this._sel.r0, this._sel.r1))
    const c0 = Math.min(this._sel.c0, this._sel.c1)
    const c1 = Math.max(this._sel.c0, this._sel.c1)
    const selected: unknown[][] = []
    for (let d = r0; d <= r1; d += 1) {
      const ref = order[d]
      if (!ref) continue
      const values = this._rowValuesAt(ref)
      const cells: unknown[] = []
      for (let c = c0; c <= c1; c += 1) cells.push(values[c])
      selected.push(cells)
    }
    // cellsToTsv applies full TSV field escaping: an embedded tab/newline is
    // quoted (stays one cell) and a formula-leading cell is neutralized.
    void window.sqlkit.writeClipboardText(cellsToTsv(selected))
  }

  private _onGridPaste = (event: ClipboardEvent) => {
    if ((event.target as HTMLElement).closest('.cell-edit')) return
    const text = event.clipboardData?.getData('text/plain')
    if (text !== undefined && this._pasteText(text)) event.preventDefault()
  }

  private _pasteText(text: string): boolean {
    const selection = this._sel
    const result = this._shownResult()
    if (!selection || this.run.phase !== 'done' || !result) return false
    const matrix = parseClipboardTsv(text)
    const { order } = this._display()
    const startRow = Math.max(0, Math.min(selection.r0, selection.r1))
    const startCol = Math.max(0, Math.min(selection.c0, selection.c1))
    const values: Array<{ ref: RowRef; col: number; value: string }> = []

    if (matrix.length === 1 && matrix[0]?.length === 1) {
      const value = matrix[0]?.[0] ?? ''
      for (const target of this._editTargets({ ref: order[startRow]!, col: startCol, sel: selection })) {
        if (target.ref.kind === 'draft' || (this.editable && this._canEditShownResult())) values.push({ ...target, value })
      }
    } else {
      for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
        const ref = order[startRow + rowOffset]
        if (!ref || (ref.kind === 'result' && (!this.editable || !this._canEditShownResult()))) continue
        for (let colOffset = 0; colOffset < (matrix[rowOffset]?.length ?? 0); colOffset += 1) {
          const col = startCol + colOffset
          if (col >= result.columns.length) break
          values.push({ ref, col, value: matrix[rowOffset]?.[colOffset] ?? '' })
        }
      }
    }
    if (!values.length) return false
    this._commitValues(values)
    return true
  }

  private _onGridKeydown = (event: KeyboardEvent) => {
    if (this.run.phase !== 'done') return
    // A second consecutive Escape (with staged changes) discards them; the first
    // just arms it. Any other key disarms, so only a genuine double-Esc fires.
    if (event.key === 'Escape') {
      if (this._record) {
        event.preventDefault()
        this._closeRecord()
        return
      }
      if (!this._hasPending()) return
      event.preventDefault()
      if (this._escArmed) this._discardChanges()
      else this._escArmed = true
      return
    }
    this._escArmed = false
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      this._copySelection()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      if (this.rowEditable && this._canEditShownResult()) this._duplicateSelection()
      return
    }
    // ⌘Z / ⌘⇧Z (staged-edit undo/redo) is handled at the workbench level so it
    // works from anywhere on the tab, not just when the grid holds focus.
    if (event.metaKey || event.ctrlKey || event.altKey || !this._sel) return
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); return this._moveFocus(1, 0, event.shiftKey)
      case 'ArrowUp': event.preventDefault(); return this._moveFocus(-1, 0, event.shiftKey)
      case 'ArrowRight': event.preventDefault(); return this._moveFocus(0, 1, event.shiftKey)
      case 'ArrowLeft': event.preventDefault(); return this._moveFocus(0, -1, event.shiftKey)
      case 'Tab': event.preventDefault(); return this._openRecordAtSelection()
      case 'Enter':
      case 'F2':
        event.preventDefault()
        return this._editAnchor(null)
      default:
        // Type-to-edit: a printable key opens the editor seeded with that char.
        if (event.key.length === 1) {
          event.preventDefault()
          this._editAnchor(event.key)
        }
    }
  }

  // --- cell editing -----------------------------------------------------------

  // Edits the anchor (top-left) cell of the selection — so a typed value fills
  // from the first selected cell, not the last.
  private _editAnchor(seed: string | null) {
    if (!this._sel) return
    const display = Math.min(this._sel.r0, this._sel.r1)
    const col = Math.min(this._sel.c0, this._sel.c1)
    const ref = this._refAt(display)
    if (ref) this._beginEdit(ref, col, seed)
  }

  private _onCellDblClick = (event: MouseEvent) => {
    // Double-clicking inside the editor (e.g. to select a word) must not reset it.
    if ((event.target as HTMLElement).closest('.cell-edit')) return
    const hit = this._cellRefAt(event.target as Element)
    if (hit) this._beginEdit(hit.ref, hit.col, null)
  }

  // Opens the inline editor on a cell; `seed` (a typed char) replaces the value.
  // The current selection is snapshotted so the committed value fills all of it.
  private _beginEdit(ref: RowRef, col: number, seed: string | null) {
    if (ref.kind === 'result' && (!this.editable || !this._canEditShownResult())) return
    this._editing = { ref, col, seed, sel: this._sel ? { ...this._sel } : null }
    this._editFocusPending = true
    this._scrollCellIntoView(this._displayIndexOfRef(ref), col)
  }

  private _onEditKeydown = (event: KeyboardEvent) => {
    const input = event.target as HTMLInputElement
    if (event.key === 'Enter') {
      event.preventDefault()
      this._commitEdit(input)
      this._moveFocus(1, 0, false) // commit and drop to the next row
      this._focusGridPending = true
    } else if (event.key === 'Tab') {
      event.preventDefault()
      this._commitEdit(input)
      this._moveTab(!event.shiftKey)
      this._focusGridPending = true
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this._editing = null
      this._focusGridPending = true
    }
    // Don't let Cmd/Ctrl-C etc. bubble to the grid's copy handler while typing.
    event.stopPropagation()
  }

  // Commits the inline edit onto the snapshotted selection. A single cell keeps
  // the per-cell events; a multi-cell fill collapses into one staged step so ⌘Z
  // reverses the whole gesture (and it doesn't clone the edit map once per cell).
  private _commitEdit(input: HTMLInputElement) {
    const editing = this._editing
    this._editing = null
    if (!editing) return
    const value = input.value
    if (editing.seed === null && value === this._editCellText(editing.ref, editing.col)) return
    const targets = this._editTargets(editing)
    if (targets.length > 1) return this._commitFill(targets, value)
    const target = targets[0]
    const change = target && this._classifyEdit(target.ref, target.col, value)
    if (change) this.dispatchEvent(new CustomEvent(change.event, { detail: change.detail, bubbles: true, composed: true }))
  }

  // What a value does to one cell: stage a draft cell, stage/clear a result edit,
  // or nothing when it matches the current value.
  private _classifyEdit(ref: RowRef, col: number, value: CellInput): { event: string; detail: Record<string, unknown> } | null {
    if (ref.kind === 'draft') {
      const current = this.drafts[ref.index]?.cells[col]
      return current !== null && current !== undefined && sameInput(value, current)
        ? null
        : { event: 'draft-edit', detail: { index: ref.index, col, value } }
    }
    if (this.run.phase !== 'done') return null
    const original = this._shownResult()?.rows[ref.row]?.[col]
    const originalInput: CellInput = original === null || original === undefined ? SQL_NULL : formatCell(original)
    const pending = this.edits.get(`${ref.row}:${col}`)
    const current = pending ?? originalInput
    if (sameInput(value, current)) return null
    if (pending !== undefined && sameInput(value, originalInput)) return { event: 'cell-edit-clear', detail: { row: ref.row, col } }
    return { event: 'cell-edit', detail: { row: ref.row, col, value } }
  }

  // Bundles every changed cell of a fill into one event so the owner stages them
  // in a single undoable step.
  private _commitFill(targets: Array<{ ref: RowRef; col: number }>, value: CellInput) {
    this._commitValues(targets.map((target) => ({ ...target, value })))
  }

  private _commitValues(targets: Array<{ ref: RowRef; col: number; value: CellInput }>) {
    const edits: Array<{ row: number; col: number; value: CellInput }> = []
    const clears: Array<{ row: number; col: number }> = []
    const draftCells: Array<{ index: number; col: number; value: CellInput }> = []
    for (const { ref, col, value } of targets) {
      const change = this._classifyEdit(ref, col, value)
      if (!change) continue
      if (change.event === 'draft-edit') draftCells.push(change.detail as { index: number; col: number; value: CellInput })
      else if (change.event === 'cell-edit-clear') clears.push(change.detail as { row: number; col: number })
      else edits.push(change.detail as { row: number; col: number; value: CellInput })
    }
    if (edits.length || clears.length || draftCells.length) {
      this.dispatchEvent(new CustomEvent('cells-fill', { detail: { edits, clears, draftCells }, bubbles: true, composed: true }))
    }
  }

  private _editCellText(ref: RowRef, col: number): string {
    if (ref.kind === 'draft') {
      const value = this.drafts[ref.index]?.cells[col]
      return value === null || value === undefined || isSqlNull(value) ? '' : value
    }
    if (this.run.phase !== 'done') return ''
    const original = this._shownResult()?.rows[ref.row]?.[col]
    const originalText = original === null || original === undefined ? '' : formatCell(original)
    const pending = this.edits.get(`${ref.row}:${col}`)
    return pending === undefined ? originalText : inputText(pending)
  }

  // The cells a commit writes to: the whole snapshotted selection (fill), or just
  // the edited cell when there was no multi-cell selection.
  private _editTargets(editing: { ref: RowRef; col: number; sel: { r0: number; c0: number; r1: number; c1: number } | null }) {
    const s = editing.sel
    if (!s) return [{ ref: editing.ref, col: editing.col }]
    const { order } = this._display()
    const r0 = Math.max(0, Math.min(s.r0, s.r1))
    const r1 = Math.min(order.length - 1, Math.max(s.r0, s.r1))
    const c0 = Math.min(s.c0, s.c1)
    const c1 = Math.max(s.c0, s.c1)
    const targets: Array<{ ref: RowRef; col: number }> = []
    for (let d = r0; d <= r1; d += 1) {
      const ref = order[d]
      if (!ref) continue
      for (let c = c0; c <= c1; c += 1) targets.push({ ref, col: c })
    }
    return targets
  }

  // Clicking away commits the staged value (a safe local change, like leaving a
  // spreadsheet cell). The snapshotted selection makes the fill correct even
  // though a click may have already moved the live selection.
  private _onEditBlur = (event: FocusEvent) => {
    this._commitEdit(event.target as HTMLInputElement)
  }

  private _status() {
    if (this._draining) {
      return html`${t('results.preparing', {
        done: formatInteger(this._draining.done),
        total: formatInteger(this._draining.total),
      })}`
    }
    if (this.run.phase !== 'done') return ''
    const result = this._shownResult()
    if (!result) return ''
    const buffered = result.bufferedRowCount
    // A safe server SELECT is stopped at the buffer cap, so its observed count
    // is a lower bound ("N+ rows"). Scripts that must drain may know the total.
    const totalKnown = result.rowCountExact !== false && (!result.truncated || buffered === undefined || result.rowCount > buffered)
    const rows = totalKnown
      ? `${formatInteger(result.rowCount)} ${rowWord(result.rowCount)}`
      : `${formatInteger(buffered ?? result.rows.length)}+ ${t('results.rows')}`
    // Only a result past the buffer cap is partial; everything else is fully
    // scrollable (paged in on demand), so no "showing first N" caveat.
    const capped =
      result.truncated && totalKnown && buffered !== undefined
        ? ` · ${t('results.loadedPrefix', { count: formatInteger(buffered) })}`
        : ''
    const pace = result.durationMs < 500 ? 'fast' : result.durationMs < 2000 ? 'medium' : 'slow'
    return html`${rows}${capped} · <span class="duration ${pace}">${Math.max(1, Math.round(result.durationMs))} ms</span>`
  }

  private _renderBody() {
    const run = this.run
    if (run.phase === 'idle') {
      return html`<p class="hint">${t('results.idle', { shortcut: isMac ? '⌘↵' : 'Ctrl+↵' })}</p>`
    }
    if (run.phase === 'running') {
      // A note means connecting, which has no backend to cancel yet.
      const cancellable = !run.note && this.canCancel
      return html`
        <p class="hint">
          <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
          ${run.note ?? t('results.running')}
          ${cancellable ? html`<button class="stop" @click=${this._cancel}>${t('common.stop')}</button>` : ''}
        </p>
      `
    }
    if (run.phase === 'error') {
      return html`<pre class="error">${run.error}</pre>`
    }

    const result = this._shownResult()!
    if (!result.columns.length) {
      return html`<p class="hint">${t('results.affected', {
        count: formatInteger(result.rowCount),
        rows: rowWord(result.rowCount),
      })}</p>`
    }
    if (this._record) return this._renderRecordView()
    // Header sort buttons re-run the query with a driver-built ORDER BY (only
    // when it's a single read statement). The active direction comes from the
    // grid-injected sort, falling back to the query's own ORDER BY before any click.
    const { sortable, current } = this._sortState(result)
    // Measured widths, with any column the user dragged swapped in (reuse the
    // cached array unchanged in the common no-override case).
    const measured = this._columnWidths(result)
    const widths = this._widthOverrides.size ? measured.map((width, index) => this._widthOverrides.get(index) ?? width) : measured
    // table-layout: fixed only engages with a definite width; with width:
    // auto the browser falls back to AUTO layout and the colgroup widths
    // become minimums a long nowrap cell can blow past. min-width: 100% in
    // the CSS still stretches the columns when they underfill the panel.
    const numColWidth = numberColumnWidth(result)
    const viewportWidth = Math.max(0, this._viewportW - 1)
    const baseTableWidth = numColWidth + widths.reduce((sum, width) => sum + width, 0)
    // Stretch the last column to fill the panel only until the user takes over
    // sizing — then their widths are honored exactly (empty space or scroll).
    const fill = !this._widthOverrides.size && widths.length && viewportWidth > baseTableWidth ? viewportWidth - baseTableWidth : 0
    const tableWidth = baseTableWidth + fill
    const displayWidths = fill ? widths.map((width, index) => (index === widths.length - 1 ? width + fill : width)) : widths
    this._colLayout = { numColWidth, widths: displayWidths }
    // Only the visible window of loaded rows is in the DOM; spacer rows above
    // and below stand in for the rest so the scrollbar reflects the full set.
    const { first, last, rowH } = this._window()
    const { resultToDisplay, draftToDisplay } = this._display()
    const colSpan = result.columns.length + 1
    const topPad = first * rowH
    const bottomPad = Math.max(0, (result.rows.length - last) * rowH)
    // Staged rows are interleaved at their anchor (the result row they sit below;
    // -1 = above the first row). A stale anchor past the result clamps to the last
    // row. Only anchors inside the rendered window appear — the rest scroll in.
    const lastRow = result.rows.length - 1
    const draftsByAnchor = new Map<number, Array<{ draft: { cells: Array<CellInput | null> }; index: number }>>()
    this.drafts.forEach((draft, index) => {
      const anchor = draft.after < 0 ? -1 : Math.min(draft.after, lastRow)
      const list = draftsByAnchor.get(anchor) ?? []
      list.push({ draft, index })
      draftsByAnchor.set(anchor, list)
    })
    const draftsAfter = (anchor: number) =>
      (draftsByAnchor.get(anchor) ?? []).map(({ draft, index }) =>
        this._renderDraft(draft.cells, index, draftToDisplay[index] ?? 0, result.columns.length, numColWidth),
      )
    return html`
      <table
        class=${this._resizing ? 'resizing' : ''}
        style="width: ${tableWidth}px"
        tabindex="0"
        @contextmenu=${this._onTableContextMenu}
        @pointerdown=${this._onCellPointerDown}
        @dblclick=${this._onCellDblClick}
        @keydown=${this._onGridKeydown}
        @paste=${this._onGridPaste}
      >
        <colgroup>
          <col style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px" />
          ${displayWidths.map((width) => html`<col style="width: ${width}px" />`)}
        </colgroup>
        <thead>
          <tr>
            <th class="num" style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px">#</th>
            ${result.columns.map((column, col) => this._renderHeader(column, col, sortable, current?.columnIndex === col ? current.direction : null))}
          </tr>
        </thead>
        <tbody>
          ${topPad > 0 ? html`<tr class="spacer" style="height: ${topPad}px"><td colspan=${colSpan}></td></tr>` : ''}
          ${first === 0 ? draftsAfter(-1) : ''}
          ${result.rows.slice(first, last).map((row, i) => {
            const absRow = first + i
            const display = resultToDisplay[absRow] ?? 0
            const editing = this._editing?.ref.kind === 'result' && this._editing.ref.row === absRow ? this._editing : null
            return html`
              <tr data-row=${absRow} class=${absRow % 2 ? 'alt' : ''}>
                <td class="num" style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px">${absRow + 1}</td>
                ${row.map((cell, col) => {
                  const sel = this._isSelectedDisplay(display, col) ? 'selected' : ''
                  const original = cell === null || cell === undefined ? '' : formatCell(cell)
                  const pending = this.edits.get(`${absRow}:${col}`)
                  const cls = `${sel}${pending !== undefined ? ' dirty' : ''}`
                  if (editing && editing.col === col) {
                    const value = editing.seed ?? (pending === undefined ? original : inputText(pending))
                    return html`<td class=${cls}>
                      <input
                        class="cell-edit"
                        .value=${value}
                        @keydown=${this._onEditKeydown}
                        @blur=${this._onEditBlur}
                      />
                    </td>`
                  }
                  if (pending !== undefined) {
                    if (isSqlNull(pending)) return html`<td class=${cls}><span class="null">NULL</span></td>`
                    return pending === '' ? html`<td class=${cls}></td>` : html`<td class=${cls} title=${pending}>${pending}</td>`
                  }
                  if (cell === null || cell === undefined) return html`<td class=${sel}><span class="null">NULL</span></td>`
                  return html`<td class=${sel} title=${original}>${original}</td>`
                })}
              </tr>
              ${draftsAfter(absRow)}
            `
          })}
          ${bottomPad > 0 ? html`<tr class="spacer" style="height: ${bottomPad}px"><td colspan=${colSpan}></td></tr>` : ''}
        </tbody>
      </table>
    `
  }

  // A column header with an optional sort button. The button shows the active
  // direction when this column is sorted; clicking it opens a sort-only menu
  // (Ascending / Descending / Clear). Sorting is also in the right-click menu.
  private _renderHeader(column: string, col: number, sortable: boolean, dir: SortDir | null) {
    // A thin grip on the header's right edge, dragged to resize the column;
    // double-click restores the measured width.
    const grip = html`<span
      class="col-resize"
      @pointerdown=${(event: PointerEvent) => this._onColResizeStart(event, col)}
      @dblclick=${(event: MouseEvent) => this._onColResizeReset(event, col)}
    ></span>`
    if (!sortable) {
      return html`<th><div class="th-inner"><span class="th-name" title=${column}>${column}</span></div>${grip}</th>`
    }
    const next = t(dir === 'asc' ? 'results.descending' : dir === 'desc' ? 'results.unsorted' : 'results.ascending')
    return html`
      <th class=${dir ? 'sorted' : ''}>
        <div class="th-inner">
          <span class="th-name" title=${column}>${column}</span>
          <button
            class="th-sort ${dir ? 'active' : ''}"
            title=${t('results.sortTitle', { column, direction: next })}
            aria-label=${t('results.sortColumn', { column, direction: next })}
            @click=${(event: MouseEvent) => this._openSortMenu(event, col)}
          >
            <i class="codicon codicon-${dir === 'desc' ? 'arrow-down' : 'arrow-up'}" aria-hidden="true"></i>
          </button>
        </div>
        ${grip}
      </th>
    `
  }

  // Drag handle: start tracking from the column's current rendered width. Freeze
  // and persist wait for real movement (_onColResizeMove), so a click is a no-op.
  private _onColResizeStart(event: PointerEvent, col: number) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation() // not a cell selection
    const startWidth = this._colLayout?.widths[col] ?? this._widthOverrides.get(col) ?? MIN_COL_WIDTH
    this._resizing = { col, startX: event.clientX, startWidth, moved: false }
    window.addEventListener('pointermove', this._onColResizeMove)
    window.addEventListener('pointerup', this._endColResize)
    window.addEventListener('pointercancel', this._endColResize)
  }

  private _onColResizeMove = (event: PointerEvent) => {
    const resizing = this._resizing
    if (!resizing) return
    const dx = event.clientX - resizing.startX
    if (!resizing.moved && Math.abs(dx) < RESIZE_DRAG_THRESHOLD) return
    if (!resizing.moved) {
      resizing.moved = true
      // First real movement: freeze every column at its rendered width (which
      // includes the last column's fill) so turning off auto-fill can't jump them.
      if (!this._widthOverrides.size && this._colLayout) {
        this._colLayout.widths.forEach((width, index) => {
          if (width > 0) this._widthOverrides.set(index, Math.round(width))
        })
      }
    }
    const width = Math.max(MIN_COL_WIDTH, Math.round(resizing.startWidth + dx))
    this._widthOverrides.set(resizing.col, width)
    this.requestUpdate()
  }

  // Always tears down the window listeners (even after a mid-drag refresh nulled
  // _resizing, and on disconnect), and persists only when a real drag happened.
  private _endColResize = () => {
    const resizing = this._resizing
    this._resizing = null
    window.removeEventListener('pointermove', this._onColResizeMove)
    window.removeEventListener('pointerup', this._endColResize)
    window.removeEventListener('pointercancel', this._endColResize)
    if (resizing?.moved) this._persistWidths()
  }

  // Double-click the grip to drop this column back to its measured width.
  private _onColResizeReset(event: MouseEvent, col: number) {
    event.preventDefault()
    event.stopPropagation()
    if (!this._widthOverrides.delete(col)) return
    this.requestUpdate()
    this._persistWidths()
  }

  // Hands the current widths to the owner so they persist per tab; the owner
  // tags them with the result's columns and feeds them back via `columnWidths`.
  private _persistWidths() {
    this.dispatchEvent(
      new CustomEvent('resize-columns', {
        detail: { widths: [...this._widthOverrides.entries()] },
        bubbles: true,
        composed: true,
      }),
    )
  }

  // Whether the query can be re-sorted, and its active single-column sort: the
  // grid-injected sort, else the query's own ORDER BY parsed from the SQL.
  private _sortState(result: QueryResult): { sortable: boolean; current: QuerySort | null } {
    const sql = this.run.phase === 'done' ? this.run.sql : undefined
    const sortable = !!sql && isReorderableQuery(sql)
    let current: QuerySort | null = sortable ? this.sort : null
    if (!current && sortable && sql) {
      const parsed = activeSort(sql, result.columns)
      if (parsed) current = { columnIndex: parsed.index, direction: parsed.dir }
    }
    return { sortable, current }
  }

  // Left-click a header: open a sort-only menu anchored under the sort button.
  private _openSortMenu(event: MouseEvent, col: number) {
    if (this.run.phase !== 'done') return
    if (this._shownResult()?.columns[col] === undefined) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    this._menu = { x: rect.left, y: rect.bottom + 2, row: -1, col, sortOnly: true }
  }

  // Sets an explicit sort direction (or clears it) for the context-menu picks,
  // then asks the owner to rewrite + re-run the query.
  private _setSort(col: number, direction: SortDir | null) {
    if (this.run.phase !== 'done') return
    if (this._shownResult()?.columns[col] === undefined) return
    this.dispatchEvent(new CustomEvent<SortColumnDetail>('sort-column', { detail: { columnIndex: col, direction }, bubbles: true, composed: true }))
  }

  // A staged new row interleaved at its anchor: highlighted, with a discard
  // button in the # column. Edited like a result cell, but commits to the draft.
  private _renderDraft(cells: Array<CellInput | null>, index: number, display: number, columnCount: number, numColWidth: number) {
    const editing = this._editing?.ref.kind === 'draft' && this._editing.ref.index === index ? this._editing : null
    return html`
      <tr class="draft" data-draft=${index}>
        <td class="num draft-num" style="width: ${numColWidth}px; min-width: ${numColWidth}px; max-width: ${numColWidth}px">
          <button class="draft-remove" title=${t('results.discardNewRow')} aria-label=${t('results.discardNewRow')} @click=${() => this._removeDraft([index])}>
            <i class="codicon codicon-close" aria-hidden="true"></i>
          </button>
        </td>
        ${Array.from({ length: columnCount }, (_, col) => {
          const value = cells[col] ?? null
          const sel = this._isSelectedDisplay(display, col) ? 'draft-sel' : ''
          if (editing && editing.col === col) {
            const initial = editing.seed ?? (value === null || isSqlNull(value) ? '' : value)
            return html`<td class=${sel}>
              <input class="cell-edit" .value=${initial} @keydown=${this._onEditKeydown} @blur=${this._onEditBlur} />
            </td>`
          }
          if (value === null) return html`<td class=${sel}></td>`
          if (isSqlNull(value)) return html`<td class=${sel}><span class="null">NULL</span></td>`
          if (value === '') return html`<td class=${sel}></td>`
          return html`<td class=${sel} title=${value}>${value}</td>`
        })}
      </tr>
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
        position: relative;
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
        position: relative;
        display: inline-flex;
        flex-shrink: 0;
        padding: 3px;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .head-action[data-tooltip]::after,
      .filter-action[data-tooltip]::after {
        content: attr(data-tooltip);
        position: absolute;
        top: calc(100% + 7px);
        left: 50%;
        z-index: 20;
        padding: 5px 7px;
        color: var(--text);
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        font-weight: 400;
        letter-spacing: normal;
        line-height: 1.25;
        text-transform: none;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transform: translate(-50%, -2px);
        transition: opacity 80ms ease, visibility 0s linear 80ms, transform 80ms ease;
      }

      .head-action[data-tooltip]:hover::after,
      .head-action[data-tooltip]:focus-visible::after,
      .filter-action[data-tooltip]:hover::after,
      .filter-action[data-tooltip]:focus-visible::after {
        opacity: 1;
        visibility: visible;
        transform: translate(-50%, 0);
        transition-delay: 400ms;
      }

      .head > .head-action[data-tooltip]::after {
        right: 0;
        left: auto;
        transform: translateY(-2px);
      }

      .head > .head-action[data-tooltip]:hover::after,
      .head > .head-action[data-tooltip]:focus-visible::after {
        transform: translateY(0);
      }

      .head-action:hover:not(:disabled) {
        color: var(--text);
        background: var(--list-hover);
      }

      .head-action.active {
        color: var(--text);
        background: var(--list-selection);
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

      .filter-bar {
        height: 34px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 8px 0 12px;
        background: var(--header-bg);
        border-bottom: 1px solid var(--border-subtle);
        color: var(--text-3);
      }

      .filter-input {
        flex: 1;
        min-width: 0;
        height: 24px;
      }

      .filter-apply,
      .filter-clear {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        padding: 0;
        color: var(--btn-secondary-fg);
        background: var(--btn-secondary-bg);
        border: none;
        border-radius: 3px;
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        cursor: pointer;
        --codicon-size: 14px;
      }

      .filter-apply:not(:disabled):hover,
      .filter-clear:not(:disabled):hover {
        background: var(--btn-secondary-hover);
      }

      .filter-apply:disabled,
      .filter-clear:disabled {
        opacity: 0.45;
        cursor: default;
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
        font-family: var(--mono-font);
        font-size: 12px;
        color: var(--status-dot-error);
        white-space: pre-wrap;
      }

      /* Reference-style grid: fixed layout with measured colgroup widths,
         uppercase UI-font headers, mono cells, zebra rows, row hover. */
      table {
        border-collapse: collapse;
        table-layout: fixed;
        font-family: var(--ui-font);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        /* Selection is cell-based (drag a rectangle); suppress native text
           selection, which spans whole rows. */
        user-select: none;
      }

      table:focus {
        outline: none;
      }

      th,
      td {
        box-sizing: border-box;
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
        color: var(--tab-inactive-fg);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      th.sorted {
        color: var(--text);
      }

      .th-inner {
        display: flex;
        align-items: center;
        min-width: 0;
      }

      /* Reserve room for the pinned arrow only on the sorted column, so other
         headers keep their full label width. */
      th.sorted .th-inner {
        padding-right: 18px;
      }

      .th-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Pinned to the header's right edge (the sticky th is the containing
         block); hidden until the header is hovered, except when this column is
         sorted. The header-bg fill hides the label end it overlays. */
      .th-sort {
        position: absolute;
        top: 50%;
        right: 6px;
        transform: translateY(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        color: var(--text-3);
        background: var(--header-bg);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        opacity: 0;
        --codicon-size: 12px;
      }

      th:hover .th-sort,
      .th-sort.active {
        opacity: 1;
      }

      .th-sort:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      .th-sort.active {
        color: var(--accent);
      }

      /* A grab strip on the header's inner right edge (kept inside the th, which
         clips overflow for the label ellipsis). The visible 2px bar lights up on
         hover; while a drag is in flight the whole table shows the resize cursor. */
      .col-resize {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 2;
        width: 8px;
        height: 100%;
        cursor: col-resize;
        touch-action: none;
      }

      .col-resize::after {
        content: '';
        position: absolute;
        top: 0;
        right: 0;
        width: 2px;
        height: 100%;
        background: transparent;
      }

      .col-resize:hover::after {
        background: var(--accent);
      }

      /* Keep the resize cursor over the whole grid while a drag is in flight,
         even as the pointer strays off the 7px grip. */
      table.resizing,
      table.resizing th,
      table.resizing td {
        cursor: col-resize;
      }

      td {
        color: var(--editor-fg);
        line-height: 18px;
      }

      /* Pin every content cell to one height (with border-box, so it includes
         padding + the 1px separator) so rows are identical whether their cells
         hold text, NULL, or nothing — an empty <td> has no line box, so content
         alone sizes rows unevenly and throws off the windowing, which measures
         one row and assumes the rest match. Spacer cells are excluded so the
         windowing keeps their exact inline heights. */
      tbody tr:not(.spacer) td {
        height: 25px;
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
      tbody tr:not(.spacer) td:not(.num):not(.selected):not(.draft-sel):hover {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
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

      /* Staged changes use dark theme-blended tints, not raw status colors, so
         they read as pending state without glowing against the grid. */
      tbody tr td.dirty {
        background: var(--staged-edit-bg);
        color: var(--staged-edit-fg);
      }

      tbody tr td.dirty:hover:not(.selected) {
        background: var(--staged-edit-hover-bg);
      }

      /* Cell selection — wins over zebra striping, cell hover, and dirty tint. */
      tbody tr td.selected,
      tbody tr:hover td.selected {
        background: var(--grid-selection-bg);
        color: var(--text);
      }

      tbody tr td.dirty.selected,
      tbody tr:hover td.dirty.selected {
        background: var(--staged-edit-selection-bg);
        color: var(--staged-edit-fg);
      }

      /* Focus replaces selection while the inline editor is open. */
      tbody tr td.selected:has(.cell-edit),
      tbody tr:hover td.selected:has(.cell-edit) {
        background: var(--editor-bg);
      }

      tbody tr td.dirty.selected:has(.cell-edit),
      tbody tr:hover td.dirty.selected:has(.cell-edit) {
        background: var(--staged-edit-bg);
      }

      /* Unsaved new rows: a low-contrast insert tint until saved. The hover rule
         below sits after the generic cell hover so it wins at equal specificity. */
      tbody tr.draft td {
        background: var(--staged-add-bg);
        color: var(--staged-add-fg);
      }

      tbody tr.draft:hover td:not(.num) {
        background: var(--staged-add-hover-bg);
      }

      /* The anchored draft cell — after the draft rules so it wins at equal specificity. */
      tbody tr.draft td.draft-sel,
      tbody tr.draft:hover td.draft-sel {
        background: var(--staged-add-selection-bg);
        color: var(--staged-add-fg);
      }

      tbody tr.draft td.draft-sel:has(.cell-edit),
      tbody tr.draft:hover td.draft-sel:has(.cell-edit) {
        background: var(--staged-add-bg);
      }

      td.draft-num {
        padding: 0;
        box-shadow: inset 2px 0 0 color-mix(in srgb, var(--staged-add-fg) 45%, transparent);
      }

      /* The button fills the # cell and flex-centers the ✕, so it's centered both
         axes regardless of the icon font's baseline metrics (an inline button
         would sit slightly high). */
      .draft-remove {
        display: flex;
        width: 100%;
        height: 100%;
        align-items: center;
        justify-content: center;
        padding: 0;
        color: var(--text-3);
        background: transparent;
        border: none;
        cursor: pointer;
        --codicon-size: 12px;
      }

      .draft-remove:hover {
        color: var(--status-dot-error);
        background: var(--list-hover);
      }

      .record-view {
        display: flex;
        width: 100%;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        background: var(--editor-bg);
        outline: none;
      }

      .record-grid {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        overflow: auto;
        font-family: var(--ui-font);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }

      .record-field {
        display: grid;
        grid-template-columns: var(--record-column-w) minmax(0, 1fr);
        min-height: 25px;
        border-bottom: 1px solid var(--grid-border);
      }

      .record-field.active {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }

      .record-field.dirty-record {
        background: var(--staged-edit-bg);
        color: var(--staged-edit-fg);
      }

      .record-field.active.dirty-record {
        background: var(--staged-edit-selection-bg);
        color: var(--staged-edit-fg);
      }

      .record-column {
        min-width: 0;
        min-height: 25px;
        box-sizing: border-box;
        padding: 3px 10px;
        color: var(--text);
        font: inherit;
        line-height: 18px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-right: 1px solid var(--grid-border);
      }

      .record-value {
        width: 100%;
        min-width: 0;
        height: 25px;
        min-height: 25px;
        box-sizing: border-box;
        margin: 0;
        padding: 3px 10px;
        color: var(--text);
        background: transparent;
        border: 0;
        font: inherit;
        line-height: 18px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        resize: vertical;
        outline: none;
      }

      .record-value::placeholder {
        color: var(--text-3);
        font-style: italic;
      }

      textarea.record-value:focus {
        background: var(--input-bg);
        box-shadow: inset 0 0 0 1px var(--focus-border);
      }

      textarea.record-value:read-only {
        color: var(--text-3);
        resize: none;
        cursor: default;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'results-panel': ResultsPanel
  }
}
