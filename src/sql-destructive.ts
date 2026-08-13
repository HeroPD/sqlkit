import type { Engine } from './electron'
import type { SqlModeFlags } from './sql-mask'
import { scanGoBatches, splitScript } from './sql-statements'

/** A kind of irreversible statement a run may contain. */
export type DestructiveKind = 'dropDatabase' | 'drop' | 'truncate' | 'deleteAll' | 'alterDrop' | 'updateAll'

// Reported in this order, so a preflight leads with the finding that costs most.
const SEVERITY: DestructiveKind[] = ['dropDatabase', 'drop', 'truncate', 'deleteAll', 'alterDrop', 'updateAll']

const WRITES = new Set(['delete', 'update'])

/**
 * Words that can only open a statement of their own, so a qualifier past one
 * belongs to that statement rather than to the write being judged. SET is
 * absent on purpose: it is part of UPDATE … SET.
 */
const NEXT_STATEMENT = new Set([
  'alter', 'begin', 'call', 'commit', 'create', 'declare', 'delete', 'do', 'drop', 'exec', 'execute', 'grant',
  'if', 'insert', 'merge', 'print', 'revoke', 'rollback', 'select', 'truncate', 'update', 'use', 'waitfor',
  'while', 'with',
])

/** Anything that narrows a write to less than every row; LIMIT/TOP bound one as deliberately as WHERE. */
const QUALIFIERS = new Set(['where', 'limit', 'top'])

/** Words between DROP and the kind of object it removes (DROP MATERIALIZED VIEW …). */
const DROP_MODIFIERS = new Set([
  'concurrently', 'exists', 'external', 'foreign', 'global', 'if', 'local', 'materialized', 'temp', 'temporary',
  'unlogged',
])

/** ALTER … DROP of an attribute rather than of data (DROP NOT NULL, DROP DEFAULT). */
const ATTRIBUTE_DROPS = new Set(['default', 'expression', 'generated', 'identity', 'not', 'statistics', 'valid'])

/** Routine and view bodies hold statements that define, rather than run, the writes inside them. */
const ROUTINES = new Set(['function', 'proc', 'procedure', 'trigger', 'view'])

/** Keywords that can head a statement, used to find where an EXPLAIN's wrapped statement starts. */
const STATEMENT_HEADS = new Set([
  'alter', 'call', 'create', 'delete', 'drop', 'exec', 'execute', 'insert', 'merge', 'pragma', 'replace',
  'select', 'show', 'table', 'truncate', 'update', 'upsert', 'values', 'with',
])

/**
 * What MariaDB's bare ANALYZE may wrap. Narrower than STATEMENT_HEADS on
 * purpose: ANALYZE TABLE (MySQL) and ANALYZE <table> (Postgres) maintain
 * statistics and run no wrapped statement, so they must not be unwrapped.
 */
const ANALYZE_BODIES = new Set(['delete', 'insert', 'replace', 'select', 'update', 'with'])

type Word = { text: string; depth: number }

/**
 * Words and their paren depth, over masked SQL: comments and quoted text are
 * already blanks there, so nothing inside them can be read as a keyword. T-SQL
 * variable sigils stay part of a word so `@delete` is not the DELETE keyword.
 */
function words(masked: string): Word[] {
  const found: Word[] = []
  let depth = 0
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]!
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (/[A-Za-z_@#]/.test(char)) {
      let end = i + 1
      while (/[A-Za-z0-9_@#$]/.test(masked[end] ?? '')) end += 1
      found.push({ text: masked.slice(i, end).toLowerCase(), depth })
      i = end - 1
    }
  }
  return found
}

/**
 * Whether the write at `index` scopes itself. The qualifier has to sit at the
 * write's own paren depth: the WHERE of a subquery narrows the subquery, not
 * the statement — UPDATE t SET x = (SELECT … WHERE …) still rewrites every row.
 */
function isQualified(scan: Word[], index: number): boolean {
  const depth = scan[index]!.depth
  for (let i = index + 1; i < scan.length; i += 1) {
    const word = scan[i]!
    if (word.depth < depth) return false
    if (word.depth > depth) continue
    if (QUALIFIERS.has(word.text)) return true
    if (NEXT_STATEMENT.has(word.text)) return false
  }
  return false
}

/** The index of `target` within the statement starting at `index`, or -1. */
function findWithin(scan: Word[], index: number, target: string): number {
  const depth = scan[index]!.depth
  for (let i = index + 1; i < scan.length; i += 1) {
    const word = scan[i]!
    if (word.depth < depth) return -1
    if (word.depth > depth) continue
    if (word.text === target) return i
    if (NEXT_STATEMENT.has(word.text)) return -1
  }
  return -1
}

/** The kind of object a DROP removes, ignoring the modifiers in between. */
function dropObject(scan: Word[], index: number): string {
  const depth = scan[index]!.depth
  for (let i = index + 1; i < scan.length; i += 1) {
    const word = scan[i]!
    if (word.depth !== depth) continue
    if (!DROP_MODIFIERS.has(word.text)) return word.text
  }
  return ''
}

/**
 * Where the statement that actually runs begins. EXPLAIN ANALYZE executes what
 * it wraps, so the wrapped statement is the one to judge; plain EXPLAIN only
 * reports a plan, and SQLite's EXPLAIN QUERY PLAN — which has no ANALYZE form —
 * runs nothing either. Options may be bare words (EXPLAIN ANALYZE VERBOSE …) or
 * a parenthesised list (EXPLAIN (ANALYZE, BUFFERS) …), so the wrapped statement
 * is found by its own head keyword rather than by enumerating option names.
 */
function explainBody(scan: Word[], engine?: Engine): number {
  // MariaDB has no EXPLAIN ANALYZE: it spells the running form `ANALYZE
  // <statement>` (with an optional FORMAT=JSON), and that really runs the write
  // it wraps — so it is judged by the wrapped statement, like EXPLAIN ANALYZE.
  if (engine === 'mysql' && scan[0]?.text === 'analyze') {
    const index = scan[1]?.text === 'format' ? 3 : 1
    return ANALYZE_BODIES.has(scan[index]?.text ?? '') ? index : 0
  }
  if (scan[0]?.text !== 'explain') return 0
  let analyze = false
  for (let index = 1; index < scan.length; index += 1) {
    const word = scan[index]!
    if (word.text === 'analyze' || word.text === 'analyse') analyze = true
    if (word.depth === 0 && STATEMENT_HEADS.has(word.text)) return analyze ? index : 0
  }
  return 0
}

function classify(masked: string, engine?: Engine): DestructiveKind[] {
  const all = words(masked)
  const scan = all.slice(explainBody(all, engine))
  const head = scan[0]
  if (!head) return []

  // T-SQL makes semicolons optional and GO is a client-side separator, so one
  // split statement can hold several: every top-level keyword is a candidate
  // there. Elsewhere only the head is a statement — except a CTE's own write
  // (WITH x AS (DELETE … RETURNING …) …), which runs wherever it sits.
  const scanAll = engine === 'sqlserver' || head.text === 'with'
  // The cost of scanning all of a T-SQL statement is routine bodies: the writes
  // in a CREATE PROCEDURE define what it will do later, not what runs now.
  if (scanAll && (head.text === 'create' || head.text === 'alter') && scan.slice(1, 4).some((word) => ROUTINES.has(word.text))) {
    return []
  }

  const found: DestructiveKind[] = []
  const consumed = new Set<number>()
  const limit = scanAll ? scan.length : 1
  for (let index = 0; index < limit; index += 1) {
    if (consumed.has(index)) continue
    const word = scan[index]!
    // A MERGE branch's UPDATE/DELETE is scoped by the merge's ON condition.
    if (scan[index - 1]?.text === 'then') continue
    if (word.depth > 0 && !(head.text === 'with' && WRITES.has(word.text))) continue
    switch (word.text) {
      case 'drop': {
        const object = dropObject(scan, index)
        found.push(object === 'database' || object === 'schema' ? 'dropDatabase' : 'drop')
        break
      }
      case 'truncate':
        found.push('truncate')
        break
      case 'alter': {
        // ALTER … DROP takes a column or constraint and its data with it, while
        // ALTER … ADD does not. That DROP belongs to this statement, so it must
        // not also count as a DROP of its own.
        const drop = findWithin(scan, index, 'drop')
        if (drop < 0) break
        consumed.add(drop)
        if (!ATTRIBUTE_DROPS.has(scan[drop + 1]?.text ?? '')) found.push('alterDrop')
        break
      }
      case 'delete':
        if (!isQualified(scan, index)) found.push('deleteAll')
        break
      case 'update':
        if (!isQualified(scan, index)) found.push('updateAll')
        break
    }
  }
  return found
}

const SHOWPLAN_MODES = new Set(['showplan_all', 'showplan_xml', 'showplan_text'])

/** The SHOWPLAN switch this statement flips, if any. SQL Server's estimated
 * plan — what History's Explain sends — turns it on, and every statement after
 * it is compiled rather than run until the matching OFF. */
function showplanSwitch(masked: string): 'on' | 'off' | undefined {
  const scan = words(masked)
  if (scan.length !== 3 || scan[0]!.text !== 'set' || !SHOWPLAN_MODES.has(scan[1]!.text)) return undefined
  const mode = scan[2]!.text
  return mode === 'on' || mode === 'off' ? mode : undefined
}

/**
 * The kinds of irreversible statement in `sql`, worst first and deduplicated —
 * a preflight names each risk once however many statements carry it. Classified
 * on masked SQL, so a DROP inside a comment or a string literal is not one.
 *
 * Known blind spots, all narrow, all needing the shared splitter or new IPC to
 * close properly:
 *  - MySQL sessions running NO_BACKSLASH_ESCAPES or ANSI_QUOTES quote strings by
 *    other rules than the default masking here, and `mode` is not available in
 *    the renderer (the driver reads sql_mode at connect). A crafted literal can
 *    therefore hide a second statement that the connection would run.
 *  - MySQL DELIMITER scripts are not preprocessed here, and the splitter tracks
 *    compound BEGIN … END bodies for PostgreSQL only, so a routine definition
 *    splits at its body's semicolons and can raise a *false* warning about a
 *    write that merely gets defined.
 *  - A WHERE spelled as a tautology (WHERE 1=1) reads as a scoped write.
 */
export function analyzeDestructive(sql: string, engine?: Engine, mode?: SqlModeFlags): DestructiveKind[] {
  if (!sql.trim()) return []
  const found = new Set<DestructiveKind>()
  // GO is a client-side separator, so each batch is parsed by the server on its
  // own: analysing per batch keeps a routine body in one batch from suppressing
  // the statements in the next, which the executor will still run.
  const batches = engine === 'sqlserver' ? scanGoBatches(sql).map((batch) => batch.sql).filter(Boolean) : [sql]
  // Carried across batches, because the switch is session state: the SET owns
  // its batch, and the statement it spares is in the next one. SHOWPLAN is
  // T-SQL only — on every other engine that SET is not a statement that spares
  // anything, so reading one there would silently disarm the whole preflight.
  let compiledOnly = false
  for (const batch of batches) {
    for (const statement of splitScript(batch, engine, mode).statements) {
      const showplan = engine === 'sqlserver' ? showplanSwitch(statement.masked) : undefined
      if (showplan) compiledOnly = showplan === 'on'
      else if (!compiledOnly) for (const kind of classify(statement.masked, engine)) found.add(kind)
    }
  }
  return SEVERITY.filter((kind) => found.has(kind))
}
