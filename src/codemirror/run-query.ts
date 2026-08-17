import { EditorState, Prec, type Extension, type Line, type Text } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import type { SyntaxNode, Tree } from '@lezer/common'
import { maskSqlRegions } from '../sql-mask'
import { atomicBodySpans, type SqlSpan } from '../sql-statements'
import { engineForDialect, SQL_DIALECTS, type SqlDialectName } from './dialects'

/**
 * The regions the syntax tree cannot be trusted inside. The editor's postgres
 * dialect parses dollar-quoted bodies as plain SQL, and the parser splits on
 * `;` alone, so a `BEGIN ATOMIC` routine body shatters into fragments too.
 * Both come from the same dialect-aware scan the executor's splitter uses, so
 * the statement offered to run and the statement that actually runs cannot
 * disagree about where either one ends.
 */
const unparsedSpans = (text: string, dialect: SqlDialectName | undefined): SqlSpan[] => {
  const engine = dialect ? engineForDialect[dialect] : undefined
  // Both constructs are Postgres-only and the mask is the one full-text pass
  // per run, so skip it outright when neither can be in the document. Either
  // spelling would have to appear literally, inside a string or not.
  if (engine && engine !== 'postgresql') return []
  if (!text.includes('$') && !/atomic/i.test(text)) return []

  const { masked, regions } = maskSqlRegions(text, engine)
  const spans: SqlSpan[] = []
  for (const region of regions) if (region.kind === 'dollar') spans.push([region.from, region.to])
  if (!engine || engine === 'postgresql') spans.push(...atomicBodySpans(masked))
  return spans.sort((a, b) => a[0] - b[0])
}

/** The span strictly containing `pos`; span edges count as outside. */
const spanAt = (spans: SqlSpan[], pos: number): SqlSpan | null => {
  for (const span of spans) {
    if (pos <= span[0]) break
    if (pos < span[1]) return span
  }
  return null
}

/** The SQL to run and its start offset in the document (post-trim). */
export type QueryBlock = { sql: string; from: number }

export type RunQueryHandler = (query: QueryBlock, view: EditorView) => void

/**
 * A query block is the intersection of two segmentations:
 *  - parser statements (split on real `;`, so semicolons in strings,
 *    comments and dollar-quotes never split), and
 *  - blank-line blocks (scratch files often omit `;` and separate queries
 *    with blank lines instead; blank lines inside parens, strings or
 *    dollar-quoted bodies do not count as separators).
 *
 * Lookup stays cheap on large documents: the tree is probed around the cursor
 * (O(log n)) instead of walking every statement, and only the block that will
 * run is ever sliced. The one full-text pass is the mask behind
 * `unparsedSpans`, paid per run rather than per keystroke — the editor's
 * per-update check (`hasExplicitQueryTarget`) stays on the tree alone.
 */

const PARSE_TIMEOUT_MS = 100
const PARSE_AHEAD_CHARS = 100_000
const PARSE_RETRY_TIMEOUT_MS = 300

/**
 * Normally a no-op: the editor parses in the background, so the full tree is
 * already there. On a huge doc opened moments ago, pay a bounded one-time
 * cost to parse through the cursor region so the statement under the cursor
 * is trustworthy, rather than blocking on the whole document.
 */
const treeForQuery = (state: EditorState, cursor: number) => {
  const full = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS)
  if (full) return full

  const nearCursor = Math.min(state.doc.length, cursor + PARSE_AHEAD_CHARS)
  return ensureSyntaxTree(state, nearCursor, PARSE_RETRY_TIMEOUT_MS) ?? syntaxTree(state)
}

const isBlank = (text: string) => !/\S/.test(text)

/**
 * A blank line only separates queries at the top level of a statement.
 * Inside parens or strings the innermost node is not Script/Statement, so the
 * line is part of the query; dollar-quoted bodies parse as plain SQL and need
 * the span check instead.
 */
const isSeparatorLine = (tree: Tree, spans: SqlSpan[], line: Line) => {
  if (!isBlank(line.text)) return false
  if (spanAt(spans, line.from)) return false
  const context = tree.resolveInner(line.from, 0)
  return context.name === 'Script' || context.name === 'Statement'
}

/**
 * Keywords that can only open a statement, never continue one. The parser
 * splits on `;` alone, so an unterminated query swallows everything up to the
 * next semicolon — `SELECT … LIMIT 200` followed by `ALTER TABLE …;` parses as
 * one statement and runs as one, which the server rejects. A flush-left
 * statement keyword ends the query above it.
 *
 * Absent on purpose: keywords that legally continue a statement — SET
 * (UPDATE … SET), VALUES, and DROP (ALTER TABLE t / DROP COLUMN c, which
 * people do write across two lines). SELECT and WITH continue one only
 * sometimes, so they answer per block in `statementStarts` instead.
 * ALTER counts only when what follows can head a statement — ALTER COLUMN and
 * ALTER CONSTRAINT/CHECK continue an ALTER TABLE the same way DROP does — and
 * BEGIN only with an explicit transaction tail: bare BEGIN opens a T-SQL
 * block. Outside SQL Server a lone BEGIN can still open a transaction — see
 * `bareTransactionBegin`.
 */
const STATEMENT_START =
  /^(?:(?:create|insert|update|delete|merge|truncate|copy|grant|revoke|vacuum|reindex|refresh|explain|commit|rollback|savepoint|call|do|show|use|describe|pragma)\b|alter\s+(?!column\b|constraint\b|check\b)|begin(?:\s*;|\s+(?:transaction|tran|work|isolation|deferred|immediate|exclusive|read)\b))/i

/**
 * A lone flush-left BEGIN outside SQL Server: there it opens a T-SQL block,
 * everywhere else it starts a transaction — a complete statement, never the
 * head of the query typed under it. The previous line must be finished
 * (start of doc, blank, or `;`-terminated) because the same lone BEGIN under
 * an unterminated header line is a body opener instead: a SQLite trigger or
 * a MySQL routine.
 */
const bareTransactionBegin = (dialect: SqlDialectName | undefined, doc: Text, line: Line) => {
  if (!dialect || dialect === 'mssql' || !/^begin\s*$/i.test(line.text)) return false
  if (line.number === 1) return true
  const prev = doc.line(line.number - 1).text
  return isBlank(prev) || /;\s*$/.test(prev)
}

/**
 * A keyword line can still be the body of the construct above it: T-SQL
 * control flow takes a bare statement (IF @x = 1 / WHILE … / ELSE), a bare
 * BEGIN opens a block, and a MERGE branch hands off with THEN. A lone BEGIN
 * that opened a transaction is already finished, so nothing continues it.
 */
const continuesPreviousLine = (dialect: SqlDialectName | undefined, doc: Text, line: Line) => {
  if (line.number === 1) return false
  const prev = doc.line(line.number - 1)
  if (/^\s*(?:if|while|else)\b/i.test(prev.text) || /\bthen\s*$/i.test(prev.text)) return true
  return /^\s*begin\s*$/i.test(prev.text) && !bareTransactionBegin(dialect, doc, prev)
}

/**
 * Whether the line's leading keyword sits at the top level of the script.
 * Inside parens (a CTE's DELETE), a string, or a comment the parser gives a
 * different context; dollar-quoted bodies parse as plain SQL, so — as with
 * blank lines — they need the span check instead.
 */
const topLevelKeywordLine = (tree: Tree, spans: SqlSpan[], line: Line) => {
  if (spanAt(spans, line.from)) return false
  const keyword = tree.resolveInner(line.from, 1)
  return keyword.name === 'Keyword' && keyword.parent?.name === 'Statement' && keyword.parent.parent?.name === 'Script'
}

/** A lone transaction-opening BEGIN at the top level: one complete statement on its own line. */
const transactionBeginLine = (dialect: SqlDialectName | undefined, tree: Tree, spans: SqlSpan[], doc: Text, line: Line) =>
  bareTransactionBegin(dialect, doc, line) && topLevelKeywordLine(tree, spans, line)

/**
 * Whether `line` opens a new statement: the keyword must be flush left (a
 * continuation clause of a well-formed statement is indented — MERGE's WHEN
 * MATCHED THEN / UPDATE SET), must not be the body the previous line expects,
 * and must sit at the top level of the script.
 */
const startsStatement = (dialect: SqlDialectName | undefined, tree: Tree, spans: SqlSpan[], doc: Text, line: Line) => {
  if (!STATEMENT_START.test(line.text) && !bareTransactionBegin(dialect, doc, line)) return false
  if (continuesPreviousLine(dialect, doc, line)) return false
  return topLevelKeywordLine(tree, spans, line)
}

/**
 * A flush-left SELECT or WITH is as often the body of the statement above it —
 * an INSERT's source, a CTE's query, `CREATE VIEW … AS`, the right side of a
 * UNION — as it is a new statement. Which one it is depends on what opened the
 * statement above rather than on the line itself, so these are settled against
 * that head in `statementStarts` instead of in `startsStatement`.
 */
const SELECT_OPENER = /^(?:select|with)\b/i

/**
 * Whether a statement opening with `head` takes the flush-left SELECT under it
 * as its body. An INSERT does only while it is still missing its source: one
 * that already names its rows is finished, and the SELECT below it is the next
 * query. Only the head line is read, so `VALUES` parked on a line of its own
 * still reads as unfinished.
 */
const takesSelectBody = (head: string) =>
  /^\s*(?:with|create|explain|analyze|prepare|declare)\b/i.test(head) ||
  (/^\s*(?:insert|replace)\b/i.test(head) && !/\bvalues\b/i.test(head))

const isCommentLine = (text: string) => /^\s*--/.test(text)

// A trailing line comment is no part of the statement's tail. A `--` with a
// quote after it sits inside a string literal and starts no comment.
const codeTail = (text: string) => text.replace(/--[^'"]*$/, '')

const SET_OPERATOR = /\b(?:union|intersect|except|minus)(?:\s+(?:all|distinct))?\s*$/i

/** Whether the code above `line` hands off to a SELECT: `… UNION [ALL]`. */
const afterSetOperator = (doc: Text, line: Line) => {
  for (let n = line.number - 1; n >= 1; n -= 1) {
    const { text } = doc.line(n)
    if (isBlank(text) || isCommentLine(text)) continue
    return SET_OPERATOR.test(codeTail(text))
  }
  return false
}

/**
 * The lines in [first, last] that open a statement of their own. Only the
 * SELECT/WITH question is answered here — every other keyword already answered
 * for itself in `startsStatement` — and it is answered against the head of the
 * statement the line would otherwise join, which is why this walks down from
 * the block's first line carrying that head. A SELECT taken as some other
 * statement's body becomes the head itself, so the next one still splits. A
 * comment heads nothing, so the query written under one stays with it.
 */
const statementStarts = (
  dialect: SqlDialectName | undefined,
  tree: Tree,
  spans: SqlSpan[],
  doc: Text,
  first: Line,
  last: Line,
) => {
  const starts = [first]
  let head = ''
  for (let n = first.number; n <= last.number; n += 1) {
    const line = doc.line(n)
    if (isBlank(line.text) || isCommentLine(line.text)) continue
    if (!head) {
      head = line.text
      continue
    }
    if (!SELECT_OPENER.test(line.text) || !topLevelKeywordLine(tree, spans, line)) continue
    if (!takesSelectBody(head) && !continuesPreviousLine(dialect, doc, line) && !afterSetOperator(doc, line)) {
      starts.push(line)
    }
    head = line.text
  }
  return starts
}

/** An empty statement (a bare `;`) is never worth running. */
const isRunnable = (doc: Text, node: SyntaxNode) =>
  node.name === 'Statement' &&
  (node.to - node.from > 1 || doc.sliceString(node.from, node.to) !== ';')

/** The direct child of the top node at the cursor, or null when the cursor sits in top-level whitespace. */
const topLevelNodeAt = (tree: Tree, cursor: number) => {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode = tree.resolve(cursor, side)
    while (node.parent && node.parent.parent) node = node.parent
    if (node.parent) return node
  }
  return null
}

const statementSibling = (doc: Text, start: SyntaxNode | null, dir: -1 | 1) => {
  for (let node = start; node; node = dir < 0 ? node.prevSibling : node.nextSibling) {
    if (isRunnable(doc, node)) return node
  }
  return null
}

/**
 * The top-level Statement nodes around the cursor: the one covering it, or
 * its nearest runnable neighbors when the cursor sits in whitespace or a
 * top-level comment.
 */
const statementsAround = (tree: Tree, doc: Text, cursor: number) => {
  const top = tree.topNode

  const at = topLevelNodeAt(tree, cursor)
  const covering = at && isRunnable(doc, at) ? at : null
  const prev = covering
    ? null
    : statementSibling(doc, at ? at.prevSibling : top.childBefore(cursor), -1)
  const next = covering
    ? null
    : statementSibling(doc, at ? at.nextSibling : top.childAfter(cursor), 1)

  return { covering, prev, next }
}

/**
 * The blank-line-delimited block at/nearest the cursor, found by walking
 * lines outward and clipped to [lo, hi] when given.
 */
const paragraphBlock = (dialect: SqlDialectName | undefined, tree: Tree, spans: SqlSpan[], doc: Text, cursor: number, lo = 0, hi = doc.length) => {
  let line = doc.lineAt(cursor)

  if (isBlank(line.text)) {
    let above: Line | null = null
    for (let n = line.number - 1; n >= 1; n -= 1) {
      const candidate = doc.line(n)
      if (!isBlank(candidate.text)) {
        above = candidate
        break
      }
    }

    let below: Line | null = null
    for (let n = line.number + 1; n <= doc.lines; n += 1) {
      const candidate = doc.line(n)
      if (!isBlank(candidate.text)) {
        below = candidate
        break
      }
    }

    if (!above && !below) return null
    // Ties go to the block above, matching the statement tie-break.
    line = !below || (above && cursor - above.to <= below.from - cursor) ? above! : below
  }

  // A statement keyword bounds the block from whichever side it is met: the
  // line that opens a statement is the block's first line, and the next one to
  // open a statement is where the block stops. A transaction-opening BEGIN is
  // complete on its own: as the anchor it is the whole block, and met above
  // the anchor it is a finished statement rather than this block's opener.
  let first = line
  let last = line
  if (!transactionBeginLine(dialect, tree, spans, doc, line)) {
    while (first.number > 1 && first.from > lo) {
      if (startsStatement(dialect, tree, spans, doc, first)) break
      const candidate = doc.line(first.number - 1)
      if (isSeparatorLine(tree, spans, candidate) || transactionBeginLine(dialect, tree, spans, doc, candidate)) break
      first = candidate
    }

    while (last.number < doc.lines && last.to < hi) {
      const candidate = doc.line(last.number + 1)
      if (isSeparatorLine(tree, spans, candidate) || startsStatement(dialect, tree, spans, doc, candidate)) break
      last = candidate
    }
  }

  // A flush-left SELECT reads as a statement start only in the light of the
  // block above it, so the block is narrowed to the one covering the anchor
  // once both ends are known.
  for (const start of statementStarts(dialect, tree, spans, doc, first, last)) {
    if (start.number > line.number) {
      last = doc.line(start.number - 1)
      break
    }
    first = start
  }

  const from = Math.max(first.from, lo)
  const to = Math.min(last.to, hi)
  if (from >= to) return null
  const raw = doc.sliceString(from, to)
  const sql = raw.trim()
  return sql ? { sql, from: from + raw.length - raw.trimStart().length } : null
}

/** The direct child of the top node whose `side` edge is at/inside pos, or null. */
const topLevelCovering = (tree: Tree, pos: number, side: -1 | 1) => {
  let node: SyntaxNode = tree.resolve(pos, side)
  while (node.parent && node.parent.parent) node = node.parent
  return node.parent ? node : null
}

const intersectsSpan = (spans: SqlSpan[], from: number, to: number) =>
  spans.some(([spanFrom, spanTo]) => from < spanTo && to > spanFrom)

/**
 * A `;` inside a dollar-quoted body falsely ends a Statement (the body parses
 * as plain SQL), shattering one CREATE FUNCTION into fragments and stray `$$`
 * error nodes. Grow the chosen range until both edges are genuine boundaries:
 * over any span an edge lands in, out to the top-level node covering an edge,
 * back over neighbors still touching a span, and forward while the statement
 * hasn't ended in a real `;` outside every span.
 */
const expandOverSpans = (tree: Tree, spans: SqlSpan[], doc: Text, node: SyntaxNode): [number, number] => {
  let from = node.from
  let to = node.to
  if (!spans.length) return [from, to]
  for (;;) {
    const span = spanAt(spans, from)
    if (span) { from = span[0]; continue }
    const covering = topLevelCovering(tree, from, 1)
    if (covering && covering.from < from) { from = covering.from; continue }
    const prev = tree.topNode.childBefore(from)
    // A neighbor ending in a real `;` outside every span is a genuine
    // boundary even when its head sits inside one (`$fn$ LANGUAGE sql;`).
    const prevComplete =
      prev?.name === 'Statement' &&
      doc.sliceString(prev.to - 1, prev.to) === ';' &&
      !spanAt(spans, prev.to - 1)
    if (prev && !prevComplete && intersectsSpan(spans, prev.from, prev.to)) { from = prev.from; continue }
    break
  }
  for (;;) {
    const span = spanAt(spans, to)
    if (span) { to = span[1]; continue }
    const covering = topLevelCovering(tree, to, -1)
    if (covering && covering.to > to) { to = covering.to; continue }
    if (to >= doc.length || doc.sliceString(to - 1, to) === ';') break
    const next = tree.topNode.childAfter(to)
    if (!next || next.from < to) break
    to = next.to
  }
  return [from, to]
}

const closestQueryBlock = (state: EditorState, cursor: number, allowNeighbor = true, dialect?: SqlDialectName) => {
  const doc = state.doc
  const tree = treeForQuery(state, cursor)
  // One full-text scan per run; the tree can't provide these (see unparsedSpans).
  const spans = unparsedSpans(doc.toString(), dialect)
  const { covering, prev, next } = statementsAround(tree, doc, cursor)

  if (!covering && !allowNeighbor) return null
  if (!covering && !prev && !next) return paragraphBlock(dialect, tree, spans, doc, cursor)

  const chosen = covering
    ? covering
    : !prev
      ? next!
      : !next
        ? prev
        : next.from - cursor < cursor - prev.to
          ? next
          : prev

  // Partial parse: anything at or past the frontier may be a truncated
  // statement. The line-based block needs no tree, but accept it only when
  // it does not visibly span multiple statements; running nothing is safer
  // than running a fragment or half the file.
  if (tree.length < doc.length && (cursor > tree.length || chosen.to >= tree.length)) {
    const block = paragraphBlock(dialect, tree, spans, doc, cursor)
    if (!block) return null
    const body = block.sql.endsWith(';') ? block.sql.slice(0, -1) : block.sql
    return body.includes(';') ? null : block
  }

  const [from, to] = expandOverSpans(tree, spans, doc, chosen)

  // Clip to the blank-line block at the cursor, so an unterminated query
  // that the parser merged into the next statement still runs alone.
  const seed = Math.max(from, Math.min(cursor, to))
  return paragraphBlock(dialect, tree, spans, doc, seed, from, to)
}

// A position strictly inside a leaf token (identifier, keyword, string, …):
// a selection endpoint there is a sloppy drag, not a deliberate fragment.
const cutsToken = (state: EditorState, pos: number) => {
  const node = syntaxTree(state).resolveInner(pos, 0)
  return !node.firstChild && node.from < pos && node.to > pos
}

/**
 * The SQL that Mod-Enter would run: the selection if any, else the query
 * block at/nearest the cursor. A selection with an endpoint mid-token is
 * snapped out to whole lines — the cut fragment could never run, and a drag
 * across lines rarely lands exactly on token edges.
 */
export const queryToRun = (state: EditorState, dialect?: SqlDialectName): QueryBlock | null => {
  const { from, to, head } = state.selection.main
  if (from < to) {
    const snap = cutsToken(state, from) || cutsToken(state, to)
    const runFrom = snap ? state.doc.lineAt(from).from : from
    const runTo = snap ? state.doc.lineAt(to).to : to
    const raw = state.sliceDoc(runFrom, runTo)
    const selected = raw.trim()
    if (selected) return { sql: selected, from: runFrom + raw.length - raw.trimStart().length }
  }
  return closestQueryBlock(state, head, true, dialect)
}

/** An explicit selection, or only the statement that actually contains the caret. */
export const explicitQueryToRun = (state: EditorState, dialect?: SqlDialectName): QueryBlock | null => {
  const { from, to, head } = state.selection.main
  if (from < to) {
    const raw = state.sliceDoc(from, to)
    const selected = raw.trim()
    if (selected) return { sql: selected, from: from + raw.length - raw.trimStart().length }
  }
  return closestQueryBlock(state, head, false, dialect)
}

/** Cheap UI-state check; execution itself uses the fully parsed explicitQueryToRun path. */
export const hasExplicitQueryTarget = (state: EditorState): boolean => {
  const { from, to, head } = state.selection.main
  if (from < to) return Boolean(state.sliceDoc(from, to).trim())
  return statementsAround(syntaxTree(state), state.doc, head).covering !== null
}

// First runnable statement of a plain SQL string (same `;`/blank-line splitting as run-at-caret),
// for callers without a live editor — e.g. re-running a stored tab minus its trailing half-written query.
// The throwaway state parses under the caller's dialect: the generic one tokenizes `[b]`/`` `b` ``
// as plain SQL and splits inside quoted identifiers that happen to hold a `;`.
export const firstStatement = (text: string, dialect?: SqlDialectName): string => {
  const language = dialect ? sql({ dialect: SQL_DIALECTS[dialect].dialect }) : sql()
  const state = EditorState.create({ doc: text, extensions: [language] })
  return closestQueryBlock(state, 0, true, dialect)?.sql ?? ''
}

/** Binds Mod-Enter to run the selection, or the query block at/nearest the cursor. */
export const runQuery = (onRun: RunQueryHandler, dialect?: () => SqlDialectName): Extension =>
  Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: (view) => {
          const query = queryToRun(view.state, dialect?.())
          if (query) onRun(query, view)
          return true
        },
      },
    ]),
  )
