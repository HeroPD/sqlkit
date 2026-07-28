// @vitest-environment jsdom
import { beforeAll, expect, test, vi } from 'vitest'
import { startCompletion, completionStatus, acceptCompletion, moveCompletionSelection } from '@codemirror/autocomplete'
import { EditorSelection } from '@codemirror/state'
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

test('formats the whole document using the active SQL dialect', async () => {
  const el = await mount('format-document', 'select id,name from users where id=1;')
  el.dialect = 'postgres'
  await el.updateComplete

  expect(el.formatSql()).toBe(true)
  await sleep(25)
  expect((el as unknown as { _view: EditorView })._view.state.doc.toString()).toBe(
    'SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1;',
  )
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

test('runCurrentQuery matches the selection-or-nearest-statement shortcut target', async () => {
  const el = await mount('titlebar-run', 'select 1;\n\nselect 2;')
  const runs: Array<{ sql: string; line: number }> = []
  el.addEventListener('run-query', (event) =>
    runs.push((event as CustomEvent<{ sql: string; line: number }>).detail),
  )
  const view = (el as unknown as { _view: EditorView })._view
  view.dispatch({ selection: { anchor: 11, head: 20 } })

  expect(el.runCurrentQuery()).toBe(true)
  expect(runs).toEqual([{ sql: 'select 2;', line: 3 }])
  el.remove()
})

test('runExplicitQuery runs a selection or only the statement containing the caret', async () => {
  const el = await mount('titlebar-explicit-run', '  select 1;\n\nselect 2;  ')
  const runs: Array<{ sql: string; line: number }> = []
  el.addEventListener('run-query', (event) =>
    runs.push((event as CustomEvent<{ sql: string; line: number }>).detail),
  )
  const view = (el as unknown as { _view: EditorView })._view
  view.focus()

  view.dispatch({ selection: { anchor: 13, head: 22 } })
  expect(el.runExplicitQuery()).toBe(true)

  view.dispatch({ selection: { anchor: 17 } })
  expect(el.runExplicitQuery()).toBe(true)
  view.dispatch({ selection: { anchor: 12 } })
  expect(el.runExplicitQuery()).toBe(false)
  expect(runs).toEqual([
    { sql: 'select 2;', line: 3 },
    { sql: 'select 2;', line: 3 },
  ])

  view.contentDOM.blur()
  expect(el.runExplicitQuery()).toBe(false)
  el.remove()
})

// Regression: the host swapping `value` on a live tab (the History list
// recycling its preview tab to another entry) dispatched the new doc into the
// view, which fired the change listener — so the host saw a programmatic load
// as typing and pinned the preview tab on every pick.
const viewOf = (el: SqlEditor) => (el as unknown as { _view: EditorView })._view

// jsdom has no layout, so the coordinate lookup is stubbed to a known offset:
// what matters here is what the handler decides, not CodeMirror's geometry.
async function rightClickAt(el: SqlEditor, pos: number) {
  vi.spyOn(viewOf(el), 'posAtCoords').mockReturnValue(pos)
  el.shadowRoot!
    .querySelector('.host')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 30, clientY: 40 }))
  await el.updateComplete
  return el.shadowRoot!.querySelector('context-menu')!
}

const menuButtons = (menu: Element) => [...menu.shadowRoot!.querySelectorAll<HTMLButtonElement>('.menu-item')]

const pickItem = (menu: Element, label: string) =>
  menuButtons(menu)
    .find((button) => button.querySelector('.label')?.textContent?.trim() === label)!
    .click()

// window.sqlkit is the trusted-process clipboard; the editor has no other route
// to it (permission requests are denied in the sandboxed renderer).
function stubClipboard(text = '') {
  const writeClipboardText = vi.fn(() => Promise.resolve())
  const readClipboardText = vi.fn(() => Promise.resolve(text))
  ;(window as unknown as { sqlkit: Record<string, unknown> }).sqlkit = { writeClipboardText, readClipboardText }
  return { writeClipboardText, readClipboardText }
}

test('right-click moves the caret only when it lands outside a selection', async () => {
  const el = await mount('menu-caret', 'select alpha from beta;')
  const view = viewOf(el)

  await rightClickAt(el, 9)
  expect(view.state.selection.main.head).toBe(9)

  // With a live selection, a click inside it leaves the selection alone.
  view.dispatch({ selection: { anchor: 7, head: 12 } })
  await rightClickAt(el, 10)
  expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([7, 12])

  // Outside it, the selection collapses to the clicked position.
  await rightClickAt(el, 2)
  expect(view.state.selection.main.empty).toBe(true)
  expect(view.state.selection.main.head).toBe(2)
  el.remove()
})

test('cut and copy are dimmed until something is selected', async () => {
  const el = await mount('menu-disabled', 'select 1;')
  const disabledLabels = (menu: Element) =>
    menuButtons(menu)
      .filter((button) => button.disabled)
      .map((button) => button.querySelector('.label')?.textContent?.trim())

  expect(disabledLabels(await rightClickAt(el, 3))).toEqual(['Cut', 'Copy'])

  viewOf(el).dispatch({ selection: { anchor: 0, head: 6 } })
  expect(disabledLabels(await rightClickAt(el, 3))).toEqual([])
  el.remove()
})

test('copy writes the selection, cut also removes it', async () => {
  const el = await mount('menu-copy', 'select alpha from beta;')
  const view = viewOf(el)
  const { writeClipboardText } = stubClipboard()

  view.dispatch({ selection: { anchor: 7, head: 12 } })
  pickItem(await rightClickAt(el, 10), 'Copy')
  expect(writeClipboardText).toHaveBeenCalledWith('alpha')
  expect(view.state.doc.toString()).toBe('select alpha from beta;')

  pickItem(await rightClickAt(el, 10), 'Cut')
  expect(writeClipboardText).toHaveBeenLastCalledWith('alpha')
  expect(view.state.doc.toString()).toBe('select  from beta;')
  el.remove()
})

test('context-menu copy and cut include every non-empty selection', async () => {
  const el = await mount('menu-multi-copy', 'alpha + alpha')
  const view = viewOf(el)
  const { writeClipboardText } = stubClipboard()
  const selection = EditorSelection.create(
    [EditorSelection.range(0, 5), EditorSelection.range(8, 13)],
    0,
  )

  view.dispatch({ selection })
  pickItem(await rightClickAt(el, 10), 'Copy')
  expect(writeClipboardText).toHaveBeenCalledWith('alpha\nalpha')
  expect(view.state.selection.ranges).toHaveLength(2)

  pickItem(await rightClickAt(el, 10), 'Cut')
  expect(writeClipboardText).toHaveBeenLastCalledWith('alpha\nalpha')
  expect(view.state.doc.toString()).toBe(' + ')
  expect(view.state.selection.ranges).toHaveLength(2)
  el.remove()
})

test('paste inserts the clipboard text over the selection', async () => {
  const el = await mount('menu-paste', 'select alpha;')
  const view = viewOf(el)
  stubClipboard('omega')

  view.dispatch({ selection: { anchor: 7, head: 12 } })
  pickItem(await rightClickAt(el, 10), 'Paste')
  await sleep(0)
  expect(view.state.doc.toString()).toBe('select omega;')
  el.remove()
})

test('a pending context-menu paste does not cross a tab switch', async () => {
  const el = await mount('menu-paste-first', 'select alpha;')
  const view = viewOf(el)
  let resolveClipboard!: (text: string) => void
  const readClipboardText = vi.fn(
    () => new Promise<string>((resolve) => {
      resolveClipboard = resolve
    }),
  )
  ;(window as unknown as { sqlkit: Record<string, unknown> }).sqlkit = { readClipboardText }

  view.dispatch({ selection: { anchor: 7, head: 12 } })
  pickItem(await rightClickAt(el, 10), 'Paste')

  el.tabId = 'menu-paste-second'
  el.value = 'select beta;'
  await el.updateComplete
  resolveClipboard('omega')
  await sleep(0)

  expect(view.state.doc.toString()).toBe('select beta;')
  el.remove()
})

test('the menu runs the selection and opens the palette', async () => {
  const el = await mount('menu-run', 'select 1;\n\nselect 2;')
  const runs: string[] = []
  const commands: string[] = []
  el.addEventListener('run-query', (event) => runs.push((event as CustomEvent<{ sql: string }>).detail.sql))
  el.addEventListener('editor-command', (event) =>
    commands.push((event as CustomEvent<{ command: string }>).detail.command),
  )

  viewOf(el).dispatch({ selection: { anchor: 11, head: 20 } })
  pickItem(await rightClickAt(el, 15), 'Run Query')
  expect(runs).toEqual(['select 2;'])

  pickItem(await rightClickAt(el, 15), 'Command Palette')
  expect(commands).toEqual(['command-palette'])
  el.remove()
})

test('menu selection commands act on the editor', async () => {
  const el = await mount('selection-commands', 'select alpha;\nselect beta;')
  const view = viewOf(el)

  view.dispatch({ selection: { anchor: 0 } })
  expect(el.runSelectionCommand('copy-line-down')).toBe(true)
  expect(view.state.doc.toString()).toBe('select alpha;\nselect alpha;\nselect beta;')

  // The cursor rode down to the copy, so moving down swaps it past `beta`.
  expect(el.runSelectionCommand('move-line-down')).toBe(true)
  expect(view.state.doc.toString()).toBe('select alpha;\nselect beta;\nselect alpha;')

  // "alpha" now occurs twice: selecting one and asking for all matches gives two ranges.
  view.dispatch({ selection: { anchor: 7, head: 12 } })
  expect(el.runSelectionCommand('select-all-occurrences')).toBe(true)
  expect(view.state.selection.ranges).toHaveLength(2)
  el.remove()
})

test('add cursors to line ends splits a selection across its lines', async () => {
  const el = await mount('line-ends', 'select one;\nselect two;\nselect three;')
  const view = viewOf(el)
  const heads = () => view.state.selection.ranges.map((range) => range.head)

  // Line 1 col 8 → line 3 col 8: ends of lines 1 and 2, then where it stopped.
  view.dispatch({ selection: { anchor: 7, head: 31 } })
  expect(el.runSelectionCommand('add-cursors-to-line-ends')).toBe(true)
  expect(heads()).toEqual([11, 23, 31])

  // Stopping at the start of line 3 leaves that line out.
  view.dispatch({ selection: { anchor: 7, head: 24 } })
  expect(el.runSelectionCommand('add-cursors-to-line-ends')).toBe(true)
  expect(heads()).toEqual([11, 23])

  // A bare cursor has no lines to split.
  view.dispatch({ selection: { anchor: 7 } })
  expect(el.runSelectionCommand('add-cursors-to-line-ends')).toBe(false)
  expect(heads()).toEqual([7])
  el.remove()
})

// Regression: macOS types a character for Option+letter (⌥I is "ˆ") and
// CodeMirror skips its keyCode fallback for Alt combos there, so a
// `Shift-Alt-i` keymap entry never fires — these shortcuts match event.code.
test('shift-alt shortcuts fire from the physical key, not the typed character', async () => {
  const el = await mount('alt-shift-keys', 'select one;\nselect two;')
  const view = viewOf(el)
  const press = (key: string, code: string) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, altKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    )

  view.dispatch({ selection: { anchor: 7, head: 19 } })
  press('ˆ', 'KeyI')
  expect(view.state.selection.ranges.map((range) => range.head)).toEqual([11, 19])

  press('Ï', 'KeyF')
  await sleep(25)
  expect(view.state.doc.toString()).toBe('SELECT\n  one;\n\nSELECT\n  two;')
  el.remove()
})

test('a host value swap does not report an editor-change', async () => {
  const el = await mount('host-swap', 'select 1 as alpha;')
  const changes: string[] = []
  el.addEventListener('editor-change', (event) => changes.push((event as CustomEvent<{ value: string }>).detail.value))

  el.value = 'select 2 as beta;'
  await el.updateComplete
  await sleep(25)

  // The doc followed the host, but no edit was reported.
  expect(text(el)).toContain('select 2 as beta;')
  expect(changes).toEqual([])

  // A real edit still reports.
  const view = (el as unknown as { _view: EditorView })._view
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' -- typed' } })
  expect(changes).toHaveLength(1)
  expect(changes[0]).toContain('-- typed')
  el.remove()
})
