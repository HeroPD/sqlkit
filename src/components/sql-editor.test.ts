// @vitest-environment jsdom
import { beforeAll, expect, test, vi } from 'vitest'
import { startCompletion, completionStatus, acceptCompletion, moveCompletionSelection } from '@codemirror/autocomplete'
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ColumnRef } from '../electron'
import { stubEditorLayout } from '../test/dom-stubs'
import './sql-editor'
import type { SqlEditor } from './sql-editor'

beforeAll(stubEditorLayout)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The fixture schema, as `table: columns`. Ten tables, because completion's
 * failure modes only appear among neighbours: a column of an unbound table to
 * leak into a WHERE, a prefix that two tables share, an alias already taken.
 * `!` marks a primary key, `-> table.column` a foreign key.
 */
const SCHEMA: Record<string, string[]> = {
  postings: ['id!', 'item_count', 'sort order', 'created_at', 'author -> users.id'],
  users: ['id!', 'user_name'],
  merchants: ['id!', 'merchant_name', 'status_id', 'created_at'],
  admins: [
    'id!', 'merchant_id -> merchants.id', 'permission_group_id -> permission_groups.id',
    'email', 'first_name', 'last_name', 'status_id', 'last_login_at', 'created_at', 'updated_at',
  ],
  permission_groups: ['id!', 'group_name', 'created_at'],
  orders: ['id!', 'merchant_id -> merchants.id', 'user_id -> users.id', 'total_amount', 'tran_date', 'created_at'],
  order_items: ['id!', 'order_id -> orders.id', 'posting_id -> postings.id', 'quantity', 'unit_price'],
  payments: ['id!', 'order_id -> orders.id', 'amount', 'paid_at', 'tran_date'],
  sessions: ['id!', 'user_id -> users.id', 'token', 'start_date', 'end_date'],
  campaigns: ['id!', 'merchant_id -> merchants.id', 'campaign_name', 'date_to_activate', 'start_date', 'end_date'],
}

const fixtureTables = () => Object.keys(SCHEMA).map((name) => ({ schema: 'public', name }))

// Completion reads only schema/table/name/references; the rest of ColumnRef is
// filled plausibly so the fixture still reads like real metadata.
const fixtureColumns = (): ColumnRef[] =>
  Object.entries(SCHEMA).flatMap(([table, specs]) =>
    specs.map((spec) => {
      const [left = '', target] = spec.split(' -> ')
      const [refTable, refColumn] = target?.split('.') ?? []
      const primaryKey = left.endsWith('!')
      const name = primaryKey ? left.slice(0, -1) : left
      return {
        schema: 'public',
        table,
        name,
        dataType: 'text',
        nullable: !primaryKey,
        primaryKey,
        foreignKey: target !== undefined,
        ...(refTable !== undefined && refColumn !== undefined
          ? { references: { schema: 'public', table: refTable, column: refColumn, constraint: `${table}_${name}_fkey` } }
          : {}),
      }
    }),
  )

// Mounts an editor with fixture metadata; completion is opened by the caller.
async function mountWithMeta(doc: string, withCountColumn = false) {
  const el = document.createElement('sql-editor')
  el.tabId = `completion:${doc}`
  el.value = doc
  el.tables = fixtureTables()
  el.columns = fixtureColumns()
  if (withCountColumn) {
    el.tables.push({ schema: 'public', name: 'stats' })
    el.columns.push({ schema: 'public', table: 'stats', name: 'count', dataType: 'integer', nullable: false, primaryKey: false, foreignKey: false })
  }
  document.body.append(el)
  await el.updateComplete
  const view = (el as unknown as { _view: EditorView })._view
  return { el, view }
}

// Mounts an editor and opens completion at `cursor` (default: end of `doc`).
async function mountCompletion(doc: string, cursor = doc.length, withCountColumn = false) {
  const { el, view } = await mountWithMeta(doc, withCountColumn)
  view.dispatch({ selection: { anchor: cursor } })
  startCompletion(view)
  await completionOpen(view)
  return { el, view }
}

async function completionOpen(view: EditorView) {
  for (let i = 0; i < 20 && completionStatus(view.state) !== 'active'; i++) await sleep(25)
}

const optionLabels = (el: HTMLElement) =>
  [...el.shadowRoot!.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(
    (label) => label.textContent,
  )

// The label of each option with its matched characters wrapped in <>.
const optionMatches = (el: HTMLElement) =>
  [...el.shadowRoot!.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map((label) =>
    [...label.childNodes]
      .map((node) => (node.nodeName === 'SPAN' ? `<${node.textContent}>` : node.textContent))
      .join(''),
  )

// Opens completion at `cursor` (default: end of `doc`) and returns the option labels.
async function completionsAt(doc: string, cursor?: number) {
  const { el } = await mountCompletion(doc, cursor)
  const labels = optionLabels(el)
  el.remove()
  return labels
}

async function completionsWithCountColumn(doc: string, cursor?: number) {
  const { el } = await mountCompletion(doc, cursor, true)
  const labels = optionLabels(el)
  el.remove()
  return labels
}

// Accepts the option with `label` and returns the resulting document.
async function acceptAt(doc: string, label: string, cursor = doc.length) {
  const { el, view } = await mountCompletion(doc, cursor)
  const selected = () => el.shadowRoot!.querySelector('li[aria-selected] .cm-completionLabel')?.textContent
  // the tooltip's selection marker updates asynchronously, so settle after each move
  for (let i = 0; i < 40 && selected() !== label; i++) {
    moveCompletionSelection(true)(view)
    await sleep(15)
  }
  await sleep(80) // interactionDelay guards against accepting a just-opened tooltip
  acceptCompletion(view)
  const result = view.state.doc.toString()
  el.remove()
  return result
}

test('table. completes its columns', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE postings.i')).toEqual(['id', 'item_count'])
})

test('columns list in table order, not alphabetically', async () => {
  // author and created_at sort first alphabetically but sit last in the table
  expect(await completionsAt('SELECT * FROM postings WHERE postings.')).toEqual([
    'id', 'item_count', 'sort order', 'created_at', 'author',
  ])
})

test('FROM/JOIN alias resolves to the aliased table', async () => {
  expect(await completionsAt('SELECT * FROM postings pg WHERE pg.i')).toEqual(['id', 'item_count'])
  expect(await completionsAt('SELECT * FROM postings AS pg JOIN users u ON u.us')).toEqual(['user_name'])
})

test('unbound unique prefix expands to table.column', async () => {
  expect(await completionsAt('SELECT * FROM postings WHERE post.i')).toEqual(['postings.id', 'postings.item_count'])
  expect(await acceptAt('SELECT * FROM postings WHERE post.it', 'postings.item_count')).toBe(
    'SELECT * FROM postings WHERE postings.item_count',
  )
})

test('ambiguous or unknown prefix completes nothing', async () => {
  // matches neither a table, an alias, a schema, nor a unique prefix
  expect(await completionsAt('SELECT * FROM postings WHERE x.i')).toEqual([])
  // payments, permission_groups and postings all start with p
  expect(await completionsAt('SELECT * FROM postings WHERE p.i')).toEqual([])
})

test('schema. lists its tables', async () => {
  expect([...await completionsAt('SELECT * FROM public.')].sort()).toEqual(Object.keys(SCHEMA).sort())
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

// Undemoted multi-word keywords outrank a table name; demoted ones fall below
// it. A table is the stable yardstick: the popup renders 100 options at most,
// which an unfiltered list of every keyword and column now exceeds.
const ranksAbove = (labels: (string | null)[], label: string, other = 'users') => {
  expect(labels).toContain(label)
  expect(labels.indexOf(label)).toBeLessThan(labels.indexOf(other))
}

test('FROM-less SELECT keeps normal multi-word keyword boosts', async () => {
  const labels = await completionsAt('SELECT id, name ')
  for (const keyword of ['LEFT JOIN', 'ORDER BY', 'GROUP BY']) ranksAbove(labels, keyword)
})

test('a FROM without metadata keeps normal multi-word keyword boosts', async () => {
  // Column metadata gates the demotion, not the binding alone: mystery_tbl binds but has none.
  const doc = 'SELECT id,  FROM mystery_tbl'
  ranksAbove(await completionsAt(doc, doc.indexOf(',') + 2), 'ORDER BY')
})

test('transaction keywords complete', async () => {
  expect(await completionsAt('BEG')).toContain('BEGIN')
  expect(await completionsAt('COMM')).toContain('COMMIT')
  expect(await completionsAt('ROLL')).toContain('ROLLBACK')
  expect(await completionsAt('START T')).toContain('START TRANSACTION')
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

test('a table completed after FROM or JOIN inserts a fresh alias', async () => {
  expect(await acceptAt('SELECT * FROM us', 'users')).toBe('SELECT * FROM users u')
  // u is taken by the first join, so the second falls back to a longer prefix
  expect(await acceptAt('SELECT * FROM users u JOIN us', 'users')).toBe('SELECT * FROM users u JOIN users us')
})

test('a multi-word table aliases to its initials', async () => {
  expect(await acceptAt('SELECT * FROM orders o JOIN order_i', 'order_items')).toBe(
    'SELECT * FROM orders o JOIN order_items oi',
  )
  expect(await acceptAt('SELECT * FROM admins a JOIN permission_g', 'permission_groups')).toBe(
    'SELECT * FROM admins a JOIN permission_groups pg',
  )
})

test('ON suggests the FK of the joined pair, not of every bound table', async () => {
  // payments keys to orders; users and merchants are bound but unrelated to it
  const doc = 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id JOIN merchants m ON o.merchant_id = m.id JOIN payments p ON '
  expect((await completionsAt(doc)).filter((label) => label?.includes(' = '))).toEqual(['p.order_id = o.id'])
  // a table with two foreign keys offers the one reaching the table it joins
  const admins = 'SELECT * FROM merchants m JOIN permission_groups pg ON pg.id = 1 JOIN admins a ON '
  expect((await completionsAt(admins)).filter((label) => label?.includes(' = '))).toEqual([
    'a.merchant_id = m.id', 'a.permission_group_id = pg.id',
  ])
})

test('a table completed in a subquery does not shadow an outer alias', async () => {
  expect(await acceptAt(
    'SELECT * FROM users u WHERE u.id IN (SELECT author FROM us',
    'users',
  )).toBe('SELECT * FROM users u WHERE u.id IN (SELECT author FROM users us')

  const correlated = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM us WHERE postings.author = u.id)'
  const cursor = correlated.indexOf('us WHERE') + 'us'.length
  expect(await acceptAt(correlated, 'users', cursor)).toBe(
    'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM users us WHERE postings.author = u.id)',
  )
})

test('FROM-list commas and schema-qualified tables alias too', async () => {
  expect(await acceptAt('SELECT * FROM postings p, us', 'users')).toBe('SELECT * FROM postings p, users u')
  expect(await acceptAt('SELECT * FROM public.us', 'users')).toBe('SELECT * FROM public.users u')
})

test('tables outside FROM/JOIN complete without an alias', async () => {
  expect(await acceptAt('INSERT INTO us', 'users')).toBe('INSERT INTO users')
})

test('ON suggestions ignore bindings from other statements', async () => {
  // the quoted binding in the first statement must not produce a second condition
  const labels = await completionsAt('SELECT * FROM "postings";\n\nSELECT * FROM postings pt JOIN users cu ON ')
  expect(labels.filter((label) => label?.includes(' = '))).toEqual(['cu.id = pt.author'])
})

test('alias suggestions ignore aliases bound in other statements', async () => {
  expect(await acceptAt('SELECT * FROM users u;\n\nSELECT * FROM us', 'users')).toBe(
    'SELECT * FROM users u;\n\nSELECT * FROM users u',
  )
})

test('bound aliases complete first outside FROM/JOIN', async () => {
  const doc = 'SELECT * FROM postings pt\n  JOIN users cu ON cu.id = pt.author\n  WHERE pt.id = 1\n  ORDER BY c'
  expect((await completionsAt(doc))[0]).toBe('cu')
  // in FROM/JOIN position the binding suggestions stay alias-free
  expect(await completionsAt('SELECT * FROM postings pt JOIN p')).not.toContain('pt')
})

test('SELECT-list completion ranks aliases and bound columns before functions and keywords', async () => {
  const doc = 'SELECT id,  FROM "public"."postings" p LIMIT 200'
  const labels = await completionsAt(doc, doc.indexOf(',') + 2)
  expect(labels).toContain('p')
  expect(labels).toContain('id')
  expect(labels).toContain('SUM')
  expect(labels).toContain('SELECT')
  expect(labels).toContain('ORDER BY')
  expect(labels.indexOf('p')).toBeLessThan(labels.indexOf('id'))
  expect(labels.indexOf('id')).toBeLessThan(labels.indexOf('SUM'))
  expect(labels.indexOf('SUM')).toBeLessThan(labels.indexOf('SELECT'))
  expect(labels.indexOf('SUM')).toBeLessThan(labels.indexOf('ORDER BY'))
})

test('SELECT-list completion boosts scalar functions above plain keywords', async () => {
  // NULL sorts before NULLIF, so only the function boost can invert the pair.
  const doc = 'SELECT id, nu FROM "public"."postings" p'
  const labels = await completionsAt(doc, 'SELECT id, nu'.length)
  expect(labels).toContain('NULLIF')
  expect(labels.indexOf('NULLIF')).toBeLessThan(labels.indexOf('NULL'))
})

test('a bound column does not suppress a same-named aggregate keyword', async () => {
  const doc = 'SELECT cou FROM stats s'
  const labels = await completionsWithCountColumn(doc, 'SELECT cou'.length)
  expect(labels.filter((label) => label.toLowerCase() === 'count')).toEqual(['count', 'COUNT'])
})

test('SELECT-list completion ignores clause words in strings and quoted identifiers', async () => {
  for (const doc of [
    `SELECT 'FROM users u',  FROM postings p`,
    'SELECT p."sort order",  FROM postings p',
  ]) {
    const labels = await completionsAt(doc, doc.indexOf(',') + 2)
    expect(labels[0]).toBe('p')
    expect(labels).toContain('item_count')
    expect(labels).not.toContain('u')
    expect(labels).not.toContain('user_name')
  }
})

test('SELECT-list completion returns to the outer scope after a nested query', async () => {
  const doc = 'SELECT (SELECT max(id) FROM users u),  FROM postings p'
  const labels = await completionsAt(doc, doc.indexOf(',') + 2)
  expect(labels[0]).toBe('p')
  expect(labels).toContain('item_count')
  expect(labels).not.toContain('u')
  expect(labels).not.toContain('user_name')
})

test('SELECT-list completion does not leak bindings out of a CTE', async () => {
  const doc = 'WITH recent AS (SELECT * FROM users u) SELECT id,  FROM postings p'
  const labels = await completionsAt(doc, doc.indexOf(',') + 2)
  expect(labels[0]).toBe('p')
  expect(labels).toContain('item_count')
  expect(labels).not.toContain('u')
  expect(labels).not.toContain('user_name')
})

test('SELECT-list completion falls back to bare columns for a metadata-less CTE', async () => {
  const doc = 'WITH recent AS (SELECT * FROM postings) SELECT  FROM recent r'
  const labels = await completionsAt(doc, doc.indexOf('  FROM') + 1)
  expect(labels).toContain('r')
  expect(labels).toContain('id')
  expect(labels).toContain('item_count')
  expect(labels).toContain('user_name')
})

test('SELECT-list completion does not leak bindings across UNION branches', async () => {
  const doc = 'SELECT id,  FROM postings p UNION SELECT id FROM users u'
  const labels = await completionsAt(doc, doc.indexOf(',') + 2)
  expect(labels[0]).toBe('p')
  expect(labels).toContain('item_count')
  expect(labels).not.toContain('u')
  expect(labels).not.toContain('user_name')
})

test('a parenthesized join group binds into the query around it', async () => {
  const group = 'SELECT  FROM (postings p JOIN users u ON u.id = p.author)'
  const labels = await completionsAt(group, 'SELECT '.length)
  expect(labels.slice(0, 2)).toEqual(['p', 'u'])
  expect(labels).toContain('p.id')
  expect(labels).toContain('u.id')
  expect(labels).toContain('item_count')

  // the FK condition and alias members resolve inside the group too
  const on = 'SELECT * FROM (postings p JOIN users u ON '
  expect((await completionsAt(on, on.length))[0]).toBe('u.id = p.author')
  expect(await completionsAt('SELECT * FROM (postings p JOIN users u ON u.')).toEqual(['id', 'user_name'])
})

test('a derived table keeps its bindings out of the query around it', async () => {
  const outer = 'SELECT  FROM (SELECT id FROM users u) x'
  const outerLabels = await completionsAt(outer, 'SELECT '.length)
  expect(outerLabels).not.toContain('u')
  expect(outerLabels).not.toContain('u.id')
  // the subquery's own SELECT list still sees it
  const inner = 'SELECT * FROM (SELECT  FROM users u) x'
  const innerLabels = await completionsAt(inner, inner.indexOf('(SELECT ') + '(SELECT '.length)
  expect(innerLabels[0]).toBe('u')
  expect(innerLabels).toContain('user_name')
})

test('a correlated subquery resolves the aliases of the query around it', async () => {
  const exists = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM postings p WHERE p.author = u.'
  expect(await completionsAt(exists)).toEqual(['id', 'user_name'])

  const inList = 'SELECT * FROM users u WHERE u.id IN (SELECT p.author FROM postings p WHERE p.item_count > u.'
  expect(await completionsAt(inList)).toEqual(['id', 'user_name'])

  // a scalar subquery whose outer FROM comes after the caret
  const scalar = 'SELECT (SELECT count(*) FROM postings p WHERE p.author = u.) FROM users u'
  expect(await completionsAt(scalar, scalar.indexOf('= u.') + '= u.'.length)).toEqual(['id', 'user_name'])

  // the nearest binding answers when the subquery rebinds the name: postings, not
  // users — asserted by table, not by the fixture's column list
  const shadowed = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM postings u WHERE u.'
  const shadowedLabels = await completionsAt(shadowed)
  expect(shadowedLabels).toContain('item_count')
  expect(shadowedLabels).not.toContain('user_name')
})

test('a correlated SELECT list adds the outer columns and leaves its own bare', async () => {
  const doc = 'SELECT * FROM users u WHERE EXISTS (SELECT  FROM postings p)'
  const labels = await completionsAt(doc, doc.indexOf('SELECT  FROM') + 'SELECT '.length)
  expect(labels.slice(0, 2)).toEqual(['p', 'u'])
  // unambiguous in the subquery's own scope, where an unqualified name resolves first
  expect(labels).toContain('id')
  expect(labels).not.toContain('p.id')
  // the outer query's columns carry their alias and rank below
  expect(labels).toContain('u.id')
  expect(labels).toContain('u.user_name')
  expect(labels.indexOf('id')).toBeLessThan(labels.indexOf('u.id'))

  const word = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM postings p WHERE u'
  expect(await completionsAt(word)).toContain('u')
})

test('a derived table and an ON clause keep the outer query out', async () => {
  // without LATERAL a derived table cannot reference the query around it
  const derived = 'SELECT * FROM users u JOIN (SELECT  FROM postings p) d ON d.id = u.id'
  const inner = await completionsAt(derived, derived.indexOf('(SELECT ') + '(SELECT '.length)
  expect(inner).not.toContain('u')
  expect(inner).not.toContain('u.id')
  // FK conditions stay on the joins of the query being written
  const on = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM postings p JOIN users u2 ON '
  expect((await completionsAt(on))[0]).toBe('u2.id = p.author')
})

test('ambiguous joined columns complete with their aliases', async () => {
  const doc = 'SELECT  FROM postings p JOIN users u ON u.id = p.author'
  const labels = await completionsAt(doc, 'SELECT '.length)
  expect(labels.slice(0, 2)).toEqual(['p', 'u'])
  expect(labels).toContain('p.id')
  expect(labels).toContain('u.id')
  expect(labels).not.toContain('id')
  expect(labels).toContain('item_count')
  expect(labels).toContain('user_name')

  const oneChar = 'SELECT i FROM postings p JOIN users u ON u.id = p.author'
  const oneCharLabels = await completionsAt(oneChar, 'SELECT i'.length)
  expect(oneCharLabels).toContain('p.id')
  expect(oneCharLabels).toContain('u.id')
  expect(oneCharLabels).not.toContain('id')

  const typed = 'SELECT id FROM postings p JOIN users u ON u.id = p.author'
  const idLabels = await completionsAt(typed, 'SELECT id'.length)
  expect(idLabels).toContain('p.id')
  expect(idLabels).toContain('u.id')

  // a word reaching for the alias keeps its qualified columns
  const alias = 'SELECT p FROM postings p JOIN users u ON u.id = p.author'
  const aliasLabels = await completionsAt(alias, 'SELECT p'.length)
  expect(aliasLabels).toContain('p.id')
  expect(aliasLabels).not.toContain('u.id')
})

// Four bindings, so a name can be shared by two of them, by all of them, or by
// none — the cases a two-table join cannot tell apart.
const CHAIN = 'FROM users u'
  + ' JOIN orders o ON o.user_id = u.id'
  + ' JOIN order_items oi ON oi.order_id = o.id'
  + ' JOIN payments p ON p.order_id = o.id'

test('a long join lists every alias, then qualifies only the clashing columns', async () => {
  const doc = `SELECT  ${CHAIN}`
  const labels = await completionsAt(doc, 'SELECT '.length)
  expect(labels.slice(0, 4)).toEqual(['u', 'o', 'oi', 'p'])
  // tran_date is orders' and payments', created_at only orders'
  expect(labels).toContain('o.tran_date')
  expect(labels).toContain('p.tran_date')
  expect(labels).not.toContain('tran_date')
  expect(labels).toContain('created_at')
  expect(labels).toContain('user_name')
  expect(labels).toContain('quantity')
  // sessions and campaigns are unbound, however many tables the statement joins
  expect(labels).not.toContain('token')
  expect(labels).not.toContain('date_to_activate')
})

test('a column every bound table owns qualifies for each of them', async () => {
  const doc = `SELECT i ${CHAIN}`
  const labels = await completionsAt(doc, 'SELECT i'.length)
  expect(labels.slice(0, 4)).toEqual(['u.id', 'o.id', 'oi.id', 'p.id'])
  expect(labels).not.toContain('id')
})

test('mixed join kinds and a schema-qualified join bind like a plain JOIN', async () => {
  const doc = 'SELECT tok FROM users u'
    + ' LEFT JOIN public.sessions s ON s.user_id = u.id'
    + ' INNER JOIN orders o ON o.user_id = u.id'
  expect(await completionsAt(doc, 'SELECT tok'.length)).toEqual(['token'])
})

test('the clauses after a long join scope to exactly its tables', async () => {
  const where = await completionsAt(`SELECT * ${CHAIN} WHERE tran`)
  expect(where.slice(0, 2)).toEqual(['o.tran_date', 'p.tran_date'])
  expect(where).not.toContain('tran_date')
  // status_id and start_date belong to tables this statement never joins
  const order = await completionsAt(`SELECT * ${CHAIN} ORDER BY sta`)
  expect(order).not.toContain('status_id')
  expect(order).not.toContain('start_date')
  // and an alias mid-chain still resolves to its own table
  expect(await completionsAt(`SELECT * ${CHAIN} WHERE oi.`)).toEqual([
    'id', 'order_id', 'posting_id', 'quantity', 'unit_price',
  ])
})

test('a third join takes an alias none of the bindings own', async () => {
  // o and oi are bound; or is reserved; order_items claims ord in this same popup
  expect(await acceptAt('SELECT * FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN ord', 'orders')).toBe(
    'SELECT * FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN orders orde',
  )
})

test('the aliases stay reachable in a popup opened before the word', async () => {
  const doc = 'SELECT  FROM postings p JOIN users u ON u.id = p.author'
  const at = 'SELECT '.length
  const { el, view } = await mountCompletion(doc, at)
  view.dispatch({ changes: { from: at, insert: 'p' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
  await completionOpen(view)
  expect(optionLabels(el)).toContain('p.id')
  el.remove()
})

test('a qualified option highlights the typed part of its column', async () => {
  const doc = 'SELECT i FROM postings p JOIN users u ON u.id = p.author'
  const { el } = await mountCompletion(doc, 'SELECT i'.length)
  // the match sits on the column, not on the ref that only the display carries
  expect(optionMatches(el).slice(0, 3)).toEqual(['p.<i>d', '<i>tem_count', 'u.<i>d'])
  el.remove()
})

test('SELECT-list completion includes aliased old-style FROM bindings', async () => {
  const doc = 'SELECT  FROM postings p, users u'
  const labels = await completionsAt(doc, 'SELECT '.length)
  expect(labels.slice(0, 2)).toEqual(['p', 'u'])
  expect(labels).toContain('p.id')
  expect(labels).toContain('u.id')
  expect(labels).toContain('user_name')
})

test('SELECT-list completion includes unaliased old-style FROM bindings', async () => {
  const doc = 'SELECT  FROM postings, users'
  const labels = await completionsAt(doc, 'SELECT '.length)
  expect(labels).toContain('postings.id')
  expect(labels).toContain('users.id')
  expect(labels).toContain('item_count')
  expect(labels).toContain('user_name')

  const qualified = 'SELECT  FROM postings, public.users'
  expect(await completionsAt(qualified, 'SELECT '.length)).toContain('user_name')
})

test('a parenthesized FROM list binds its comma items, a call argument does not', async () => {
  const group = 'SELECT  FROM (postings p, users u)'
  const labels = await completionsAt(group, 'SELECT '.length)
  expect(labels.slice(0, 2)).toEqual(['p', 'u'])
  expect(labels).toContain('p.id')
  expect(labels).toContain('u.id')
  expect(labels).toContain('item_count')
  expect(labels).toContain('user_name')

  // a table function's arguments are expressions: `users` here is no binding,
  // so postings stays the only table and its columns keep completing bare
  const call = 'SELECT  FROM postings p, unnest(users, postings) x'
  const callLabels = await completionsAt(call, 'SELECT '.length)
  expect(callLabels).toContain('id')
  expect(callLabels).not.toContain('postings.id')
  expect(callLabels).not.toContain('users.id')
  expect(callLabels).not.toContain('user_name')
})

test('WHERE completion scopes bare names to the statement bindings', async () => {
  // admins owns none of the fixture's date columns, in or out of a call paren
  const dates = ['date_to_activate', 'start_date', 'end_date', 'tran_date']
  const call = 'SELECT * FROM "public"."admins"\n  WHERE admins.created_at = DATE(dat)  LIMIT 200'
  const inCall = await completionsAt(call, call.indexOf('DATE(dat') + 'DATE(dat'.length)
  const bare = await completionsAt('SELECT * FROM "public"."admins" WHERE dat')
  for (const column of dates) {
    expect(inCall, column).not.toContain(column)
    expect(bare, column).not.toContain(column)
  }
  // the date the caret could mean is still there, and so are the admin's own columns
  expect(inCall).toContain('CURRENT_DATE')
  expect(await completionsAt('SELECT * FROM admins WHERE id = 1 AND ema')).toContain('email')
})

test('every column-expression clause scopes its bare names', async () => {
  for (const doc of [
    'SELECT * FROM users ORDER BY cre',
    'SELECT * FROM users GROUP BY cre',
    'SELECT id FROM users GROUP BY id HAVING cre',
    'DELETE FROM users WHERE cre',
    'UPDATE users SET cre',
  ]) {
    expect(await completionsAt(doc), doc).not.toContain('created_at')
  }
  // a subquery scopes to its own FROM, where created_at does belong
  const subquery = 'SELECT * FROM users WHERE id IN (SELECT author FROM postings WHERE cre'
  expect(await completionsAt(subquery)).toContain('created_at')
})

test('a metadata-less statement still offers every bare column', async () => {
  expect(await completionsAt('SELECT * FROM mystery_tbl WHERE cre')).toContain('created_at')
  expect(await completionsAt('SET search_path = cre')).toContain('created_at')
})

test('an UPDATE alias resolves to the table being written', async () => {
  expect(await completionsAt('UPDATE users u SET u.')).toEqual(['id', 'user_name'])
})

test('an assignment target scopes to the written table and takes no ref', async () => {
  // Postgres and SQLite reject `SET o.col = …`, and payments is never assignable
  const doc = 'UPDATE orders o SET tra = 1 FROM payments p WHERE p.order_id = o.id'
  const target = await completionsAt(doc, doc.indexOf('tra = 1') + 'tra'.length)
  expect(target).toContain('tran_date')
  expect(target).not.toContain('o.tran_date')
  expect(target).not.toContain('p.tran_date')
  // an empty target position leads with the written table's columns, not the aliases
  const empty = await completionsAt('UPDATE orders o SET ')
  expect(empty.slice(0, 3)).toEqual(['id', 'merchant_id', 'user_id'])
  expect(empty).not.toContain('o')
  expect(empty).not.toContain('p')
  // and so does the target after a comma
  const second = 'UPDATE orders o SET total_amount = 1, tra = 2 FROM payments p'
  expect(await completionsAt(second, second.indexOf('tra = 2') + 'tra'.length)).not.toContain('p.tran_date')
})

test('a SET value is an ordinary column expression over the whole statement', async () => {
  const value = 'UPDATE orders o SET tran_date = tra FROM payments p WHERE p.order_id = o.id'
  const labels = await completionsAt(value, value.indexOf('= tra') + '= tra'.length)
  expect(labels.slice(0, 2)).toEqual(['o.tran_date', 'p.tran_date'])
  // a call argument sits past the `=` however many commas it holds
  const call = 'UPDATE orders o SET tran_date = coalesce(paid_at, amo) FROM payments p'
  expect(await completionsAt(call, call.indexOf('amo)') + 'amo'.length)).toContain('amount')
})

test('USING binds its table for the clauses that follow', async () => {
  const deleted = await completionsAt('DELETE FROM orders o USING payments p WHERE amo')
  expect(deleted).toContain('amount')
  expect(deleted).toContain('total_amount')
  expect(await completionsAt('MERGE INTO orders o USING payments p ON amo')).toContain('amount')
  // `JOIN … USING (id)` names a column, so no unbound table rides in on it
  const joined = await completionsAt('SELECT * FROM orders o JOIN payments p USING (id) WHERE tok')
  expect(joined).not.toContain('token')
})

test('RETURNING completes the columns of the table written, not of the query between', async () => {
  const inserted = await completionsAt('INSERT INTO users SELECT * FROM postings p RETURNING user_')
  expect(inserted).toContain('user_name')
  expect(inserted).not.toContain('user_id')
  expect(await completionsAt('UPDATE orders SET total_amount = 1 RETURNING tran')).toEqual(
    ['tran_date', 'START TRANSACTION'],
  )
  expect(await completionsAt('DELETE FROM users WHERE id = 1 RETURNING user_')).toEqual(['user_name'])
})

test('a keyword that only reuses UPDATE or INTO binds no table', async () => {
  const locked = await completionsAt('SELECT * FROM users u WHERE u.id > 0 FOR UPDATE OF users AND us')
  expect(locked.filter((label) => label === 'users')).toHaveLength(1)
  expect(locked).toContain('user_name')
  // `SELECT … INTO` names a variable; the columns still come from the FROM
  expect(await completionsAt('SELECT id INTO myvar FROM users WHERE user_')).toEqual(['user_name'])
})

test('the written table leads the tables an UPDATE reads from', async () => {
  const doc = 'UPDATE orders o SET total_amount = 1 FROM payments p WHERE o.id = p.order_id AND i'
  const labels = await completionsAt(doc)
  expect(labels.slice(0, 2)).toEqual(['o.id', 'p.id'])
})

test('multi-word keywords rank below the scoped names in every expression clause', async () => {
  const where = await completionsAt('SELECT * FROM orders o WHERE ')
  expect(where.indexOf('AVG')).toBeGreaterThan(-1)
  expect(where.indexOf('AVG')).toBeLessThan(where.indexOf('LEFT JOIN'))
  // a statement the metadata does not cover keeps the dialect keyword ranking
  const unknown = await completionsAt('SELECT * FROM mystery_tbl WHERE ')
  expect(unknown.indexOf('LEFT JOIN')).toBeLessThan(unknown.indexOf('AVG'))
})

test('FROM/JOIN suggestions omit bare column names', async () => {
  const labels = await completionsAt('SELECT * FROM us')
  expect(labels).toContain('users')
  expect(labels).not.toContain('user_name')
})

test('ON suggestions resolve aliases mid-document with trailing clauses', async () => {
  const doc = 'SELECT * FROM postings pt\n  JOIN users cu ON \n  WHERE pt.id = 1\n  ORDER BY c.id\n  LIMIT 1'
  const cursor = doc.indexOf(' ON ') + ' ON '.length
  expect((await completionsAt(doc, cursor))[0]).toBe('cu.id = pt.author')
})

test('FK conditions pop up unprompted after typing the space past ON', async () => {
  const { el, view } = await mountWithMeta('SELECT * FROM users u JOIN postings p ON')
  const end = view.state.doc.length
  view.dispatch({
    changes: { from: end, insert: ' ' },
    selection: { anchor: end + 1 },
    userEvent: 'input.type',
  })
  await completionOpen(view)
  // the unprompted popup shows only the join conditions, not keywords
  expect(optionLabels(el)).toEqual(['p.author = u.id'])
  el.remove()
})

test('ON after a join suggests the FK condition first', async () => {
  expect((await completionsAt('SELECT * FROM users u JOIN postings p ON '))[0]).toBe('p.author = u.id')
  expect(await acceptAt('SELECT * FROM users u JOIN postings p ON p', 'p.author = u.id')).toBe(
    'SELECT * FROM users u JOIN postings p ON p.author = u.id',
  )
})

test('ON conditions follow the FK in either direction and bare table names', async () => {
  expect((await completionsAt('SELECT * FROM postings p JOIN users u ON '))[0]).toBe('u.id = p.author')
  expect((await completionsAt('SELECT * FROM users JOIN postings p ON '))[0]).toBe('p.author = users.id')
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

test('Shift-Tab dedents every selected line', async () => {
  const el = await mount('tab-dedent', 'select\n  1,\n  2;')
  const view = (el as unknown as { _view: EditorView })._view
  view.dispatch({ selection: { anchor: 9, head: 14 } }) // spans lines 2-3
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
  )
  expect(view.state.doc.toString()).toBe('select\n1,\n2;')
  el.remove()
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

// A drag that began at the caret sitting at the end of the first line: the
// statement's own head is outside the selected characters, and running from
// the line below it would send a clause the server cannot parse. The reported
// line is the head's, so a driver error maps to the statement, not its tail.
test('runs the whole statement when the drag started at the end of its first line', async () => {
  const doc = 'ALTER TABLE t\n    ALTER COLUMN c TYPE bigint;\n\nALTER TABLE u\n    RENAME COLUMN a TO b;'
  const el = await mount('titlebar-drag-run', doc)
  const runs: Array<{ sql: string; line: number }> = []
  el.addEventListener('run-query', (event) =>
    runs.push((event as CustomEvent<{ sql: string; line: number }>).detail),
  )
  const view = (el as unknown as { _view: EditorView })._view
  view.focus()
  view.dispatch({ selection: { anchor: doc.indexOf('\n'), head: doc.length } })

  expect(el.runCurrentQuery()).toBe(true)
  expect(el.runExplicitQuery()).toBe(true)
  expect(runs).toEqual([
    { sql: doc, line: 1 },
    { sql: doc, line: 1 },
  ])
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
