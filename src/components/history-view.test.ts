// @vitest-environment jsdom
import { render, type TemplateResult } from 'lit'
import { describe, expect, it } from 'vitest'
import type { HistoryItem } from '../electron'
import type { ExplainFlavor } from '../sql-explain'
import { HistoryView, type HistoryExplainDetail } from './history-view'
import type { MenuItem } from './context-menu'

const item: HistoryItem = {
  id: '1',
  contextKey: 'profile:db',
  sql: 'select 1',
  success: true,
  durationMs: 3,
  rowCount: 1,
  error: '',
  createdAt: '2026-08-12T09:00:00.000Z',
}

type Internals = {
  flavors: ExplainFlavor[]
  _menu: { x: number; y: number; item: HistoryItem } | null
  _renderMenu(): TemplateResult | string
  _onMenuPick(action: string, item: HistoryItem): void
}

const menuFor = (flavors: ExplainFlavor[]) => {
  const view = new HistoryView() as unknown as Internals
  view.flavors = flavors
  view._menu = { x: 0, y: 0, item }
  const container = document.createElement('div')
  render(view._renderMenu(), container)
  const menu = container.querySelector('context-menu') as unknown as { items: MenuItem[] }
  return menu.items.map((entry) => entry.id)
}

describe('HistoryView explain menu', () => {
  it('offers only the flavors the live server has', () => {
    expect(menuFor(['plan', 'analyze'])).toEqual(['explain', 'explain-analyze', 'copy-sql'])
    expect(menuFor(['plan'])).toEqual(['explain', 'copy-sql'])
    expect(menuFor([])).toEqual(['copy-sql'])
  })

  it('names the picked flavor in the event the workbench turns into SQL', () => {
    const view = new HistoryView()
    const seen: HistoryExplainDetail[] = []
    view.addEventListener('history-explain', (event) => seen.push((event as CustomEvent<HistoryExplainDetail>).detail))
    const internals = view as unknown as Internals
    internals._onMenuPick('explain', item)
    internals._onMenuPick('explain-analyze', item)
    expect(seen).toEqual([
      { sql: 'select 1', flavor: 'plan' },
      { sql: 'select 1', flavor: 'analyze' },
    ])
  })
})
