import { Prec, type Extension } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'

/**
 * Shift+Alt+<letter> shortcuts, matched by physical key rather than by name.
 *
 * A `Shift-Alt-f` entry in a keymap never fires on macOS: Option+F types a
 * character (ƒ), and CodeMirror deliberately skips its keyCode fallback for
 * Alt combos there, since those are how Mac users enter accented text. Matching
 * `event.code` gives one spelling that works on every platform. Keys are code
 * names ('KeyF'), so the binding follows the physical key on any layout.
 */
export const altShiftKeys = (bindings: Record<string, Command>): Extension =>
  Prec.high(
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return false
        if (!bindings[event.code]?.(view)) return false
        event.preventDefault()
        return true
      },
    }),
  )
