import type { Engine } from './electron'
import { maskSql, type SqlModeFlags } from './sql-mask'

/** One statement of a script: as written, and with quoted text/comments blanked. */
export type ScriptStatement = { raw: string; masked: string }

export type SplitScript = { statements: ScriptStatement[]; masked: string }

// Splits a script into top-level statements. Shared by the renderer and the
// main-process drivers, like src/sql-mask.ts: the destructive-statement
// preflight must see exactly the statements the executor will run, or it warns
// about — and stays silent about — the wrong ones. One mask pass serves the
// splitter and every per-statement consumer.
export function splitScript(sql: string, engine?: Engine, mode?: SqlModeFlags): SplitScript {
  const masked = maskSql(sql, engine, mode)
  const statements: ScriptStatement[] = []
  let depth = 0
  // PostgreSQL's SQL-standard routine body is part of one CREATE statement
  // even though it contains semicolon-terminated statements. CASE has its own
  // END inside that body, so retain a tiny construct stack rather than treating
  // the first END as the end of BEGIN ATOMIC.
  const postgresBlocks: Array<'atomic' | 'case'> = []
  let previousWord = ''
  let start = 0
  const push = (from: number, to: number) => {
    if (masked.slice(from, to).trim()) statements.push({ raw: sql.slice(from, to).trim(), masked: masked.slice(from, to).trim() })
  }
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]!
    if (engine === 'postgresql' && /[A-Za-z_]/.test(char) && !/[A-Za-z0-9_$]/.test(masked[i - 1] ?? '')) {
      let end = i + 1
      while (/[A-Za-z0-9_$]/.test(masked[end] ?? '')) end += 1
      const word = masked.slice(i, end).toLowerCase()
      if (word === 'begin' && /^\s+atomic\b/i.test(masked.slice(end))) {
        postgresBlocks.push('atomic')
      } else if (postgresBlocks.length && word === 'case' && previousWord !== 'end') {
        postgresBlocks.push('case')
      } else if (postgresBlocks.length && word === 'end') {
        postgresBlocks.pop()
      }
      previousWord = word
      i = end - 1
    } else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0 && postgresBlocks.length === 0) {
      push(start, i)
      start = i + 1
    }
  }
  push(start, sql.length)
  return { statements, masked }
}

export function splitTopLevelStatements(sql: string, engine?: Engine, mode?: SqlModeFlags): string[] {
  return splitScript(sql, engine, mode).statements.map((statement) => statement.raw)
}

/** One client-side batch of a T-SQL script, with the repeat count written after its GO. */
export type GoBatch = { sql: string; repeat: number | undefined }

/**
 * Splits a T-SQL script at GO separator lines: GO is a client batch separator,
 * not T-SQL, so each batch is what the server parses on its own. Repeat counts
 * are reported rather than applied — the executor validates and expands them
 * (`splitSqlServerBatches`), while the preflight only needs to see each batch
 * once. Empty batches are kept so a caller still sees every separator's count.
 */
export function scanGoBatches(sql: string): GoBatch[] {
  const masked = maskSql(sql, 'sqlserver')
  const batches: GoBatch[] = []
  let start = 0
  const line = /^\s*go(?:\s+(\d+))?\s*$/gim
  for (const match of masked.matchAll(line)) {
    batches.push({ sql: sql.slice(start, match.index).trim(), repeat: match[1] === undefined ? undefined : Number(match[1]) })
    start = match.index + match[0].length
  }
  const tail = sql.slice(start).trim()
  if (tail) batches.push({ sql: tail, repeat: undefined })
  return batches
}
