// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SQL_NULL } from '../sql-write'
import './results-panel'

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

    const select = el.shadowRoot!.querySelector<HTMLSelectElement>('.result-set-select')!
    expect(select).toBeTruthy()
    select.value = '0'
    select.dispatchEvent(new Event('change'))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('thead th:not(.num)')?.textContent).toContain('first')

    el.shadowRoot!.querySelector<HTMLTableCellElement>('tbody td:not(.num)')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.cell-edit')).toBeNull()
    el.remove()
  })

  it('fetches every page needed for export instead of silently stopping at 200 rows', async () => {
    const all = Array.from({ length: 450 }, (_, index) => [index])
    const fetchRows = vi.fn((_session: string, offset: number, limit: number) =>
      Promise.resolve({ success: true as const, rows: all.slice(offset, offset + limit) }),
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
    expect(fetchRows).toHaveBeenCalledTimes(3)
  })
})

describe('results-panel collapse toggle', () => {
  const collapseButton = (el: HTMLElement) =>
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label$="results panel"]')!

  it('toggles the chevron and dispatches toggle-collapse on click', async () => {
    const el = await mount()
    const toggled = vi.fn()
    el.addEventListener('toggle-collapse', toggled)

    const button = collapseButton(el)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.querySelector('.codicon-chevron-down')).toBeTruthy()

    button.click()
    expect(toggled).toHaveBeenCalledOnce()

    // The owner drives the collapsed state back down; the chevron follows it.
    ;(el as unknown as { collapsed: boolean }).collapsed = true
    await el.updateComplete
    const flipped = collapseButton(el)
    expect(flipped.getAttribute('aria-expanded')).toBe('false')
    expect(flipped.querySelector('.codicon-chevron-up')).toBeTruthy()
    el.remove()
  })

  it('shows the collapse button even with no result', async () => {
    const el = document.createElement('results-panel')
    el.run = { phase: 'idle' }
    document.body.append(el)
    await el.updateComplete
    expect(collapseButton(el)).toBeTruthy()
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

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')).toBeTruthy()

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')).toBeTruthy()
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

  it('delete on a mixed selection deletes result rows and discards drafts', async () => {
    const el = await mountGrid(2)
    el.drafts = [{ after: 0, cells: [null, null] }]
    await el.updateComplete
    const deleteRows = vi.fn()
    const draftRemove = vi.fn()
    el.addEventListener('delete-rows', deleteRows)
    el.addEventListener('draft-remove', draftRemove)

    key(el, { key: 'ArrowDown', shiftKey: true }) // result row 0 + the draft
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Delete selected rows"]')!.click()

    expect((deleteRows.mock.calls[0]![0] as CustomEvent).detail).toEqual({ rows: [0] })
    expect((draftRemove.mock.calls[0]![0] as CustomEvent).detail).toEqual({ indexes: [0] })
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
  const fakeViewport = (el: HTMLElement) => {
    const body = el.shadowRoot!.querySelector<HTMLElement>('.body')!
    const state = { left: 0, top: 0 }
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 50 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(body, 'scrollLeft', { configurable: true, get: () => state.left, set: (v: number) => (state.left = v) })
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => state.top, set: (v: number) => (state.top = v) })
    return state
  }

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
