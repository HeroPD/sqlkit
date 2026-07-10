// Rewrites the ORDER BY of the last-run query when a result column header's
// sort button is clicked. Works on the SQL text (not a real parser) but scans
// while skipping strings, comments, dollar-quoted bodies and nested parens, so
// it only ever touches the outer query's order/limit clauses.

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

// One left-to-right pass that records the outer query's clause boundaries while
// skipping over anything a top-level keyword could hide inside.
function scan(sql: string): Scan {
  const n = sql.length
  const lower = sql.toLowerCase()
  const isWord = (idx: number) => idx >= 0 && idx < n && WORD.test(sql[idx]!)
  let i = 0
  let depth = 0
  let orderFrom = -1
  let orderTermsFrom = -1
  let tailFrom = -1
  let bodyEnd = n
  let multiStatement = false
  let unsafeClause = false

  while (i < n) {
    const c = sql[i]!
    if (c === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i += 1
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    // Dollar-quoted string ($tag$ ... $tag$); a bare $ falls through.
    if (c === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close < 0 ? n : close + tag.length
        continue
      }
    }
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
      if (sql.slice(i + 1).trim() !== '') multiStatement = true
      break
    }
    if (depth === 0 && WORD.test(c) && !isWord(i - 1)) {
      let j = i + 1
      while (j < n && WORD.test(sql[j]!)) j += 1
      const word = lower.slice(i, j)
      if (word === 'into' || word === 'for' || word === 'option') unsafeClause = true
      if (word === 'order' && orderFrom < 0) {
        let k = j
        while (k < n && /\s/.test(sql[k]!)) k += 1
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

const leadingKeyword = (sql: string): string => {
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i += 1
    } else if (c === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i += 1
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
    } else {
      break
    }
  }
  let j = i
  while (j < n && WORD.test(sql[j]!)) j += 1
  return sql.slice(i, j).toLowerCase()
}

// Whether sorting by a header makes sense: a single read statement whose ORDER
// BY we can safely rewrite. Non-SELECT or multi-statement SQL is left alone.
export function isReorderableQuery(sql: string): boolean {
  if (!sql.trim()) return false
  const scanned = scan(sql)
  if (scanned.multiStatement || scanned.unsafeClause) return false
  const head = leadingKeyword(sql)
  return head === 'select'
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
function firstTerm(clause: string): { expr: string; dir: SortDir } | null {
  const n = clause.length
  let depth = 0
  let i = 0
  for (; i < n; i += 1) {
    const c = clause[i]!
    if (c === "'" || c === '"' || c === '`') {
      i += 1
      while (i < n) {
        if (clause[i] === c) {
          if (clause[i + 1] === c) {
            i += 1
          } else break
        }
        i += 1
      }
      continue
    }
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
export function activeSort(sql: string, columns: string[]): { index: number; dir: SortDir } | null {
  const s = scan(sql)
  if (s.orderFrom < 0 || s.orderTermsFrom < 0) return null
  const end = s.tailFrom >= 0 ? s.tailFrom : s.bodyEnd
  const first = firstTerm(sql.slice(s.orderTermsFrom, end))
  if (!first) return null
  const index = columnIndexForExpr(first.expr, columns)
  return index < 0 ? null : { index, dir: first.dir }
}

// Replaces the outer query's ORDER BY with `term` (or removes it when null),
// keeping any trailing LIMIT/OFFSET after it and the statement's ';'. The new
// clause lands on its own line.
export function applyOrderBy(sql: string, term: OrderByTerm | null): string {
  const s = scan(sql)
  const headEnd = s.orderFrom >= 0 ? s.orderFrom : s.tailFrom >= 0 ? s.tailFrom : s.bodyEnd
  const head = sql.slice(0, headEnd).replace(/\s+$/, '')
  const tail = s.tailFrom >= 0 ? sql.slice(s.tailFrom, s.bodyEnd).trim() : ''
  const trailing = sql.slice(s.bodyEnd)
  const parts = [head]
  if (term) parts.push(`ORDER BY ${term.column} ${term.dir === 'desc' ? 'DESC' : 'ASC'}`)
  if (tail) parts.push(tail)
  return parts.filter((part) => part !== '').join('\n') + trailing
}
