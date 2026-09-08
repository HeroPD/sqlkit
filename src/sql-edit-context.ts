import type { Engine, TableRef } from './electron'
import { maskSql, maskSqlRegions } from './sql-mask'

const identEqual = (a: string | null, b: string | null) => a === b || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase())

const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)

function wordAt(sql: string, index: number, word: string) {
  return sql.slice(index, index + word.length).toLowerCase() === word && !isWord(sql[index - 1]) && !isWord(sql[index + word.length])
}

function topLevelWord(sql: string, word: string, start = 0) {
  let depth = 0
  for (let i = start; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1
    else if (sql[i] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && wordAt(sql, i, word)) return i
  }
  return -1
}

// Quote pairs by opening char: ANSI double quotes, MySQL backticks, SQL Server
// brackets. Each escapes its closer by doubling it.
const QUOTE_CLOSERS: Record<string, string> = { '"': '"', '`': '`', '[': ']' }

function parseIdentifier(sql: string, index: number): { name: string; end: number } | null {
  const closer = QUOTE_CLOSERS[sql[index] ?? '']
  if (closer) {
    let name = ''
    let i = index + 1
    while (i < sql.length) {
      if (sql[i] === closer && sql[i + 1] === closer) {
        name += closer
        i += 2
        continue
      }
      if (sql[i] === closer) return { name, end: i + 1 }
      name += sql[i]
      i += 1
    }
    return null
  }
  const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(index))
  return match ? { name: match[0], end: index + match[0].length } : null
}

function parseTableName(sql: string, index: number): { schema: string | null; name: string; end: number } | null {
  let i = index
  while (/\s/.test(sql[i] ?? '')) i += 1
  if (sql[i] === '(') return null
  const first = parseIdentifier(sql, i)
  if (!first) return null
  i = first.end
  while (/\s/.test(sql[i] ?? '')) i += 1
  if (sql[i] !== '.') return { schema: null, name: first.name, end: i }
  i += 1
  while (/\s/.test(sql[i] ?? '')) i += 1
  const second = parseIdentifier(sql, i)
  return second ? { schema: first.name, name: second.name, end: second.end } : null
}

function hasForbiddenTopLevelSource(masked: string, start: number) {
  let depth = 0
  for (let i = start; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1
    else if (masked[i] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      if (masked[i] === ',') return true
      if (['join', 'union', 'except', 'intersect'].some((word) => wordAt(masked, i, word))) return true
    }
  }
  return false
}

function matchingParen(masked: string, open: number) {
  let depth = 0
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1
    else if (masked[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return masked.length
}

// Keywords a table name can follow. SQL Server's APPLY takes a derived table
// rather than a name; MySQL's STRAIGHT_JOIN is a JOIN the `join` scan misses,
// since the underscore makes it one word.
const SOURCE_KEYWORDS = ['from', 'straight_join', 'join', 'apply']

// Depth-0 words that end the FROM list, so a comma after one of them is not
// another source.
const CLAUSE_ENDERS = ['where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch', 'for', 'union', 'intersect', 'except', 'returning', 'into', 'set', 'values']

// Sources named in one query level, recursing only where a column can still
// reach the result: derived tables and CTE bodies. A subquery in expression
// position (WHERE ... IN, a scalar SELECT) is skipped whole — nothing it
// selects is projected, so re-using a table there is not a second source.
function collectSources(masked: string, source: string, from: number, to: number, out: Array<{ schema: string | null; name: string }>, state: { hasCte: boolean }) {
  // The source after `from`, a comma, or a join keyword: a derived table to
  // walk into, or a name to record. Returns where scanning resumes.
  const readSource = (at: number): number => {
    let i = at
    const skip = (word: string) => {
      while (/\s/.test(source[i] ?? '')) i += 1
      if (!wordAt(masked, i, word)) return
      i += word.length
    }
    // Neither is a source itself, and LATERAL precedes one worth walking into.
    skip('lateral')
    skip('only')
    while (/\s/.test(source[i] ?? '')) i += 1
    if (masked[i] === '(') {
      const close = matchingParen(masked, i)
      collectSources(masked, source, i + 1, close, out, state)
      return close + 1
    }
    // Identifiers are read from the unmasked text: masking blanks quoted names.
    const parsed = parseTableName(source, i)
    if (!parsed) return i + 1
    out.push({ schema: parsed.schema, name: parsed.name })
    return parsed.end
  }

  let i = from
  let inCteList = /^[\s;]*with\b/i.test(masked.slice(from, to))
  let inFromList = false
  while (i < to) {
    if (masked[i] === '(') {
      i = matchingParen(masked, i) + 1
      continue
    }
    if (inFromList && masked[i] === ',') {
      i = readSource(i + 1)
      continue
    }
    if (isWord(masked[i]) && !isWord(masked[i - 1])) {
      const keyword = SOURCE_KEYWORDS.find((word) => wordAt(masked, i, word))
      if (keyword) {
        i = readSource(i + keyword.length)
        inFromList = true
        continue
      }
      if (wordAt(masked, i, 'select')) inCteList = false
      // Only declarations in the leading WITH list own CTE bodies.
      if (inCteList && wordAt(masked, i, 'as')) {
        let j = i + 2
        for (const word of ['not', 'materialized']) {
          while (/\s/.test(masked[j] ?? '')) j += 1
          if (wordAt(masked, j, word)) j += word.length
        }
        while (/\s/.test(masked[j] ?? '')) j += 1
        if (masked[j] === '(') {
          state.hasCte = true
          const close = matchingParen(masked, j)
          collectSources(masked, source, j + 1, close, out, state)
          i = close + 1
          continue
        }
      }
      if (CLAUSE_ENDERS.some((word) => wordAt(masked, i, word))) inFromList = false
    }
    i += 1
  }
}

/** Every table the statement names as a source, in order, including repeats. */
function scanSources(sql: string, engine?: Engine) {
  const out: Array<{ schema: string | null; name: string }> = []
  const { masked, regions } = maskSqlRegions(sql, engine)
  const chars = sql.split('')
  for (const region of regions) {
    if (region.kind !== 'comment') continue
    for (let i = region.from; i < region.to; i += 1) chars[i] = masked[i]!
  }
  const state = { hasCte: false }
  collectSources(masked, chars.join(''), 0, sql.length, out, state)
  return { tables: out, hasCte: state.hasCte }
}

export function sqlSourceTables(sql: string, engine?: Engine): Array<{ schema: string | null; name: string }> {
  return scanSources(sql, engine).tables
}

/** Whether the statement names `table` as a source more than once — a self-join,
 * or a derived table or CTE over the same table. A column origin carries the
 * table it came from, not which of those references produced it, so a second
 * reference makes every origin for that table ambiguous: a primary key resolved
 * from one reference can address a different row than the one on screen.
 * CTE provenance is unresolved and has a separate refusal reason. */
export function editSourceRefusal(sql: string, table: TableRef, engine?: Engine): 'cte' | 'repeated-table' | null {
  const scan = scanSources(sql, engine)
  // CTE references need scope-aware provenance; refuse writes until that is resolved.
  if (scan.hasCte) return 'cte'
  let seen = 0
  for (const source of scan.tables) {
    if (!identEqual(table.name, source.name)) continue
    if (source.schema !== null && !identEqual(table.schema, source.schema)) continue
    seen += 1
    if (seen > 1) return 'repeated-table'
  }
  return null
}

export function tableReferencedTwice(sql: string, table: TableRef, engine?: Engine): boolean {
  return editSourceRefusal(sql, table, engine) !== null
}

export function inferEditableTable(sql: string, tables: TableRef[], engine?: Engine): TableRef | null {
  const source = sql.trim()
  const masked = maskSql(source, engine)
  if (!/^\s*select\b/i.test(masked)) return null
  const from = topLevelWord(masked, 'from')
  if (from < 0) return null
  const parsed = parseTableName(source, from + 4)
  if (!parsed || hasForbiddenTopLevelSource(masked, parsed.end)) return null

  const matches = tables.filter((table) => identEqual(table.name, parsed.name) && (parsed.schema === null || identEqual(table.schema, parsed.schema)))
  return matches.length === 1 ? (matches[0] ?? null) : null
}
