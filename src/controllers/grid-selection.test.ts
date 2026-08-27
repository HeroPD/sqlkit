// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import { GRID_ROW_ATTR, GridSelectionController, type GridSource } from './grid-selection'

const host = (requestUpdate = () => {}): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate, updateComplete: Promise.resolve(true) })

// A 3x2 table of `a0`/`b0`-style values, matching the fixture the results-panel
// selection tests use so the copy output is comparable between the two.
const source = (rows = 3, cols = 2): GridSource => ({
  rowCount: () => rows,
  colCount: () => cols,
  columnNames: () => ['a', 'b'].slice(0, cols),
  valueAt: (row, col) => `${'ab'[col]}${row}`,
})

/** A rendered table the controller can hit-test and read row indices from. */
const table = (rows = 3, cols = 2) => {
  const el = document.createElement('table')
  const body = el.createTBody()
  for (let row = 0; row < rows; row += 1) {
    const tr = body.insertRow()
    tr.setAttribute(GRID_ROW_ATTR, String(row))
    const num = tr.insertCell()
    num.className = 'num'
    num.textContent = String(row + 1)
    for (let col = 0; col < cols; col += 1) tr.insertCell().textContent = `${'ab'[col]}${row}`
  }
  document.body.append(el)
  return el
}

const cell = (el: HTMLTableElement, row: number, col: number) =>
  el.querySelector<HTMLTableCellElement>(`tr[${GRID_ROW_ATTR}="${row}"] td:nth-child(${col + 2})`)!

const press = (target: Element, init: PointerEventInit = {}) =>
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ...init }))

describe('GridSelectionController rectangle', () => {
  it('normalizes a rectangle drawn from either corner', () => {
    const sel = new GridSelectionController(host(), source())
    sel.rect = { r0: 2, c0: 1, r1: 0, c1: 0 }

    for (const [row, col] of [[0, 0], [1, 1], [2, 0]] as const) expect(sel.isSelected(row, col)).toBe(true)
    expect(sel.isSelected(0, 2)).toBe(false)
    expect(sel.isSelected(3, 0)).toBe(false)
  })

  it('reports the focus corner, not the anchor', () => {
    const sel = new GridSelectionController(host(), source())
    sel.rect = { r0: 0, c0: 0, r1: 2, c1: 1 }
    expect(sel.focus).toEqual({ row: 2, col: 1 })
  })

  it('requests a host update on every change, since it holds no reactive state', () => {
    const requestUpdate = vi.fn()
    const sel = new GridSelectionController(host(requestUpdate), source())

    sel.select(1, 1)
    sel.moveFocus(1, 0, false)
    sel.clear()
    expect(requestUpdate).toHaveBeenCalledTimes(3)

    // Already clear: nothing changed, so nothing is asked to repaint.
    sel.clear()
    expect(requestUpdate).toHaveBeenCalledTimes(3)
  })
})

describe('GridSelectionController pointer', () => {
  // Wired the way a host wires it: the controller reads the event's real target.
  const wire = (el: HTMLTableElement, sel: GridSelectionController) => {
    el.addEventListener('pointerdown', (event) => void sel.pointerDown(event))
    return el
  }

  it('selects the pressed cell and extends from the anchor on shift-click', () => {
    const sel = new GridSelectionController(host(), source())
    const el = wire(table(), sel)

    press(cell(el, 0, 0))
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 0, c1: 0 })

    press(cell(el, 2, 1), { shiftKey: true })
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 2, c1: 1 })

    // A plain press afterwards starts over rather than extending again.
    press(cell(el, 1, 1))
    expect(sel.rect).toEqual({ r0: 1, c0: 1, r1: 1, c1: 1 })
    el.remove()
  })

  it('ignores the row-number column and anything outside a cell', () => {
    const sel = new GridSelectionController(host(), source())
    const el = wire(table(), sel)
    press(cell(el, 1, 0))

    expect(sel.cellAt(el)).toBeNull()
    expect(sel.cellAt(null)).toBeNull()
    press(el.querySelector<HTMLTableCellElement>(`tr[${GRID_ROW_ATTR}="2"] td.num`)!)

    // The press missed, so the selection is where it was.
    expect(sel.rect).toEqual({ r0: 1, c0: 0, r1: 1, c1: 0 })
    el.remove()
  })

  it('leaves a right-click to the context menu', () => {
    const sel = new GridSelectionController(host(), source())
    const el = wire(table(), sel)
    press(cell(el, 1, 1), { button: 2 })
    expect(sel.rect).toBeNull()
    el.remove()
  })

  it('extends to the dragged-over cell and stops once the drag ends', () => {
    const sel = new GridSelectionController(host(), source())
    const el = wire(table(), sel)
    sel.hitTest = () => cell(el, 2, 1)

    press(cell(el, 0, 0))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 2, c1: 1 })

    window.dispatchEvent(new PointerEvent('pointerup', {}))
    expect(sel.dragging).toBe(false)
    sel.hitTest = () => cell(el, 1, 0)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 40 }))
    // Teardown held: the post-drag move changed nothing.
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 2, c1: 1 })
    el.remove()
  })

  it('drops its window listeners when the host goes away mid-drag', () => {
    const sel = new GridSelectionController(host(), source())
    const el = wire(table(), sel)
    sel.hitTest = () => cell(el, 2, 1)
    press(cell(el, 0, 0))

    sel.hostDisconnected()
    expect(sel.dragging).toBe(false)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 0, c1: 0 })
    el.remove()
  })
})

describe('GridSelectionController keyboard', () => {
  const move = (sel: GridSelectionController, init: KeyboardEventInit) =>
    sel.handleKeydown(new KeyboardEvent('keydown', { cancelable: true, ...init }))

  it('clamps movement to the table and collapses unless extended', () => {
    const sel = new GridSelectionController(host(), source())
    sel.select(0, 0)

    expect(move(sel, { key: 'ArrowUp' })).toBe(true)
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 0, c1: 0 }) // clamped at the top edge

    move(sel, { key: 'ArrowDown', shiftKey: true })
    move(sel, { key: 'ArrowRight', shiftKey: true })
    expect(sel.rect).toEqual({ r0: 0, c0: 0, r1: 1, c1: 1 }) // anchor kept

    move(sel, { key: 'ArrowDown' })
    expect(sel.rect).toEqual({ r0: 2, c0: 1, r1: 2, c1: 1 }) // collapsed onto the focus
  })

  it('wraps rows on tab movement', () => {
    const sel = new GridSelectionController(host(), source())
    sel.select(0, 1)
    sel.moveTab(true)
    expect(sel.rect).toEqual({ r0: 1, c0: 0, r1: 1, c1: 0 })
    sel.moveTab(false)
    expect(sel.rect).toEqual({ r0: 0, c0: 1, r1: 0, c1: 1 })
  })

  it('reports the focused cell so the host can scroll it into view', () => {
    const onFocusMove = vi.fn()
    const sel = new GridSelectionController(host(), source())
    sel.onFocusMove = onFocusMove
    sel.select(0, 0)
    sel.moveFocus(1, 1, false)
    expect(onFocusMove).toHaveBeenCalledWith({ row: 1, col: 1 })
  })

  it('declines the keys a host binds itself', () => {
    const sel = new GridSelectionController(host(), source())
    sel.select(0, 0)
    for (const init of [{ key: 'Enter' }, { key: 'F2' }, { key: 'Tab' }, { key: 'z' }, { key: 'd', metaKey: true }]) {
      expect(move(sel, init)).toBe(false)
    }
  })
})

describe('GridSelectionController copy', () => {
  it('copies the selected rectangle as escaped TSV', () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const sel = new GridSelectionController(host(), source())
    sel.rect = { r0: 1, c0: 0, r1: 0, c1: 1 } // drawn bottom-up, right-to-left

    expect(sel.handleKeydown(new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true }))).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('a0\tb0\na1\tb1')
  })

  it('clamps a rectangle left over a shorter table', () => {
    const sel = new GridSelectionController(host(), source(2))
    sel.rect = { r0: 0, c0: 0, r1: 9, c1: 0 }
    expect(sel.selectedBlock()).toEqual({ columns: ['a'], rows: [['a0'], ['a1']] })
  })

  it('has nothing to copy with no selection', () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const sel = new GridSelectionController(host(), source())
    expect(sel.selectedBlock()).toBeNull()
    sel.copySelection()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
