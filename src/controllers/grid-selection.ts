import type { ReactiveController, ReactiveControllerHost } from 'lit'
import { cellsToTsv } from '../result-export'

/** Selected rectangle in grid space: anchor (r0,c0) → focus (r1,c1). A single
 * cell when anchor === focus. Either corner may hold the larger index, so every
 * read normalizes with min/max rather than assuming an order. */
export type GridRect = { r0: number; c0: number; r1: number; c1: number }

export type GridCoords = { row: number; col: number }

/** What a host tells the controller about its table. Rows and columns are plain
 * indices: what a row *means* stays with the host — a result row, an
 * interleaved draft, a plan node — so nothing table-specific reaches here. */
export type GridSource = {
  rowCount: () => number
  colCount: () => number
  columnNames: () => string[]
  /** One cell's value for copy. The only projection the controller needs, and
   * the reason it can serve tables that share no row model. */
  valueAt: (row: number, col: number) => unknown
}

/** The row index the controller reads back off a rendered row. Set by whoever
 * renders the <tr>, which is the grid component. */
export const GRID_ROW_ATTR = 'data-grid-row'

/** Rectangle selection for a table: press, drag, keyboard nav, and copy. Held
 * apart from any one table's cells so the results grid, the execution plan and
 * the inspector can share it — each supplying a GridSource over its own rows.
 *
 * Selection is state the host renders from, so every mutation requests a host
 * update: unlike an @state() field there is no automatic reactivity here, and a
 * missed request shows up as a selection that copies correctly but never
 * repaints. */
export class GridSelectionController implements ReactiveController {
  private readonly host: ReactiveControllerHost
  private readonly source: GridSource
  private _rect: GridRect | null = null
  private _dragging = false

  /** Called with the focused cell after a keyboard move, so the host can keep
   * it in view — the controller has no scroll container of its own. */
  onFocusMove?: (coords: GridCoords) => void

  constructor(host: ReactiveControllerHost, source: GridSource) {
    this.host = host
    this.source = source
    host.addController(this)
  }

  hostDisconnected() {
    this.endDrag()
  }

  get rect(): GridRect | null {
    return this._rect
  }

  set rect(next: GridRect | null) {
    this._rect = next
    this.host.requestUpdate()
  }

  get dragging(): boolean {
    return this._dragging
  }

  clear() {
    if (this._rect === null) return
    this.rect = null
  }

  /** Collapses the selection onto one cell. */
  select(row: number, col: number) {
    this.rect = { r0: row, c0: col, r1: row, c1: col }
  }

  isSelected(row: number, col: number): boolean {
    const rect = this._rect
    if (!rect) return false
    return (
      row >= Math.min(rect.r0, rect.r1) &&
      row <= Math.max(rect.r0, rect.r1) &&
      col >= Math.min(rect.c0, rect.c1) &&
      col <= Math.max(rect.c0, rect.c1)
    )
  }

  /** The focus corner — where keyboard moves start and an edit opens. */
  get focus(): GridCoords | null {
    return this._rect ? { row: this._rect.r1, col: this._rect.c1 } : null
  }

  /** The cell a DOM node sits in, or null for the row-number column, a header,
   * or a windowing spacer. Two independent guards reject the row-number cell:
   * its own class, and the negative column index its cellIndex produces. Both
   * are kept — either alone holds the behavior, which is why a single slip here
   * has never become a bug. */
  cellAt(node: Element | null): GridCoords | null {
    const cell = node?.closest<HTMLTableCellElement>('td')
    if (!cell || cell.classList.contains('num')) return null
    const tr = cell.closest('tr')
    const col = cell.cellIndex - 1
    if (!tr || col < 0) return null
    const row = tr.getAttribute(GRID_ROW_ATTR)
    if (row === null) return null
    return { row: Number(row), col }
  }

  /** Starts a selection or extends one, and reports the cell pressed so the
   * host can act on it too. Returns null when the press missed a cell, so a
   * host can leave the event alone. */
  pointerDown(event: PointerEvent): GridCoords | null {
    if (event.button !== 0) return null // leave right-click to the context menu
    const hit = this.cellAt(event.target as Element)
    if (!hit) return null

    // Shift-click extends the rectangle from the anchor; a plain press starts a
    // drag. Both just set the rect — only the rendered rows repaint, so it's cheap.
    if (event.shiftKey && this._rect) {
      this.rect = { ...this._rect, r1: hit.row, c1: hit.col }
      return hit
    }
    this.select(hit.row, hit.col)
    this._dragging = true
    window.addEventListener('pointermove', this._onDragMove)
    window.addEventListener('pointerup', this._onDragEnd)
    window.addEventListener('pointercancel', this._onDragEnd)
    return hit
  }

  /** Resolves the dragged-over cell against a root that can hit-test inside
   * itself — a shadow root sees its own content, a document does not. */
  hitTest: (x: number, y: number) => Element | null = () => null

  private _onDragMove = (event: PointerEvent) => {
    if (!this._dragging || !this._rect) return
    const hit = this.cellAt(this.hitTest(event.clientX, event.clientY))
    if (!hit) return
    if (hit.row === this._rect.r1 && hit.col === this._rect.c1) return
    this.rect = { ...this._rect, r1: hit.row, c1: hit.col }
  }

  private _onDragEnd = () => {
    this.endDrag()
  }

  endDrag() {
    if (!this._dragging) return
    this._dragging = false
    window.removeEventListener('pointermove', this._onDragMove)
    window.removeEventListener('pointerup', this._onDragEnd)
    window.removeEventListener('pointercancel', this._onDragEnd)
  }

  /** Moves the focus cell by (dRow, dCol); without extend the whole selection
   * collapses onto it, with extend the anchor stays and the rectangle grows. */
  moveFocus(dRow: number, dCol: number, extend: boolean) {
    const rect = this._rect
    if (!rect) return
    const rows = this.source.rowCount()
    const cols = this.source.colCount()
    const row = Math.max(0, Math.min(rows - 1, rect.r1 + dRow))
    const col = Math.max(0, Math.min(cols - 1, rect.c1 + dCol))
    this.rect = extend ? { ...rect, r1: row, c1: col } : { r0: row, c0: col, r1: row, c1: col }
    this.onFocusMove?.({ row, col })
  }

  /** One cell horizontally, wrapping to the next or previous row. */
  moveTab(forward: boolean) {
    const rect = this._rect
    if (!rect) return
    const rows = this.source.rowCount()
    const cols = this.source.colCount()
    let row = rect.r1
    let col = rect.c1 + (forward ? 1 : -1)
    if (col >= cols) {
      col = 0
      row = Math.min(rows - 1, row + 1)
    } else if (col < 0) {
      col = cols - 1
      row = Math.max(0, row - 1)
    }
    this.rect = { r0: row, c0: col, r1: row, c1: col }
    this.onFocusMove?.({ row, col })
  }

  /** The values inside a rectangle, clamped to the rows that exist. */
  block(r0: number, r1: number, c0: number, c1: number): { columns: string[]; rows: unknown[][] } {
    const first = Math.max(0, r0)
    const last = Math.min(this.source.rowCount() - 1, r1)
    const rows: unknown[][] = []
    for (let row = first; row <= last; row += 1) {
      const cells: unknown[] = []
      for (let col = c0; col <= c1; col += 1) cells.push(this.source.valueAt(row, col))
      rows.push(cells)
    }
    return { columns: this.source.columnNames().slice(c0, c1 + 1), rows }
  }

  selectedBlock(): { columns: string[]; rows: unknown[][] } | null {
    const rect = this._rect
    if (!rect) return null
    return this.block(
      Math.min(rect.r0, rect.r1),
      Math.max(rect.r0, rect.r1),
      Math.min(rect.c0, rect.c1),
      Math.max(rect.c0, rect.c1),
    )
  }

  /** Copies the selection as TSV. cellsToTsv applies full field escaping: an
   * embedded tab or newline is quoted (stays one cell) and a formula-leading
   * cell is neutralized. */
  copySelection() {
    const block = this.selectedBlock()
    if (!block) return
    void window.sqlkit.writeClipboardText(cellsToTsv(block.rows))
  }

  /** The navigation and copy keys, reporting whether one was taken. A host
   * calls this after its own keys so table-specific bindings — opening an
   * editor, duplicating a row — keep winning over plain movement. */
  handleKeydown(event: KeyboardEvent): boolean {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      this.copySelection()
      return true
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !this._rect) return false
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); this.moveFocus(1, 0, event.shiftKey); return true
      case 'ArrowUp': event.preventDefault(); this.moveFocus(-1, 0, event.shiftKey); return true
      case 'ArrowRight': event.preventDefault(); this.moveFocus(0, 1, event.shiftKey); return true
      case 'ArrowLeft': event.preventDefault(); this.moveFocus(0, -1, event.shiftKey); return true
      default:
        return false
    }
  }
}
