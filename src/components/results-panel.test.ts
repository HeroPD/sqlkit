// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SQL_NULL } from '../sql-write'
import { stubEditorLayout } from '../test/dom-stubs'
import './results-panel'
import type { SqlExpressionEditor } from './sql-expression-editor'

beforeAll(() => {
  // The panel mounts CodeMirror for JSON cells, which measures the DOM and
  // reaches for execCommand when it takes focus.
  stubEditorLayout()
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

describe('results-panel Find', () => {
  it('opens from Ctrl/Cmd+F and navigates matching cells', async () => {
    const el = await mountGrid(3)

    key(el, { key: 'f', ctrlKey: true, cancelable: true })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.result-find input')!
    expect(input).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.result-find .icon-x')).toBeTruthy()

    input.value = 'a'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 3')
    expect(el.shadowRoot!.querySelectorAll('mark.find-hit')).toHaveLength(3)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('1 of 3')
    expect(el.shadowRoot!.querySelector('tr[data-row="0"] td mark.find-current')).toBeTruthy()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('2 of 3')
    expect(el.shadowRoot!.querySelector('tr[data-row="1"] td mark.find-current')).toBeTruthy()
    el.remove()
  })

  it('searches staged display values and reports invalid regular expressions', async () => {
    const el = await mount()
    el.edits = new Map([['0:0', 'Changed']])
    await el.updateComplete

    key(el, { key: 'f', metaKey: true, cancelable: true })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.result-find input')!
    input.value = 'changed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 1')
    expect(el.shadowRoot!.querySelector('td.dirty mark.find-hit')).toBeTruthy()

    el.shadowRoot!.querySelector<HTMLButtonElement>('.find-toggle[aria-label="Use Regular Expression"]')!.click()
    input.value = '['
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-input-box.invalid')).toBeTruthy()
    el.remove()
  })

  it('labels a paged search as loaded rows only', async () => {
    const el = await mount()
    if (el.run.phase === 'done') el.run = { ...el.run, result: { ...el.run.result, bufferedRowCount: 20 } }
    await el.updateComplete

    key(el, { key: 'f', ctrlKey: true, cancelable: true })
    await el.updateComplete

    expect(el.shadowRoot!.querySelector('.find-scope')?.textContent).toBe('Loaded rows only')
    el.remove()
  })

  it('follows the visible mode: all loaded grid rows, then only the visible record', async () => {
    const el = await mountGrid(3)
    key(el, { key: 'f', ctrlKey: true, cancelable: true })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.result-find input')!
    input.value = 'a'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 3')

    // Tab switches the selected row into Record view while Find stays open.
    key(el, { key: 'Tab', cancelable: true })
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 1')
    expect(el.shadowRoot!.querySelector('.record-view mark.find-hit')?.textContent).toBe('a')

    // Returning to the grid restores loaded-grid scope without reopening Find.
    el.shadowRoot!.querySelector('.record-view')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 3')
    el.remove()
  })

  it('counts and highlights each matching text occurrence', async () => {
    const el = await mount()
    if (el.run.phase === 'done') el.run = { ...el.run, result: { ...el.run.result, rows: [['banana', 'locked']] } }
    await el.updateComplete
    key(el, { key: 'f', ctrlKey: true, cancelable: true })
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.result-find input')!
    input.value = 'an'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete

    const marks = [...el.shadowRoot!.querySelectorAll('mark.find-hit')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['an', 'an'])
    expect(el.shadowRoot!.querySelector('.find-count')?.textContent).toBe('? of 2')
    el.remove()
  })

  it('keeps Record view fields mounted and hands editing back when a value is focused', async () => {
    const el = await mountGrid(1)
    key(el, { key: 'Tab', cancelable: true })
    await el.updateComplete
    const record = el.shadowRoot!.querySelector<HTMLElement>('.record-view')!
    record.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
    await el.updateComplete
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.result-find input')!
    input.value = 'a'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await el.updateComplete

    const value = el.shadowRoot!.querySelector<HTMLTextAreaElement>('.record-value')!
    expect(value).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.record-find-overlay mark.find-hit')?.textContent).toBe('a')

    el.shadowRoot!.querySelector('.record-value-wrap')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    value.focus()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.result-find')).toBeNull()
    expect(el.shadowRoot!.querySelector('.record-value-wrap.finding')).toBeNull()
    expect(el.shadowRoot!.querySelector('.record-value')).toBe(value)
    el.remove()
  })
})

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

  it('closes the JSON editor when another result set takes the body', async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      result: {
        columns: ['second'], rows: [['{"b":2}']], rowCount: 1, durationMs: 1,
        resultSets: [
          { columns: ['first'], rows: [['{"a":1}']], rowCount: 1 },
          { columns: ['second'], rows: [['{"b":2}']], rowCount: 1 },
        ],
      },
    }
    document.body.append(el)
    await el.updateComplete
    ;(el as unknown as { _openJson: (ref: unknown, col: number) => void })._openJson({ kind: 'result', row: 0 }, 0)
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.json-view .json-title')?.textContent).toBe('second')

    const select = el.shadowRoot!.querySelector('ui-select.result-set-select' as 'ui-select')!
    select.value = '0'
    select.dispatchEvent(new CustomEvent('change', { detail: { value: '0' } }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.json-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('thead th:not(.num)')?.textContent).toContain('first')
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

  it('offers a singular discard action for one staged cell edit', async () => {
    const el = await mount()
    el.edits = new Map([['0:0', 'changed']])
    await el.updateComplete
    const fill = vi.fn()
    el.addEventListener('cells-fill', fill)

    const cell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="0"] td:nth-child(2)')!
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    const menu = el.shadowRoot!.querySelector('context-menu')!
    expect(menu.items).toContainEqual(
      expect.objectContaining({ id: 'discard-cell-edits', label: 'Discard Cell Edit' }),
    )

    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'discard-cell-edits' } }))

    expect(fill).toHaveBeenCalledOnce()
    expect((fill.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      edits: [],
      clears: [{ row: 0, col: 0 }],
      draftCells: [],
    })
    el.remove()
  })

  it('discards every staged edit in a multi-cell selection as one fill', async () => {
    const el = await mountGrid(2)
    el.edits = new Map([
      ['0:0', 'changed a0'],
      ['0:1', 'changed b0'],
      ['1:0', 'changed a1'],
    ])
    await el.updateComplete
    const fill = vi.fn()
    el.addEventListener('cells-fill', fill)

    key(el, { key: 'ArrowRight', shiftKey: true })
    key(el, { key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    const untouchedCell = el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="1"] td:nth-child(3)')!
    untouchedCell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    await el.updateComplete
    const menu = el.shadowRoot!.querySelector('context-menu')!
    expect(menu.items).toContainEqual(
      expect.objectContaining({ id: 'discard-cell-edits', label: 'Discard Selected Edits' }),
    )

    menu.dispatchEvent(new CustomEvent('menu-pick', { detail: { id: 'discard-cell-edits' } }))

    expect(fill).toHaveBeenCalledOnce()
    expect((fill.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      edits: [],
      clears: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
      ],
      draftCells: [],
    })
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

  // ⌘S and the app menu route through saveRows() so they cannot drift from the
  // toolbar button; its answer is what tells them whether the keystroke was
  // spoken for or still belongs to the file.
  it('reports whether it had a save to make', async () => {
    const el = await mount()
    el.drafts = []
    el.edits = new Map()
    await el.updateComplete
    const saveRows = vi.fn()
    el.addEventListener('save-rows', saveRows)

    expect(el.saveRows()).toBe(false)
    expect(saveRows).not.toHaveBeenCalled()

    el.edits = new Map([['0:0', 'changed']])
    await el.updateComplete
    expect(el.saveRows()).toBe(true)
    expect(saveRows).toHaveBeenCalledOnce()
    el.remove()
  })

  it('stages the cell being typed into rather than letting the save pass it by', async () => {
    const el = await mountGrid(2)
    const saveRows = vi.fn()
    const cellEdit = vi.fn()
    el.addEventListener('save-rows', saveRows)
    el.addEventListener('cell-edit', cellEdit)

    // Open the inline editor and type, without blurring — which is exactly
    // where the caret is when a keyboard save arrives.
    el.shadowRoot!.querySelector<HTMLTableCellElement>('tbody td:not(.num)')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')!.value = 'typed'

    // Nothing is staged yet, so without the flush this reports no save to make
    // and ⌘S falls through to writing the file.
    expect(el.saveRows()).toBe(true)
    expect((cellEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 0, value: 'typed' })
    expect(saveRows).toHaveBeenCalledOnce()
    el.remove()
  })

  it('stages the record field being typed into, alongside what was already staged', async () => {
    const el = await mountGrid(2)
    const cellEdit = vi.fn()
    el.addEventListener('cell-edit', cellEdit)
    // An edit staged earlier: the save would have gone ahead on its own and
    // quietly dropped whatever was still in the open field.
    el.edits = new Map([['1:1', 'earlier']])
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete

    const field = el.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea.record-value[data-col="1"]')!
    field.focus()
    field.value = 'in progress'

    expect(el.saveRows()).toBe(true)
    expect((cellEdit.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 1, value: 'in progress' })
    el.remove()
  })

  it('does not claim a save after the open field clears the last staged edit', async () => {
    const el = await mountGrid(2)
    el.edits = new Map([['0:1', 'pending']])
    await el.updateComplete
    const clear = vi.fn()
    const saveRows = vi.fn()
    el.addEventListener('cell-edit-clear', clear)
    el.addEventListener('save-rows', saveRows)
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete

    const field = el.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea.record-value[data-col="1"]')!
    field.focus()
    field.value = 'b0'

    expect(el.saveRows()).toBe(false)
    expect((clear.mock.calls[0]![0] as CustomEvent).detail).toEqual({ row: 0, col: 1 })
    expect(saveRows).not.toHaveBeenCalled()
    el.remove()
  })

  it('claims the keystroke for a JSON document typed but never flushed', async () => {
    const el = await mount()
    el.drafts = []
    el.edits = new Map()
    await el.updateComplete
    const saveRows = vi.fn()
    const cellEdit = vi.fn()
    el.addEventListener('save-rows', saveRows)
    el.addEventListener('cell-edit', cellEdit)
    ;(el as unknown as { _openJson(ref: unknown, col: number): void })._openJson({ kind: 'result', row: 0 }, 0)
    await el.updateComplete
    ;(el as unknown as { _jsonDraft: string })._jsonDraft = '{"a":1}'

    // Nothing is staged by the write controller's reckoning, but the document
    // on screen is a save waiting to happen and only the panel can see it.
    expect(el.saveRows()).toBe(true)
    expect(cellEdit).toHaveBeenCalledOnce()
    expect(saveRows).toHaveBeenCalledOnce()
    el.remove()
  })

  it('does not claim a save for a JSON-only formatting change', async () => {
    const el = await mount()
    el.run = {
      phase: 'done',
      result: { columns: ['document'], rows: [['{"a":1}']], rowCount: 1, durationMs: 1 },
    }
    el.drafts = []
    el.edits = new Map()
    await el.updateComplete
    const cellEdit = vi.fn()
    const saveRows = vi.fn()
    el.addEventListener('cell-edit', cellEdit)
    el.addEventListener('save-rows', saveRows)
    ;(el as unknown as { _openJson(ref: unknown, col: number): void })._openJson({ kind: 'result', row: 0 }, 0)
    await el.updateComplete
    ;(el as unknown as { _jsonDraft: string })._jsonDraft = '{ "a" : 1 }'

    expect(el.saveRows()).toBe(false)
    expect(cellEdit).not.toHaveBeenCalled()
    expect(saveRows).not.toHaveBeenCalled()
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

// The pointer half of rectangle selection. Characterized before the selection
// machinery moves behind a controller, so a lift that changes any of it fails
// here rather than in someone's hands.
describe('results-panel cell selection by pointer', () => {
  const cellAt = (el: HTMLElement, row: number, col: number) =>
    el.shadowRoot!.querySelector<HTMLTableCellElement>(`tr[data-row="${row}"] td:nth-child(${col + 2})`)!
  const press = (cell: HTMLElement, init: PointerEventInit = {}) =>
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, ...init }))
  const selectedCells = (el: HTMLElement) =>
    [...el.shadowRoot!.querySelectorAll('td.selected')].map(
      (cell) => `${cell.closest('tr')!.getAttribute('data-row')}:${(cell as HTMLTableCellElement).cellIndex - 1}`,
    )

  it('extends the rectangle to the cell dragged over', async () => {
    const el = await mountGrid(3)
    // jsdom has no layout, so the hit test the drag relies on is stubbed to
    // report the cell the pointer is meant to be over.
    const target = cellAt(el, 1, 1)
    Object.defineProperty(el.shadowRoot!, 'elementFromPoint', { configurable: true, value: () => target })

    press(cellAt(el, 0, 0))
    await el.updateComplete
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    await el.updateComplete

    expect(selectedCells(el).sort()).toEqual(['0:0', '0:1', '1:0', '1:1'])
    el.remove()
  })

  it('stops extending once the drag ends', async () => {
    const el = await mountGrid(3)
    const target = cellAt(el, 2, 1)
    Object.defineProperty(el.shadowRoot!, 'elementFromPoint', { configurable: true, value: () => target })

    press(cellAt(el, 0, 0))
    await el.updateComplete
    window.dispatchEvent(new PointerEvent('pointerup', {}))
    // The window listeners are gone, so this move must not reach the grid.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 90 }))
    await el.updateComplete

    expect(selectedCells(el)).toEqual(['0:0'])
    el.remove()
  })

  it('extends the rectangle from the anchor on shift-click', async () => {
    const el = await mountGrid(3)
    press(cellAt(el, 0, 0))
    await el.updateComplete
    press(cellAt(el, 2, 1), { shiftKey: true })
    await el.updateComplete

    expect(selectedCells(el).sort()).toEqual(['0:0', '0:1', '1:0', '1:1', '2:0', '2:1'])
    el.remove()
  })

  it('leaves the selection where it is when the row-number cell is pressed', async () => {
    const el = await mountGrid(3)
    press(cellAt(el, 1, 0))
    await el.updateComplete
    expect(selectedCells(el)).toEqual(['1:0'])

    press(el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-row="2"] td.num')!)
    await el.updateComplete

    expect(selectedCells(el)).toEqual(['1:0'])
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
    expect(editor.submitKey).toBe('Mod-Enter')
    expect(el.shadowRoot!.querySelector('.filter-apply .icon-check')).toBeTruthy()
    expect(el.shadowRoot!.querySelector('.filter-clear .icon-x')).toBeTruthy()

    editor.dispatchEvent(new CustomEvent('expression-change', {
      detail: { value: "a = 'a1'" },
      bubbles: true,
    }))
    editor.shadowRoot!.querySelector<HTMLElement>('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    )
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

describe('results-panel navigation focus', () => {
  it('restores grid focus when an asynchronously followed result lands', async () => {
    const el = document.createElement('results-panel')
    el.run = { phase: 'running', executionId: 'follow', profileId: 'p1' }
    document.body.append(el)
    await el.updateComplete

    el.focusLandedResult()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('table')).toBeNull()

    el.run = {
      phase: 'done',
      result: { columns: ['id'], rows: [[1]], rowCount: 1, durationMs: 1 },
    }
    await el.updateComplete

    expect(el.shadowRoot!.activeElement?.tagName).toBe('TABLE')
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

describe('results-panel execution plans', () => {
  const mountPlan = async (executionMs = 0.042) => {
    const el = document.createElement('results-panel')
    el.engine = 'postgresql'
    el.run = {
      phase: 'done',
      sql: 'explain (analyze, buffers, format json) select * from users',
      result: {
        columns: ['QUERY PLAN'],
        rows: [[[{ Plan: {
          'Node Type': 'Limit',
          'Plan Rows': 10,
          'Actual Rows': 4,
          'Actual Loops': 1,
          'Actual Total Time': 0.027,
          Plans: [{
            'Node Type': 'Seq Scan',
            'Relation Name': 'users',
            'Plan Rows': 610,
            'Actual Rows': 4,
            'Actual Loops': 1,
            'Actual Total Time': 0.011,
          }],
        }, 'Execution Time': executionMs }]]],
        rowCount: 1,
        durationMs: 1,
      },
    }
    document.body.append(el)
    await el.updateComplete
    return el
  }

  it('opens actual plans as a compact result-cell grid with 100% self-duration shares', async () => {
    const el = await mountPlan()
    const table = el.shadowRoot!.querySelector('.execution-plan')!
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent?.trim())).toEqual([
      '#', 'Operation', 'Rows · actual / estimate', 'Duration · %',
    ])
    expect([...table.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()))).toEqual([
      ['2', 'Limit', '4 / 10', '0.016 ms · 59.3%'],
      ['1', 'Seq Scan · users', '4 / 610', '0.011 ms · 40.7%'],
    ])
    expect(el.shadowRoot!.querySelector('.plan-note')?.textContent).toContain('totals 100%')
    expect(el.shadowRoot!.querySelector('.status')?.textContent).toContain('2 operations · 0.042 ms')
    expect(el.shadowRoot!.querySelector('[aria-label="Export results…"]')).toBeNull()
    el.remove()
  })

  it('selects a rectangle of plan cells and copies it as TSV', async () => {
    const writeClipboardText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { writeClipboardText }
    const el = await mountPlan()
    const cell = (row: number, col: number) =>
      el.shadowRoot!.querySelector<HTMLTableCellElement>(`tr[data-grid-row="${row}"] td:nth-child(${col + 2})`)!

    cell(0, 0).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(1)

    cell(1, 2).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, shiftKey: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(6)

    el.shadowRoot!.querySelector('.execution-plan')!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'c', metaKey: true, cancelable: true }),
    )
    expect(writeClipboardText).toHaveBeenCalledWith(
      'Limit\t4 / 10\t0.016 ms · 59.3%\nSeq Scan · users\t4 / 610\t0.011 ms · 40.7%',
    )
    el.remove()
  })

  it('walks plan rows with the arrow keys and leaves the flow number unselectable', async () => {
    const el = await mountPlan()
    const table = el.shadowRoot!.querySelector('.execution-plan')!
    const press = (init: KeyboardEventInit) =>
      table.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

    // The flow-number column is the plan's row number, so pressing it selects nothing.
    el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-grid-row="0"] td.num')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(0)

    el.shadowRoot!.querySelector<HTMLTableCellElement>('tr[data-grid-row="0"] td:nth-child(2)')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }))
    await el.updateComplete
    press({ key: 'ArrowDown', shiftKey: true })
    await el.updateComplete
    expect(
      [...el.shadowRoot!.querySelectorAll('td.selected')].map((cell) => cell.closest('tr')!.getAttribute('data-grid-row')),
    ).toEqual(['0', '1'])

    press({ key: 'ArrowUp' })
    await el.updateComplete
    expect(el.shadowRoot!.querySelectorAll('td.selected')).toHaveLength(1)
    el.remove()
  })

  it('bands a plan duration on the same pace scale as a query duration', async () => {
    const pace = (el: HTMLElement) => el.shadowRoot!.querySelector('.status .duration')!.className

    const fast = await mountPlan(0.042)
    expect(pace(fast)).toBe('duration fast')
    fast.remove()

    const medium = await mountPlan(900)
    expect(pace(medium)).toBe('duration medium')
    medium.remove()

    const slow = await mountPlan(4200)
    expect(pace(slow)).toBe('duration slow')
    expect(slow.shadowRoot!.querySelector('.status')?.textContent).toContain('4200 ms')
    slow.remove()
  })

  it('keeps the engine-native plan available through Raw', async () => {
    const el = await mountPlan()
    const buttons = [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.plan-toggle-button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Plan', 'Raw'])
    buttons[1]!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.execution-plan')).toBeNull()
    expect(el.shadowRoot!.querySelector('th')?.textContent).toBe('#')
    expect(el.shadowRoot!.textContent).toContain('QUERY PLAN')
    buttons[0]!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.execution-plan')).not.toBeNull()
    el.remove()
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

  // Find survives the hop: the search continues against whatever result the
  // follow lands on (the query recounts there — see the result-change reset).
  it('asks the owner to follow, keeping an open Find bar for the destination', async () => {
    const el = await mountFk()
    const seen: Array<{ row: number; col: number }> = []
    el.addEventListener('follow-foreign-key', (event) =>
      seen.push((event as CustomEvent<{ row: number; col: number }>).detail))
    el.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Find in Results"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.result-find')).toBeTruthy()

    followButtons(el)[0]!.click()
    await el.updateComplete
    expect(seen).toEqual([{ row: 0, col: 1 }])
    expect(el.shadowRoot!.querySelector('.result-find')).toBeTruthy()
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

describe('results-panel JSON cell editor', () => {
  const mountJson = async (over: { rows?: unknown[][]; editable?: boolean; edits?: Map<string, string> } = {}) => {
    const el = document.createElement('results-panel')
    el.editable = over.editable ?? true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      sql: 'SELECT id, payload FROM events',
      result: {
        columns: ['id', 'payload'],
        rows: over.rows ?? [[1, { a: 1, b: [2, 3] }]],
        rowCount: 1,
        durationMs: 1,
      },
    }
    el.jsonColumns = new Set([1])
    if (over.edits) el.edits = over.edits
    document.body.append(el)
    await el.updateComplete
    return el
  }

  const openButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('td.fk .fk-follow')
  const editor = (el: HTMLElement) => el.shadowRoot!.querySelector('json-cell-editor') as (HTMLElement & { value: string }) | null
  const headAction = (el: HTMLElement, label: string) =>
    [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.head-action')].find(
      (button) => button.getAttribute('aria-label') === label,
    )
  const type = async (el: Awaited<ReturnType<typeof mountJson>>, value: string) => {
    editor(el)!.dispatchEvent(new CustomEvent('json-change', { detail: { value }, bubbles: true, composed: true }))
    await el.updateComplete
  }

  // Types into the editor's document rather than faking the change event, so
  // the linter has the same text the user would have given it.
  const typeForReal = async (el: Awaited<ReturnType<typeof mountJson>>, value: string) => {
    const view = (editor(el) as unknown as { _view: { state: { doc: { length: number } }; dispatch: (spec: unknown) => void } })._view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    await el.updateComplete
  }

  it('offers the affordance on the JSON column only, including its null cells', async () => {
    const el = await mountJson({ rows: [[1, { a: 1 }], [2, null]] })
    expect(el.shadowRoot!.querySelectorAll('td.fk .fk-follow')).toHaveLength(2)
    // The id column keeps its plain cell.
    const cells = [...el.shadowRoot!.querySelectorAll('tbody tr[data-row="0"] td')]
    expect(cells[1]?.querySelector('.fk-value')).toBeNull()
  })

  it('opens the document formatted', async () => {
    const el = await mountJson()
    headAction(el, 'Find in Results')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.result-find')).toBeTruthy()
    openButton(el)!.click()
    await el.updateComplete
    expect(editor(el)?.value).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
    expect(el.shadowRoot!.querySelector('.result-find')).toBeNull()
  })

  it('gives the editor keyboard focus when it opens', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    // Follow activeElement through shadow roots to the editor's content node.
    let active: Element | null = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    expect(active?.classList.contains('cm-content')).toBe(true)
  })

  it('carries its own find: Mod-F opens it, Esc peels find before the editor', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    const content = editor(el)!.shadowRoot!.querySelector('.cm-content')!
    const press = (key: string, init: KeyboardEventInit = {}) =>
      content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))

    press('f', { ctrlKey: true })
    expect(editor(el)!.shadowRoot!.querySelector('.find-widget')).toBeTruthy()
    // The document is editable here, so the widget keeps its replace chevron.
    expect(editor(el)!.shadowRoot!.querySelector('.toggle-replace')).toBeTruthy()

    press('Escape')
    expect(editor(el)!.shadowRoot!.querySelector('.find-widget')).toBeNull()
    expect(editor(el)).toBeTruthy() // find closed, the editor did not

    press('Escape')
    await el.updateComplete
    expect(editor(el)).toBeNull() // now Esc reaches the editor's own close
  })

  it('hides replace in its find when the document is read-only', async () => {
    const el = await mountJson({ editable: false })
    openButton(el)!.click()
    await el.updateComplete
    editor(el)!.shadowRoot!.querySelector('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    expect(editor(el)!.shadowRoot!.querySelector('.find-widget.no-replace')).toBeTruthy()
    expect(editor(el)!.shadowRoot!.querySelector('.toggle-replace')).toBeNull()
    expect(editor(el)!.shadowRoot!.querySelector('.replace-row')).toBeNull()
  })

  it('stages the edit minified to one line, and only on a flush', async () => {
    const el = await mountJson()
    const staged: Array<{ row: number; col: number; value: string }> = []
    el.addEventListener('cell-edit', (event) => staged.push((event as CustomEvent<{ row: number; col: number; value: string }>).detail))

    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{\n  "a": 2\n}')
    expect(staged).toEqual([]) // typing alone stages nothing

    editor(el)!.dispatchEvent(new CustomEvent('json-flush', { bubbles: true, composed: true }))
    expect(staged).toEqual([{ row: 0, col: 1, value: '{"a":2}' }])
  })

  it('stages nothing while the text is not valid JSON', async () => {
    const el = await mountJson()
    const staged: unknown[] = []
    el.addEventListener('cell-edit', (event) => staged.push((event as CustomEvent).detail))

    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{"a":')

    editor(el)!.dispatchEvent(new CustomEvent('json-flush', { bubbles: true, composed: true }))
    expect(staged).toEqual([])
  })

  // While typing, the mark and its hover are the whole report; the strip is what
  // a refused save adds, and it names the error and where it is.
  it('shows the error strip on a refused save, not while typing', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    await typeForReal(el, '{\n  "ok": 1,\n  "broken": ,\n  "after": 2\n}')
    expect(el.shadowRoot!.querySelector('.json-error')).toBeNull()

    headAction(el, 'Save changes')!.click()
    await el.updateComplete

    const strip = el.shadowRoot!.querySelector('.json-error')
    expect(strip).not.toBeNull()
    // Trimmed to the clause that names the problem — no echoed source, no
    // "is not valid JSON" tail, no position repeated inside the message.
    expect(strip!.querySelector('.json-error-message')?.textContent?.trim()).toBe("Unexpected token ','")
    expect(strip!.querySelector('.json-error-at')?.textContent?.trim()).toBe('line 3, column 13')

    // A list of one error needs no panel of its own, and one gutter is enough.
    const cm = editor(el)!.shadowRoot!
    expect(cm.querySelector('.cm-gutter-lint')).toBeNull()
    expect(cm.querySelector('.cm-panel-lint')).toBeNull()
  })

  it('puts the cursor on the error when a save has to refuse', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    await typeForReal(el, '{\n  "ok": 1,\n  "broken": ,\n  "after": 2\n}')
    const view = (editor(el) as unknown as { _view: { state: { selection: { main: { head: number } } } } })._view
    expect(view.state.selection.main.head).not.toBe(25)

    headAction(el, 'Save changes')!.click()
    await el.updateComplete
    // Character 25 is the stray comma on line 3.
    expect(view.state.selection.main.head).toBe(25)
  })

  it('retires the strip once the document parses, so the next save re-earns it', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    await typeForReal(el, '{"a": }')
    headAction(el, 'Save changes')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.json-error')).not.toBeNull()

    await typeForReal(el, '{"a": 1}')
    expect(el.shadowRoot!.querySelector('.json-error')).toBeNull()

    // Broken again, but nothing has asked for the strip since.
    await typeForReal(el, '{"a": 1,}')
    expect(el.shadowRoot!.querySelector('.json-error')).toBeNull()
  })

  it('dims the row actions while it is open, and keeps save and revert live', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    expect(headAction(el, 'Add new row')?.disabled).toBe(true)
    expect(headAction(el, 'Delete selected rows')?.disabled).toBe(true)
    // Nothing is staged yet, so save stays dim until the text actually changes.
    expect(headAction(el, 'Save changes')?.disabled).toBe(true)

    await type(el, '{"a":2}')
    expect(headAction(el, 'Save changes')?.disabled).toBe(false)
    expect(headAction(el, 'Discard changes')?.disabled).toBe(false)
  })

  it('flushes before saving, so ⌘S writes what is on screen', async () => {
    const el = await mountJson()
    const staged: Array<{ value: string }> = []
    const saves: unknown[] = []
    el.addEventListener('cell-edit', (event) => staged.push((event as CustomEvent<{ value: string }>).detail))
    el.addEventListener('save-rows', () => saves.push(true))

    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{"a":2}')
    editor(el)!.dispatchEvent(new CustomEvent('json-save', { bubbles: true, composed: true }))

    // The staged edit reaches the owner synchronously but only returns as an
    // `edits` property on the next render, so the save must count the flush
    // itself — reading the stale map would swallow the first click.
    expect(staged).toEqual([{ row: 0, col: 1, value: '{"a":2}' }])
    expect(saves).toEqual([true])
  })

  // The trail's own back button, rather than a second one inside the view: the
  // editor is a view of the current result, not a new trail entry.
  it('returns to the grid through the toolbar back button', async () => {
    const el = await mountJson()
    expect(headAction(el, 'Back to the previous result')).toBeUndefined() // no trail, no nav yet

    openButton(el)!.click()
    await el.updateComplete
    expect(editor(el)).not.toBeNull()
    const back = headAction(el, 'Back to the grid')
    expect(back?.disabled).toBe(false)
    // Forward belongs to the trail and has nowhere to go from here.
    expect(headAction(el, 'Forward to the next result')?.disabled).toBe(true)

    back!.click()
    await el.updateComplete
    expect(editor(el)).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).not.toBeNull()
  })

  it('reopens the editor on forward, with the text left mid-edit', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    // Invalid on purpose: it was never staged, so only Forward can bring it back.
    await type(el, '{"a": ')

    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    expect(editor(el)).toBeNull()

    const forward = headAction(el, 'Back to the JSON editor')
    expect(forward?.disabled).toBe(false)
    forward!.click()
    await el.updateComplete
    expect(editor(el)?.value).toBe('{"a": ')
  })

  it('lets the trail have forward when it has somewhere to go', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    headAction(el, 'Back to the grid')!.click()
    el.canGoForward = true
    await el.updateComplete

    const steps: string[] = []
    el.addEventListener('result-navigate', (event) =>
      steps.push((event as CustomEvent<{ direction: string }>).detail.direction),
    )
    headAction(el, 'Forward to the next result')!.click()
    await el.updateComplete
    expect(steps).toEqual(['forward'])
    expect(editor(el)).toBeNull()
  })

  it('reopens an invalid draft before a forward trail step can discard it', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{"unfinished": ')
    headAction(el, 'Back to the grid')!.click()
    el.canGoForward = true
    await el.updateComplete

    const steps: string[] = []
    el.addEventListener('result-navigate', (event) =>
      steps.push((event as CustomEvent<{ direction: string }>).detail.direction),
    )
    const forward = headAction(el, 'Back to the JSON editor')
    expect(forward).toBeDefined()
    forward!.click()
    await el.updateComplete

    expect(steps).toEqual([])
    expect(editor(el)?.value).toBe('{"unfinished": ')
  })

  it('reports unstaged JSON text for the workbench leave guard', async () => {
    const el = await mountJson()
    expect(el.hasUnstagedJson()).toBe(false)

    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{"a": ')
    expect(el.hasUnstagedJson()).toBe(true) // open and dirty

    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    expect(el.hasUnstagedJson()).toBe(true) // closed, but only Forward still holds it
  })

  it('counts nothing unstaged once a valid document flushes on close', async () => {
    const el = await mountJson()
    openButton(el)!.click()
    await el.updateComplete
    await type(el, '{"a":2}')
    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    // The close staged the text, so nothing is left that only the editor holds.
    expect(el.hasUnstagedJson()).toBe(false)
  })

  it('drops the forward target once another cell is opened', async () => {
    const el = await mountJson({ rows: [[1, { a: 1 }], [2, { b: 2 }]] })
    const buttons = () => [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('td.fk .fk-follow')]
    buttons()[0]!.click()
    await el.updateComplete
    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    expect(headAction(el, 'Back to the JSON editor')).toBeDefined()

    buttons()[1]!.click()
    await el.updateComplete
    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    // Forward now points at the second cell, not the first.
    headAction(el, 'Back to the JSON editor')!.click()
    await el.updateComplete
    expect(editor(el)?.value).toBe('{\n  "b": 2\n}')
  })

  it('steps the trail as usual when no editor is open', async () => {
    const el = await mountJson()
    el.canGoBack = true
    await el.updateComplete
    const steps: string[] = []
    el.addEventListener('result-navigate', (event) =>
      steps.push((event as CustomEvent<{ direction: string }>).detail.direction),
    )
    headAction(el, 'Back to the previous result')!.click()
    expect(steps).toEqual(['back'])
  })

  it('comes back to the row the user left, not the top of the grid', async () => {
    const el = await mountJson({ rows: Array.from({ length: 200 }, (_, i) => [i, { row: i }]) })
    const body = el.shadowRoot!.querySelector<HTMLElement>('.body')!
    // jsdom has no layout, so give the body a scrollable box of its own.
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 4000 })
    let scrollTop = 0
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
    })
    body.scrollTop = 1200
    body.scrollLeft = 300

    el.shadowRoot!.querySelectorAll<HTMLButtonElement>('td.fk .fk-follow')[0]!.click()
    await el.updateComplete
    expect(editor(el)).not.toBeNull()

    headAction(el, 'Back to the grid')!.click()
    await el.updateComplete
    expect(body.scrollTop).toBe(1200)
    expect(body.scrollLeft).toBe(300)
  })

  it('offers the affordance on draft rows too', async () => {
    const el = await mountJson()
    el.drafts = [{ after: -1, cells: ['1', '{"a":1}'] }]
    await el.updateComplete

    const button = el.shadowRoot!.querySelector<HTMLButtonElement>('tr.draft td.fk .fk-follow')
    expect(button).not.toBeNull()
    button!.click()
    await el.updateComplete
    expect(editor(el)?.value).toBe('{\n  "a": 1\n}')
    expect(el.shadowRoot!.querySelector('.json-row')?.textContent).toContain('New row')
  })

  it('opens read-only when the result cannot be edited', async () => {
    const el = await mountJson({ editable: false })
    openButton(el)!.click()
    await el.updateComplete
    expect((editor(el) as unknown as { readonly: boolean }).readonly).toBe(true)
  })

  it('reopens a staged value rather than the stored one', async () => {
    const el = await mountJson({ edits: new Map([['0:1', '{"a":9}']]) })
    openButton(el)!.click()
    await el.updateComplete
    expect(editor(el)?.value).toBe('{\n  "a": 9\n}')
  })
})

describe('results-panel toolbar focus', () => {
  // Clicking a toolbar button must not move focus onto it: focus parked there
  // gets the browser's focus ring painted by the next keypress (Esc closing
  // the query popover). Keyboard focus via Tab is untouched.
  it('cancels pointerdown on toolbar buttons, and only on buttons', async () => {
    const el = document.createElement('results-panel')
    el.run = {
      phase: 'done',
      sql: 'SELECT 1',
      result: { columns: ['a'], rows: [[1]], rowCount: 1, durationMs: 1 },
    }
    document.body.append(el)
    await el.updateComplete

    const button = el.shadowRoot!.querySelector('.query-info')!
    const onButton = new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true })
    button.dispatchEvent(onButton)
    expect(onButton.defaultPrevented).toBe(true)

    const head = el.shadowRoot!.querySelector('.head')!
    const onHead = new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true })
    head.dispatchEvent(onHead)
    expect(onHead.defaultPrevented).toBe(false)
  })
})

describe('results-panel keeps the reader in place across a save', () => {
  // A save re-runs the tab's query; the rows are the same ones, so the grid
  // should not snap back to row 1 and lose what the user was working on.
  const mountScrollable = async (columns: string[] = ['a', 'b']) => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.rowEditable = true
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: {
        columns,
        rows: Array.from({ length: 200 }, (_, i) => columns.map((column) => `${column}${i}`)),
        rowCount: 200,
        durationMs: 1,
      },
    }
    // Column a is the table's primary key, so `a42` is what names row 42 across
    // the re-run — the workbench derives this from the same metadata the write
    // path targets rows by.
    el.keyColumns = [0]
    el.edits = new Map([['5:0', 'edited']])
    document.body.append(el)
    await el.updateComplete
    const body = el.shadowRoot!.querySelector<HTMLElement>('.body')!
    let scrollTop = 0
    let scrollLeft = 0
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
    })
    Object.defineProperty(body, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => (scrollLeft = value),
    })
    return { el, body }
  }

  // A save's refresh re-runs the query, so the panel sees `running` before the
  // rows land — the state the first version of this fix spent its flag on.
  const refresh = async (el: Awaited<ReturnType<typeof mountScrollable>>['el'], columns: string[]) => {
    el.edits = new Map()
    el.run = { phase: 'running', executionId: 'refresh', profileId: 'p' }
    await el.updateComplete
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: {
        columns,
        rows: Array.from({ length: 200 }, (_, i) => columns.map((column) => `${column}${i}`)),
        rowCount: 200,
        durationMs: 1,
        sessionId: 'refreshed',
      },
    }
    await el.updateComplete
  }

  // The same refresh, but with rows the caller chooses — a re-run is free to
  // hand the same columns back in a different order or one row short.
  const refreshWith = async (el: Awaited<ReturnType<typeof mountScrollable>>['el'], rows: unknown[][]) => {
    el.edits = new Map()
    el.drafts = []
    el.pendingDeletes = new Set()
    el.run = { phase: 'running', executionId: 'refresh', profileId: 'p' }
    await el.updateComplete
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: { columns: ['a', 'b'], rows, rowCount: rows.length, durationMs: 1, sessionId: 'refreshed' },
    }
    await el.updateComplete
  }

  const save = (el: HTMLElement) =>
    [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.head-action')]
      .find((button) => button.getAttribute('aria-label') === 'Save changes')!
      .click()

  const openRecordOnRow42 = async (el: Awaited<ReturnType<typeof mountScrollable>>['el']) => {
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')?.textContent).toContain('Row #43')
  }

  it('stays where it was when the refresh brings back the same columns', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    save(el)
    await refresh(el, ['a', 'b'])
    expect(body.scrollTop).toBe(1200)
  })

  it('starts at the top when the result is a different query', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    save(el)
    await refresh(el, ['x', 'y', 'z'])
    expect(body.scrollTop).toBe(0)
  })

  it('starts at the top for a result that follows no save', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    await refresh(el, ['a', 'b'])
    expect(body.scrollTop).toBe(0)
  })

  it('forgets the armed restore when the review is cancelled', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    save(el)
    // The workbench relays a review-dialog cancel as refreshNotComing(): the
    // save never ran, so a later same-column result must not inherit the restore.
    el.refreshNotComing()
    await refresh(el, ['a', 'b'])
    expect(body.scrollTop).toBe(0)
  })

  it('keeps the selected cell, not just the scroll position', async () => {
    const { el } = await mountScrollable()
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    save(el)
    await refresh(el, ['a', 'b'])
    expect((el as unknown as { _sel: unknown })._sel).toEqual({ r0: 42, c0: 1, r1: 42, c1: 1 })
  })

  it('stays in the record view when the save was made there', async () => {
    const { el } = await mountScrollable()
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeTruthy()

    save(el)
    await refresh(el, ['a', 'b'])
    const record = el.shadowRoot!.querySelector<HTMLElement>('.record-view')
    expect(record).toBeTruthy()
    // The same row, with the same field focused.
    expect(record!.textContent).toContain('Row #43')
    expect(record!.querySelectorAll('.record-field')[2]?.classList.contains('active')).toBe(true)
  })

  it('returns to the grid when the refreshed result cannot hold the record row', async () => {
    const { el } = await mountScrollable()
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete

    el.edits = new Map()
    save(el)
    el.run = { phase: 'running', executionId: 'refresh', profileId: 'p' }
    await el.updateComplete
    el.run = {
      phase: 'done',
      sql: 'SELECT a, b FROM t',
      result: { columns: ['a', 'b'], rows: [['a0', 'b0']], rowCount: 1, durationMs: 1, sessionId: 'shrunk' },
    }
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
  })

  it('will not reopen a row-specific view once the refresh has renumbered the rows', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    await openRecordOnRow42(el)
    save(el)
    // A row above was removed (another client, or a delete in the same batch),
    // so index 42 now holds what used to be row 43.
    const rows = Array.from({ length: 199 }, (_, i) => ['a', 'b'].map((column) => `${column}${i + 1}`))
    await refreshWith(el, rows)

    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(el.shadowRoot!.querySelector('table')).toBeTruthy()
    // The scroll offset addresses a position, not a row, so it still applies.
    expect(body.scrollTop).toBe(1200)
    expect((el as unknown as { _sel: unknown })._sel).toEqual({ r0: 0, c0: 0, r1: 0, c1: 0 })
  })

  it('will not reopen a row-specific view when the save also inserts or deletes', async () => {
    const { el, body } = await mountScrollable()
    body.scrollTop = 1200
    await openRecordOnRow42(el)
    // A delete staged elsewhere in the grid renumbers every row below it, so
    // nothing addressed by index survives the save — probe or no probe.
    el.pendingDeletes = new Set([7])
    await el.updateComplete
    save(el)
    await refresh(el, ['a', 'b'])

    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(body.scrollTop).toBe(1200)
  })

  it('reopens the record view when the rows come back unmoved', async () => {
    const { el } = await mountScrollable()
    await openRecordOnRow42(el)
    save(el)
    await refreshWith(el, Array.from({ length: 200 }, (_, i) => ['a', 'b'].map((column) => `${column}${i}`)))
    expect(el.shadowRoot!.querySelector('.record-view')?.textContent).toContain('Row #43')
  })

  it('recognises the row by the key it will carry once the save lands', async () => {
    const { el } = await mountScrollable()
    await openRecordOnRow42(el)
    // The key column itself is what is being written, so the value it is about
    // to hold is what names the row afterwards — not the one it is replacing.
    el.edits = new Map([['42:0', 'rekeyed']])
    await el.updateComplete
    save(el)
    const rows = Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`])
    rows[42] = ['rekeyed', 'b42']
    await refreshWith(el, rows)
    expect(el.shadowRoot!.querySelector('.record-view')?.textContent).toContain('Row #43')
  })

  it('reopens even when other rows read identically outside the key', async () => {
    const { el } = await mountScrollable()
    await openRecordOnRow42(el)
    save(el)
    // Row 100 duplicates everything but the key. The key is the identity, so
    // there is nothing ambiguous here to back away from.
    const refreshed = Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`])
    refreshed[100] = ['a100', 'b42']
    await refreshWith(el, refreshed)
    expect(el.shadowRoot!.querySelector('.record-view')?.textContent).toContain('Row #43')
  })

  it('will not reopen when the result has no key to go on', async () => {
    const { el, body } = await mountScrollable()
    // An expression projection or a keyless table: the write path could not
    // target these rows either, so there is nothing to recognise one by.
    el.keyColumns = []
    await el.updateComplete
    body.scrollTop = 1200
    await openRecordOnRow42(el)
    save(el)
    await refresh(el, ['a', 'b'])
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
    expect(body.scrollTop).toBe(1200)
  })

  it('brings a range selection back collapsed onto its focus cell', async () => {
    const { el } = await mountScrollable()
    // Rows 5-10 selected, focused on 10. Editing row 5's sort value can lift it
    // clear of the range while index 10 keeps its occupant, so the corner proves
    // nothing about what the range now spans.
    ;(el as unknown as { _sel: unknown })._sel = { r0: 5, c0: 0, r1: 10, c1: 1 }
    save(el)
    await refresh(el, ['a', 'b'])
    expect((el as unknown as { _sel: unknown })._sel).toEqual({ r0: 10, c0: 1, r1: 10, c1: 1 })
  })

  it('drops the armed restore when the refresh errors instead of landing rows', async () => {
    const { el } = await mountScrollable()
    await openRecordOnRow42(el)
    save(el)
    el.edits = new Map()
    el.run = { phase: 'running', executionId: 'refresh', profileId: 'p' }
    await el.updateComplete
    el.run = { phase: 'error', error: 'relation "t" does not exist' }
    await el.updateComplete

    // The next query stands on its own: same columns and the same key at that
    // index would otherwise be enough to inherit a token nothing spent.
    await refreshWith(el, Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`]))
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
  })

  it('drops the armed restore when another tab takes the panel over', async () => {
    const { el } = await mountScrollable()
    el.tabId = 'tab-a'
    await el.updateComplete
    await openRecordOnRow42(el)
    save(el)
    // The save's refresh never ran — the user moved on before it was dispatched.
    // Tab B browses the same table, so its rows answer every other check.
    el.tabId = 'tab-b'
    await refreshWith(el, Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`]))
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
  })

  it('still restores across the running phase the refresh passes through', async () => {
    const { el } = await mountScrollable()
    el.tabId = 'tab-a'
    await el.updateComplete
    await openRecordOnRow42(el)
    save(el)
    await refresh(el, ['a', 'b'])
    expect(el.shadowRoot!.querySelector('.record-view')?.textContent).toContain('Row #43')
  })

  it('will not reopen when the row it was on has moved elsewhere in the result', async () => {
    const { el } = await mountScrollable()
    await openRecordOnRow42(el)
    save(el)
    // Row 42 is still in the result, just not at index 42 — an ORDER BY the
    // edit disturbed, or a Postgres update on a query that carries none.
    const refreshed = Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`])
    refreshed[42] = ['a199', 'b199']
    refreshed[199] = ['a42', 'b42']
    await refreshWith(el, refreshed)
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()
  })

  it('stays in the JSON editor when the save was made there', async () => {
    const { el } = await mountScrollable()
    ;(el as unknown as { _openJson: (ref: unknown, col: number) => void })._openJson({ kind: 'result', row: 42 }, 1)
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.json-view')).toBeTruthy()

    save(el)
    await refresh(el, ['a', 'b'])
    const json = el.shadowRoot!.querySelector<HTMLElement>('.json-view')
    expect(json).toBeTruthy()
    expect(json!.querySelector('.json-row')?.textContent).toBe('Row #43')
  })
})

describe('results-panel remembers where the reader was in each result', () => {
  const resultOf = (columns: string[], marker: string) => ({
    columns,
    rows: Array.from({ length: 200 }, (_, i) => columns.map((column) => `${marker}-${column}${i}`)),
    rowCount: 200,
    durationMs: 1,
  })

  const mount = async () => {
    const el = document.createElement('results-panel')
    el.editable = true
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: resultOf(['a', 'b'], 'first') }
    document.body.append(el)
    await el.updateComplete
    const body = el.shadowRoot!.querySelector<HTMLElement>('.body')!
    let scrollTop = 0
    let scrollLeft = 0
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
    })
    Object.defineProperty(body, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => (scrollLeft = value),
    })
    return { el, body }
  }

  const sel = (el: HTMLElement) => (el as unknown as { _sel: unknown })._sel

  it('returns to the row and cell it left when a result comes back', async () => {
    const { el, body } = await mount()
    const first = el.run.phase === 'done' ? el.run.result : null
    body.scrollTop = 1500
    body.scrollLeft = 420
    // Pick a cell, the way clicking one does.
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }

    // Follow a foreign key: a different result takes over, starting at the top.
    const followed = resultOf(['x'], 'second')
    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: followed }
    await el.updateComplete
    expect(body.scrollTop).toBe(0)

    // Back: the trail hands the same object back, so the bookmark applies.
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: first! }
    await el.updateComplete
    expect(body.scrollTop).toBe(1500)
    // Both axes: a wide result is as easily scrolled sideways as down.
    expect(body.scrollLeft).toBe(420)
    expect(sel(el)).toEqual({ r0: 42, c0: 1, r1: 42, c1: 1 })
  })

  it('keeps a bookmark per result, so forward returns too', async () => {
    const { el, body } = await mount()
    const first = el.run.phase === 'done' ? el.run.result : null
    body.scrollTop = 900
    const followed = resultOf(['x'], 'second')
    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: followed }
    await el.updateComplete
    body.scrollTop = 600

    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: first! }
    await el.updateComplete
    expect(body.scrollTop).toBe(900)

    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: followed }
    await el.updateComplete
    expect(body.scrollTop).toBe(600)
  })

  it('comes back to the same rows after a trip through the record view', async () => {
    const { el, body } = await mount()
    body.scrollTop = 1500
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete
    // The grid leaves the DOM, so the body collapses and the browser clamps.
    body.scrollTop = 0

    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click()
    await el.updateComplete
    expect(body.scrollTop).toBe(1500)
  })

  it('bookmarks the grid position a result was showing before the record view', async () => {
    const { el, body } = await mount()
    const first = el.run.phase === 'done' ? el.run.result : null
    body.scrollTop = 1500
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete
    body.scrollTop = 0

    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: resultOf(['x'], 'second') }
    await el.updateComplete
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: first! }
    await el.updateComplete
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click()
    await el.updateComplete
    expect(body.scrollTop).toBe(1500)
  })

  it('returns to the record view a result was left in', async () => {
    const { el, body } = await mount()
    const first = el.run.phase === 'done' ? el.run.result : null
    body.scrollTop = 1500
    ;(el as unknown as { _sel: unknown })._sel = { r0: 42, c0: 1, r1: 42, c1: 1 }
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click()
    await el.updateComplete

    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: resultOf(['x'], 'second') }
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.record-view')).toBeNull()

    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: first! }
    await el.updateComplete
    const record = el.shadowRoot!.querySelector<HTMLElement>('.record-view')
    expect(record).toBeTruthy()
    expect(record!.textContent).toContain('Row #43')
  })

  it('starts a never-seen result at the top', async () => {
    const { el, body } = await mount()
    body.scrollTop = 1500
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: resultOf(['a', 'b'], 'fresh') }
    await el.updateComplete
    expect(body.scrollTop).toBe(0)
  })

  it('keeps the bookmark through appends, which replace the result object', async () => {
    const { el, body } = await mount()
    // Appends deliver a new result object under the same session key; the
    // bookmark must file under the newest object — the one the trail holds.
    const first = { ...resultOf(['a', 'b'], 'first'), sessionId: 's1' }
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: first }
    await el.updateComplete
    const appended = { ...resultOf(['a', 'b'], 'first'), sessionId: 's1' }
    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: appended }
    await el.updateComplete
    body.scrollTop = 1100

    el.run = { phase: 'done', sql: 'SELECT x FROM u', result: { ...resultOf(['x'], 'second'), sessionId: 's2' } }
    await el.updateComplete
    expect(body.scrollTop).toBe(0)

    el.run = { phase: 'done', sql: 'SELECT a, b FROM t', result: appended }
    await el.updateComplete
    expect(body.scrollTop).toBe(1100)
  })
})
