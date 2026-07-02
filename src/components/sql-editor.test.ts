// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest'
import { startCompletion, completionStatus, acceptCompletion, moveCompletionSelection } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { stubEditorLayout } from '../test/dom-stubs'
import './sql-editor'
import type { SqlEditor } from './sql-editor'

beforeAll(stubEditorLayout)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Mounts an editor with fixture metadata and opens completion at the end of `doc`.
async function mountCompletion(doc: string) {
  const el = document.createElement('sql-editor')
  el.tabId = `completion:${doc}`
  el.value = doc
  el.tables = [
    { schema: 'public', name: 'postings' },
    { schema: 'public', name: 'users' },
  ]
  el.columns = [
    { schema: 'public', table: 'postings', name: 'id', dataType: 'integer', nullable: false, primaryKey: true, foreignKey: false },
    { schema: 'public', table: 'postings', name: 'item_count', dataType: 'integer', nullable: true, primaryKey: false, foreignKey: false },
    { schema: 'public', table: 'postings', name: 'sort order', dataType: 'integer', nullable: true, primaryKey: false, foreignKey: false },
    { schema: 'public', table: 'users', name: 'user_name', dataType: 'text', nullable: true, primaryKey: false, foreignKey: false },
  ]
  document.body.append(el)
  await el.updateComplete
  const view = (el as unknown as { _view: EditorView })._view
  view.dispatch({ selection: { anchor: doc.length } })
  startCompletion(view)
  for (let i = 0; i < 20 && completionStatus(view.state) !== 'active'; i++) await sleep(25)
  return { el, view }
}

// Opens completion at the end of `doc` and returns the option labels.
async function completionsAt(doc: string) {
  const { el } = await mountCompletion(doc)
  const labels = [...el.shadowRoot!.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(
    (label) => label.textContent,
  )
  el.remove()
  return labels
}

// Accepts the option with `label` and returns the resulting document.
async function acceptAt(doc: string, label: string) {
  const { el, view } = await mountCompletion(doc)
  const selected = () => el.shadowRoot!.querySelector('li[aria-selected] .cm-completionLabel')?.textContent
  for (let i = 0; i < 40 && selected() !== label; i++) moveCompletionSelection(true)(view)
  await sleep(80) // interactionDelay guards against accepting a just-opened tooltip
  acceptCompletion(view)
  const result = view.state.doc.toString()
  el.remove()
  return result
}

test('table. completes its columns', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE postings.i')).toEqual(['id', 'item_count'])
})

test('FROM/JOIN alias resolves to the aliased table', async () => {
  expect(await completionsAt('SELECT * FROM postings pg WHERE pg.i')).toEqual(['id', 'item_count'])
  expect(await completionsAt('SELECT * FROM postings AS pg JOIN users u ON u.us')).toEqual(['user_name'])
})

test('unbound unique prefix expands to table.column', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE p.i')).toEqual(['postings.id', 'postings.item_count'])
  expect(await acceptAt('SELECT * FROM postings WHERE p.it', 'postings.item_count')).toBe(
    'SELECT * FROM postings WHERE postings.item_count',
  )
})

test('ambiguous or unknown prefix completes nothing', async () => {
  // matches neither a table, an alias, a schema, nor a unique prefix
  expect(await completionsAt('SELECT * FROM postings WHERE x.i')).toEqual([])
})

test('schema. lists its tables', async () => {
  expect(await completionsAt('SELECT * FROM public.')).toEqual(['postings', 'users'])
})

test('schema.table. completes columns', async () => {
  expect(await completionsAt('SELECT * FROM public.users WHERE public.users.us')).toEqual(['user_name'])
})

test('an opened quote completes identifiers in that quote style', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE postings."so')).toEqual(['"sort order"'])
})

test('column names that cannot appear bare insert quoted', async () => {
  expect(await acceptAt('SELECT * FROM postings WHERE postings.sor', 'sort order')).toBe(
    'SELECT * FROM postings WHERE postings."sort order"',
  )
})

test('multi-word keywords survive past the first word', async () => {
  expect(await completionsAt('SELECT * FROM users GROUP B')).toContain('GROUP BY')
  expect(await acceptAt('SELECT * FROM users GROUP B', 'GROUP BY')).toBe('SELECT * FROM users GROUP BY')
})

test('explicit completion still lists multi-word keywords', async () => {
  expect(await completionsAt('SELECT * FROM users ')).toContain('GROUP BY')
})

test('boosted keywords rank before table names for lowercase prefixes', async () => {
  const labels = await completionsAt('u')
  expect(labels).toContain('UPDATE')
  expect(labels).toContain('users')
  expect(labels.indexOf('UPDATE')).toBeLessThan(labels.indexOf('users'))
})

test('select-list commas do not bind aliases', async () => {
  expect(await completionsAt('SELECT id, users q FROM postings WHERE q.')).toEqual([])
})

test('FROM-list commas bind old-style join aliases', async () => {
  expect(await completionsAt('SELECT * FROM postings g, users q WHERE q.us')).toEqual(['user_name'])
})

const text = (el: SqlEditor) => el.shadowRoot!.querySelector('.cm-content')!.textContent ?? ''

async function mount(tabId: string, value: string) {
  const el = document.createElement('sql-editor')
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

// Regression: a cached state restored into a remounted element carried the
// old element's run/change closures, so Mod-Enter and edits dispatched
// events on a detached node and vanished (Cmd+Enter dead after switching
// contexts or visiting a config tab).
test('run-query and editor-change fire on the remounted element', async () => {
  const first = await mount('tab-remount', 'select 42;')
  first.remove() // stashes the state, like opening a config/inspect tab

  const second = await mount('tab-remount', 'select 42;')
  const view = (second as unknown as { _view: EditorView })._view

  const events: string[] = []
  second.addEventListener('run-query', () => events.push('run'))
  second.addEventListener('editor-change', () => events.push('change'))

  // Mod-Enter through the restored state's keymap (Mod = Ctrl off-Mac/jsdom).
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  view.dispatch({ changes: { from: 0, insert: '-- edit\n' } })

  expect(events).toContain('run')
  expect(events).toContain('change')
  second.remove()
})
