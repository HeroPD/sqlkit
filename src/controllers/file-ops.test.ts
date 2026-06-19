// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { FileInfo } from '../electron'
import type { FilesController } from './files'
import type { QueriesController } from './queries'
import { ContextsController } from './contexts'
import { DialogsController } from './dialogs'
import { FileOpsController } from './file-ops'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const contextKey = (profileId: string | null, childDb: string | null) =>
  profileId === null ? '__none__' : `${profileId}:${childDb ?? ''}`

const fileInfo = (path: string, name = path.split('/').pop() ?? path): FileInfo =>
  ({ type: 'file', name, path, relativePath: name })

const defer = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

const make = (over: { contextFolder?: string | null; listing?: FileInfo[] } = {}) => {
  const folder = 'contextFolder' in over ? (over.contextFolder ?? null) : '/ws/ctx'
  const ctx = new ContextsController(host(), { contextKey, dropQuery: vi.fn() })
  const files = {
    files: [] as FileInfo[],
    reload: vi.fn(() => {
      files.files = over.listing ?? []
      return Promise.resolve()
    }),
  }
  const queries = { renameTab: vi.fn(), sweepOrphans: vi.fn() } as unknown as QueriesController
  const dialogs = new DialogsController(host())
  const ctrl = new FileOpsController({
    ctx,
    files: files as unknown as FilesController,
    queries,
    dialogs,
    contextFolder: () => folder,
  })
  return { ctrl, ctx, files, queries, dialogs }
}

function stubSqlkit(over: Record<string, unknown> = {}) {
  const api = {
    readFile: vi.fn(() => Promise.resolve({ success: true, content: 'select 1' })),
    openExternal: vi.fn(() => Promise.resolve({ success: true })),
    saveFile: vi.fn(() => Promise.resolve({ success: true, path: '/ws/ctx/q.sql', name: 'q.sql' })),
    saveFileAs: vi.fn(() => Promise.resolve({ success: true, path: '/ws/ctx/Untitled-1.sql', name: 'Untitled-1.sql' })),
    createFile: vi.fn(() => Promise.resolve({ success: true, path: '/ws/ctx/new.sql', name: 'new.sql' })),
    renameFile: vi.fn(() => Promise.resolve({ success: true, path: '/ws/ctx/new.sql', name: 'new.sql' })),
    deleteFile: vi.fn(() => Promise.resolve({ success: true })),
    ...over,
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api
  return api
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FileOpsController.openFile', () => {
  it('reads a file and opens it as the active tab', async () => {
    stubSqlkit({ readFile: vi.fn(() => Promise.resolve({ success: true, content: 'select 42' })) })
    const { ctrl, ctx } = make()
    await ctrl.openFile(fileInfo('/ws/ctx/q.sql'))
    expect(ctx.tabs).toHaveLength(1)
    expect(ctx.tabs[0]).toMatchObject({ id: 'file:/ws/ctx/q.sql', name: 'q.sql', path: '/ws/ctx/q.sql', content: 'select 42' })
    expect(ctx.activeTabId).toBe('file:/ws/ctx/q.sql')
  })

  it('re-activates an already-open file instead of re-reading it', async () => {
    const readFile = vi.fn(() => Promise.resolve({ success: true, content: 'x' }))
    stubSqlkit({ readFile })
    const { ctrl, ctx } = make()
    const file = fileInfo('/ws/ctx/q.sql')
    await ctrl.openFile(file)
    ctx.activeTabId = null
    await ctrl.openFile(file)
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(ctx.activeTabId).toBe('file:/ws/ctx/q.sql')
  })

  it('opens no tab when the read fails', async () => {
    stubSqlkit({ readFile: vi.fn(() => Promise.resolve({ success: false, error: 'nope' })) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctrl, ctx } = make()
    await ctrl.openFile(fileInfo('/ws/ctx/q.sql'))
    expect(ctx.tabs).toEqual([])
  })

  it('opens a file in the context where the request started after a context switch', async () => {
    const read = defer<{ success: true; content: string }>()
    stubSqlkit({ readFile: vi.fn(() => read.promise) })
    const { ctrl, ctx } = make()
    ctx.switchInstance('p1', 'db_a')

    const opened = ctrl.openFile(fileInfo('/ws/a/q.sql'))
    ctx.switchInstance('p1', 'db_b')
    read.resolve({ success: true, content: 'select 42' })
    await opened

    expect(ctx.tabs).toEqual([])
    ctx.switchInstance('p1', 'db_a')
    expect(ctx.tabs[0]).toMatchObject({ id: 'file:/ws/a/q.sql', content: 'select 42' })
    expect(ctx.activeTabId).toBe('file:/ws/a/q.sql')
  })
})

describe('FileOpsController.openFileOrExternal', () => {
  it('opens .sql files in the editor', async () => {
    const api = stubSqlkit()
    const { ctrl, ctx } = make()
    ctrl.openFileOrExternal(fileInfo('/ws/ctx/q.sql'))
    await vi.waitFor(() => expect(ctx.tabs).toHaveLength(1))
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('hands non-SQL files to the system default app', () => {
    const api = stubSqlkit()
    const { ctrl, ctx } = make()
    ctrl.openFileOrExternal(fileInfo('/ws/ctx/data.csv'))
    expect(api.openExternal).toHaveBeenCalledWith('/ws/ctx/data.csv')
    expect(ctx.tabs).toEqual([])
  })
})

describe('FileOpsController.saveActive', () => {
  it('writes a saved file in place and marks it clean', async () => {
    const api = stubSqlkit()
    const { ctrl, ctx } = make()
    ctx.addTab({ id: 'file:/ws/ctx/q.sql', kind: 'sql', name: 'q.sql', path: '/ws/ctx/q.sql', content: 'select 2', savedContent: 'select 1' })
    await ctrl.saveActive()
    expect(api.saveFile).toHaveBeenCalledWith('/ws/ctx/q.sql', 'select 2')
    expect(ctx.activeSqlTab()?.savedContent).toBe('select 2')
  })

  it('routes an untitled query through Save As into the context folder', async () => {
    const api = stubSqlkit()
    const { ctrl, ctx } = make()
    ctx.newQuery()
    await ctrl.saveActive()
    expect(api.saveFileAs).toHaveBeenCalledWith('/ws/ctx', 'Untitled-1.sql', '')
  })

  it('marks the original context tab clean when save finishes after a context switch', async () => {
    const saved = defer<{ success: true; path: string; name: string }>()
    stubSqlkit({ saveFile: vi.fn(() => saved.promise) })
    const { ctrl, ctx } = make()
    ctx.switchInstance('p1', 'db_a')
    ctx.addTab({ id: 'file:/ws/a/q.sql', kind: 'sql', name: 'q.sql', path: '/ws/a/q.sql', content: 'select 2', savedContent: 'select 1' })

    const saving = ctrl.saveActive()
    ctx.switchInstance('p1', 'db_b')
    saved.resolve({ success: true, path: '/ws/a/q.sql', name: 'q.sql' })
    await saving

    expect(ctx.tabs).toEqual([])
    ctx.switchInstance('p1', 'db_a')
    expect(ctx.activeSqlTab()?.savedContent).toBe('select 2')
  })
})

describe('FileOpsController.create', () => {
  it('creates a file under the context folder', async () => {
    const api = stubSqlkit()
    const { ctrl, files } = make({ listing: [fileInfo('/ws/ctx/new.sql')] })
    await ctrl.create('', 'new.sql')
    expect(api.createFile).toHaveBeenCalledWith('/ws/ctx', 'new.sql')
    expect(files.reload).toHaveBeenCalled()
  })

  it('joins a parent folder into the relative path', async () => {
    const api = stubSqlkit()
    const { ctrl } = make()
    await ctrl.create('reports', 'q.sql')
    expect(api.createFile).toHaveBeenCalledWith('/ws/ctx', 'reports/q.sql')
  })

  it('does nothing without a context folder', async () => {
    const api = stubSqlkit()
    const { ctrl } = make({ contextFolder: null })
    await ctrl.create('', 'x.sql')
    expect(api.createFile).not.toHaveBeenCalled()
  })
})

describe('FileOpsController.rename', () => {
  it('renames the file and retargets its tab and query', async () => {
    stubSqlkit({ readFile: vi.fn(() => Promise.resolve({ success: true, content: 'x' })) })
    const { ctrl, ctx, queries } = make()
    const file = fileInfo('/ws/ctx/old.sql')
    await ctrl.openFile(file)
    await ctrl.rename(file, 'new.sql')
    expect(ctx.tabs[0]).toMatchObject({ id: 'file:/ws/ctx/new.sql', name: 'new.sql', path: '/ws/ctx/new.sql' })
    expect(ctx.activeTabId).toBe('file:/ws/ctx/new.sql')
    expect(queries.renameTab).toHaveBeenCalledWith('file:/ws/ctx/old.sql', 'file:/ws/ctx/new.sql')
  })
})

describe('FileOpsController delete', () => {
  it('confirms, then closes the file tab, sweeps queries, and refreshes', async () => {
    const api = stubSqlkit()
    const { ctrl, ctx, queries, files, dialogs } = make()
    await ctrl.openFile(fileInfo('/ws/ctx/q.sql'))

    ctrl.requestDelete('/ws/ctx/q.sql', 'q.sql')
    expect(dialogs.confirm?.message).toContain('Delete "q.sql"')

    dialogs.acceptConfirm()
    await vi.waitFor(() => expect(api.deleteFile).toHaveBeenCalledWith('/ws/ctx/q.sql'))
    await vi.waitFor(() => expect(ctx.tabs).toEqual([]))
    expect(queries.sweepOrphans).toHaveBeenCalled()
    expect(files.reload).toHaveBeenCalled()
  })
})
