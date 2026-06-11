// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest'
import { stubEditorLayout } from '../test/dom-stubs'
import './sql-editor'
import type { SqlEditor } from './sql-editor'

beforeAll(stubEditorLayout)

const text = (el: SqlEditor) => el.shadowRoot!.querySelector('.cm-content')!.textContent ?? ''

async function mount(tabId: string, value: string) {
  const el = document.createElement('sql-editor') as SqlEditor
  el.tabId = tabId
  el.value = value
  document.body.append(el)
  await el.updateComplete
  return el
}

test('renders the doc and swaps state per tab, restoring on switch back', async () => {
  const el = await mount('tab-a', 'select 1;')
  expect(text(el)).toContain('select 1;')

  el.tabId = 'tab-b'
  el.value = 'select 2;'
  await el.updateComplete
  expect(text(el)).toContain('select 2;')
  expect(text(el)).not.toContain('select 1;')

  el.tabId = 'tab-a'
  el.value = 'select 1;'
  await el.updateComplete
  expect(text(el)).toContain('select 1;')
  el.remove()
})

test('external rewrite of the active tab replaces the doc', async () => {
  const el = await mount('tab-preview', 'old query;')
  el.value = 'new query;'
  await el.updateComplete
  expect(text(el)).toContain('new query;')
  expect(text(el)).not.toContain('old query;')
  el.remove()
})

test('a changed doc under a reused tab id is not resurrected from cache', async () => {
  const first = await mount('tab-reuse', 'original;')
  first.remove()

  const second = await mount('tab-reuse', 'rewritten;')
  expect(text(second)).toContain('rewritten;')
  expect(text(second)).not.toContain('original;')
  second.remove()
})
