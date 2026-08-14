import { expect, test, vi } from 'vitest'
import type { SqlDialectName } from './codemirror/dialects'
import { maskSql } from './sql-mask'
import {
  boundAliases,
  clauseAt,
  findAliasTarget,
  queryScopesAt,
  scanSql,
  sqlStructure,
  tableBindings,
  visibleBindings,
} from './sql-scope'

vi.mock('./sql-mask', async (importActual) => {
  const actual = await importActual<typeof import('./sql-mask')>()
  return { ...actual, maskSql: vi.fn(actual.maskSql) }
})

// `|` marks the caret in every fixture below and is stripped before scanning.
function scopeAt(marked: string, dialect: SqlDialectName = 'postgres') {
  const pos = marked.indexOf('|')
  if (pos < 0) throw new Error('fixture needs a | caret')
  const sql = marked.slice(0, pos) + marked.slice(pos + 1)
  const structure = scanSql(sql, dialect)
  return { structure, pos, query: clauseAt(structure, pos) }
}

const render = (binding: { table: string; alias?: string; outer?: boolean }) =>
  `${binding.table}${binding.alias ? ` ${binding.alias}` : ''}${binding.outer ? ' (outer)' : ''}`

// Tables the caret's own query binds.
function bindings(marked: string, dialect?: SqlDialectName) {
  const { structure, query } = scopeAt(marked, dialect)
  return query ? tableBindings(structure, query).map(render) : []
}

// Tables the caret may reference, its own query's first.
function visible(marked: string) {
  const { structure, query } = scopeAt(marked)
  return query ? visibleBindings(structure, query).map(render) : []
}

const clause = (marked: string, dialect?: SqlDialectName) => scopeAt(marked, dialect).query?.clause

function aliasTarget(marked: string, alias: string) {
  const { structure, query } = scopeAt(marked)
  return query ? findAliasTarget(structure, alias, query) : null
}

function taken(marked: string) {
  const { structure, pos } = scopeAt(marked)
  return [...boundAliases(structure, queryScopesAt(structure, pos))].sort()
}

test('the clause at the caret follows the query that owns it', () => {
  expect(clause('SELECT | FROM t')).toBe('select')
  expect(clause('SELECT * FROM t WHERE |')).toBe('where')
  expect(clause('SELECT * FROM t GROUP BY |')).toBe('group')
  // an expression paren inherits the clause around it
  expect(clause('SELECT count(|) FROM t')).toBe('select')
  // a nested SELECT owns its own clauses until its parens close
  expect(clause('SELECT (SELECT max(id) FROM u WHERE |) FROM t')).toBe('where')
  expect(clause('SELECT (SELECT max(id) FROM u), | FROM t')).toBe('select')
})

test('masked text cannot impersonate a clause keyword', () => {
  expect(clause(`SELECT 'FROM x', | FROM t`)).toBe('select')
  expect(clause('SELECT "from", | FROM t')).toBe('select')
  expect(clause('SELECT * FROM t -- WHERE y\n, | ')).toBe('from')
  expect(clause('SELECT * FROM t /* WHERE y */ , |')).toBe('from')
  // a token the caret sits inside is unread, as a scan of the prefix would leave it
  expect(clause('SELECT * FR|OM t')).toBe('select')
})

test('explicit joins and old-style FROM lists both bind', () => {
  expect(bindings('SELECT | FROM postings p JOIN users u ON u.id = p.author')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM postings, users')).toEqual(['postings', 'users'])
  expect(bindings('SELECT | FROM postings p, users u')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM postings AS p JOIN users AS u ON u.id = p.author')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM public.users u')).toEqual(['users u'])
  expect(bindings('SELECT | FROM "My Table" mt')).toEqual(['"My Table" mt'])
})

test('a statement-leading keyword binds, having no clause before it', () => {
  expect(bindings('DELETE FROM users WHERE |')).toEqual(['users'])
  expect(bindings('UPDATE users u SET name = | ')).toEqual(['users u'])
  expect(bindings('UPDATE public.users u SET name = 1 WHERE |')).toEqual(['users u'])
  // the write target joins the FROM items of the same statement
  expect(bindings('UPDATE users u SET n = 1 FROM postings p WHERE |')).toEqual(['postings p', 'users u'])
  expect(aliasTarget('UPDATE users u SET name = | ', 'u')).toBe('users')
  // an INSERT's SELECT is its own query, so the target stays out of it
  expect(bindings('INSERT INTO users SELECT | FROM postings p')).toEqual(['postings p'])
  // the UPDATE of an upsert names no table
  expect(bindings('INSERT INTO users VALUES (1) ON CONFLICT (id) DO UPDATE SET name = |')).toEqual(['users'])
})

test('a parenthesized join group binds into the query around it', () => {
  expect(bindings('SELECT | FROM (postings p JOIN users u ON u.id = p.author)')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM (postings p, users u)')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM ((postings p, users u))')).toEqual(['postings p', 'users u'])
  expect(bindings('SELECT | FROM postings p, (users u JOIN posts x ON x.id = u.id)')).toEqual(
    ['postings p', 'posts x', 'users u'],
  )
})

test('commas that separate anything but FROM items bind nothing', () => {
  // a select-list comma must not read `b c` as a binding
  expect(bindings('SELECT a, b c, | FROM postings p')).toEqual(['postings p'])
  expect(bindings('SELECT coalesce(a, b), | FROM postings p')).toEqual(['postings p'])
  // a table function's arguments are expressions, not FROM items
  expect(bindings('SELECT | FROM postings p, unnest(users, posts) x')).toEqual(['postings p', 'unnest'])
  expect(bindings('SELECT | FROM generate_series(1, users) g')).toEqual(['generate_series'])
  // neither a comment nor a string can smuggle a FROM item in
  expect(bindings('SELECT | FROM postings p /* , users u */')).toEqual(['postings p'])
  expect(bindings(`SELECT | FROM postings p WHERE tags = ', users u'`)).toEqual(['postings p'])
})

test('a query sees only its own bindings', () => {
  const subquery = 'SELECT $ FROM postings p WHERE id IN (SELECT $ FROM users u)'
  expect(bindings(subquery.replace('$', '|').replace('$', ''))).toEqual(['postings p'])
  expect(bindings(subquery.replace('$', '').replace('$', '|'))).toEqual(['users u'])

  const union = 'SELECT $ FROM postings p UNION SELECT $ FROM users u'
  expect(bindings(union.replace('$', '|').replace('$', ''))).toEqual(['postings p'])
  expect(bindings(union.replace('$', '').replace('$', '|'))).toEqual(['users u'])

  const cte = 'WITH r AS (SELECT $ FROM users u) SELECT $ FROM postings p'
  expect(bindings(cte.replace('$', '|').replace('$', ''))).toEqual(['users u'])
  expect(bindings(cte.replace('$', '').replace('$', '|'))).toEqual(['postings p'])

  // a derived table's bindings stay inside it
  expect(bindings('SELECT | FROM (SELECT id FROM users u) d')).not.toContain('users u')
  expect(bindings('SELECT * FROM (SELECT | FROM users u) d')).toEqual(['users u'])
})

test('a correlated subquery also sees the query around it', () => {
  expect(visible('SELECT * FROM users u WHERE EXISTS (SELECT | FROM postings p)')).toEqual(
    ['postings p', 'users u (outer)'],
  )
  expect(visible('SELECT * FROM users u WHERE u.id IN (SELECT | FROM postings p)')).toEqual(
    ['postings p', 'users u (outer)'],
  )
  expect(visible('SELECT (SELECT | FROM postings p) FROM users u')).toEqual(
    ['postings p', 'users u (outer)'],
  )
  // both branches of a subquery's UNION reach the same outer query
  const union = 'SELECT * FROM users u WHERE u.id IN (SELECT author FROM posts UNION SELECT | FROM postings p)'
  expect(visible(union)).toEqual(['postings p', 'users u (outer)'])
  // two levels of correlation stack, nearest first
  const deep = 'SELECT * FROM users a WHERE EXISTS (SELECT 1 FROM posts b WHERE EXISTS (SELECT | FROM postings c))'
  expect(visible(deep)).toEqual(['postings c', 'posts b (outer)', 'users a (outer)'])
})

test('a derived table sees nothing outward, having no LATERAL', () => {
  expect(visible('SELECT * FROM users u JOIN (SELECT | FROM postings p) d ON d.id = u.id')).toEqual(['postings p'])
  expect(visible('SELECT * FROM (SELECT | FROM postings p) d')).toEqual(['postings p'])
})

test('a rebound name hides the outer one it shadows', () => {
  // `u` is postings here, so the outer users must not ride along as `u`
  expect(visible('SELECT * FROM users u WHERE EXISTS (SELECT | FROM postings u)')).toEqual(['postings u'])
})

test('an alias resolves in the nearest scope that binds it', () => {
  expect(aliasTarget('SELECT * FROM postings p WHERE p.|', 'p')).toBe('postings')
  expect(aliasTarget('SELECT * FROM public.users u WHERE u.|', 'u')).toBe('public.users')
  expect(aliasTarget('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE u.|)', 'u')).toBe('users')
  // the subquery rebinds `u`, so its own table answers
  expect(aliasTarget('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM postings u WHERE u.|)', 'u')).toBe('postings')
  // a derived table cannot reach the outer alias
  expect(aliasTarget('SELECT * FROM users u JOIN (SELECT 1 FROM posts p WHERE u.|) d ON true', 'u')).toBeNull()
  // a select-list comma never binds an alias
  expect(aliasTarget('SELECT a, b c FROM postings WHERE c.|', 'c')).toBeNull()
  expect(aliasTarget('SELECT * FROM postings p WHERE x.|', 'x')).toBeNull()
})

test('a fresh alias avoids every name bound in the scopes at the caret', () => {
  expect(taken('SELECT * FROM users u JOIN posts |')).toEqual(['u'])
  // an outer alias is off limits inside a subquery, where reusing it would shadow
  expect(taken('SELECT * FROM users u WHERE id IN (SELECT id FROM posts |)')).toEqual(['u'])
  // sibling subqueries are disjoint, so the name is free again
  expect(taken('SELECT (SELECT id FROM users u), (SELECT id FROM posts |)')).toEqual([])
  // a select-list comma binds nothing, so `q` is not taken
  expect(taken('SELECT id, users q FROM postings |')).toEqual([])
})

test('each dialect masks by its own rules', () => {
  // MySQL reads # as a comment, Postgres does not
  expect(clause('SELECT * FROM t # WHERE y\n, |', 'mysql')).toBe('from')
  expect(clause('SELECT * FROM t # WHERE y\n, |', 'postgres')).toBe('where')
  // T-SQL brackets quote an identifier
  expect(bindings('SELECT | FROM [my table] mt', 'mssql')).toEqual(['[my table] mt'])
})

test('one statement is scanned once', () => {
  const sql = 'SELECT id FROM postings p'
  expect(sqlStructure(sql, 'postgres')).toBe(sqlStructure(sql, 'postgres'))
  // a different dialect must not answer from the same scan
  expect(sqlStructure(sql, 'mysql')).not.toBe(sqlStructure(sql, 'postgres'))
})

// Masking allocates over the whole statement, so resolving a match must read the
// scan rather than mask again: doing it per match was quadratic in statement size.
test('a statement is masked once, however many matches resolve against it', () => {
  const sql = 'SELECT id FROM a x, d w JOIN b y ON y.id = x.id JOIN c z ON z.id = x.id WHERE x.id > 0'
  vi.mocked(maskSql).mockClear()
  const structure = sqlStructure(sql, 'postgres')
  const query = clauseAt(structure, 'SELECT '.length)
  expect(query).toBeDefined()
  if (!query) return
  expect(tableBindings(structure, query)).toHaveLength(4)
  findAliasTarget(structure, 'y', query)
  visibleBindings(structure, query)
  boundAliases(structure, queryScopesAt(structure, 'SELECT '.length))
  expect(vi.mocked(maskSql)).toHaveBeenCalledTimes(1)
})
