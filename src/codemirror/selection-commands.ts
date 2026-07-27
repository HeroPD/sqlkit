import { EditorSelection, type SelectionRange } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import { copyLineDown, copyLineUp, moveLineDown, moveLineUp, selectParentSyntax } from '@codemirror/commands'
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'

// The selection commands the app menu offers by name. Every one of them is
// already bound to a key by the editor's keymap; the menu only surfaces them,
// so ids exist purely to name a command across the main/renderer boundary.
export type SelectionCommandId =
  | 'expand'
  | 'copy-line-up'
  | 'copy-line-down'
  | 'move-line-up'
  | 'move-line-down'
  | 'add-cursor-above'
  | 'add-cursor-below'
  | 'add-cursors-to-line-ends'
  | 'add-next-occurrence'
  | 'select-all-occurrences'

// "Add cursor above/below" (Cmd/Ctrl-Alt-Up/Down): grow from the cursor furthest in the travel direction so presses stack one way; the new cursor is main, so the view follows it.
export function addCursorVertically(forward: boolean) {
  return (view: EditorView): boolean => {
    const ranges = view.state.selection.ranges
    const edge = ranges.reduce((far, r) =>
      (forward ? r.head > far.head : r.head < far.head) ? r : far,
    )
    const moved = view.moveVertically(edge, forward)
    if (moved.head === edge.head) return false // already at the first/last line
    view.dispatch({
      selection: EditorSelection.create([...ranges, moved], ranges.length),
      scrollIntoView: true,
    })
    return true
  }
}

/**
 * "Add cursors to line ends" (Shift-Alt-i): every line a selection spans gets a
 * cursor at its end, except the last one, which gets a cursor where the
 * selection stopped — VS Code's rule, so selecting down into a line's middle
 * leaves you editing at that column rather than past its tail. A selection
 * ending at column 1 adds nothing for that line: it was never really included.
 */
export const addCursorsToLineEnds: Command = (view) => {
  const { doc, selection } = view.state
  const cursors: SelectionRange[] = []
  for (const range of selection.ranges) {
    if (range.empty) continue
    const first = doc.lineAt(range.from).number
    const last = doc.lineAt(range.to)
    for (let number = first; number < last.number; number += 1) {
      cursors.push(EditorSelection.cursor(doc.line(number).to))
    }
    if (range.to > last.from) cursors.push(EditorSelection.cursor(range.to))
  }
  if (!cursors.length) return false
  view.dispatch({
    selection: EditorSelection.create(cursors, cursors.length - 1),
    scrollIntoView: true,
  })
  return true
}

export const SELECTION_COMMANDS: Record<SelectionCommandId, Command> = {
  expand: selectParentSyntax,
  'copy-line-up': copyLineUp,
  'copy-line-down': copyLineDown,
  'move-line-up': moveLineUp,
  'move-line-down': moveLineDown,
  'add-cursor-above': addCursorVertically(false),
  'add-cursor-below': addCursorVertically(true),
  'add-cursors-to-line-ends': addCursorsToLineEnds,
  'add-next-occurrence': selectNextOccurrence,
  'select-all-occurrences': selectSelectionMatches,
}
