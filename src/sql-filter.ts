import type { Engine } from './electron'
import { maskSql, type SqlModeFlags } from './sql-mask'
import { t } from './i18n'

const WORD = /[A-Za-z0-9_$]/
const TAIL_CLAUSES = new Set(['group', 'having', 'window', 'qualify', 'order', 'limit', 'offset', 'fetch', 'for', 'option'])

type FilterScan = {
  bodyEnd: number
  insertFrom: number
  whereFrom: number
  filterable: boolean
}

// Finds the outer SELECT's WHERE and the first clause that must remain after
// it. Quoted text/comments are masked without changing offsets; nested queries
// are skipped by depth so their clauses never affect the outer statement.
function scanFilter(sql: string, engine?: Engine, mode?: SqlModeFlags): FilterScan {
  const masked = maskSql(sql, engine, mode)
  const lower = masked.toLowerCase()
  let depth = 0
  let bodyEnd = sql.length
  let insertFrom = -1
  let whereFrom = -1
  let firstWord = ''
  let multiStatement = false
  let unsafe = false

  for (let i = 0; i < masked.length;) {
    const char = masked[i]!
    if (char === '(') {
      depth += 1
      i += 1
      continue
    }
    if (char === ')') {
      if (depth > 0) depth -= 1
      i += 1
      continue
    }
    if (char === ';' && depth === 0) {
      bodyEnd = i
      multiStatement = masked.slice(i + 1).trim() !== ''
      break
    }
    if (depth !== 0 || !WORD.test(char) || (i > 0 && WORD.test(masked[i - 1]!))) {
      i += 1
      continue
    }
    let end = i + 1
    while (end < masked.length && WORD.test(masked[end]!)) end += 1
    const word = lower.slice(i, end)
    if (!firstWord) firstWord = word
    else if (word === 'where' && whereFrom < 0) whereFrom = i
    else if (word === 'union' || word === 'intersect' || word === 'except' || word === 'into') unsafe = true
    else if (TAIL_CLAUSES.has(word) && insertFrom < 0) insertFrom = i
    i = end
  }

  if (insertFrom < 0) insertFrom = bodyEnd
  const sqlServerBatches = engine === 'sqlserver' && /^\s*go(?:\s+\d+)?\s*$/im.test(masked)
  return { bodyEnd, insertFrom, whereFrom, filterable: firstWord === 'select' && !multiStatement && !unsafe && !sqlServerBatches }
}

export function isFilterableQuery(sql: string, engine?: Engine, mode?: SqlModeFlags): boolean {
  return !!sql.trim() && scanFilter(sql, engine, mode).filterable
}

// Adds a condition to the outer SELECT without changing the editor's SQL. The
// caller supplies only a predicate; WHERE/AND placement remains engine-side.
export function applyFilterCondition(sql: string, condition: string, engine?: Engine, mode?: SqlModeFlags): string {
  const trimmed = condition.trim()
  if (!trimmed) return sql
  const maskedCondition = maskSql(trimmed, engine, mode)
  if (!maskedCondition.trim()) throw new Error(t('filter.commentsOnly'))
  if (maskedCondition.includes(';')) throw new Error(t('filter.noSemicolon'))
  if (/^\s*where\b/i.test(maskedCondition)) throw new Error(t('filter.withoutWhere'))

  const scanned = scanFilter(sql, engine, mode)
  if (!scanned.filterable) throw new Error(t('filter.singleSelect'))
  const head = sql.slice(0, scanned.insertFrom).replace(/\s+$/, '')
  const tail = sql.slice(scanned.insertFrom, scanned.bodyEnd).trim()
  const trailing = sql.slice(scanned.bodyEnd)
  const clause = `${scanned.whereFrom >= 0 ? 'AND' : 'WHERE'} (${trimmed})`
  return [head, clause, tail].filter(Boolean).join('\n') + trailing
}
