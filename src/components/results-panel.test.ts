// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
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

  it('type-to-edit on a multi-cell selection fills the whole selection', async () => {
    const el = await mountGrid(3)
    const edits: Array<{ row: number; col: number; value: string }> = []
    el.addEventListener('cell-edit', (e) => edits.push((e as CustomEvent<{ row: number; col: number; value: string }>).detail))

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

    expect(edits).toEqual([
      { row: 0, col: 0, value: 'X' },
      { row: 1, col: 0, value: 'X' },
      { row: 2, col: 0, value: 'X' },
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
