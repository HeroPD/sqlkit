// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { SessionContext } from '../electron'
import { SessionController } from './session'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const context = (tabs: SessionContext['tabs']): SessionContext =>
  ({ profileId: 'p1', childDb: null, tabs, activeTabId: tabs[0]?.id ?? null, selectedTable: null })

const sqlTab = (over: Partial<Extract<SessionContext['tabs'][number], { kind: 'sql' }>> = {}) =>
  ({ kind: 'sql' as const, id: 'tab-1', name: 'Untitled-1', path: null, ...over })

function stubSqlkit(over: Record<string, unknown> = {}) {
  const api = {
    readSession: vi.fn(() => Promise.resolve(null)),
    writeSession: vi.fn(() => Promise.resolve({ success: true })),
    readSessionBackup: vi.fn(() => Promise.resolve(null)),
    writeSessionBackup: vi.fn(() => Promise.resolve({ success: true })),
    dropSessionBackup: vi.fn(() => Promise.resolve()),
    readFile: vi.fn(() => Promise.resolve({ success: true, content: 'on disk' })),
    flushSession: vi.fn(),
    onFlushSession: vi.fn(() => () => {}),
    ...over,
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api
  return api
}

type Overrides = {
  snapshot?: () => SessionContext[]
  buffers?: () => Map<string, string>
  enabled?: () => boolean
  onBackupFailed?: (tabId: string) => void
}

const make = (over: Overrides = {}) => new SessionController(host(), {
  snapshot: over.snapshot ?? (() => [context([sqlTab()])]),
  buffers: over.buffers ?? (() => new Map()),
  enabled: over.enabled ?? (() => true),
  ...(over.onBackupFailed ? { onBackupFailed: over.onBackupFailed } : {}),
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('layout writes', () => {
  it('coalesces a burst of changes into one write', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.scheduleLayoutWrite()
    ctrl.scheduleLayoutWrite()
    ctrl.scheduleLayoutWrite()
    expect(api.writeSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSession).toHaveBeenCalledTimes(1)
  })

  it('skips a write when nothing about the layout changed', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSession).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed write rather than treating it as done', async () => {
    const api = stubSqlkit({ writeSession: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })) })
    const ctrl = make()
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSession).toHaveBeenCalledTimes(2)
  })

  it('writes nothing while no workspace is open', async () => {
    const api = stubSqlkit()
    const ctrl = make({ enabled: () => false })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSession).not.toHaveBeenCalled()
  })
})

describe('buffer backups', () => {
  it('waits for a pause in typing before writing', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.noteBufferChange('tab-1', 'sel', true)
    await vi.advanceTimersByTimeAsync(400)
    ctrl.noteBufferChange('tab-1', 'select', true)
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledWith('tab-1', 'select')
  })

  it('writes anyway when typing never pauses', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    for (let tick = 0; tick < 20; tick += 1) {
      ctrl.noteBufferChange('tab-1', `select ${tick}`, true)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(api.writeSessionBackup).toHaveBeenCalled()
  })

  it('drops the backup once the buffer matches the file again', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.noteBufferChange('tab-1', 'edited', true)
    ctrl.noteBufferChange('tab-1', 'on disk', false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()
    expect(api.dropSessionBackup).toHaveBeenCalledWith('tab-1')
  })

  it('cancels a queued write when the tab closes', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.noteBufferChange('tab-1', 'edited', true)
    ctrl.dropBuffer('tab-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()
    expect(api.dropSessionBackup).toHaveBeenCalledWith('tab-1')
  })

  it('abandons pending writes for a workspace that is being left', async () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.noteBufferChange('tab-1', 'edited', true)
    ctrl.reset()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()
  })
})

// Only the tab being typed in ever reaches noteBufferChange, so a browse tab, a
// History pick or a restored tab would otherwise never be backed up at all.
describe('buffers no edit event reported', () => {
  const withBuffers = (entries: [string, string][]) => make({ buffers: () => new Map(entries) })

  it('backs up a tab the user never typed in', async () => {
    const api = stubSqlkit()
    const ctrl = withBuffers([['browse', 'select * from users']])
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledWith('browse', 'select * from users')
  })

  it('writes the buffer before the session write that prunes unclaimed ones', async () => {
    const api = stubSqlkit()
    const order: string[] = []
    api.writeSessionBackup.mockImplementation(() => {
      order.push('backup')
      return Promise.resolve({ success: true })
    })
    api.writeSession.mockImplementation(() => {
      order.push('session')
      return Promise.resolve({ success: true })
    })
    const ctrl = withBuffers([['browse', 'select 1']])
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(order).toEqual(['backup', 'session'])
  })

  it('writes an unchanged buffer only once', async () => {
    const api = stubSqlkit()
    const ctrl = withBuffers([['browse', 'select 1']])
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledTimes(1)
  })

  it('leaves a tab mid-typing to its own debounce, which holds newer text', async () => {
    const api = stubSqlkit()
    const ctrl = withBuffers([['tab-1', 'stale snapshot text']])
    ctrl.noteBufferChange('tab-1', 'what the user just typed', true)
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600)
    expect(api.writeSessionBackup).toHaveBeenCalledTimes(1)
    expect(api.writeSessionBackup).toHaveBeenCalledWith('tab-1', 'what the user just typed')
  })

  it('does not describe a buffer whose write failed as though it were there', async () => {
    const api = stubSqlkit({ writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })) })
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'browse', name: 'users.sql' })])],
      buffers: () => new Map([['browse', 'select * from users']]),
    })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    const calls = api.writeSession.mock.calls as unknown as [{ contexts: SessionContext[] }][]
    const written = calls.at(-1)?.[0]
    // Nothing on disk holds this tab's text, so a session claiming it would
    // restore blank after a crash.
    expect(written?.contexts.flatMap((c) => c.tabs)).toEqual([])
  })

  it('retries a failed buffer on its own', async () => {
    const api = stubSqlkit({ writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })) })
    const ctrl = make({ buffers: () => new Map([['browse', 'select 1']]) })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2500)
    expect(api.writeSessionBackup.mock.calls.length).toBeGreaterThan(1)
  })

  it('keeps a tab whose file can still reopen it, minus the dirty marker', async () => {
    const api = stubSqlkit({ writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })) })
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql', dirty: true })])],
      buffers: () => new Map([['file:/ws/a.sql', 'edited but unwritable']]),
    })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    const calls = api.writeSession.mock.calls as unknown as [{ contexts: SessionContext[] }][]
    // The file still holds a version worth reopening; claiming it dirty would
    // promise unsaved text that no backup has.
    expect(calls.at(-1)?.[0].contexts[0]?.tabs[0]).toEqual({ kind: 'sql', id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql' })
  })

  it('keeps claiming a tab that still has an older backup behind it', async () => {
    const api = stubSqlkit()
    const buffers = new Map([['browse', 'first version']])
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'browse', name: 'users.sql' })])],
      buffers: () => buffers,
    })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)

    // A newer version that the disk refuses: the older backup is still the
    // user's work, so the session must go on claiming it or the next write
    // would prune it away.
    api.writeSessionBackup.mockImplementation(() => Promise.resolve({ success: false, error: 'disk full' }))
    buffers.set('browse', 'second version')
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    const calls = api.writeSession.mock.calls as unknown as [{ contexts: SessionContext[] }][]
    expect(calls.at(-1)?.[0].contexts[0]?.tabs).toHaveLength(1)
  })

  it('gives up after a few attempts and says so, rather than retrying forever', async () => {
    const api = stubSqlkit({ writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'too large' })) })
    const onBackupFailed = vi.fn()
    const ctrl = make({ buffers: () => new Map([['browse', 'select 1']]), onBackupFailed })
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(api.writeSessionBackup).toHaveBeenCalledTimes(3)
    expect(onBackupFailed).toHaveBeenCalledWith('browse')
  })

  it('retries a buffer whose write was refused', async () => {
    const api = stubSqlkit({ writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'too large' })) })
    const ctrl = withBuffers([['browse', 'select 1']])
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledTimes(2)
  })

  it('carries them through the synchronous flush too', () => {
    const api = stubSqlkit()
    const ctrl = withBuffers([['browse', 'select 1']])
    ctrl.flushOutgoing()
    const [payload] = api.flushSession.mock.calls[0] as [{ backups: { tabId: string; content: string }[] }]
    expect(payload.backups).toEqual([{ tabId: 'browse', content: 'select 1' }])
  })

  it('forgets what a dropped tab had on disk, so a later tab with that id is written', async () => {
    const api = stubSqlkit()
    const ctrl = withBuffers([['browse', 'select 1']])
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    ctrl.dropBuffer('browse')
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).toHaveBeenCalledTimes(2)
  })
})

// A restore reads backups that are already on disk. Forgetting that is how the
// first write after a restore comes to treat them as missing — and prune them.
describe('hydrate seeds what is already on disk', () => {
  const restoredSession = (tab: ReturnType<typeof sqlTab>) => ({ version: 1, contexts: [context([tab])] })

  it('does not rewrite a buffer it just restored', async () => {
    const api = stubSqlkit({
      readSession: vi.fn(() => Promise.resolve(restoredSession(sqlTab({ id: 'browse', name: 'users.sql' })))),
      readSessionBackup: vi.fn(() => Promise.resolve('select * from users')),
    })
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'browse', name: 'users.sql' })])],
      buffers: () => new Map([['browse', 'select * from users']]),
    })
    await ctrl.hydrate()
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.writeSessionBackup).not.toHaveBeenCalled()
  })

  it('keeps claiming a restored tab even when a rewrite of it fails', async () => {
    const api = stubSqlkit({
      readSession: vi.fn(() => Promise.resolve(restoredSession(sqlTab({ id: 'browse', name: 'users.sql' })))),
      readSessionBackup: vi.fn(() => Promise.resolve('recovered sql')),
      writeSessionBackup: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })),
    })
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'browse', name: 'users.sql' })])],
      // The user has since typed, so the text no longer matches the backup.
      buffers: () => new Map([['browse', 'recovered sql, edited']]),
    })
    await ctrl.hydrate()
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)

    const calls = api.writeSession.mock.calls as unknown as [{ contexts: SessionContext[] }][]
    // Dropping the claim would let the write prune the backup holding the
    // recovered text — older than the buffer, but the only copy on disk.
    expect(calls.at(-1)?.[0].contexts[0]?.tabs).toHaveLength(1)
  })

  it('treats a tab restored from its file, with no backup, as unbacked', async () => {
    const api = stubSqlkit({
      readSession: vi.fn(() => Promise.resolve(restoredSession(sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql' })))),
    })
    const ctrl = make({
      snapshot: () => [context([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql' })])],
      buffers: () => new Map([['file:/ws/a.sql', 'edited since']]),
    })
    await ctrl.hydrate()
    ctrl.scheduleLayoutWrite()
    await vi.advanceTimersByTimeAsync(400)
    // Nothing was read off a backup, so the edit has to be written like any other.
    expect(api.writeSessionBackup).toHaveBeenCalledWith('file:/ws/a.sql', 'edited since')
  })
})

describe('flushOutgoing', () => {
  it('writes synchronously even though the workspace is already gone', () => {
    // The workbench calls this from willUpdate, where `workspace` is already
    // null: main still points at the outgoing folder, so this is the last
    // moment the tabs can be written to it.
    const api = stubSqlkit()
    const ctrl = make({ enabled: () => false })
    ctrl.flushOutgoing()
    expect(api.flushSession).toHaveBeenCalledTimes(1)
    const [payload] = api.flushSession.mock.calls[0] as [{ session?: { contexts: SessionContext[] } }]
    expect(payload.session?.contexts).toHaveLength(1)
  })

  it('carries buffers that never reached their debounce', () => {
    const api = stubSqlkit()
    const ctrl = make()
    ctrl.noteBufferChange('tab-1', 'typed a moment ago', true)
    ctrl.flushOutgoing()
    const [payload] = api.flushSession.mock.calls[0] as [{ backups: { tabId: string; content: string }[] }]
    expect(payload.backups).toEqual([{ tabId: 'tab-1', content: 'typed a moment ago' }])
  })
})

describe('hydrate', () => {
  it('restores a saved file with the buffer that never reached it', async () => {
    stubSqlkit({
      readSession: vi.fn(() => Promise.resolve({
        version: 1,
        contexts: [context([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql', dirty: true })])],
      })),
      readSessionBackup: vi.fn(() => Promise.resolve('unsaved edit')),
    })
    const restored = await make().hydrate()
    expect(restored?.buffers.get('file:/ws/a.sql')).toEqual({ content: 'unsaved edit', savedContent: 'on disk', path: '/ws/a.sql' })
  })

  it('reads a clean file back from disk without touching a backup', async () => {
    const api = stubSqlkit({
      readSession: vi.fn(() => Promise.resolve({
        version: 1,
        contexts: [context([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql' })])],
      })),
    })
    const restored = await make().hydrate()
    expect(api.readSessionBackup).not.toHaveBeenCalled()
    expect(restored?.buffers.get('file:/ws/a.sql')).toEqual({ content: 'on disk', savedContent: 'on disk', path: '/ws/a.sql' })
  })

  it('keeps unsaved work when the file behind it has been deleted', async () => {
    stubSqlkit({
      readSession: vi.fn(() => Promise.resolve({
        version: 1,
        contexts: [context([sqlTab({ id: 'file:/ws/gone.sql', name: 'gone.sql', path: '/ws/gone.sql', dirty: true })])],
      })),
      readSessionBackup: vi.fn(() => Promise.resolve('work in progress')),
      readFile: vi.fn(() => Promise.resolve({ success: false, error: 'ENOENT' })),
    })
    const restored = await make().hydrate()
    // Back as an untitled tab: the work survives, the path does not.
    expect(restored?.buffers.get('file:/ws/gone.sql')).toEqual({ content: 'work in progress', savedContent: '', path: null })
  })

  it('drops a tab whose file is gone and had nothing unsaved', async () => {
    stubSqlkit({
      readSession: vi.fn(() => Promise.resolve({
        version: 1,
        contexts: [context([sqlTab({ id: 'file:/ws/gone.sql', name: 'gone.sql', path: '/ws/gone.sql' })])],
      })),
      readFile: vi.fn(() => Promise.resolve({ success: false, error: 'ENOENT' })),
    })
    const restored = await make().hydrate()
    expect(restored?.buffers.size).toBe(0)
  })

  it('restores a clean untitled tab unmarked and an edited one marked', async () => {
    stubSqlkit({
      readSession: vi.fn(() => Promise.resolve({
        version: 1,
        contexts: [context([
          sqlTab({ id: 'browse', name: 'users.sql' }),
          sqlTab({ id: 'typed', name: 'Untitled-1', dirty: true }),
        ])],
      })),
      readSessionBackup: vi.fn((tabId: string) => Promise.resolve(tabId === 'browse' ? 'select * from users' : 'half a query')),
    })
    const restored = await make().hydrate()
    // A browse/History tab was never dirty; it must not come back wearing a dot.
    expect(restored?.buffers.get('browse')).toEqual({ content: 'select * from users', savedContent: 'select * from users', path: null })
    expect(restored?.buffers.get('typed')).toEqual({ content: 'half a query', savedContent: '', path: null })
  })

  it('ignores a session that arrives after the workspace changed', async () => {
    const ctrl = make()
    stubSqlkit({
      readSession: vi.fn(() => {
        ctrl.reset()
        return Promise.resolve({ version: 1, contexts: [context([sqlTab()])] })
      }),
    })
    expect(await ctrl.hydrate()).toBeNull()
  })

  it('has nothing to restore from an empty session', async () => {
    stubSqlkit({ readSession: vi.fn(() => Promise.resolve({ version: 1, contexts: [] })) })
    expect(await make().hydrate()).toBeNull()
  })
})
