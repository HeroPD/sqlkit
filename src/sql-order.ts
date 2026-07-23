// Rewrites the ORDER BY of the last-run query when a result column header's
// sort button is clicked. Works on the SQL text (not a real parser): quoted
// text and comments are masked dialect-aware first (offsets preserved) and
// nested parens skipped, so only the outer query's order/limit clauses move.

import type { Engine } from './electron'
import { maskSql, type SqlModeFlags } from './sql-mask'

export type SortDir = 'asc' | 'desc'
export type OrderByTerm = { column: string; dir: SortDir }

const WORD = /[A-Za-z0-9_$]/

type Scan = {
  // Index of the top-level ORDER keyword, and of the terms right after "BY"; -1 when absent.
  orderFrom: number
  orderTermsFrom: number
  // Index of the first top-level LIMIT/OFFSET/FETCH (the tail that must stay after ORDER BY); -1 when absent.
  tailFrom: number
  // Index where the statement body ends — the trailing ';' or the string end.
  bodyEnd: number
  // A second top-level statement follows the first ';'.
  multiStatement: boolean
  // Clauses that either write/lock or must remain after ORDER BY and are not
  // safely handled by this deliberately small rewriter.
  unsafeClause: boolean
}

// One left-to-right pass over the masked SQL (quoted text/comments already
// blanked, offsets intact) recording the outer query's clause boundaries. The
// raw text is only needed to find where the first ORDER BY term starts — a
// quoted term is all blanks in the masked text, indistinguishable from space.
function scan(masked: string, sql: string): Scan {
  const n = masked.length
  const lower = masked.toLowerCase()
  const isWord = (idx: number) => idx >= 0 && idx < n && WORD.test(masked[idx]!)
  let i = 0
  let depth = 0
  let orderFrom = -1
  let orderTermsFrom = -1
  let tailFrom = -1
  let bodyEnd = n
  let multiStatement = false
  let unsafeClause = false

  while (i < n) {
    const c = masked[i]!
    if (c === '(') {
      depth += 1
      i += 1
      continue
    }
    if (c === ')') {
      if (depth > 0) depth -= 1
      i += 1
      continue
    }
    if (c === ';' && depth === 0) {
      bodyEnd = i
      if (masked.slice(i + 1).trim() !== '') multiStatement = true
      break
    }
    if (depth === 0 && WORD.test(c) && !isWord(i - 1)) {
      let j = i + 1
      while (j < n && WORD.test(masked[j]!)) j += 1
      const word = lower.slice(i, j)
      if (word === 'into' || word === 'for' || word === 'option') unsafeClause = true
      if (word === 'order' && orderFrom < 0) {
        let k = j
        while (k < n && /\s/.test(masked[k]!)) k += 1
        if (lower.startsWith('by', k) && !isWord(k + 2)) {
          orderFrom = i
          let m = k + 2
          while (m < n && /\s/.test(sql[m]!)) m += 1
          orderTermsFrom = m
        }
      } else if ((word === 'limit' || word === 'offset' || word === 'fetch') && tailFrom < 0) {
        tailFrom = i
      }
      i = j
      continue
    }
    i += 1
  }
  return { orderFrom, orderTermsFrom, tailFrom, bodyEnd, multiStatement, unsafeClause }
}

// First word of the masked SQL (comments are already blanks there).
const leadingKeyword = (masked: string): string => /^\s*([A-Za-z0-9_$]+)/.exec(masked)?.[1]!.toLowerCase() ?? ''

// Whether sorting by a header makes sense: a single read statement whose ORDER
// BY we can safely rewrite. Non-SELECT or multi-statement SQL is left alone.
export function isReorderableQuery(sql: string, engine?: Engine, mode?: SqlModeFlags): boolean {
  if (!sql.trim()) return false
  const masked = maskSql(sql, engine, mode)
  const scanned = scan(masked, sql)
  if (scanned.multiStatement || scanned.unsafeClause) return false
  return leadingKeyword(masked) === 'select'
}

// Whether a query is safe to re-run for a full-result export: one statement, no
// writes or side effects. Streaming export re-executes the SQL, so anything that
// modifies data (or a SELECT … INTO / FOR, which unsafeClause already flags)
// must fall back to exporting the buffered rows instead.
export function isReadOnlyQuery(sql: string, engine?: Engine, mode?: SqlModeFlags): boolean {
  if (!sql.trim()) return false
  const masked = maskSql(sql, engine, mode)
  const scanned = scan(masked, sql)
  if (scanned.multiStatement || scanned.unsafeClause) return false
  const head = leadingKeyword(masked)
  if (head === 'select' || head === 'values' || head === 'show' || head === 'pragma' || head === 'table') return true
  // A CTE is read-only unless it drives a data-modifying statement
  // (WITH x AS (DELETE … RETURNING …) …), which Postgres permits.
  if (head === 'with') {
    return !/\b(?:insert|update|delete|merge|call)\b/.test(masked.toLowerCase())
  }
  return false
}

// Strips a trailing direction (and NULLS FIRST/LAST) off one ORDER BY term.
function parseTermDir(term: string): { expr: string; dir: SortDir } {
  let t = term.trim().replace(/\s+nulls\s+(?:first|last)\s*$/i, '')
  let dir: SortDir = 'asc'
  const m = /\s+(asc|desc)\s*$/i.exec(t)
  if (m) {
    dir = m[1]!.toLowerCase() === 'desc' ? 'desc' : 'asc'
    t = t.slice(0, m.index)
  }
  return { expr: t.trim(), dir }
}

// The first ORDER BY term (up to the first top-level comma), with its direction.
// The comma is located on the masked clause; the term text comes from the raw one.
function firstTerm(clause: string, maskedClause: string): { expr: string; dir: SortDir } | null {
  const n = maskedClause.length
  let depth = 0
  let i = 0
  for (; i < n; i += 1) {
    const c = maskedClause[i]!
    if (c === '(') depth += 1
    else if (c === ')') {
      if (depth > 0) depth -= 1
    } else if (c === ',' && depth === 0) break
  }
  const term = clause.slice(0, i).trim()
  return term ? parseTermDir(term) : null
}

// The result column index an ORDER BY expression points at: a quoted/bare name
// matched case-insensitively, or a 1-based ordinal. -1 for expressions we can't
// map back to a single column.
function columnIndexForExpr(expr: string, columns: string[]): number {
  const e = expr.trim()
  if (/^\d+$/.test(e)) {
    const ord = Number(e) - 1
    return ord >= 0 && ord < columns.length ? ord : -1
  }
  let name: string | null = null
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) name = e.slice(1, -1).replaceAll('""', '"')
  else if (/^[A-Za-z_][\w$]*$/.test(e)) name = e
  if (name === null) return -1
  const lower = name.toLowerCase()
  return columns.findIndex((column) => column.toLowerCase() === lower)
}

// Which result column the query is currently sorted by (its first ORDER BY
// term), so the header can show the active direction. Null when there's no
// top-level ORDER BY or it doesn't map to one of these columns.
export function activeSort(sql: string, columns: string[], engine?: Engine, mode?: SqlModeFlags): { index: number; dir: SortDir } | null {
  const masked = maskSql(sql, engine, mode)
  const s = scan(masked, sql)
  if (s.orderFrom < 0 || s.orderTermsFrom < 0) return null
  const end = s.tailFrom >= 0 ? s.tailFrom : s.bodyEnd
  const first = firstTerm(sql.slice(s.orderTermsFrom, end), masked.slice(s.orderTermsFrom, end))
  if (!first) return null
  const index = columnIndexForExpr(first.expr, columns)
  return index < 0 ? null : { index, dir: first.dir }
}

// Replaces the outer query's ORDER BY with `term` (or removes it when null),
// keeping any trailing LIMIT/OFFSET after it and the statement's ';'. The new
// clause lands on its own line.
export function applyOrderBy(sql: string, term: OrderByTerm | null, engine?: Engine, mode?: SqlModeFlags): string {
  const s = scan(maskSql(sql, engine, mode), sql)
  const headEnd = s.orderFrom >= 0 ? s.orderFrom : s.tailFrom >= 0 ? s.tailFrom : s.bodyEnd
  const head = sql.slice(0, headEnd).replace(/\s+$/, '')
  const tail = s.tailFrom >= 0 ? sql.slice(s.tailFrom, s.bodyEnd).trim() : ''
  const trailing = sql.slice(s.bodyEnd)
  const parts = [head]
  if (term) parts.push(`ORDER BY ${term.column} ${term.dir === 'desc' ? 'DESC' : 'ASC'}`)
  if (tail) parts.push(tail)
  return parts.filter((part) => part !== '').join('\n') + trailing
}
