// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SQL_NULL } from '../sql-write'
import './results-panel'
import type { SqlExpressionEditor } from './sql-expression-editor'

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: (text: string) => ({ width: text.length * 8 }) }),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

async function mount() {
  const el = document.createElement('results-panel')
  el.editable = true
  el.rowEditable = true
  el.run = {
    phase: 'done',
    result: {
      columns: ['editable', 'readonly'],
      rows: [['old', 'locked']],
      rowCount: 1,
      durationMs: 1,
    },
  }
  document.body.append(el)
  await el.updateComplete
  return el
}

// A grid with `n` two-column result rows, editable, for nav/selection tests.
async function mountGrid(n: number) {
  const el = document.createElement('results-panel')
  el.editable = true
  el.rowEditable = true
  el.run = {
    phase: 'done',
    result: {
      columns: ['a', 'b'],
      rows: Array.from({ length: n }, (_, i) => [`a${i}`, `b${i}`]),
      rowCount: n,
      durationMs: 1,
    },
  }
  document.body.append(el)
  await el.updateComplete
  return el
}

const key = (el: HTMLElement, init: KeyboardEventInit) =>
  el.shadowRoot!.querySelector('table')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))

describe('results-panel editability', () => {
  it('opens inline editing for any result cell', async () => {
    const el = await mount()
    const cells = el.shadowRoot!.querySelectorAll<HTMLTableCellElement>('tbody tr[data-row] td:not(.num)')

    cells[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')?.value).toBe('locked')

    cells[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')?.value).toBe('old')
    el.remove()
  })

  it('opens result-cell editing even when row actions are unavailable', async () => {
    const el = await mount()
    el.rowEditable = false
    await el.updateComplete

    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tbody tr[data-row] td:not(.num)')!
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete

    expect(el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')?.value).toBe('old')
    el.remove()
  })

  it('clears a staged edit when edited back to the original value', async () => {
    const el = await mount()
    el.edits = new Map([['0:0', 'changed']])
    await el.updateComplete
    const cellEdit = vi.fn()
    const clearEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)
    el.addEventListener('cell-edit-clear', clearEdit)

    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tbody tr[data-row] td.dirty')!
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!
    input.value = 'old'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(clearEdit).toHaveBeenCalledOnce()
    expect((clearEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 0 })
    expect(cellEdit).not.toHaveBeenCalled()
    el.remove()
  })
})

describe('results-panel multiple and paged results', () => {
  it('lets the user inspect each result set and keeps earlier sets read-only', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      result: {
        columns: ['second'], rows: [[2]], rowCount: 1, durationMs: 1,
        resultSets: [
          { columns: ['first'], rows: [[1]], rowCount: 1 },
          { columns: ['second'], rows: [[2]], rowCount: 1 },
        ],
      },
    }
    document.body.append(el)
    await el.updateComplete

    const select = el.shadowRoot!.querySelector('ui-select.result-set-select' as 'ui-select')!
    expect(select).toBeTruthy()
    select.value = '0'
    select.dispatchEvent(new CustomEvent('change', { detail: { value: '0' } }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('thead th:not(.num)')?.textContent).toContain('first')

    el.shadowRoot!.querySelector<HTMLTableCellElement>('tbody td:not(.num)')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.cell-edit')).toBeNull()
    el.remove()
  })

  it('drops dragged widths on other result sets but re-adopts saved widths on the last', async () => {
    const el = document.createElement('results-panel')
    el.columnWidths = new Map([[0, 321]])
    el.run = {
      phase: 'done',
      result: {
        columns: ['second'],
        rows: [[2]],
        rowCount: 1,
        durationMs: 1,
        resultSets: [
          { columns: ['first'], rows: [[1]], rowCount: 1 },
          { columns: ['second'], rows: [[2]], rowCount: 1 },
        ],
      },
    }
    document.body.append(el)
    await el.updateComplete
    const internal = el as unknown as { _widthOverrides: Map<number, number> }
    expect(internal._widthOverrides.get(0)).toBe(321)

    const select = el.shadowRoot!.querySelector('ui-select.result-set-select' as 'ui-select')!
    select.value = '0'
    select.dispatchEvent(new CustomEvent('change', { detail: { value: '0' } }))
    await el.updateComplete
    expect(internal._widthOverrides.size).toBe(0)

    select.value = '1'
    select.dispatchEvent(new CustomEvent('change', { detail: { value: '1' } }))
    await el.updateComplete
    expect(internal._widthOverrides.get(0)).toBe(321)
    el.remove()
  })

  it('drains the full export in large pages, retrying when a page comes back short', async () => {
    const all = Array.from({ length: 450 }, (_, index) => [index])
    // First page returns short of the requested limit (the main process caps
    // pages by bytes); the loop must continue from where it left off.
    const fetchRows = vi.fn((_session: string, offset: number, limit: number) =>
      Promise.resolve({ success: true as const, rows: all.slice(offset, offset + Math.min(limit, 300)) }),
    )
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { fetchRows }
    const el = document.createElement('results-panel')
    const internal = el as unknown as {
      _allRows(result: { columns: string[]; rows: unknown[][]; rowCount: number; durationMs: number; sessionId: string; bufferedRowCount: number }, limit: number): Promise<unknown[][]>
    }
    const rows = await internal._allRows(
      { columns: ['n'], rows: all.slice(0, 200), rowCount: 450, durationMs: 1, sessionId: 's1', bufferedRowCount: 450 },
      450,
    )
    expect(rows).toHaveLength(450)
    expect(fetchRows).toHaveBeenCalledTimes(2)
    expect(fetchRows).toHaveBeenNthCalledWith(1, 's1', 0, 450)
    expect(fetchRows).toHaveBeenNthCalledWith(2, 's1', 300, 150)
  })
})

describe('results-panel has no collapse control of its own', () => {
  // Hiding the panel is the status bar's toggle (and ⌘J) only — the panel used to
  // carry a duplicate chevron, and the owner now sets display:none rather than
  // shrinking the host to its toolbar.
  it('renders no results-panel show/hide button', async () => {
    const el = await mount()
    const buttons = [...el.shadowRoot!.querySelectorAll('button')]
    expect(buttons.some((b) => /results panel/i.test(b.getAttribute('aria-label') ?? ''))).toBe(false)
    expect(el.shadowRoot!.querySelector('[class*="chevron-down"], [class*="chevron-up"]')).toBeNull()
    el.remove()
  })

  it('keeps the filter bar reachable without a collapsed state', async () => {
    // The filter bar used to be suppressed by `collapsed`; that property is gone,
    // so opening the filter must still show it.
    const el = await mount()
    expect((el as unknown as Record<string, unknown>).collapsed).toBeUndefined()
    el.remove()
  })
})
describe('results-panel draft rows', () => {
  async function mountWithDrafts(cellRows: Array<Array<string | null>>, after = -1) {
    const el = await mount()
    el.rowEditable = true
    el.drafts = cellRows.map((cells) => ({ after, cells }))
    await el.updateComplete
    return el
  }

  it('renders highlighted draft rows below the result', async () => {
    const el = await mountWithDrafts([['new', null]])
    const draftRow = el.shadowRoot!.querySelector('tr.draft[data-draft="0"]')
    expect(draftRow).toBeTruthy()
    expect(draftRow!.querySelector('.draft-remove')).toBeTruthy()
    el.remove()
  })

  it('edits a draft cell to a draft-edit event, not a cell-edit', async () => {
    const el = await mountWithDrafts([[null, null]])
    const cellEdit = vi.fn()
    const draftEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)
    el.addEventListener('draft-edit', draftEdit)

    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr.draft td:not(.num)')!
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!
    input.value = 'Zoe'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(draftEdit).toHaveBeenCalledOnce()
    expect((draftEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ index: 0, col: 0, value: 'Zoe' })
    expect(cellEdit).not.toHaveBeenCalled()
    el.remove()
  })

  it('selects cell (0,0) by default and anchors a new row below it', async () => {
    const el = await mount()
    el.rowEditable = true
    await el.updateComplete
    // Default selection lands on the first result cell.
    expect(el.shadowRoot!.querySelector('tbody tr[data-row="0"] td.selected')).toBeTruthy()

    const addRow = vi.fn()
    el.addEventListener('add-row', addRow)
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Add new row"]')!.click()
    // The selected result row is row 0, so the new row anchors below it (after: 0).
    expect((addRow.mock.calls[0]![0] as CustomEvent).detail.after).toBe(0)
    el.remove()
  })

  it('inserts the next new row below the selected draft', async () => {
    const el = await mountWithDrafts([['a', null], ['b', null], ['c', null]])
    const addRow = vi.fn()
    el.addEventListener('add-row', addRow)

    // Select the first draft row, then add: the new row goes directly below it.
    const firstDraftCell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr.draft[data-draft="0"] td:not(.num)')!
    firstDraftCell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Add new row"]')!.click()

    // Same anchor as the selected draft, spliced right after it in the array.
    expect((addRow.mock.calls[0]![0] as CustomEvent).detail).toEqual({ after: -1, index: 1 })
    el.remove()
  })

  it('duplicates selected result rows into prefilled drafts with every column value', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      result: {
        columns: ['id', 'name', 'meta'],
        rows: [[1, null, 'admin']],
        rowCount: 1,
        durationMs: 1,
      },
    }
    el.edits = new Map([['0:0', '2']])
    document.body.append(el)
    await el.updateComplete
    const duplicate = vi.fn()
    el.addEventListener('duplicate-rows', duplicate)

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Duplicate selected rows"]')!.click()

    expect(duplicate).toHaveBeenCalledOnce()
    expect((duplicate.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      drafts: [{ after: 0, cells: ['2', SQL_NULL, 'admin'] }],
    })
    el.remove()
  })

  it('stages an explicit NULL for the selection from the context menu', async () => {
    const el = await mountGrid(2)
    const fill = vi.fn()
    el.addEventListener('cells-fill', fill)

    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="0"] td:nth-child(2)')!
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    const menu = el.shadowRoot!.querySelector('context-menu')!
    expect(menu.items).toContainEqual(expect.objectContaining({ id: 'view-record', shortcut: 'Tab' }))
    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'set-null' } }))

    expect(fill).toHaveBeenCalledOnce()
    const detail = (fill.mock.calls[0]![0] as CustomEvent).detail as { edits: Array<{ row: number; col: number; value: unknown }> }
    expect(detail.edits).toEqual([{ row: 0, col: 0, value: SQL_NULL }])
    el.remove()
  })

  it('copies a whole row on Copy Row without moving the selection', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountGrid(2)
    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td:nth-child(2)')!
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete

    el.shadowRoot!.querySelector('context-menu')!.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'copy-row' } }))
    await el.updateComplete

    expect(writeClipboardText).toHaveBeenCalledWith('a1\tb1')
    // Both columns were copied, but only the right-clicked cell stays highlighted.
    expect(el.shadowRoot!.querySelectorAll('tr[data-row="1"] td.selected')).toHaveLength(1)
    expect(el.shadowRoot!.querySelectorAll('tr[data-row="0"] td.selected')).toHaveLength(0)
    el.remove()
  })

  it('copies a row as an INSERT naming the result source table', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountGrid(2)
    el.insertTable = { schema: 'public', name: 'users', kind: 'table' }
    await el.updateComplete
    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td:nth-child(2)')!
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('context-menu')!.items).toContainEqual(
      expect.objectContaining({ id: 'copy-insert', label: 'Copy Row as INSERT' }),
    )

    el.shadowRoot!.querySelector('context-menu')!.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'copy-insert' } }))
    await el.updateComplete

    expect(writeClipboardText).toHaveBeenCalledWith(
      'INSERT INTO "public"."users" ("a", "b")\n' + `VALUES ('a1', 'b1');\n`,
    )
    // The copy took the whole row but left the right-clicked cell selected —
    // widening the highlight would read as the grid moving on its own.
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(1)
    el.remove()
  })

  // A partial column selection still yields whole rows: an INSERT missing a
  // row's other columns is not a statement worth emitting.
  it('widens a column selection to whole rows when copying as INSERT', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountGrid(2)
    key(el, { key: 'ArrowRight' })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td:nth-child(3)')!
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('context-menu')!.items).toContainEqual(
      expect.objectContaining({ id: 'copy-insert', label: 'Copy Selected Rows as INSERT' }),
    )

    el.shadowRoot!.querySelector('context-menu')!.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'copy-insert' } }))
    await el.updateComplete

    // No source table: the statement names the placeholder for the user to replace.
    expect(writeClipboardText).toHaveBeenCalledWith(
      'INSERT INTO "table_name" ("a", "b")\n' + `VALUES ('a0', 'b0'),\n       ('a1', 'b1');\n`,
    )
    // Both rows were copied in full, yet the one-column selection is intact.
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(2)
    el.remove()
  })

  it('copies every selected row when Copy Row is chosen inside a multi-row selection', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountGrid(3)
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    const selectedCell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td:nth-child(2)')!
    selectedCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('context-menu')!.items).toContainEqual(
      expect.objectContaining({ id: 'copy-row', label: 'Copy Selected Rows' }),
    )

    el.shadowRoot!.querySelector('context-menu')!.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'copy-row' } }))
    await el.updateComplete

    expect(writeClipboardText).toHaveBeenCalledWith('a0\tb0\na1\tb1')
    // Every column of both rows was copied; the column selection is left as it was.
    expect(el.shadowRoot!.querySelectorAll('tr[data-row="0"] td.selected')).toHaveLength(1)
    expect(el.shadowRoot!.querySelectorAll('tr[data-row="1"] td.selected')).toHaveLength(1)
    el.remove()
  })

  it('selects the whole row when its number cell opens the context menu', async () => {
    const el = await mountGrid(2)
    const rowNumber = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td.num')!

    rowNumber.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete

    expect(el.shadowRoot!.querySelectorAll('tr[data-row="1"] td.selected')).toHaveLength(2)
    el.remove()
  })

  it('offers explicit sort directions from a column header context menu', async () => {
    const el = document.createElement('results-panel')
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: { columns: ['a', 'b'], rows: [['a0', 'b0']], rowCount: 1, durationMs: 1 },
    }
    document.body.append(el)
    await el.updateComplete
    const sorted = vi.fn()
    el.addEventListener('sort-column', (e) => {
      sorted((e as CustomEvent<{ columnIndex: number; direction: string | null }>).detail)
    })

    const header = el.shadowRoot!.querySelectorAll<HTMLTableCellElement>('thead th:not(.num)')[1]!
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete

    const menu = el.shadowRoot!.querySelector('context-menu')!
    expect(menu.items.map((i) => i.id).slice(0, 3)).toEqual(['sort-asc', 'sort-desc', 'sort-clear'])
    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'sort-desc' } }))
    expect(sorted).toHaveBeenCalledWith({ columnIndex: 1, direction: 'desc' })
    el.remove()
  })

  it('opens a sort-only menu when a header sort button is left-clicked', async () => {
    const el = document.createElement('results-panel')
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: { columns: ['a', 'b'], rows: [['a0', 'b0']], rowCount: 1, durationMs: 1 },
    }
    document.body.append(el)
    await el.updateComplete
    const sorted = vi.fn()
    el.addEventListener('sort-column', (e) => {
      sorted((e as CustomEvent<{ columnIndex: number; direction: string | null }>).detail)
    })

    el.shadowRoot!.querySelectorAll<HTMLButtonElement>('thead th:not(.num) .th-sort')[0]!.click()
    await el.updateComplete

    const menu = el.shadowRoot!.querySelector('context-menu')!
    expect(menu.items.map((i) => i.id)).toEqual(['sort-asc', 'sort-desc', 'sort-clear'])
    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'sort-asc' } }))
    expect(sorted).toHaveBeenCalledWith({ columnIndex: 0, direction: 'asc' })
    el.remove()
  })

  it('refuses to duplicate rows with structured values and disables it for truncated results', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      result: { columns: ['payload'], rows: [[{ nested: true }]], rowCount: 1, durationMs: 1 },
    }
    document.body.append(el)
    await el.updateComplete
    const duplicate = vi.fn()
    const notice = vi.fn()
    el.addEventListener('duplicate-rows', duplicate)
    el.addEventListener('grid-notice', notice)

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Duplicate selected rows"]')!.click()
    expect(duplicate).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledOnce()

    el.run = { phase: 'done', result: { columns: ['value'], rows: [['partial']], rowCount: 1, durationMs: 1, truncated: true } }
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Duplicate selected rows"]')!.disabled).toBe(true)
    el.remove()
  })

  it('stacks every duplicate below the last selected row in selection order', async () => {
    const el = await mountGrid(3)
    const duplicate = vi.fn()
    el.addEventListener('duplicate-rows', duplicate)

    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Duplicate selected rows"]')!.click()

    expect((duplicate.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      drafts: [
        { after: 2, cells: ['a0', 'b0'] },
        { after: 2, cells: ['a1', 'b1'] },
        { after: 2, cells: ['a2', 'b2'] },
      ],
    })
    el.remove()
  })

  it('duplicates the selection on Cmd/Ctrl+D', async () => {
    const el = await mountGrid(3)
    const duplicate = vi.fn()
    el.addEventListener('duplicate-rows', duplicate)

    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    key(el, { key: 'd', metaKey: true })

    expect((duplicate.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      drafts: [
        { after: 1, cells: ['a0', 'b0'] },
        { after: 1, cells: ['a1', 'b1'] },
      ],
    })
    el.remove()
  })

  it('ignores Cmd/Ctrl+D when rows are not editable', async () => {
    const el = await mountGrid(2)
    el.rowEditable = false
    await el.updateComplete
    const duplicate = vi.fn()
    el.addEventListener('duplicate-rows', duplicate)

    key(el, { key: 'd', metaKey: true })

    expect(duplicate).not.toHaveBeenCalled()
    el.remove()
  })

  it('disables Save until a draft or edit exists and emits save-rows on click', async () => {
    const el = await mount()
    el.rowEditable = true
    // No staged changes yet — start from a clean slate.
    el.drafts = []
    el.edits = new Map()
    await el.updateComplete
    const saveButton = () => el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Save changes"]')!
    expect(saveButton().disabled).toBe(true)

    el.drafts = [{ after: -1, cells: ['x', null] }]
    await el.updateComplete
    expect(saveButton().disabled).toBe(false)

    const saveRows = vi.fn()
    el.addEventListener('save-rows', saveRows)
    saveButton().click()
    expect(saveRows).toHaveBeenCalledOnce()
    el.remove()
  })

  it('a staged edit enables Save and shows the pending value (dirty)', async () => {
    const el = await mount()
    el.edits = new Map([['0:0', 'changed']])
    await el.updateComplete
    const dirty = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="0"] td.dirty')
    expect(dirty?.textContent).toContain('changed')
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Save changes"]')!.disabled).toBe(false)
    el.remove()
  })

  it('shows save/discard for pending cell edits even when row actions are unavailable', async () => {
    const el = await mount()
    el.rowEditable = false
    el.edits = new Map([['0:0', 'changed']])
    await el.updateComplete

    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Save changes"]')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Add new row"]')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Delete selected rows"]')).toBeNull()
    el.remove()
  })

  it('type-to-edit on a multi-cell selection fills the whole selection in one batch', async () => {
    const el = await mountGrid(3)
    const fills: Array<{ edits: unknown[]; clears: unknown[]; draftCells: unknown[] }> = []
    const perCell = vi.fn()
    el.addEventListener('cells-fill', (e) => fills.push((e as CustomEvent<{ edits: unknown[]; clears: unknown[]; draftCells: unknown[] }>).detail))
    el.addEventListener('cell-edit', perCell)

    // Select column 0 of rows 0..2 (anchor at top), then type — fills all three.
    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    key(el, { key: 'X' })
    await el.updateComplete
    // The editor opened on the first (top) cell, seeded with the char.
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!
    expect(input.closest('tr')!.getAttribute('data-row')).toBe('0')
    expect(input.value).toBe('X')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // One batch event covers the whole fill (not one per-cell event).
    expect(perCell).not.toHaveBeenCalled()
    expect(fills).toHaveLength(1)
    expect(fills[0]).toEqual({
      edits: [
        { row: 0, col: 0, value: 'X' },
        { row: 1, col: 0, value: 'X' },
        { row: 2, col: 0, value: 'X' },
      ],
      clears: [],
      draftCells: [],
    })
    el.remove()
  })

  it('copies the displayed cell through the desktop clipboard', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountGrid(2)
    el.edits = new Map([['0:0', 'pending value']])
    await el.updateComplete

    key(el, { key: 'c', metaKey: true })

    expect(writeClipboardText).toHaveBeenCalledWith('pending value')
    el.remove()
  })

  it('pastes a TSV rectangle from the selected cell in one batch', async () => {
    const el = await mountGrid(3)
    const fill = vi.fn()
    el.addEventListener('cells-fill', fill)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => type === 'text/plain' ? 'x\ty\nz\tw' : '' },
    })

    el.shadowRoot!.querySelector('table')!.dispatchEvent(paste)

    expect(paste.defaultPrevented).toBe(true)
    expect((fill.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      edits: [
        { row: 0, col: 0, value: 'x' },
        { row: 0, col: 1, value: 'y' },
        { row: 1, col: 0, value: 'z' },
        { row: 1, col: 1, value: 'w' },
      ],
      clears: [],
      draftCells: [],
    })
    el.remove()
  })

  it('pastes one value across the current selection', async () => {
    const el = await mountGrid(3)
    const fill = vi.fn()
    el.addEventListener('cells-fill', fill)
    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'same' } })

    el.shadowRoot!.querySelector('table')!.dispatchEvent(paste)

    expect((fill.mock.calls[0]?.[0] as CustomEvent).detail.edits).toEqual([
      { row: 0, col: 0, value: 'same' },
      { row: 1, col: 0, value: 'same' },
      { row: 2, col: 0, value: 'same' },
    ])
    el.remove()
  })

  it('pressing Enter on an unchanged editor does not fill a multi-cell selection', async () => {
    const el = await mountGrid(3)
    const cellEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)

    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    key(el, { key: 'Enter' })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!
    expect(input.value).toBe('a0')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(cellEdit).not.toHaveBeenCalled()
    el.remove()
  })

  it('the discard button emits discard-changes when something is staged', async () => {
    const el = await mountGrid(2)
    el.edits = new Map([['0:0', 'x']])
    await el.updateComplete
    const discard = vi.fn()
    el.addEventListener('discard-changes', discard)
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Discard changes"]')!.click()
    expect(discard).toHaveBeenCalledOnce()
    el.remove()
  })

  it('double-Esc discards staged changes; a single Esc (or one interrupted) does not', async () => {
    const el = await mountGrid(2)
    el.edits = new Map([['0:0', 'x']])
    await el.updateComplete
    const discard = vi.fn()
    el.addEventListener('discard-changes', discard)

    key(el, { key: 'Escape' }) // arms
    expect(discard).not.toHaveBeenCalled()
    key(el, { key: 'ArrowDown' }) // disarms
    key(el, { key: 'Escape' }) // arms again, but alone
    expect(discard).not.toHaveBeenCalled()
    key(el, { key: 'Escape' }) // second in a row → fires
    expect(discard).toHaveBeenCalledOnce()
    el.remove()
  })
})

describe('results-panel DBeaver-style editing', () => {
  it('type-to-edit opens the editor seeded with the typed character', async () => {
    const el = await mount() // editable, (0,0) selected by default
    key(el, { key: 'Z' })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!
    expect(input.value).toBe('Z')

    const cellEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect((cellEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 0, value: 'Z' })
    el.remove()
  })

  it('arrow keys move the selected cell', async () => {
    const el = await mountGrid(3)
    const selected = () => el.shadowRoot!.querySelector('td.selected')?.closest('tr')?.getAttribute('data-row')
    expect(selected()).toBe('0')
    key(el, { key: 'ArrowDown' })
    await el.updateComplete
    expect(selected()).toBe('1')
    key(el, { key: 'ArrowRight' })
    await el.updateComplete
    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('td.selected')!
    expect(cell.closest('tr')!.getAttribute('data-row')).toBe('1')
    expect(cell.cellIndex).toBe(2) // # column shifts data cols right by one
    el.remove()
  })

  it('shift+arrow extends one selection across result and new rows', async () => {
    const el = await mountGrid(2)
    el.drafts = [{ after: 0, cells: [null, null] }] // a new row below result row 0
    await el.updateComplete
    // Display order: result0 (0), draft (1), result1 (2). Extend from result0 into the draft.
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('tr[data-row="0"] td.selected')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('tr.draft td.draft-sel')).toBeTruthy()
    el.remove()
  })

  it('Tab on a selected cell opens a record view for the focused row', async () => {
    const el = await mountGrid(3)
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')).toBeNull()
    key(el, { key: 'ArrowDown' }) // focus row 1
    key(el, { key: 'ArrowRight' }) // focus column b
    await el.updateComplete

    key(el, { key: 'Tab' })
    await el.updateComplete

    const record = el.shadowRoot!.querySelector<HTMLElement>('.record-view')!
    expect(record).toBeTruthy()
    expect(el.shadowRoot!.querySelector('table')).toBeNull()
    expect(record.textContent).toContain('Row #2')
    const header = record.querySelectorAll('.record-field')[0]!
    expect(header.querySelector('.record-column')?.textContent).toBe('')
    expect(header.querySelector('.record-value')?.textContent).toBe('Row #2')
    expect(record.textContent).toContain('a')
    expect(record.textContent).toContain('b')
    expect([...record.querySelectorAll<HTMLTextAreaElement>('textarea.record-value')].map((input) => input.value)).toEqual(['a1', 'b1'])
    expect(record.querySelectorAll('.record-field')[2]?.classList.contains('active')).toBe(true)

    record.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
    el.remove()
  })

  it('the result toolbar List and Grid buttons switch result views', async () => {
    const el = await mountGrid(2)

    const listButton = el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!
    expect(listButton.dataset.tooltip).toBe('List view (Tab)')
    expect(listButton.title).toBe('')
    listButton.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')).toBeNull()
    const gridButton = el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!
    expect(gridButton.dataset.tooltip).toBe('Grid view (Tab)')

    gridButton.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')).toBeTruthy()
    el.remove()
  })

  it('opens a condition-only filter field and emits apply/clear requests', async () => {
    const el = await mountGrid(2)
    if (el.run.phase !== 'done') throw new Error('Expected a completed result')
    el.run = { phase: 'done', result: el.run.result, sql: 'SELECT a, b FROM sample' }
    const applied = vi.fn()
    el.addEventListener('filter-condition', applied)
    await el.updateComplete

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Filter results"]')!.click()
    await el.updateComplete
    const editor = el.shadowRoot!.querySelector<SqlExpressionEditor>('.filter-input')!
    expect(editor.placeholderText).toContain('Filter condition')
    expect(editor.placeholderText).not.toMatch(/^WHERE/i)
    expect(editor.columns).toEqual(['a', 'b'])
    expect(editor.engine).toBe('postgresql')
    expect(el.shadowRoot!.querySelector('.filter-apply .icon-check')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.filter-clear .icon-x')).toBeTruthy()

    editor.dispatchEvent(new CustomEvent('expression-change', {
      detail: { value: "a = 'a1'" },
      bubbles: true,
    }))
    editor.dispatchEvent(new CustomEvent('expression-submit', { bubbles: true, cancelable: true }))
    expect(applied.mock.calls[0]?.[0].detail).toEqual({ condition: "a = 'a1'" })

    el.filter = "a = 'a1'"
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('.filter-clear')!.click()
    expect(applied.mock.calls[1]?.[0].detail).toEqual({ condition: null })
    el.remove()
  })

  it('keeps the active filter available on a query error', async () => {
    const el = document.createElement('results-panel')
    el.filter = 'missing_column = 1'
    el.run = { phase: 'error', error: 'column does not exist', sql: 'SELECT * FROM sample' }
    document.body.append(el)
    await el.updateComplete

    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Filter results"]')).toBeTruthy()
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Filter results"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<SqlExpressionEditor>('.filter-input')?.value).toBe('missing_column = 1')
    el.remove()
  })

  it('record view sizes the column-name lane from the longest column name', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      result: {
        columns: ['id', 'very_long_column_name'],
        rows: [[1, 'Ada']],
        rowCount: 1,
        durationMs: 1,
      },
    }
    document.body.append(el)
    await el.updateComplete

    key(el, { key: 'Tab' })
    await el.updateComplete

    expect(el.shadowRoot!.querySelector<HTMLElement>('.record-view')!.getAttribute('style')).toContain('--record-column-w: 196px')
    el.remove()
  })

  it('record view value edits stage cell changes', async () => {
    const el = await mountGrid(2)
    const cellEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)

    key(el, { key: 'Tab' })
    await el.updateComplete
    const firstValue = el.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea.record-value')!
    firstValue.value = 'changed'
    firstValue.dispatchEvent(new FocusEvent('blur'))

    expect(cellEdit).toHaveBeenCalledOnce()
    expect((cellEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 0, value: 'changed' })
    el.remove()
  })

  it('delete on a mixed selection stages result rows and discards drafts', async () => {
    const el = await mountGrid(2)
    el.drafts = [{ after: 0, cells: [null, null] }]
    await el.updateComplete
    const stageDelete = vi.fn()
    const draftRemove = vi.fn()
    el.addEventListener('stage-delete', stageDelete)
    el.addEventListener('draft-remove', draftRemove)

    key(el, { key: 'ArrowDown', shiftKey: true }) // result row 0 + the draft
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Delete selected rows"]')!.click()

    // Result rows are staged for deletion (run on save), not deleted immediately.
    expect((stageDelete.mock.calls[0]![0] as CustomEvent).detail).toEqual({ rows: [0], remove: false })
    expect((draftRemove.mock.calls[0]![0] as CustomEvent).detail).toEqual({ indexes: [0] })
    el.remove()
  })

  it('reselects only the surviving result rows after a mixed delete drops drafts', async () => {
    const el = await mountGrid(4)
    // 3 duplicated rows anchored under result row 0.
    el.drafts = [
      { after: 0, cells: ['x', 'y'] },
      { after: 0, cells: ['x', 'y'] },
      { after: 0, cells: ['x', 'y'] },
    ]
    await el.updateComplete

    // Select result row 0 + the 3 drafts (display rows 0-3).
    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Delete selected rows"]')!.click()

    // The owner stages row 0 and drops the drafts.
    el.pendingDeletes = new Set([0])
    el.drafts = []
    await el.updateComplete

    // Only result row 0 stays selected — the selection must not slide onto rows 1-3.
    expect(el.shadowRoot!.querySelector('tr[data-row="0"] td.selected')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('tr[data-row="1"] td.selected')).toBeNull()
    expect(el.shadowRoot!.querySelector('tr[data-row="3"] td.selected')).toBeNull()
    el.remove()
  })

  it('renders a result row staged for deletion with the deleting style', async () => {
    const el = await mountGrid(2)
    el.pendingDeletes = new Set([0])
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('tr[data-row="0"]')!.classList.contains('deleting')).toBe(true)
    el.remove()
  })
})

describe('results-panel column resize', () => {
  // The first <col> is the # column; the rest map to data columns.
  const dataCols = (el: HTMLElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>('colgroup col')].slice(1)

  it('renders a resize grip per data column', async () => {
    const el = await mountGrid(3)
    expect(el.shadowRoot!.querySelectorAll('.col-resize')).toHaveLength(2) // 2 data columns
    el.remove()
  })

  it('widens a column as its grip is dragged, and stops auto-filling', async () => {
    const el = await mountGrid(2)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!
    const startWidth = parseFloat(dataCols(el)[0]!.style.width)

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 160 }))
    await el.updateComplete

    // Dragged 60px to the right → the frozen start width grows by 60.
    expect(parseFloat(dataCols(el)[0]!.style.width)).toBe(startWidth + 60)
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    el.remove()
  })

  it('clamps a column to a minimum width when dragged far left', async () => {
    const el = await mountGrid(2)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 300 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0 }))
    await el.updateComplete

    expect(parseFloat(dataCols(el)[0]!.style.width)).toBe(48) // MIN_COL_WIDTH
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    el.remove()
  })

  it('treats a grip click (sub-threshold nudge) as a no-op, not a resize', async () => {
    const el = await mountGrid(2)
    const resized = vi.fn()
    el.addEventListener('resize-columns', resized)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!
    const startWidth = parseFloat(dataCols(el)[0]!.style.width)

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 101 })) // 1px, below threshold
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    await el.updateComplete

    // Nothing frozen and nothing persisted, so auto-fill stays available.
    expect(resized).not.toHaveBeenCalled()
    expect(parseFloat(dataCols(el)[0]!.style.width)).toBe(startWidth)
    el.remove()
  })

  it('restores the measured width on double-clicking the grip', async () => {
    const el = await mountGrid(2)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!
    const startWidth = parseFloat(dataCols(el)[0]!.style.width)

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }))
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    await el.updateComplete
    expect(parseFloat(dataCols(el)[0]!.style.width)).not.toBe(startWidth)

    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(parseFloat(dataCols(el)[0]!.style.width)).toBe(startWidth)
    el.remove()
  })

  it('re-measures from scratch when a new result has no persisted widths', async () => {
    const el = await mountGrid(2)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!
    const startWidth = parseFloat(dataCols(el)[0]!.style.width)

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }))
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    await el.updateComplete
    expect(parseFloat(dataCols(el)[0]!.style.width)).not.toBe(startWidth)

    // A fresh result with no adopted widths (columnWidths prop still empty).
    el.run = { phase: 'done', result: { columns: ['a', 'b'], rows: [['a0', 'b0']], rowCount: 1, durationMs: 1 } }
    await el.updateComplete
    expect(parseFloat(dataCols(el)[0]!.style.width)).toBe(startWidth)
    el.remove()
  })

  it('emits resize-columns so the owner can persist dragged widths', async () => {
    const el = await mountGrid(2)
    const resized = vi.fn()
    el.addEventListener('resize-columns', resized)
    const grip = el.shadowRoot!.querySelectorAll<HTMLElement>('.col-resize')[0]!

    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 160 }))
    window.dispatchEvent(new PointerEvent('pointerup', {}))

    expect(resized).toHaveBeenCalledOnce()
    const { widths } = (resized.mock.calls[0]![0] as CustomEvent<{ widths: Array<[number, number]> }>).detail
    // Freeze-all captures every column (2); the dragged one grew by the 60px drag.
    const map = new Map(widths)
    expect(map.size).toBe(2)
    const startWidth = 60 // the measured width mountGrid renders for these cells
    expect(map.get(0)).toBe(startWidth + 60)
    el.remove()
  })

  it('adopts persisted widths from the columnWidths prop when a result loads', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.columnWidths = new Map([[0, 240]])
    el.run = { phase: 'done', result: { columns: ['a', 'b'], rows: [['a0', 'b0']], rowCount: 1, durationMs: 1 } }
    document.body.append(el)
    await el.updateComplete

    const cols = [...el.shadowRoot!.querySelectorAll<HTMLElement>('colgroup col')].slice(1)
    expect(parseFloat(cols[0]!.style.width)).toBe(240)
    el.remove()
  })
})

describe('results-panel keyboard scroll-into-view', () => {
  // jsdom has no layout, so fake a narrow viewport with writable scroll offsets.
  const fakeViewport = (el: HTMLElement, height = 400, headerHeight = 0) => {
    const body = el.shadowRoot!.querySelector<HTMLElement>('.body')!
    const header = el.shadowRoot!.querySelector<HTMLElement>('thead')!
    const state = { left: 0, top: 0 }
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 50 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: height })
    Object.defineProperty(body, 'scrollLeft', { configurable: true, get: () => state.left, set: (v: number) => (state.left = v) })
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => state.top, set: (v: number) => (state.top = v) })
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: headerHeight })
    return state
  }

  it('keeps vertical keyboard navigation clear of the sticky header', async () => {
    const el = await mountGrid(3)
    const view = fakeViewport(el, 50, 25)

    key(el, { key: 'ArrowDown' })
    expect(view.top).toBe(25)

    key(el, { key: 'ArrowUp' })
    expect(view.top).toBe(0)
    el.remove()
  })

  it('scrolls right to keep the selected column in view (ArrowRight)', async () => {
    const el = await mountGrid(1) // 2 columns, wider than the faked 50px viewport
    const view = fakeViewport(el)

    key(el, { key: 'ArrowRight' }) // col 0 → col 1, off to the right
    await el.updateComplete
    expect(view.left).toBeGreaterThan(0)
    el.remove()
  })

  it('scrolls back left when the selection returns to an earlier column', async () => {
    const el = await mountGrid(1)
    const view = fakeViewport(el)

    key(el, { key: 'ArrowRight' })
    const scrolledRight = view.left
    expect(scrolledRight).toBeGreaterThan(0)

    key(el, { key: 'ArrowLeft' }) // back to col 0
    await el.updateComplete
    expect(view.left).toBeLessThan(scrolledRight)
    el.remove()
  })
})

// The head's old static "RESULTS" label conveyed nothing. It now shows the query
// that produced the visible result, which matters once a result can come from
// following a foreign key rather than from the editor's own SQL.
describe('results-panel query info', () => {
  const mountWithSql = async (sql?: string, params?: unknown[]) => {
    const el = document.createElement('results-panel')
    el.run = sql === undefined
      ? { phase: 'idle' }
      : { phase: 'done', sql, ...(params ? { params } : {}), result: { columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 1 } }
    document.body.append(el)
    await el.updateComplete
    return el
  }
  const head = (el: HTMLElement) => el.shadowRoot!.querySelector('.head')!

  it('falls back to the plain label when no query is known', async () => {
    const el = await mountWithSql()
    expect(head(el).textContent).toContain('Results')
    expect(el.shadowRoot!.querySelector('.query-info')).toBeNull()
  })

  it('keeps the head to the affordance alone, with the statement in the popover', async () => {
    const el = await mountWithSql('SELECT * FROM customers WHERE id = 42')
    const button = el.shadowRoot!.querySelector('.query-info')!
    // No inline preview: the icon is the whole control.
    expect(button.textContent?.trim()).toBe('')
    expect(button.querySelector('.icon-code')).not.toBeNull()
  })

  // A followed foreign key runs a bound query, so the raw text carries a marker
  // where the value belongs. Showing "= ?" tells the user nothing about which row
  // they are looking at.
  it('substitutes bound values so the statement reads as what was run', async () => {
    const el = await mountWithSql('SELECT * FROM `customers` WHERE `id` = ? LIMIT 200', [3])
    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete

    expect(el.shadowRoot!.querySelector('.query-pop-sql')?.textContent)
      .toBe('SELECT * FROM `customers` WHERE `id` = 3 LIMIT 200')
  })

  it('substitutes the numbered and named markers the other engines bind with', async () => {
    for (const [sql, expected] of [
      ['SELECT * FROM t WHERE id = $1 LIMIT 200', 'SELECT * FROM t WHERE id = 42 LIMIT 200'],
      ['SELECT TOP 200 * FROM t WHERE id = @p1', 'SELECT TOP 200 * FROM t WHERE id = 42'],
    ] as const) {
      const el = await mountWithSql(sql, [42])
      el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
      await el.updateComplete
      expect(el.shadowRoot!.querySelector('.query-pop-sql')?.textContent).toBe(expected)
      el.remove()
    }
  })

  it('quotes a substituted string and renders a null key as NULL', async () => {
    const el = await mountWithSql('SELECT * FROM t WHERE code = ? AND parent = ?', ["O'Hara", null])
    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop-sql')?.textContent)
      .toBe("SELECT * FROM t WHERE code = 'O''Hara' AND parent = NULL")
  })

  it('colours keywords and string literals in the popover', async () => {
    const el = await mountWithSql("SELECT * FROM customers WHERE name = 'Ada'")
    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete

    const pop = el.shadowRoot!.querySelector('.query-pop-sql')!
    const keywords = [...pop.querySelectorAll('.keyword')].map((node) => node.textContent)
    expect(keywords).toContain('SELECT')
    expect(keywords).toContain('FROM')
    expect(keywords).toContain('WHERE')
    expect([...pop.querySelectorAll('.string')].map((node) => node.textContent)).toEqual(["'Ada'"])
    // Colouring must not alter the statement itself.
    expect(pop.textContent).toBe("SELECT * FROM customers WHERE name = 'Ada'")
  })

  it('reveals the full query in a popover, and closes on a second click', async () => {
    const sql = 'SELECT *\nFROM customers\nWHERE id = 42'
    const el = await mountWithSql(sql)
    expect(el.shadowRoot!.querySelector('.query-pop')).toBeNull()

    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete
    // The popover keeps the original formatting, unlike the collapsed head line.
    expect(el.shadowRoot!.querySelector('.query-pop-sql')?.textContent).toBe(sql)

    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop')).toBeNull()
  })

  it('closes when a different result takes over, instead of reattaching to it', async () => {
    const el = await mountWithSql('SELECT 1')
    el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop')).not.toBeNull()

    el.run = { phase: 'done', sql: 'SELECT 2', result: { columns: ['id'], rows: [[2]], rowCount: 1, durationMs: 1 } }
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop')).toBeNull()
    el.remove()
  })

  it('closes on the backdrop and on Escape, and leaves no window listener behind', async () => {
    const el = await mountWithSql('SELECT 1')
    const open = () => el.shadowRoot!.querySelector<HTMLButtonElement>('.query-info')!.click()

    open()
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLElement>('.pop-backdrop')!.dispatchEvent(new MouseEvent('mousedown'))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop')).toBeNull()

    open()
    await el.updateComplete
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.query-pop')).toBeNull()

    // Escape after teardown must not reach a detached panel.
    open()
    await el.updateComplete
    el.remove()
    expect(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow()
  })
})

// Back/forward only exist once a tab has a trail, so an untravelled tab keeps a
// clean toolbar. The panel does not own the trail: it asks its owner to step.
describe('results-panel result navigation', () => {
  const mountNav = async (canGoBack: boolean, canGoForward: boolean) => {
    const el = document.createElement('results-panel')
    el.run = { phase: 'done', sql: 'SELECT 1', result: { columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 1 } }
    el.canGoBack = canGoBack
    el.canGoForward = canGoForward
    document.body.append(el)
    await el.updateComplete
    return el
  }
  const navButtons = (el: HTMLElement) =>
    [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('[aria-label^="Back to"], [aria-label^="Forward to"]')]

  it('hides both buttons when there is nowhere to go', async () => {
    expect(navButtons(await mountNav(false, false))).toHaveLength(0)
  })

  it('shows both, disabling the direction that leads nowhere', async () => {
    const el = await mountNav(true, false)
    const [back, forward] = navButtons(el)
    expect(back?.disabled).toBe(false)
    expect(forward?.disabled).toBe(true)
  })

  it('asks the owner to step rather than stepping itself', async () => {
    const el = await mountNav(true, true)
    const directions: string[] = []
    el.addEventListener('result-navigate', (event) =>
      directions.push((event as CustomEvent<{ direction: string }>).detail.direction))

    const [back, forward] = navButtons(el)
    back!.click()
    forward!.click()
    expect(directions).toEqual(['back', 'forward'])
  })
})

// The affordance appears only on cells the owner marked followable, and asks the
// owner to navigate rather than acting on its own.
describe('results-panel foreign-key affordance', () => {
  const target = { schema: 'public', table: 'authors', column: 'id', constraint: 'fk' }

  const mountFk = async (over: { foreignKeys?: Map<number, typeof target>; edits?: Map<string, string> } = {}) => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.run = {
      phase: 'done',
      sql: 'SELECT title, author_id FROM books',
      result: { columns: ['title', 'author_id'], rows: [['Dune', 7], ['Emma', null]], rowCount: 2, durationMs: 1 },
    }
    el.foreignKeys = over.foreignKeys ?? new Map([[1, target]])
    if (over.edits) el.edits = over.edits
    document.body.append(el)
    await el.updateComplete
    return el
  }
  const followButtons = (el: HTMLElement) => [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.fk-follow')]

  it('marks only the followable column, and skips its null cells', async () => {
    const el = await mountFk()
    // Row 0 has a value; row 1 is NULL and references nothing.
    expect(followButtons(el)).toHaveLength(1)
    const cell = el.shadowRoot!.querySelector('td.fk')
    expect(cell?.querySelector('.fk-value')?.textContent).toBe('7')
  })

  it('offers nothing when no column is followable', async () => {
    expect(followButtons(await mountFk({ foreignKeys: new Map() }))).toHaveLength(0)
  })

  it('names the referenced table and column so the destination is knowable', async () => {
    const el = await mountFk()
    expect(followButtons(el)[0]?.getAttribute('aria-label')).toContain('authors')
    expect(followButtons(el)[0]?.getAttribute('aria-label')).toContain('id')
  })

  it('asks the owner to follow, reporting the cell it came from', async () => {
    const el = await mountFk()
    const seen: Array<{ row: number; col: number }> = []
    el.addEventListener('follow-foreign-key', (event) =>
      seen.push((event as CustomEvent<{ row: number; col: number }>).detail))

    followButtons(el)[0]!.click()
    expect(seen).toEqual([{ row: 0, col: 1 }])
  })

  // A staged value is not in the database yet, so following it would look up a
  // row that does not exist.
  it('withdraws the affordance while an edit is staged on the cell', async () => {
    const el = await mountFk({ edits: new Map([['0:1', '99']]) })
    expect(followButtons(el)).toHaveLength(0)
  })

  it('leaves cells of non-followable columns structurally untouched', async () => {
    const el = await mountFk()
    const cells = [...el.shadowRoot!.querySelectorAll('tbody tr[data-row="0"] td')]
    // The title cell keeps its plain text node, with no wrapper span.
    expect(cells[1]?.querySelector('.fk-value')).toBeNull()
    expect(cells[1]?.textContent).toBe('Dune')
  })
})
