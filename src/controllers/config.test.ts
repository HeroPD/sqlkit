// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, ConnectionStatus } from '../electron'
import type { ConnectionsController } from './connections'
import type { DialogsController } from './dialogs'
import { ConfigController } from './config'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const make = (over: { activeDbId?: string | null; statuses?: Record<string, ConnectionStatus> } = {}) => {
  const notice = vi.fn()
  let activeDbId = over.activeDbId ?? null
  const live = { statuses: over.statuses ?? {} } as unknown as ConnectionsController
  const dialogs = { notice } as unknown as DialogsController
  const ctrl = new ConfigController(host(), { live, dialogs, activeDbId: () => activeDbId })
  return { ctrl, notice, setActive: (id: string | null) => (activeDbId = id) }
}

function stubSqlkit(over: Partial<Record<'getWorkspaceConfig' | 'updateWorkspaceConfig', unknown>> = {}) {
  const api = {
    getWorkspaceConfig: vi.fn(() => Promise.resolve({ config: { version: 1, connections: [], activeDbId: null } })),
    updateWorkspaceConfig: vi.fn(() => Promise.resolve({ success: true })),
    ...over,
  }
  ;(window as unknown as { sqlkit: unknown }).sqlkit = api
  return api
}

const withConfig = (connections: ConnectionProfile[], activeDbId: string | null = null) =>
  ({ getWorkspaceConfig: vi.fn(() => Promise.resolve({ config: { version: 1, connections, activeDbId } })) })

const profiles = (): ConnectionProfile[] => [
  { id: 'a', name: 'A', engine: 'postgresql', database: 'postgres', databaseMode: 'all', lastChildDb: 'billing' } as ConnectionProfile,
  { id: 'b', name: 'B', engine: 'sqlite' } as ConnectionProfile,
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConfigController.adoptSharedChanges', () => {
  it('takes a sibling window connections without adopting its active database', async () => {
    const api = stubSqlkit(withConfig(profiles(), 'a'))
    const { ctrl, setActive } = make({ activeDbId: 'b' })
    await ctrl.load()
    setActive('b')

    // The other window added a connection and is on a different database.
    const added = [...profiles(), { id: 'c', name: 'C', engine: 'sqlite' } as ConnectionProfile]
    api.getWorkspaceConfig = vi.fn(() => Promise.resolve({ config: { version: 1, connections: added, activeDbId: 'a' } }))
    await ctrl.adoptSharedChanges()

    expect(ctrl.connections.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    // What this window persists is its own active database — never a connection
    // list that would put back what another window removed.
    ctrl.persist()
    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({ activeDbId: 'b' })
  })

  it('keeps what it has when the config cannot be read', async () => {
    const api = stubSqlkit(withConfig(profiles(), 'a'))
    const { ctrl, notice } = make()
    await ctrl.load()

    api.getWorkspaceConfig = vi.fn(() => Promise.resolve({ config: { version: 1, connections: [], activeDbId: null }, error: 'parse failed' }))
    await ctrl.adoptSharedChanges()

    // A half-read config must not empty the list, and the window that wrote it
    // is the one that reports the failure.
    expect(ctrl.connections.map((c) => c.id)).toEqual(['a', 'b'])
    expect(notice).not.toHaveBeenCalled()
  })
})

describe('ConfigController.load', () => {
  it('sets the profiles and restores the saved active context', async () => {
    stubSqlkit(withConfig(profiles(), 'a'))
    const { ctrl } = make()
    const restore = await ctrl.load()
    expect(ctrl.connections.map((c) => c.id)).toEqual(['a', 'b'])
    // 'a' is all-databases with no live child, so its default is lastChildDb.
    expect(restore).toEqual({ profileId: 'a', child: 'billing' })
  })

  it('falls back to the first profile when the saved active id is unknown', async () => {
    stubSqlkit(withConfig(profiles(), 'gone'))
    const { ctrl } = make()
    expect((await ctrl.load()).profileId).toBe('a')
  })

  it('restores nothing for an empty workspace', async () => {
    stubSqlkit()
    const { ctrl } = make()
    expect(await ctrl.load()).toEqual({ profileId: null, child: null })
    expect(ctrl.connections).toEqual([])
  })

  it('surfaces a read error but still loads the returned config', async () => {
    stubSqlkit({
      getWorkspaceConfig: vi.fn(() => Promise.resolve({ config: { version: 1, connections: [], activeDbId: null }, error: 'parse failed' })),
    })
    const { ctrl, notice } = make()
    await ctrl.load()
    expect(notice).toHaveBeenCalledOnce()
  })

  it('warns once per session when secrets are stored unencrypted', async () => {
    stubSqlkit({
      getWorkspaceConfig: vi.fn(() => Promise.resolve({ config: { version: 1, connections: profiles(), activeDbId: 'a' }, unencryptedSecrets: true })),
    })
    const { ctrl, notice } = make()
    await ctrl.load()
    await ctrl.load()
    expect(notice).toHaveBeenCalledOnce()
    // After a workspace switch the warning can show again.
    ctrl.reset()
    await ctrl.load()
    expect(notice).toHaveBeenCalledTimes(2)
  })

  it('does not warn when secrets are encrypted at rest', async () => {
    stubSqlkit(withConfig(profiles(), 'a'))
    const { ctrl, notice } = make()
    await ctrl.load()
    expect(notice).not.toHaveBeenCalled()
  })
})

describe('ConfigController.defaultChild', () => {
  it('is null for single-database connections', () => {
    const { ctrl } = make()
    expect(ctrl.defaultChild({ databaseMode: 'single', database: 'x' } as ConnectionProfile)).toBeNull()
    expect(ctrl.defaultChild({ database: 'x' } as ConnectionProfile)).toBeNull()
  })

  it('prefers the live in-use child over lastChildDb', () => {
    const { ctrl } = make({
      statuses: {
        a: { profileId: 'a', phase: 'connected', children: [{ name: 'postgres', inUse: false }, { name: 'analytics', inUse: true }] },
      },
    })
    const profile = { id: 'a', databaseMode: 'all', lastChildDb: 'billing', database: 'postgres' } as ConnectionProfile
    expect(ctrl.defaultChild(profile)).toBe('analytics')
  })

  it('falls back to lastChildDb, then the discovery database', () => {
    const { ctrl } = make()
    expect(ctrl.defaultChild({ id: 'a', databaseMode: 'all', lastChildDb: 'billing', database: 'postgres' } as ConnectionProfile)).toBe('billing')
    expect(ctrl.defaultChild({ id: 'a', databaseMode: 'all', database: 'maindb' } as ConnectionProfile)).toBe('maindb')
    expect(ctrl.defaultChild({ id: 'a', databaseMode: 'all', database: '' } as ConnectionProfile)).toBe('postgres')
  })

  it('uses engine-specific discovery defaults when the database is blank', () => {
    const { ctrl } = make()
    const base = { id: 'a', databaseMode: 'all' as const, database: '' }
    expect(ctrl.defaultChild({ ...base, engine: 'postgresql' } as ConnectionProfile)).toBe('postgres')
    expect(ctrl.defaultChild({ ...base, engine: 'sqlserver' } as ConnectionProfile)).toBe('master')
    expect(ctrl.defaultChild({ ...base, engine: 'mysql' } as ConnectionProfile)).toBeNull()
  })
})

describe('ConfigController preferences', () => {
  it('hands current preferences to a new subscriber and every later change', () => {
    const { ctrl } = make()
    const seen: number[] = []
    const stop = ctrl.onPreferences((preferences) => seen.push(preferences.historyRetentionDays))

    expect(seen).toEqual([30])
    ctrl.setPreferences({ saveHistory: true, historyRetentionDays: 7, maxHistoryPerContext: 200 })
    expect(seen).toEqual([30, 7])

    stop()
    ctrl.setPreferences({ saveHistory: true, historyRetentionDays: 90, maxHistoryPerContext: 200 })
    expect(seen).toEqual([30, 7])
  })

  it('announces the defaults again when the workspace closes', () => {
    const { ctrl } = make()
    ctrl.setPreferences({ saveHistory: false, historyRetentionDays: 7, maxHistoryPerContext: 200 })
    const seen: boolean[] = []
    ctrl.onPreferences((preferences) => seen.push(preferences.saveHistory))
    ctrl.reset()
    expect(seen).toEqual([false, true])
  })
})

describe('ConfigController.save', () => {
  it('appends a new profile to the written config without mutating local state', async () => {
    const api = stubSqlkit()
    const { ctrl, setActive } = make()
    setActive('a')
    ctrl.connections = [{ id: 'a', name: 'A' } as ConnectionProfile]
    const profile = { id: 'b', name: 'B' } as ConnectionProfile

    expect(await ctrl.save(profile)).toBe(true)
    // Only the profile being saved: the rest of the file is another window's to
    // have changed.
    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({ upsertConnections: [profile] })
    // The caller re-reads via load(); save itself leaves the list untouched.
    expect(ctrl.connections.map((c) => c.id)).toEqual(['a'])
  })

  it('updates an existing profile in place', async () => {
    const api = stubSqlkit()
    const { ctrl } = make()
    ctrl.connections = [{ id: 'a', name: 'Old' } as ConnectionProfile, { id: 'b', name: 'B' } as ConnectionProfile]

    await ctrl.save({ id: 'a', name: 'New' } as ConnectionProfile)
    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({ upsertConnections: [{ id: 'a', name: 'New' }] })
  })

  it('returns false when the write fails', async () => {
    stubSqlkit({ updateWorkspaceConfig: vi.fn(() => Promise.resolve({ success: false, error: 'disk full' })) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctrl } = make()
    expect(await ctrl.save({ id: 'a' } as ConnectionProfile)).toBe(false)
  })
})

describe('ConfigController profile list', () => {
  it('looks up by id and by the active context', () => {
    const { ctrl, setActive } = make()
    ctrl.connections = profiles()
    expect(ctrl.byId('b')?.name).toBe('B')
    expect(ctrl.byId('nope')).toBeNull()
    expect(ctrl.activeProfile()).toBeNull()
    setActive('a')
    expect(ctrl.activeProfile()?.id).toBe('a')
  })

  it('removes a profile from the list, and says so on disk', async () => {
    const api = stubSqlkit()
    const { ctrl } = make()
    ctrl.connections = profiles()

    await ctrl.remove('a')

    expect(ctrl.connections.map((c) => c.id)).toEqual(['b'])
    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({ removeConnections: ['a'] })
  })

  it('writes only the field a database switch changes, not the whole profile', () => {
    const api = stubSqlkit()
    const { ctrl } = make()
    ctrl.connections = [{ id: 'a', name: 'A', host: 'old-host' } as ConnectionProfile]

    ctrl.setLastChildDb('a', 'billing')

    // Carrying the cached profile here would put this window's stale host back
    // over an edit another window just made.
    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({ lastChildDb: [{ id: 'a', database: 'billing' }] })

    ctrl.clearLastChildDb('a', 'billing')
    expect(api.updateWorkspaceConfig).toHaveBeenLastCalledWith({ lastChildDb: [{ id: 'a', database: null }] })
  })

  it('writes preferences on their own, so a context switch cannot revert them', () => {
    const api = stubSqlkit()
    const { ctrl } = make()

    ctrl.setPreferences({ saveHistory: false, historyRetentionDays: 7, maxHistoryPerContext: 50 })

    expect(api.updateWorkspaceConfig).toHaveBeenCalledWith({
      preferences: { saveHistory: false, historyRetentionDays: 7, maxHistoryPerContext: 50 },
    })
  })

  it('remembers and forgets the last child database', () => {
    const { ctrl } = make()
    ctrl.connections = [{ id: 'a', name: 'A' } as ConnectionProfile]
    ctrl.setLastChildDb('a', 'analytics')
    expect(ctrl.byId('a')?.lastChildDb).toBe('analytics')

    expect(ctrl.clearLastChildDb('a', 'billing')).toBe(false) // not the remembered one
    expect(ctrl.clearLastChildDb('a', 'analytics')).toBe(true)
    expect(ctrl.byId('a')?.lastChildDb).toBeUndefined()
  })

  it('mints a blank postgres profile for the add-database form', () => {
    const { ctrl } = make()
    const blank = ctrl.newProfile()
    expect(blank.engine).toBe('postgresql')
    expect(blank.id).toMatch(/[0-9a-f-]{36}/)
    expect(blank.name).toBe('')
    expect(blank.labelColor).toBe('accent-04')
  })
})
