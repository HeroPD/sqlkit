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
