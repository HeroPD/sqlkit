// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { QueryResult } from '../electron'
import { ResultExportController } from './result-export'

const fakeHost = (): ReactiveControllerHost => ({
  addController: (_controller: ReactiveController) => {},
  removeController: (_controller: ReactiveController) => {},
  requestUpdate: () => {},
  updateComplete: Promise.resolve(true),
})

const controllerFor = (result: QueryResult | null, notice = vi.fn(), streamExport = vi.fn()) => ({
  notice,
  streamExport,
  controller: new ResultExportController(fakeHost(), {
    result: () => result,
    sqlTarget: () => ({ engine: 'postgresql', table: { schema: 'public', name: 'nums', kind: 'table' } }),
    jsonColumns: () => new Set<number>(),
    streamExport,
    notice,
  }),
})

describe('ResultExportController draining', () => {
  it('drains the full export in large pages, retrying when a page comes back short', async () => {
    const all = Array.from({ length: 450 }, (_, index) => [index])
    // First page returns short of the requested limit (the main process caps
    // pages by bytes); the loop must continue from where it left off.
    const fetchRows = vi.fn((_session: string, offset: number, limit: number) =>
      Promise.resolve({ success: true as const, rows: all.slice(offset, offset + Math.min(limit, 300)) }),
    )
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { fetchRows }
    const { controller } = controllerFor(
      { columns: ['n'], rows: all.slice(0, 200), rowCount: 450, durationMs: 1, sessionId: 's1', bufferedRowCount: 450 },
    )

    expect(await controller.rows(450)).toMatchObject({ complete: true, expected: 450 })
    expect((await controller.rows(450)).rows).toHaveLength(450)
    expect(fetchRows).toHaveBeenNthCalledWith(1, 's1', 0, 450)
    expect(fetchRows).toHaveBeenNthCalledWith(2, 's1', 300, 150)
    expect(controller.draining).toBeNull()
  })

  it('takes the loaded rows when nothing is buffered behind them', async () => {
    const { controller } = controllerFor({ columns: ['n'], rows: [[1], [2]], rowCount: 2, durationMs: 1 })
    expect(await controller.rows()).toEqual({ rows: [[1], [2]], complete: true, expected: 2 })
  })

  // A buffer disappears through an ordinary disconnect or a bounded-session
  // eviction, and what it held cannot be had again without re-running.
  it('reports a drain the expired buffer could not finish', async () => {
    const fetchRows = vi.fn((_session: string, offset: number) =>
      Promise.resolve(offset === 0
        ? { success: true as const, rows: Array.from({ length: 100 }, (_, index) => [index]) }
        : { success: false as const, error: 'Result buffer expired' }),
    )
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { fetchRows }
    const { controller } = controllerFor(
      { columns: ['n'], rows: [[0]], rowCount: 400, durationMs: 1, sessionId: 's1', bufferedRowCount: 400 },
    )

    const drained = await controller.rows(400)
    // What survived, not the loaded prefix the caller started from.
    expect(drained).toMatchObject({ complete: false, expected: 400 })
    expect(drained.rows).toHaveLength(100)
  })

  // A buffer holding fewer rows than it advertised leaves the caller short by
  // the same amount, so it is short by the same rule.
  it('reports a buffer that runs out before the rows it promised', async () => {
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      fetchRows: vi.fn((_session: string, offset: number) =>
        Promise.resolve({ success: true as const, rows: offset === 0 ? [[1], [2]] : [] })),
    }
    const { controller } = controllerFor(
      { columns: ['n'], rows: [[1]], rowCount: 10, durationMs: 1, sessionId: 's1', bufferedRowCount: 10 },
    )
    expect(await controller.rows(10)).toMatchObject({ complete: false, expected: 10 })
  })
})

// Main reports a refused write and the IPC call itself can reject; the file the
// user asked for is not on disk either way, so neither may pass in silence.
describe('ResultExportController file writes', () => {
  const result: QueryResult = { columns: ['n'], rows: [[1]], rowCount: 1, durationMs: 1 }
  const confirm = async (exportFile: unknown) => {
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { exportFile }
    const { controller, notice } = controllerFor(result)
    await controller.confirm({ format: 'csv', rows: 1, stream: false })
    return notice
  }

  it('reports a write the main process refused', async () => {
    const notice = await confirm(vi.fn(() => Promise.resolve({ success: false, error: 'EACCES: permission denied' })))
    expect(notice).toHaveBeenCalledWith('Export failed', 'EACCES: permission denied')
  })

  it('reports a rejected call instead of leaving it unhandled', async () => {
    const notice = await confirm(vi.fn(() => Promise.reject(new Error('IPC channel closed'))))
    expect(notice).toHaveBeenCalledWith('Export failed', 'IPC channel closed')
  })

  it('names the file, and the failure, even when main answers with neither', async () => {
    const notice = await confirm(vi.fn(() => Promise.resolve({ success: false })))
    expect(notice).toHaveBeenCalledWith('Export failed', 'The file could not be written.')
  })

  it('says nothing when the user cancels the save dialog', async () => {
    const notice = await confirm(vi.fn(() => Promise.resolve({ success: false, canceled: true })))
    expect(notice).not.toHaveBeenCalled()
  })

  it('writes the chosen format, and closes the dialog behind it', async () => {
    const exportFile = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { exportFile }
    const { controller } = controllerFor(result)
    controller.dialogOpen = true
    await controller.confirm({ format: 'csv', rows: 1, stream: false })
    expect(exportFile).toHaveBeenCalledWith('results.csv', 'n\n1')
    expect(controller.dialogOpen).toBe(false)
  })

  // A short export used to be written out under an ordinary name, where nothing
  // downstream could tell it from the whole result.
  it('writes no file at all when the buffer expired mid-drain', async () => {
    const exportFile = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      exportFile,
      fetchRows: vi.fn(() => Promise.resolve({ success: false as const, error: 'Result buffer expired' })),
    }
    const { controller, notice } = controllerFor(
      { columns: ['n'], rows: [[1]], rowCount: 900, durationMs: 1, sessionId: 's1', bufferedRowCount: 900 },
    )

    await controller.confirm({ format: 'csv', rows: 900, stream: false })

    expect(exportFile).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith(
      'Result buffer expired',
      'Only 0 of 900 rows are still available, so no file was written. Re-run the query to export the whole result.',
    )
  })

  it('copies nothing, and says so, when the buffer expired mid-drain', async () => {
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      fetchRows: vi.fn((_session: string, offset: number) =>
        Promise.resolve(offset === 0
          ? { success: true as const, rows: [[1], [2]] }
          : { success: false as const, error: 'Result buffer expired' })),
    }
    const { controller, notice } = controllerFor(
      { columns: ['n'], rows: [[1]], rowCount: 5000, durationMs: 1, sessionId: 's1', bufferedRowCount: 5000 },
    )

    expect(await controller.copyAll('csv')).toBeNull()
    expect(notice).toHaveBeenCalledWith(
      'Result buffer expired',
      'Only 2 of 5,000 rows are still available, so nothing was copied. Re-run the query to copy the whole result.',
    )
  })

  // A streamed export re-runs the query in the main process, so it leaves the
  // grid entirely rather than writing the rows the buffer happens to hold.
  it('hands a streamed export to the owner and writes nothing itself', async () => {
    const exportFile = vi.fn()
    ;(window as unknown as { sqlkit: unknown }).sqlkit = { exportFile }
    const { controller, streamExport } = controllerFor(result)
    await controller.confirm({ format: 'json', rows: 1, stream: true })
    expect(streamExport).toHaveBeenCalledWith('json')
    expect(exportFile).not.toHaveBeenCalled()
  })
})


describe('ResultExportController result switching', () => {
  it.each(['csv', 'json', 'sql'] as const)('keeps the original metadata for %s export and copy', async (format) => {
    for (const copy of [false, true]) {
      let result: QueryResult = { columns: ['original'], rows: [], rowCount: 1, durationMs: 1, sessionId: 'old', bufferedRowCount: 1 }
      let target = { engine: 'postgresql' as const, table: { schema: 'public', name: 'original_table', kind: 'table' as const } }
      const jsonColumns = new Set([0])
      let finish!: (value: { success: true; rows: string[][] }) => void
      const exportFile = vi.fn((_name: string, _content: string) => Promise.resolve({ success: true }))
      ;(window as unknown as { sqlkit: unknown }).sqlkit = {
        fetchRows: vi.fn(() => new Promise(resolve => { finish = resolve })), exportFile,
      }
      const controller = new ResultExportController(fakeHost(), {
        result: () => result, sqlTarget: () => target, jsonColumns: () => jsonColumns,
        streamExport: vi.fn(), notice: vi.fn(),
      })
      const pending = copy ? controller.copyAll(format) : controller.confirm({ format, rows: 1, stream: false })
      result = { columns: ['different'], rows: [[99]], rowCount: 1, durationMs: 1 }
      target = { ...target, table: { ...target.table, name: 'different_table' } }
      jsonColumns.clear()
      finish({ success: true, rows: [['{"n":1}']] })
      const copied = await pending
      const content = copy ? copied : exportFile.mock.calls[0]?.[1]
      expect(content).toContain('original')
      expect(content).not.toContain('different')
      if (format === 'sql') expect(content).toContain('original_table')
      if (format === 'json') expect(JSON.parse(content as string)).toEqual([{ original: { n: 1 } }])
    }
  })
})
