// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest'
import { startCompletion, completionStatus } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { stubEditorLayout } from '../test/dom-stubs'
import './sql-editor'
import type { SqlEditor } from './sql-editor'

beforeAll(stubEditorLayout)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Opens completion at the end of `doc` and returns the option labels.
async function completionsAt(doc: string) {
  const el = document.createElement('sql-editor') as SqlEditor
  el.tabId = `completion:${doc}`
  el.value = doc
  el.tables = ['postings', 'users']
  el.columns = [
    { schema: null, table: 'postings', name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
    { schema: null, table: 'postings', name: 'item_count', dataType: 'integer', nullable: true, primaryKey: false },
    { schema: null, table: 'users', name: 'user_name', dataType: 'text', nullable: true, primaryKey: false },
  ]
  document.body.append(el)
  await el.updateComplete
  const view = (el as unknown as { _view: EditorView })._view
  view.dispatch({ selection: { anchor: doc.length } })
  startCompletion(view)
  for (let i = 0; i < 20 && completionStatus(view.state) !== 'active'; i++) await sleep(25)
  const labels = [...el.shadowRoot!.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(
    (label) => label.textContent,
  )
  el.remove()
  return labels
}

test('table. completes its columns', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE postings.i')).toEqual(['id', 'item_count'])
})

test('FROM/JOIN alias resolves to the aliased table', async () => {
  expect(await completionsAt('SELECT * FROM postings pg WHERE pg.i')).toEqual(['id', 'item_count'])
  expect(await completionsAt('SELECT * FROM postings AS pg JOIN users u ON u.us')).toEqual(['user_name'])
})

test('unbound prefix falls back to the unique matching table', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE p.i')).toEqual(['id', 'item_count'])
})

test('ambiguous or unknown prefix completes nothing', async () => {
  // matches neither a table, an alias, nor a unique prefix
  expect(await completionsAt('SELECT * FROM postings WHERE x.i')).toEqual([])
})

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
