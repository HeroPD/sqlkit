import { Prec, type EditorState, type Extension, type Line, type Text } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

export type RunQueryHandler = (sql: string, view: EditorView) => void

/**
 * Statement lookup is built to stay cheap on large documents: the doc is
 * never stringified as a whole, the tree is probed around the cursor
 * (O(log n)) instead of walking every statement, and only the block that
 * will run is ever sliced. The editor keeps the tree current incrementally,
 * so the ensureSyntaxTree call is normally a no-op; when the parse genuinely
 * cannot finish in the budget we fall back to line-based blocks rather than
 * risk running a statement truncated at the parse frontier.
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
 * The top-level Statement nodes around the cursor. The parser already
 * understands strings, comments and dollar-quoting, so semicolons inside
 * those never split a statement. `count` saturates at 2 - it only exists to
 * tell "exactly one statement" (paragraph fallback territory) from "many".
 */
const statementsAround = (state: EditorState, cursor: number) => {
  const doc = state.doc
  const tree = treeForQuery(state, cursor)
  const top = tree.topNode

  // The node here is either a statement (then it covers the cursor), some
  // other top-level node like a comment, or null in plain whitespace.
  const at = topLevelNodeAt(tree, cursor)
  const covering = at && isRunnable(doc, at) ? at : null
  const prev = covering ? null : statementSibling(doc, at ? at.prevSibling : top.childBefore(cursor), -1)
  const next = covering ? null : statementSibling(doc, at ? at.nextSibling : top.childAfter(cursor), 1)

  let count = 0
  for (let node = top.firstChild; node && count < 2; node = node.nextSibling) {
    if (isRunnable(doc, node)) count += 1
  }

  return { covering, prev, next, count, parsedTo: tree.length }
}

/** The blank-line-delimited block at/nearest the cursor, found by walking lines outward. */
const paragraphBlock = (doc: Text, cursor: number) => {
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
  while (first.number > 1 && !isBlank(doc.line(first.number - 1).text)) {
    first = doc.line(first.number - 1)
  }

  let last = line
  while (last.number < doc.lines && !isBlank(doc.line(last.number + 1).text)) {
    last = doc.line(last.number + 1)
  }

  return doc.sliceString(first.from, last.to).trim()
}

const closestQueryBlock = (state: EditorState, cursor: number) => {
  const doc = state.doc
  const { covering, prev, next, count, parsedTo } = statementsAround(state, cursor)

  if (!covering && !prev && !next) return paragraphBlock(doc, cursor)

  const chosen = covering
    ? covering
    : !prev
      ? next!
      : !next
        ? prev
        : next.from - cursor < cursor - prev.to
          ? next
          : prev

  // Without real semicolons the whole doc parses as one statement; fall back
  // to blank-line-separated blocks so scratch files still run one query. The
  // parser splits on actual terminators, so a lone statement is terminated
  // iff its last character is `;` - semicolons inside strings don't count.
  if (count === 1 && doc.sliceString(chosen.to - 1, chosen.to) !== ';') {
    return paragraphBlock(doc, cursor)
  }

  // Partial parse: anything at or past the frontier may be a truncated
  // statement. The line-based block needs no tree, but accept it only when
  // it does not visibly span multiple statements; running nothing is safer
  // than running a fragment or half the file.
  if (parsedTo < doc.length && (cursor > parsedTo || chosen.to >= parsedTo)) {
    const block = paragraphBlock(doc, cursor)
    const body = block.endsWith(';') ? block.slice(0, -1) : block
    return body.includes(';') ? '' : block
  }

  return doc.sliceString(chosen.from, chosen.to).trim()
}

/** The SQL that Mod-Enter would run: the selection if any, else the statement at/nearest the cursor. */
export const queryToRun = (state: EditorState) => {
  const { from, to, head } = state.selection.main
  return state.sliceDoc(from, to).trim() || closestQueryBlock(state, head)
}

/** Binds Mod-Enter to run the selection, or the statement at/nearest the cursor. */
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
