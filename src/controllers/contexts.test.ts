// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import { ContextsController } from './contexts'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

// Mirrors the workbench's contextKey so instance stashing keys line up.
const contextKey = (profileId: string | null, childDb: string | null) =>
  profileId === null ? '__none__' : `${profileId}:${childDb ?? ''}`

const make = () => {
  const dropQuery = vi.fn()
  const ctrl = new ContextsController(host(), { contextKey, dropQuery })
  return { ctrl, dropQuery }
}

describe('ContextsController.switchInstance', () => {
  it('stashes the outgoing context and restores it on return', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    const home = ctrl.activeTabId

    ctrl.switchInstance('p1', null)
    expect(ctrl.tabs).toEqual([]) // a fresh context starts empty
    expect(ctrl.activeDbId).toBe('p1')

    ctrl.newQuery()
    expect(ctrl.tabs).toHaveLength(1)

    ctrl.switchInstance(null, null)
    expect(ctrl.tabs).toHaveLength(1) // the home context's tab is back
    expect(ctrl.activeTabId).toBe(home)
  })

  it('is a no-op when the target context is already active', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    const before = ctrl.tabs
    ctrl.switchInstance(null, null) // same key as the initial context
    expect(ctrl.tabs).toBe(before)
  })

  // Browsing databases must not leave a stash entry per context visited: an
  // empty instance restores identically to none at all.
  it('does not stash a context that has nothing open', () => {
    const { ctrl } = make()
    const internals = ctrl as never as { _instances: Map<string, unknown> }

    for (let i = 0; i < 50; i += 1) ctrl.switchInstance('p1', `child-${i}`)

    expect(internals._instances.size).toBe(0)
  })

  it('still stashes a context whose only state is an Explorer selection', () => {
    const { ctrl } = make()
    const internals = ctrl as never as { _instances: Map<string, unknown> }
    ctrl.switchInstance('p1', 'db_a')
    ctrl.selectedTable = 'public.users'

    ctrl.switchInstance('p1', 'db_b')
    expect(internals._instances.size).toBe(1)

    ctrl.switchInstance('p1', 'db_a')
    expect(ctrl.selectedTable).toBe('public.users')
  })

  it('forgets a stashed context once its last tab closes', () => {
    const { ctrl } = make()
    const internals = ctrl as never as { _instances: Map<string, unknown> }
    ctrl.switchInstance('p1', 'db_a')
    ctrl.newQuery()
    const id = ctrl.activeTabId!
    ctrl.switchInstance('p1', 'db_b')
    expect(internals._instances.size).toBe(1)

    ctrl.switchInstance('p1', 'db_a')
    ctrl.closeTab(id)
    ctrl.switchInstance('p1', 'db_b')

    expect(internals._instances.size).toBe(0)
  })
})

describe('ContextsController.closeTab', () => {
  it('reassigns the active tab to a neighbor and drops its query', () => {
    const { ctrl, dropQuery } = make()
    ctrl.newQuery()
    ctrl.newQuery()
    ctrl.newQuery()
    const [a, b, c] = ctrl.tabs.map((t) => t.id)

    ctrl.closeTab(c!) // closing the active (last) tab
    expect(dropQuery).toHaveBeenCalledWith(c)
    expect(ctrl.tabs.map((t) => t.id)).toEqual([a, b])
    expect(ctrl.activeTabId).toBe(b)
  })

  it('leaves the active tab alone when closing a different one', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    ctrl.newQuery()
    const [a, b] = ctrl.tabs.map((t) => t.id)
    ctrl.activeTabId = b!

    ctrl.closeTab(a!)
    expect(ctrl.activeTabId).toBe(b)
  })
})

describe('ContextsController.newQuery', () => {
  it('numbers untitled queries by how many are open', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    ctrl.newQuery()
    expect(ctrl.tabs.map((t) => t.kind === 'sql' && t.name)).toEqual(['Untitled-1', 'Untitled-2'])
  })
})

describe('ContextsController.replaceTabInContext', () => {
  const draft = { id: 'create-1', kind: 'inspect' as const, profileId: 'p1', table: { schema: 'public', name: 'new_table', kind: 'table' as const }, createTable: true }
  const created = { id: 'inspect-projects', kind: 'inspect' as const, profileId: 'p1', table: { schema: 'public', name: 'projects', kind: 'table' as const } }

  it('replaces and activates a create draft in the live context', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', 'app')
    ctrl.addTab(draft)

    ctrl.replaceTabInContext('p1', 'app', draft.id, created)

    expect(ctrl.tabs).toEqual([created])
    expect(ctrl.activeTabId).toBe(created.id)
  })

  it('replaces a draft after its database context was switched away', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', 'app')
    ctrl.addTab(draft)
    ctrl.switchInstance('p1', 'other')

    ctrl.replaceTabInContext('p1', 'app', draft.id, created)
    ctrl.switchInstance('p1', 'app')

    expect(ctrl.tabs).toEqual([created])
    expect(ctrl.activeTabId).toBe(created.id)
  })
})

describe('ContextsController preview tabs', () => {
  it('recycles the open preview tab, then pins it once edited', () => {
    const { ctrl } = make()
    ctrl.openPreview('select 1')
    const id = ctrl.activeTabId
    expect(ctrl.tabs).toHaveLength(1)

    ctrl.openPreview('select 2') // recycles the same preview tab
    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeTabId).toBe(id)
    expect(ctrl.activeSqlTab()?.content).toBe('select 2')

    ctrl.setActiveContent('select 2 edited') // editing promotes to permanent
    ctrl.openPreview('select 3') // no preview to recycle → a new tab
    expect(ctrl.tabs).toHaveLength(2)
  })
})

describe('ContextsController.openPermanent', () => {
  it('promotes the matching preview tab in place instead of opening a new one', () => {
    const { ctrl } = make()
    ctrl.openPreview('select 1')
    const id = ctrl.activeTabId
    expect(ctrl.activeSqlTab()?.preview).toBe(true)

    ctrl.openPermanent('select 1')
    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeTabId).toBe(id)
    expect(ctrl.activeSqlTab()?.preview).toBe(false)
  })

  it('opens a fresh permanent tab when no preview holds the sql', () => {
    const { ctrl } = make()
    ctrl.openPermanent('select 42')
    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeSqlTab()?.content).toBe('select 42')
    expect(ctrl.activeSqlTab()?.preview).toBeFalsy()
  })

  // Double-clicking the same history row repeatedly used to stack one identical
  // History.sql tab per click, because only *preview* tabs were considered.
  it('refocuses the already-pinned tab instead of stacking copies', () => {
    const { ctrl } = make()
    ctrl.openPermanent('select 7')
    const id = ctrl.activeTabId

    for (let i = 0; i < 4; i += 1) ctrl.openPermanent('select 7')

    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeTabId).toBe(id)
  })

  it('still opens a separate tab per distinct sql', () => {
    const { ctrl } = make()
    ctrl.openPermanent('select 7')
    ctrl.openPermanent('select 8')
    expect(ctrl.tabs).toHaveLength(2)
  })

  it('focuses a pinned tab rather than previewing the same sql again', () => {
    const { ctrl } = make()
    ctrl.openPermanent('select 7')
    const id = ctrl.activeTabId

    ctrl.openPreview('select 7')

    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeTabId).toBe(id)
    expect(ctrl.activeSqlTab()?.preview).toBeFalsy() // stays pinned
  })

  // Reuse is keyed on an untouched tab, so a draft the user typed into is safe
  // even when its text happens to match the history entry.
  it('does not hijack an edited Untitled tab with matching text', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    const untitled = ctrl.activeTabId
    ctrl.setActiveContent('select 7')

    ctrl.openPermanent('select 7')

    expect(ctrl.tabs).toHaveLength(2)
    expect(ctrl.activeTabId).not.toBe(untitled)
  })
})

describe('ContextsController.removeProfile', () => {
  it('scrubs the profile config tab from the live strip and stashes', () => {
    const { ctrl } = make()
    // A config tab for p1 open in the home context.
    ctrl.openConfigTab({ id: 'p1', name: 'Local' } as never)
    expect(ctrl.tabs.some((t) => t.id === 'p1')).toBe(true)

    // Stash a context belonging to p1.
    ctrl.switchInstance('p1', null)
    ctrl.newQuery()
    ctrl.switchInstance(null, null)

    ctrl.removeProfile('p1')
    expect(ctrl.tabs.some((t) => t.id === 'p1')).toBe(false)
    // Its stashed context is gone too: switching back starts empty.
    ctrl.switchInstance('p1', null)
    expect(ctrl.tabs).toEqual([])
  })
})

describe('ContextsController.tabExists', () => {
  it('finds tabs in the live set and in stashed contexts', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    const live = ctrl.activeTabId!
    ctrl.switchInstance('p1', null) // stashes the home context
    expect(ctrl.tabExists(live)).toBe(true) // still belongs to a stashed context
    expect(ctrl.tabExists('nope')).toBe(false)
  })
})

// Browse tabs and object-DDL tabs are also unsaved with content === savedContent,
// so reuse keyed on text alone sent a history pick into one of them — the pick
// silently focused another tab instead of opening its own.
describe('ContextsController history picks keep to their own tab', () => {
  const browseTab = (sql: string) => ({
    id: 'browse:events',
    kind: 'sql' as const,
    name: 'events.sql',
    path: null,
    content: sql,
    savedContent: sql,
    table: { schema: null, name: 'events', kind: 'table' as const },
  })

  it('opens a History tab rather than focusing a browse tab with the same sql', () => {
    const { ctrl } = make()
    const sql = 'SELECT * FROM "events" LIMIT 200'
    ctrl.addTab(browseTab(sql))

    ctrl.openPreview(sql)

    expect(ctrl.tabs).toHaveLength(2)
    const active = ctrl.activeSqlTab()
    expect(active?.name).toBe('History.sql')
    expect(active?.history).toBe(true)
    expect(active?.table).toBeUndefined()
  })

  it('does the same for a double-click', () => {
    const { ctrl } = make()
    const sql = 'SELECT * FROM "events" LIMIT 200'
    ctrl.addTab(browseTab(sql))

    ctrl.openPermanent(sql)

    expect(ctrl.tabs).toHaveLength(2)
    expect(ctrl.activeSqlTab()?.history).toBe(true)
    expect(ctrl.activeSqlTab()?.preview).toBeFalsy()
  })

  it('leaves an object-DDL tab alone too', () => {
    const { ctrl } = make()
    const sql = 'CREATE FUNCTION f() RETURNS void AS $$ $$;'
    // Same shape as the object-DDL tab the workbench opens: unsaved, untouched.
    ctrl.addTab({ id: 'ddl:f', kind: 'sql', name: 'f.sql', path: null, content: sql, savedContent: sql })

    ctrl.openPreview(sql)

    expect(ctrl.tabs).toHaveLength(2)
    expect(ctrl.activeSqlTab()?.history).toBe(true)
  })

  it('recycles only the History tab, never a browse tab', () => {
    const { ctrl } = make()
    ctrl.addTab(browseTab('SELECT * FROM "events" LIMIT 200'))
    ctrl.openPreview('select 1')
    const historyId = ctrl.activeTabId

    ctrl.openPreview('select 2')

    expect(ctrl.tabs).toHaveLength(2)
    expect(ctrl.activeTabId).toBe(historyId)
    expect(ctrl.activeSqlTab()?.content).toBe('select 2')
    // The browse tab kept its own sql.
    expect(ctrl.tabs.find((tab) => tab.id === 'browse:events')).toMatchObject({
      content: 'SELECT * FROM "events" LIMIT 200',
    })
  })
})

describe('ContextsController session round trip', () => {
  it('carries every context, the active tab, and the dirty marker', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.newQuery()
    ctrl.setActiveContent('select 1')
    ctrl.switchInstance('p1', 'billing')
    ctrl.addTab({ id: 'file:/ws/a.sql', kind: 'sql', name: 'a.sql', path: '/ws/a.sql', content: 'x', savedContent: 'x' })
    ctrl.selectedTable = 'public.users'

    const session = ctrl.toSession()
    // The database context each bucket belongs to, stored as its parts.
    expect(session.map((context) => `${context.profileId}/${context.childDb ?? ''}`).sort())
      .toEqual(['p1/', 'p1/billing'])

    const edited = session.find((context) => context.childDb === null)
    expect(edited?.tabs[0]).toMatchObject({ kind: 'sql', path: null, dirty: true })
    expect(edited?.activeTabId).toBe(edited?.tabs[0]?.id)

    const saved = session.find((context) => context.childDb === 'billing')
    expect(saved?.tabs[0]).toMatchObject({ kind: 'sql', path: '/ws/a.sql' })
    expect(saved?.tabs[0]).not.toHaveProperty('dirty')
    expect(saved?.selectedTable).toBe('public.users')
  })

  it('leaves out contexts with nothing open', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.switchInstance('p2', null)
    expect(ctrl.toSession()).toEqual([])
  })

  it('never carries a password out of a config tab', () => {
    const { ctrl } = make()
    ctrl.openConfigTab({
      id: 'p1',
      name: 'prod',
      engine: 'postgresql',
      host: 'db',
      port: '5432',
      username: 'app',
      password: 'hunter2',
      database: 'app',
      file: '',
      folder: 'prod',
      ssh: { enabled: true, host: 'bastion', port: '22', username: 'ops', authType: 'password', password: 's3cret', keyPath: '', passphrase: 'k3y' },
    })

    const [tab] = ctrl.toSession()[0]!.tabs
    expect(tab).toMatchObject({ kind: 'config', profileId: 'p1' })
    expect(JSON.stringify(tab)).not.toContain('hunter2')
    expect(JSON.stringify(tab)).not.toContain('s3cret')
    expect(JSON.stringify(tab)).not.toContain('k3y')
  })

  it('restores the current context live, not just into the stash', () => {
    const { ctrl } = make()
    // The startup case: nothing switched yet, so the live key and the target
    // key are both the no-context key and switchInstance would return early.
    ctrl.hydrate([
      { profileId: null, childDb: null, tabs: [{ id: 't1', kind: 'sql', name: 'Untitled-1', path: null, content: 'select 1', savedContent: '' }], activeTabId: 't1', selectedTable: null },
      { profileId: 'p1', childDb: null, tabs: [{ id: 't2', kind: 'sql', name: 'a.sql', path: '/ws/a.sql', content: 'x', savedContent: 'x' }], activeTabId: 't2', selectedTable: null },
    ])

    expect(ctrl.tabs).toHaveLength(1)
    expect(ctrl.activeTabId).toBe('t1')

    ctrl.switchInstance('p1', null)
    expect(ctrl.activeSqlTab()).toMatchObject({ id: 't2', path: '/ws/a.sql' })

    ctrl.switchInstance(null, null)
    expect(ctrl.activeSqlTab()).toMatchObject({ id: 't1', content: 'select 1' })
  })

  it('replaces whatever was open when a session is hydrated', () => {
    const { ctrl } = make()
    ctrl.newQuery()
    ctrl.hydrate([])
    expect(ctrl.tabs).toEqual([])
    expect(ctrl.activeTabId).toBeNull()
  })
})

describe('ContextsController.sessionBuffers', () => {
  const browse = (sql: string) => ({
    id: 'browse:events',
    kind: 'sql' as const,
    name: 'events.sql',
    path: null,
    content: sql,
    savedContent: sql,
    table: { schema: null, name: 'events', kind: 'table' as const },
  })

  it('offers the SQL of tabs the user never typed in', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    // A browse tab and a History pick: content set programmatically, so no
    // editor event ever reports them.
    ctrl.addTab(browse('SELECT * FROM "events" LIMIT 200'))
    ctrl.openPermanent('select 99')

    const buffers = ctrl.sessionBuffers()
    expect(buffers.get('browse:events')).toBe('SELECT * FROM "events" LIMIT 200')
    expect([...buffers.values()]).toContain('select 99')
  })

  it('leaves out an empty untitled tab and a clean saved file', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.newQuery()
    ctrl.addTab({ id: 'file:/ws/a.sql', kind: 'sql', name: 'a.sql', path: '/ws/a.sql', content: 'x', savedContent: 'x' })
    expect(ctrl.sessionBuffers().size).toBe(0)
  })

  it('offers a saved file once its buffer moves away from disk', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.addTab({ id: 'file:/ws/a.sql', kind: 'sql', name: 'a.sql', path: '/ws/a.sql', content: 'x', savedContent: 'x' })
    ctrl.setActiveContent('x edited')
    expect(ctrl.sessionBuffers().get('file:/ws/a.sql')).toBe('x edited')
  })

  it('covers stashed contexts as well as the live one', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.addTab(browse('SELECT * FROM "events"'))
    ctrl.switchInstance('p1', 'billing')
    ctrl.openPermanent('select 7')

    expect(ctrl.sessionBuffers().get('browse:events')).toBe('SELECT * FROM "events"')
    expect([...ctrl.sessionBuffers().values()]).toContain('select 7')
  })

  it('prefers the live strip over the stale stash entry for its own context', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.newQuery()
    ctrl.setActiveContent('first')
    // Switching away stashes p1 and leaves that entry in place on the way back,
    // so the stash still holds the old text.
    ctrl.switchInstance('p2', null)
    ctrl.switchInstance('p1', null)
    ctrl.setActiveContent('second')

    expect([...ctrl.sessionBuffers().values()]).toEqual(['second'])
  })
})

describe('ContextsController.tabName', () => {
  it('finds a tab in the live strip and in a stashed context', () => {
    const { ctrl } = make()
    ctrl.switchInstance('p1', null)
    ctrl.addTab({ id: 'file:/ws/a.sql', kind: 'sql', name: 'a.sql', path: '/ws/a.sql', content: '', savedContent: '' })
    ctrl.switchInstance('p1', 'billing')
    ctrl.newQuery()

    expect(ctrl.tabName('file:/ws/a.sql')).toBe('a.sql')
    expect(ctrl.tabName(ctrl.activeTabId!)).toBe('Untitled-1')
    expect(ctrl.tabName('nothing')).toBeNull()
  })
})
