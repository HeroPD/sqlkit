import type { Engine, TableRef } from './electron'
import { maskSql } from './sql-mask'

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
