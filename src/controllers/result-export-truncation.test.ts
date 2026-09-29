// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { QueryResult } from '../electron'
import { ResultExportController } from './result-export'
import { ExportDialog, type ExportConfirmDetail } from '../components/export-dialog'
import { isTruncatedCell, truncatedWithinRows } from '../result-truncation'

const fakeHost = (): ReactiveControllerHost => ({
  addController: (_controller: ReactiveController) => {},
  removeController: (_controller: ReactiveController) => {},
  requestUpdate: () => {},
  updateComplete: Promise.resolve(true),
})

const marker = 'abc\n… [cell truncated by SqlKit Studio]'
// Row 2's `body` was shortened by the driver; rows 0 and 1 are faithful.
const shortened: QueryResult = {
  columns: ['id', 'body'],
  rows: [[1, 'a'], [2, 'b'], [3, marker]],
  rowCount: 3,
  durationMs: 1,
  truncatedCells: [[2, 1]],
}

const setup = (result: QueryResult) => {
  const notice = vi.fn()
  const streamExport = vi.fn()
  const exportFile = vi.fn((_name: string, _content: string) => Promise.resolve({ success: true }))
  ;(window as unknown as { sqlkit: unknown }).sqlkit = { exportFile, fetchRows: vi.fn() }
  const controller = new ResultExportController(fakeHost(), {
    result: () => result,
    sqlTarget: () => ({ engine: 'postgresql', table: null }),
    jsonColumns: () => new Set<number>(),
    streamExport,
    notice,
  })
  return { controller, notice, streamExport, exportFile }
}

describe('shortened cells never leave as data', () => {
  it('refuses Copy All and says why', async () => {
    const { controller, notice } = setup(shortened)
    expect(await controller.copyAll('csv')).toBeNull()
    expect(notice).toHaveBeenCalledWith('Values were shortened', expect.stringContaining('nothing was copied'))
  })

  it('refuses a buffered export that would include a shortened cell', async () => {
    const { controller, notice, exportFile } = setup(shortened)
    await controller.confirm({ format: 'csv', rows: 3, stream: false })
    expect(exportFile).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('Values were shortened', expect.stringContaining('no file was written'))
  })

  it('still exports the faithful rows before the first shortened one', async () => {
    const { controller, notice, exportFile } = setup(shortened)
    await controller.confirm({ format: 'csv', rows: 2, stream: false })
    expect(notice).not.toHaveBeenCalled()
    expect(exportFile.mock.calls[0]?.[1]).not.toContain('truncated')
  })

  it('copies and exports a result with no shortened cells as before', async () => {
    const { controller } = setup({ ...shortened, rows: [[1, 'a']], rowCount: 1, truncatedCells: undefined })
    expect(await controller.copyAll('tsv')).toContain('a')
  })

  it('locates shortened cells by buffered row and column', () => {
    expect(isTruncatedCell(shortened, 2, 1)).toBe(true)
    expect(isTruncatedCell(shortened, 2, 0)).toBe(false)
    expect(truncatedWithinRows(shortened, 2)).toBe(false)
    expect(truncatedWithinRows(shortened, 3)).toBe(true)
  })
})

describe('export dialog with shortened cells', () => {
  const mount = async (props: Partial<Pick<ExportDialog, 'truncated' | 'streamable' | 'shortened'>>) => {
    const dialog = document.createElement('export-dialog')
    Object.assign(dialog, { total: 3, ...props })
    document.body.append(dialog)
    await dialog.updateComplete
    return dialog
  }

  it('does not claim the query returned more, and forces the streamed export', async () => {
    const dialog = await mount({ shortened: true, streamable: true })
    const text = dialog.shadowRoot!.textContent ?? ''
    expect(text).not.toContain('the query returned more')
    expect(text).toContain('re-runs the query to write them in full')
    const confirmed = vi.fn()
    dialog.addEventListener('export-confirm', (event) => { confirmed((event as CustomEvent<ExportConfirmDetail>).detail) })
    dialog.shadowRoot!.querySelector<HTMLButtonElement>('button.primary')!.click()
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({ stream: true }))
    dialog.remove()
  })

  it('blocks the export when the query cannot be re-run', async () => {
    const dialog = await mount({ shortened: true, streamable: false })
    expect(dialog.shadowRoot!.textContent).toContain('Only a read-only query can be re-run')
    const confirmed = vi.fn()
    dialog.addEventListener('export-confirm', confirmed)
    const button = dialog.shadowRoot!.querySelector<HTMLButtonElement>('button.primary')!
    expect(button.disabled).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(confirmed).not.toHaveBeenCalled()
    dialog.remove()
  })
})
