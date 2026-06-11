import { Prec, type EditorState, type Extension, type Line, type Text } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

export type RunQueryHandler = (sql: string, view: EditorView) => void

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
 * Inside parens, strings or dollar-quoted bodies the innermost node is not
 * Script/Statement, so the line is part of the query.
 */
const isSeparatorLine = (tree: Tree, line: Line) => {
  if (!isBlank(line.text)) return false
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
const paragraphBlock = (tree: Tree, doc: Text, cursor: number, lo = 0, hi = doc.length) => {
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

    if (!above && !below) return ''
    // Ties go to the block above, matching the statement tie-break.
    line = !below || (above && cursor - above.to <= below.from - cursor) ? above! : below
  }

  let first = line
  while (first.number > 1 && first.from > lo) {
    const candidate = doc.line(first.number - 1)
    if (isSeparatorLine(tree, candidate)) break
    first = candidate
  }

  let last = line
  while (last.number < doc.lines && last.to < hi) {
    const candidate = doc.line(last.number + 1)
    if (isSeparatorLine(tree, candidate)) break
    last = candidate
  }

  const from = Math.max(first.from, lo)
  const to = Math.min(last.to, hi)
  return from < to ? doc.sliceString(from, to).trim() : ''
}

const closestQueryBlock = (state: EditorState, cursor: number) => {
  const doc = state.doc
  const tree = treeForQuery(state, cursor)
  const { covering, prev, next } = statementsAround(tree, doc, cursor)

  if (!covering && !prev && !next) return paragraphBlock(tree, doc, cursor)

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
    const block = paragraphBlock(tree, doc, cursor)
    const body = block.endsWith(';') ? block.slice(0, -1) : block
    return body.includes(';') ? '' : block
  }

  // Clip to the blank-line block at the cursor, so an unterminated query
  // that the parser merged into the next statement still runs alone.
  const seed = Math.max(chosen.from, Math.min(cursor, chosen.to))
  return paragraphBlock(tree, doc, seed, chosen.from, chosen.to)
}

/** The SQL that Mod-Enter would run: the selection if any, else the query block at/nearest the cursor. */
export const queryToRun = (state: EditorState) => {
  const { from, to, head } = state.selection.main
  return state.sliceDoc(from, to).trim() || closestQueryBlock(state, head)
}

/** Binds Mod-Enter to run the selection, or the query block at/nearest the cursor. */
export const runQuery = (onRun: RunQueryHandler): Extension =>
  Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: (view) => {
          const sql = queryToRun(view.state)
          if (sql) onRun(sql, view)
          return true
        },
      },
    ]),
  )
