import type { Engine } from './electron'
import type { SqlDialectName } from './codemirror/dialects'
import { maskSql } from './sql-mask'

// Which query owns a position in a statement, and which tables that query binds.
// Completion needs both: a caret in a subquery must not see the outer query's
// columns as its own, but a correlated subquery must still resolve its aliases.
// Shared with src/components/sql-editor.ts, which layers metadata on top.

// Words that can follow a table reference without being its alias.
export const ALIAS_STOPWORDS = new Set([
  'as', 'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'intersect', 'except', 'set',
  'using', 'returning', 'values', 'select', 'from', 'into', 'and', 'or', 'not', 'when',
  'then', 'else', 'end', 'case', 'by', 'asc', 'desc', 'for', 'with', 'window',
])

// One identifier segment: double-quoted, backticked, bracketed, or bare.
export const IDENT_SEG = '"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][\\w$]*'

// Strips any quote style and unescapes its doubled close char; lowercased for map keys.
export function normIdent(seg: string): string {
  const open = seg[0]
  if (open !== '"' && open !== '`' && open !== '[') return seg.toLowerCase()
  const close = open === '[' ? ']' : open
  const body = seg.length > 1 && seg.endsWith(close) ? seg.slice(1, -1) : seg.slice(1)
  return body.replaceAll(close + close, close).toLowerCase()
}

const CLAUSE_KEYWORDS = /\b(from|join|where|on|select|set|group|order|having|union|intersect|except|limit|offset|values|returning|update|into|window|with)\b/gi

const MASK_ENGINE: Record<SqlDialectName, Engine> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mssql: 'sqlserver',
  sqlite: 'sqlite',
}

const STRUCTURE_TOKENS = new RegExp(`[()]|${CLAUSE_KEYWORDS.source}`, 'gi')

// What sits before a paren that groups FROM items (`FROM (a x, b y)`, `, (…)`,
// or another such paren). Anything else before a paren — a function name above
// all — makes its commas argument separators.
const GROUPING_PAREN = /(?:\b(?:from|join)\b|,|\()\s*$/i

/** `parent` is the query this one may reference outward — set for a correlated
 * subquery, absent for a derived table, which cannot see the query around it. */
export type ClauseContext = { clause: string; queryDepth: number; queryStart: number; parent?: ClauseContext }

/** What a prefix scan reaches once the token ending at `end` is consumed. */
export type ClauseState = {
  end: number
  depth: number
  context: ClauseContext | undefined
  queryScopes: ClauseContext[]
  /** Depth of the innermost open function-call paren, 0 when none is open. */
  callDepth: number
}

export type SqlStructure = { sql: string; masked: string; states: ClauseState[] }

/** A FROM/JOIN/comma item: `seg` as written, `qualified` its second segment
 * when schema-qualified, `table` whichever names the table. */
export type TableBinding = { seg: string; qualified?: string; alias?: string; table: string }

// Clause and parenthesis depth at each structural token, so a caret or a match
// index resolves by lookup instead of a rescan. Child expression parens inherit
// their parent's clause; a nested SELECT replaces it until its parens close.
// Masking keeps quoted identifiers, strings and comments from impersonating
// structural keywords.
export function scanSql(sql: string, dialect: SqlDialectName): SqlStructure {
  const masked = maskSql(sql, MASK_ENGINE[dialect])
  const states: ClauseState[] = []
  const contexts = new Map<number, ClauseContext>()
  // The query a paren's own SELECT may reference outward, per depth. A paren
  // opened in FROM/JOIN holds a derived table and gets none: it cannot see the
  // query around it. Kept for the paren's life, so both branches of a
  // `IN (SELECT … UNION SELECT …)` reach the same outer query.
  const enclosing: Array<ClauseContext | undefined> = []
  // Depths of the open parens that hold arguments rather than FROM items, so a
  // comma inside `unnest(a, b)` is told apart from one inside `(a x, b y)`.
  const calls: number[] = []
  let depth = 0
  for (const match of masked.matchAll(STRUCTURE_TOKENS)) {
    const token = match[0].toLowerCase()
    const at = match.index ?? 0
    if (token === '(') {
      const inherited = contexts.get(depth)
      depth += 1
      if (inherited) contexts.set(depth, inherited)
      enclosing[depth] = inherited?.clause === 'from' || inherited?.clause === 'join' ? undefined : inherited
      if (!GROUPING_PAREN.test(masked.slice(Math.max(0, at - 64), at))) calls.push(depth)
    } else if (token === ')') {
      contexts.delete(depth)
      enclosing[depth] = undefined
      if (calls[calls.length - 1] === depth) calls.pop()
      depth = Math.max(0, depth - 1)
    } else {
      const previous = contexts.get(depth)
      contexts.set(depth, token === 'select' || !previous
        ? { clause: token, queryDepth: depth, queryStart: at, parent: enclosing[depth] }
        : { ...previous, clause: token })
    }
    // An inherited context repeats per depth; consumers key it, so leave it.
    const queryScopes = [...contexts.values()]
    const callDepth = calls[calls.length - 1] ?? 0
    states.push({ end: at + token.length, depth, context: contexts.get(depth), queryScopes, callDepth })
  }
  return { sql, masked, states }
}

// Both completion sources scan the same statement per keystroke, and each
// binding match resolves against it, so the last scan is reused.
let lastScan: { key: string; structure: SqlStructure } | undefined
export function sqlStructure(sql: string, dialect: SqlDialectName): SqlStructure {
  const key = `${dialect}:${sql}`
  if (lastScan?.key !== key) lastScan = { key, structure: scanSql(sql, dialect) }
  return lastScan.structure
}

// The last token ending at or before `index`; a token straddling it is unread,
// as it would be by a scan of the prefix.
function stateAt(structure: SqlStructure, index: number): ClauseState | undefined {
  let low = 0
  let high = structure.states.length - 1
  let found: ClauseState | undefined
  while (low <= high) {
    const mid = (low + high) >> 1
    const state = structure.states[mid]
    if (state === undefined || state.end > index) high = mid - 1
    else {
      found = state
      low = mid + 1
    }
  }
  return found
}

export const clauseAt = (structure: SqlStructure, index: number) => stateAt(structure, index)?.context
export const depthAt = (structure: SqlStructure, index: number) => stateAt(structure, index)?.depth ?? 0
export const callDepthAt = (structure: SqlStructure, index: number) => stateAt(structure, index)?.callDepth ?? 0
export const queryScopesAt = (structure: SqlStructure, index: number) => stateAt(structure, index)?.queryScopes ?? []

// `query` and the queries it may reference outward, nearest first: a name bound
// closer to the caret shadows the same name further out.
export function scopeChain(query: ClauseContext): ClauseContext[] {
  const chain: ClauseContext[] = []
  for (let scope: ClauseContext | undefined = query; scope; scope = scope.parent) chain.push(scope)
  return chain
}

// Whether the nearest clause keyword before `index` is FROM — comma aliases only bind there.
export function inFromList(structure: SqlStructure, index: number): boolean {
  return clauseAt(structure, index)?.clause === 'from'
}

// A parenthesized join group (`FROM (a x JOIN b y ON …)`) binds into the query
// around it, so the binding scans step over its parens. A paren opening a
// subquery instead is left alone: its keyword is no table name.
const GROUP_OPEN = `\\s*(?:\\(\\s*)*(?!(?:select|with|values)\\b)`

// A FROM/JOIN/UPDATE/INTO clause (or FROM-list comma) binding a table to an alias.
const ALIAS_BINDINGS = new RegExp(
  `(?:\\b(?:from|join|update|into)\\b|(,))${GROUP_OPEN}(${IDENT_SEG})(?:\\.(${IDENT_SEG}))?\\s+(?:as\\s+)?(${IDENT_SEG})`,
  'gi',
)

// Every FROM/JOIN table binding with its optional alias; the lookahead keeps a
// following keyword (`FROM users JOIN …`) from being read as users's alias.
const TABLE_BINDINGS = new RegExp(
  `\\b(?:from|join)\\b${GROUP_OPEN}(${IDENT_SEG})(?:\\.(${IDENT_SEG}))?(?:\\s+(?:as\\s+)?(?!(?:${[...ALIAS_STOPWORDS].join('|')})\\b)(${IDENT_SEG}))?`,
  'gi',
)

// The table an UPDATE or INSERT writes to. It binds like a FROM item: the SET
// list and the WHERE of the same statement resolve columns against it. The
// first lookahead keeps `ON CONFLICT DO UPDATE SET` from naming a table.
const TARGET_BINDINGS = new RegExp(
  `\\b(?:update|into)\\b\\s+(?!(?:${[...ALIAS_STOPWORDS].join('|')})\\b)(${IDENT_SEG})(?:\\.(${IDENT_SEG}))?(?:\\s+(?:as\\s+)?(?!(?:${[...ALIAS_STOPWORDS].join('|')})\\b)(${IDENT_SEG}))?`,
  'gi',
)

// A comma-separated FROM item, with or without an alias. The clause, scope and
// call-paren checks keep SELECT-list and argument commas out of the bindings.
const COMMA_BINDINGS = new RegExp(
  `,${GROUP_OPEN}(${IDENT_SEG})(?:\\.(${IDENT_SEG}))?(?:\\s+(?:as\\s+)?(?!(?:${[...ALIAS_STOPWORDS].join('|')})\\b)(${IDENT_SEG}))?`,
  'gi',
)

// A match landing in masked text (a string, comment or quoted identifier) is not
// SQL structure: masking leaves whitespace where its content was.
const isMasked = (structure: SqlStructure, index: number) => !/\S/.test(structure.masked[index] ?? '')

// The query a binding match belongs to, read from the clause before it. A
// keyword that opens the statement (`DELETE FROM …`, `UPDATE …`) has no token
// before it, so the clause it opens itself answers.
function bindingClause(structure: SqlStructure, match: RegExpMatchArray): ClauseContext | undefined {
  const at = match.index ?? 0
  return clauseAt(structure, at) ?? clauseAt(structure, at + match[0].length)
}

// The tables `query` itself binds. Cached per structure, since one completion
// resolves every binding match against the same scan.
const bindingCache = new WeakMap<SqlStructure, Map<string, TableBinding[]>>()

export function tableBindings(structure: SqlStructure, query: ClauseContext): TableBinding[] {
  let perQuery = bindingCache.get(structure)
  if (!perQuery) {
    perQuery = new Map()
    bindingCache.set(structure, perQuery)
  }
  const cacheKey = `${query.queryDepth}:${query.queryStart}`
  const cached = perQuery.get(cacheKey)
  if (cached) return cached
  const bindings: TableBinding[] = []
  for (const match of structure.sql.matchAll(TABLE_BINDINGS)) {
    const [, seg, qualified, alias] = match
    const table = qualified ?? seg
    if (seg === undefined || table === undefined) continue
    if (isMasked(structure, match.index ?? 0)) continue
    // The owning query decides scope, not the paren depth: a join group binds
    // into the query around it from one level deeper.
    if (bindingClause(structure, match)?.queryStart !== query.queryStart) continue
    bindings.push({ seg, qualified, alias, table })
  }
  // TABLE_BINDINGS covers explicit JOINs; add old-style FROM-list items.
  for (const match of structure.sql.matchAll(COMMA_BINDINGS)) {
    const [, seg, qualified, alias] = match
    if (seg === undefined) continue
    if (isMasked(structure, match.index ?? 0)) continue
    if (bindingClause(structure, match)?.queryStart !== query.queryStart) continue
    if (!inFromList(structure, match.index ?? 0)) continue
    // A FROM item may sit inside a join group, never inside a call's argument
    // list — `unnest(a, b)` names no tables.
    if (callDepthAt(structure, match.index ?? 0) > query.queryDepth) continue
    bindings.push({ seg, qualified, alias, table: qualified ?? seg })
  }
  // The table an UPDATE or INSERT writes to binds for its SET list and WHERE.
  for (const match of structure.sql.matchAll(TARGET_BINDINGS)) {
    const [, seg, qualified, alias] = match
    if (seg === undefined) continue
    if (isMasked(structure, match.index ?? 0)) continue
    if (bindingClause(structure, match)?.queryStart !== query.queryStart) continue
    bindings.push({ seg, qualified, alias, table: qualified ?? seg })
  }
  perQuery.set(cacheKey, bindings)
  return bindings
}

/** `outer` marks a binding of an enclosing query, which a reference must qualify. */
export type VisibleBinding = TableBinding & { outer: boolean }

// The caret's own bindings, then those of the queries it may reference outward.
// A ref the nearer scope already owns hides the outer one, so a rebound alias
// never suggests the wrong table's columns.
export function visibleBindings(structure: SqlStructure, query: ClauseContext): VisibleBinding[] {
  const visible: VisibleBinding[] = []
  const owned = new Set<string>()
  scopeChain(query).forEach((scope, index) => {
    for (const binding of tableBindings(structure, scope)) {
      const ref = normIdent(binding.alias ?? binding.table)
      if (index > 0 && owned.has(ref)) continue
      owned.add(ref)
      visible.push({ ...binding, outer: index > 0 })
    }
  })
  return visible
}

// Finds what table `alias` (unquoted, lowercased) is bound to in FROM/JOIN/UPDATE/INTO
// clauses or old-style FROM lists. Returns `schema.table` or `table`, lowercased.
export function findAliasTarget(structure: SqlStructure, alias: string, query: ClauseContext): string | null {
  const inScope = (queryStart: number): string | null => {
    for (const match of structure.sql.matchAll(ALIAS_BINDINGS)) {
      const [, comma, first, second, aliasSeg] = match
      if (first === undefined || aliasSeg === undefined) continue
      if (isMasked(structure, match.index ?? 0)) continue
      // Scope is the owning query, not the paren depth: a join group sits deeper
      // than the query it binds into.
      if (bindingClause(structure, match)?.queryStart !== queryStart) continue
      const candidate = normIdent(aliasSeg)
      if (candidate !== alias || ALIAS_STOPWORDS.has(candidate)) continue
      // A select-list comma must not bind "select a, b c" as alias c → table b.
      if (comma !== undefined && !inFromList(structure, match.index ?? 0)) continue
      return second !== undefined ? `${normIdent(first)}.${normIdent(second)}` : normIdent(first)
    }
    return null
  }
  // Each scope is exhausted before the next, so the nearest binding of the name
  // answers even when a correlated subquery rebinds it.
  for (const scope of scopeChain(query)) {
    const target = inScope(scope.queryStart)
    if (target !== null) return target
  }
  return null
}

// All alias names already bound in the scopes live at the caret, so a suggested
// alias picks a fresh one. Over-inclusive by design: a wider taken set only
// means a longer alias, while a missed one shadows a name already in use.
export function boundAliases(structure: SqlStructure, queryScopes: ClauseContext[]): Set<string> {
  const taken = new Set<string>()
  const visible = new Set(queryScopes.map((query) => `${query.queryDepth}:${query.queryStart}`))
  for (const match of structure.sql.matchAll(ALIAS_BINDINGS)) {
    const [, comma, first, , aliasSeg] = match
    if (first === undefined || aliasSeg === undefined) continue
    if (isMasked(structure, match.index ?? 0)) continue
    const query = bindingClause(structure, match)
    if (!query || !visible.has(`${query.queryDepth}:${query.queryStart}`)) continue
    const candidate = normIdent(aliasSeg)
    if (ALIAS_STOPWORDS.has(candidate)) continue
    if (comma !== undefined && !inFromList(structure, match.index ?? 0)) continue
    taken.add(candidate)
  }
  return taken
}
