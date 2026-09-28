import type { Engine } from './electron'
import { maskSql, type SqlModeFlags } from './sql-mask'

/** One statement of a script: as written, and with quoted text/comments blanked. */
export type ScriptStatement = { raw: string; masked: string }

export type SplitScript = { statements: ScriptStatement[]; masked: string }

/** A half-open region of a script: [from, to). */
export type SqlSpan = [from: number, to: number]

/**
 * PostgreSQL's SQL-standard routine body is part of one CREATE statement even
 * though it contains semicolon-terminated statements. CASE has its own END
 * inside that body, so a tiny construct stack keeps the first END from closing
 * BEGIN ATOMIC. Takes masked text so a `begin atomic` inside a literal or
 * comment cannot open a body.
 *
 * Shared so that everything deciding where a statement ends — the executor's
 * splitter below and the editor's run-at-caret target, whose syntax tree splits
 * on `;` alone — agrees on which semicolons are inside a routine body.
 */
export function atomicBodySpans(masked: string): SqlSpan[] {
  const spans: SqlSpan[] = []
  const blocks: Array<'atomic' | 'case'> = []
  let start = 0
  let previousWord = ''
  for (let i = 0; i < masked.length; i += 1) {
    if (!/[A-Za-z_]/.test(masked[i]!) || /[A-Za-z0-9_$]/.test(masked[i - 1] ?? '')) continue
    let end = i + 1
    while (/[A-Za-z0-9_$]/.test(masked[end] ?? '')) end += 1
    const word = masked.slice(i, end).toLowerCase()
    if (word === 'begin' && /^\s+atomic\b/i.test(masked.slice(end))) {
      if (!blocks.length) start = i
      blocks.push('atomic')
    } else if (blocks.length && word === 'case' && previousWord !== 'end') {
      blocks.push('case')
    } else if (blocks.length && word === 'end') {
      blocks.pop()
      if (!blocks.length) spans.push([start, end])
    }
    previousWord = word
    i = end - 1
  }
  // Still being typed: the body runs to the end of the script.
  if (blocks.length) spans.push([start, masked.length])
  return spans
}

// A routine header: CREATE [OR REPLACE | OR ALTER] [DEFINER = u@h] [TEMP] [AGGREGATE] PROC… | FUNCTION | TRIGGER | EVENT.
const ROUTINE_HEAD =
  /(?:create|alter)\s+(?:or\s+(?:replace|alter)\s+)?(?:definer\s*=\s*(?:\S*\s*@\s*\S*|\S+)\s+)?(?:temp(?:orary)?\s+)?(?:aggregate\s+)?(?:proc|procedure|function|trigger|event)\b/iy
const NOT_ATOMIC = /\s+not\s+atomic\b/iy
const END_WORD = /\s+([A-Za-z]+)/y

// Compound statements that only open a block where a statement starts: `IF(…)`, `REPEAT('a', 3)` and `DROP TABLE IF EXISTS` do not.
const STATEMENT_BLOCKS = new Set(['if', 'loop', 'while', 'repeat'])

// What can precede a statement inside a body, plus the header words a body without BEGIN can follow (`FOR EACH ROW IF …`).
const STATEMENT_LEADS = new Set(['', ';', ':', ')', 'begin', 'then', 'else', 'do', 'loop', 'repeat', 'row', 'deterministic', 'sql', 'data', 'definer', 'invoker', 'comment'])

const GO_LINE = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*\r?$/gim

// Whole routine definitions in masked text: MySQL/SQLite CREATE … through the END closing its compound body, T-SQL to the end
// of its GO batch. A single-statement body gets no span, since its first `;` already ends it.
export function compoundBodySpans(masked: string, engine: Engine | undefined): SqlSpan[] {
  if (engine !== 'mysql' && engine !== 'sqlite' && engine !== 'sqlserver') return []
  const spans: SqlSpan[] = []
  let start = -1
  let depth = 0
  let previous = ''
  // MySQL's `END$$` is END and a DELIMITER, not one word.
  const wordChar = engine === 'mysql' ? /[A-Za-z0-9_]/ : /[A-Za-z0-9_$]/
  const matchAt = (pattern: RegExp, at: number) => {
    pattern.lastIndex = at
    return pattern.exec(masked)
  }
  const wordAt = (from: number) => {
    let to = from + 1
    while (wordChar.test(masked[to] ?? '')) to += 1
    return masked.slice(from, to).toLowerCase()
  }
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]!
    if (/\s/.test(char)) continue
    if (!/[A-Za-z_]/.test(char) || /[A-Za-z0-9_$]/.test(masked[i - 1] ?? '')) {
      if (start >= 0 && !depth && char === ';') start = -1
      previous = char
      continue
    }
    const word = wordAt(i)
    let end = i + word.length
    if (start < 0) {
      const head = (word === 'create' || word === 'alter') && matchAt(ROUTINE_HEAD, i)
      if (head && engine === 'sqlserver') {
        const go = matchAt(GO_LINE, i)
        const to = go ? go.index : masked.length
        spans.push([i, i + masked.slice(i, to).trimEnd().length])
        i = go ? go.index + go[0].length - 1 : masked.length
        continue
      }
      if (head) {
        start = i
        end = i + head[0].length
        previous = /\w+$/.exec(head[0])![0].toLowerCase()
        i = end - 1
        continue
      } else if (engine === 'mysql' && word === 'begin' && matchAt(NOT_ATOMIC, end)) {
        // MariaDB's anonymous compound block runs at once but is still one statement.
        start = i
        depth = 1
      }
    } else if (word === 'begin' || word === 'case' || (STATEMENT_BLOCKS.has(word) && STATEMENT_LEADS.has(previous))) {
      depth += 1
    } else if (word === 'end' && depth) {
      depth -= 1
      // `END IF`, `END LOOP`, … close the block their word names; it opens nothing.
      const closes = matchAt(END_WORD, end)
      if (closes && (STATEMENT_BLOCKS.has(closes[1]!.toLowerCase()) || closes[1]!.toLowerCase() === 'case')) end += closes[0].length
      if (!depth) {
        spans.push([start, end])
        start = -1
      }
    }
    previous = word
    i = end - 1
  }
  // Still being typed: the body runs to the end of the script.
  if (start >= 0 && depth) spans.push([start, masked.length])
  return spans
}

const inSpan = (spans: SqlSpan[], pos: number) => spans.some(([from, to]) => pos >= from && pos < to)

// Splits a script into top-level statements. Shared by the renderer and the
// main-process drivers, like src/sql-mask.ts: the destructive-statement
// preflight must see exactly the statements the executor will run, or it warns
// about — and stays silent about — the wrong ones. One mask pass serves the
// splitter and every per-statement consumer.
export function splitScript(sql: string, engine?: Engine, mode?: SqlModeFlags): SplitScript {
  const masked = maskSql(sql, engine, mode)
  const statements: ScriptStatement[] = []
  let depth = 0
  const bodies = engine === 'postgresql' ? atomicBodySpans(masked) : compoundBodySpans(masked, engine)
  let start = 0
  const push = (from: number, to: number) => {
    if (masked.slice(from, to).trim()) statements.push({ raw: sql.slice(from, to).trim(), masked: masked.slice(from, to).trim() })
  }
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]!
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0 && !inSpan(bodies, i)) {
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

/**
 * Whether `sql` holds exactly one runnable statement. An EXPLAIN wrapper only
 * covers the statement it heads, so anything past the first one in a script
 * would be sent to the server as itself — planned for the caller, run for real.
 */
export function isSingleStatement(sql: string, engine?: Engine): boolean {
  const batches = engine === 'sqlserver' ? scanGoBatches(sql).map((batch) => batch.sql).filter(Boolean) : [sql]
  let count = 0
  for (const batch of batches) {
    count += splitScript(batch, engine).statements.length
    if (count > 1) return false
  }
  return count === 1
}
