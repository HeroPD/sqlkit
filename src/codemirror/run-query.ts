import { EditorState, Prec, type Extension, type Line, type Text } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import type { SyntaxNode, Tree } from '@lezer/common'
import { dollarSpans, spanAt, type DollarSpan } from './dollar-spans'

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
 * Lookup stays cheap on large documents: the doc is never stringified as a
 * whole, the tree is probed around the cursor (O(log n)) instead of walking
 * every statement, and only the block that will run is ever sliced.
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
const isSeparatorLine = (tree: Tree, spans: DollarSpan[], line: Line) => {
  if (!isBlank(line.text)) return false
  if (spanAt(spans, line.from)) return false
  const context = tree.resolveInner(line.from, 0)
  return context.name === 'Script' || context.name === 'Statement'
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
const paragraphBlock = (tree: Tree, spans: DollarSpan[], doc: Text, cursor: number, lo = 0, hi = doc.length) => {
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

  let first = line
  while (first.number > 1 && first.from > lo) {
    const candidate = doc.line(first.number - 1)
    if (isSeparatorLine(tree, spans, candidate)) break
    first = candidate
  }

  let last = line
  while (last.number < doc.lines && last.to < hi) {
    const candidate = doc.line(last.number + 1)
    if (isSeparatorLine(tree, spans, candidate)) break
    last = candidate
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

const intersectsSpan = (spans: DollarSpan[], from: number, to: number) =>
  spans.some(([spanFrom, spanTo]) => from < spanTo && to > spanFrom)

/**
 * A `;` inside a dollar-quoted body falsely ends a Statement (the body parses
 * as plain SQL), shattering one CREATE FUNCTION into fragments and stray `$$`
 * error nodes. Grow the chosen range until both edges are genuine boundaries:
 * over any span an edge lands in, out to the top-level node covering an edge,
 * back over neighbors still touching a span, and forward while the statement
 * hasn't ended in a real `;` outside every span.
 */
const expandOverSpans = (tree: Tree, spans: DollarSpan[], doc: Text, node: SyntaxNode): [number, number] => {
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

const closestQueryBlock = (state: EditorState, cursor: number) => {
  const doc = state.doc
  const tree = treeForQuery(state, cursor)
  // One full-text scan per run; the tree can't provide these (see dollar-spans.ts).
  const spans = dollarSpans(doc.toString())
  const { covering, prev, next } = statementsAround(tree, doc, cursor)

  if (!covering && !prev && !next) return paragraphBlock(tree, spans, doc, cursor)

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
    const block = paragraphBlock(tree, spans, doc, cursor)
    if (!block) return null
    const body = block.sql.endsWith(';') ? block.sql.slice(0, -1) : block.sql
    return body.includes(';') ? null : block
  }

  const [from, to] = expandOverSpans(tree, spans, doc, chosen)

  // Clip to the blank-line block at the cursor, so an unterminated query
  // that the parser merged into the next statement still runs alone.
  const seed = Math.max(from, Math.min(cursor, to))
  return paragraphBlock(tree, spans, doc, seed, from, to)
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
export const queryToRun = (state: EditorState): QueryBlock | null => {
  const { from, to, head } = state.selection.main
  if (from < to) {
    const snap = cutsToken(state, from) || cutsToken(state, to)
    const runFrom = snap ? state.doc.lineAt(from).from : from
    const runTo = snap ? state.doc.lineAt(to).to : to
    const raw = state.sliceDoc(runFrom, runTo)
    const selected = raw.trim()
    if (selected) return { sql: selected, from: runFrom + raw.length - raw.trimStart().length }
  }
  return closestQueryBlock(state, head)
}

// First runnable statement of a plain SQL string (same `;`/blank-line splitting as run-at-caret),
// for callers without a live editor — e.g. re-running a stored tab minus its trailing half-written query.
export const firstStatement = (text: string): string => {
  const state = EditorState.create({ doc: text, extensions: [sql()] })
  return closestQueryBlock(state, 0)?.sql ?? ''
}

/** Binds Mod-Enter to run the selection, or the query block at/nearest the cursor. */
export const runQuery = (onRun: RunQueryHandler): Extension =>
  Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: (view) => {
          const query = queryToRun(view.state)
          if (query) onRun(query, view)
          return true
        },
      },
    ]),
  )
