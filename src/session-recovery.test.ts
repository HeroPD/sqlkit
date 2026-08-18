import { describe, expect, it } from 'vitest'
import type { SessionContext, SessionTab } from './electron'
import { recoverableContexts } from './session-recovery'

const sqlTab = (over: Partial<Extract<SessionTab, { kind: 'sql' }>>): SessionTab =>
  ({ kind: 'sql', id: 'tab-1', name: 'Untitled-1', path: null, ...over })

const context = (tabs: SessionTab[], activeTabId = tabs[0]?.id ?? null): SessionContext =>
  ({ profileId: 'p1', childDb: null, tabs, activeTabId, selectedTable: null })

describe('recoverableContexts', () => {
  it('passes everything through when every buffer is accounted for', () => {
    const contexts = [context([sqlTab({ dirty: true })])]
    expect(recoverableContexts(contexts, new Set())).toBe(contexts)
  })

  it('drops an untitled tab whose buffer is nowhere', () => {
    const result = recoverableContexts([context([sqlTab({ id: 'gone' })])], new Set(['gone']))
    expect(result).toEqual([])
  })

  it('keeps a file-backed tab but stops calling it dirty', () => {
    const result = recoverableContexts(
      [context([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql', dirty: true })])],
      new Set(['file:/ws/a.sql']),
    )
    expect(result[0]?.tabs[0]).toEqual({ kind: 'sql', id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql' })
  })

  it('moves the active pointer off a tab it dropped', () => {
    const result = recoverableContexts(
      [context([sqlTab({ id: 'keep', path: '/ws/a.sql' }), sqlTab({ id: 'gone' })], 'gone')],
      new Set(['gone']),
    )
    expect(result[0]?.tabs.map((tab) => tab.id)).toEqual(['keep'])
    expect(result[0]?.activeTabId).toBe('keep')
  })

  it('leaves tabs that are not editors alone', () => {
    const config: SessionTab = { kind: 'config', id: 'p1', profileId: 'p1' }
    const result = recoverableContexts([context([config, sqlTab({ id: 'gone' })], 'p1')], new Set(['gone', 'p1']))
    expect(result[0]?.tabs).toEqual([config])
  })
})
