import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { bracketMatching, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { linter } from '@codemirror/lint'
import { oneDarkTheme } from '@codemirror/theme-one-dark'
import { softHighlightStyle } from '../codemirror/highlight'
import { jsonProblem } from '../json-text'

/** Where the document stops parsing, and what to say about it. */
export type JsonProblemAt = { message: string; line: number; column: number }

// The position comes from the JSON grammar's own error node rather than from the
// thrown message: this V8 reports "Unexpected token ','…" with no position in
// it, so lang-json's jsonParseLinter has nothing to read and marks character 0 —
// the one place the error certainly is not. A message that does state a position
// is the fallback for when the tree parsed but JSON.parse still refused.
function errorPosition(state: EditorState, stated: number | null): number {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state)
  let found: number | null = null
  tree.iterate({
    enter: (node) => {
      if (found !== null) return false
      if (node.type.isError) found = node.from
      return true
    },
  })
  const position = found ?? stated ?? 0
  return Math.max(0, Math.min(position, Math.max(0, state.doc.length - 1)))
}

// The problem with the document, or null while it parses. An untouched NULL cell
// is empty rather than broken, so it reports nothing until there is something to
// parse.
function problemIn(state: EditorState): { message: string; from: number } | null {
  const text = state.doc.toString()
  if (!text.trim()) return null
  const problem = jsonProblem(text)
  return problem && { message: problem.message, from: errorPosition(state, problem.position) }
}

// Marks the offending character and names it on hover. No second gutter and no
// lint panel: JSON.parse only ever knows the first error, so a list of one is
// not worth a panel — the host shows that one under the editor when a save has
// to refuse (see results-panel's .json-error strip).
const jsonDiagnostics = linter(
  (view) => {
    const problem = problemIn(view.state)
    if (!problem) return []
    return [
      {
        from: problem.from,
        to: Math.min(view.state.doc.length, problem.from + 1),
        severity: 'error' as const,
        message: problem.message,
        source: 'json',
      },
    ]
  },
  { delay: 200 },
)

const jsonTheme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--editor-bg)', fontSize: 'var(--font-size)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--mono-font)',
      fontFeatureSettings: "'liga' 0, 'calt' 0",
      lineHeight: '1.5',
      overscrollBehavior: 'none',
    },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0 10px' },
    '.cm-gutters': { backgroundColor: 'var(--editor-bg)', border: 'none', color: 'var(--text-3)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },

    // The mark on the offending character, in the app's error colour instead of
    // the base theme's wavy SVG.
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--status-dot-error)',
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '3px',
    },

    // The hover that names the error, given the same surface as every other
    // tooltip in the app (see the `tooltip` block in shared-styles): CodeMirror's
    // own card is a white box with a thick red bar, from another application.
    '.cm-tooltip': {
      backgroundColor: 'var(--input-bg)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      boxShadow: '0 3px 10px rgba(0, 0, 0, 0.35)',
      color: 'var(--text)',
    },
    '.cm-tooltip-lint': { maxWidth: '340px' },
    '.cm-diagnostic': {
      padding: '5px 8px',
      fontFamily: 'var(--ui-font)',
      fontSize: 'var(--font-size-sm)',
      lineHeight: '1.3',
      whiteSpace: 'normal',
    },
    // The base theme puts a 5px red bar down the left of every error; the card
    // is already the only red thing on screen.
    '.cm-diagnostic-error': { borderLeft: 'none' },
    // The dimmed tag naming what did the complaining. It renders as a div, so
    // inline is what keeps it beside the message instead of under it, and the
    // colour does the dimming rather than the base theme's 70%/opacity pair.
    '.cm-diagnosticSource': {
      display: 'inline',
      marginLeft: '6px',
      fontSize: 'var(--font-size-sm)',
      opacity: '1',
      color: 'var(--text-3)',
    },
  },
  { dark: true },
)

/**
 * The JSON document of one result cell. Owns only the text: the panel decides
 * when that text becomes a staged edit, so a session of typing collapses into
 * one undoable step instead of one per keystroke.
 */
@customElement('json-cell-editor')
export class JsonCellEditor extends LitElement {
  @property()
  value = ''

  @property({ type: Boolean })
  readonly = false

  private _view: EditorView | null = null
  private _syncing = false
  private _pendingFocus = false

  render() {
    return html`<div class="host"></div>`
  }

  // The host asks during its own update pass, before firstUpdated has built the
  // view — latch the request instead of dropping it on the floor.
  focusEditor() {
    if (this._view) this._view.focus()
    else this._pendingFocus = true
  }

  // Tells the host what is wrong and where, in document terms it can show
  // without knowing anything about CodeMirror.
  private _reportProblem(state: EditorState) {
    const problem = problemIn(state)
    const at = problem ? state.doc.lineAt(problem.from) : null
    this.dispatchEvent(
      new CustomEvent<{ problem: JsonProblemAt | null }>('json-problem', {
        detail: {
          problem:
            problem && at
              ? { message: problem.message, line: at.number, column: problem.from - at.from + 1 }
              : null,
        },
        bubbles: true,
        composed: true,
      }),
    )
  }

  /** Puts the cursor on the parse error, for a save that had to refuse. */
  revealError() {
    const view = this._view
    if (!view) return
    const problem = problemIn(view.state)
    if (!problem) return
    view.dispatch({ selection: { anchor: problem.from }, scrollIntoView: true })
    view.focus()
  }

  protected firstUpdated() {
    const parent = this.shadowRoot?.querySelector<HTMLElement>('.host')
    if (!parent) return
    this._view = new EditorView({
      parent,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([
            {
              // Leaves the view. Stops here so it never reaches the grid's
              // Esc-Esc, which would discard every staged change in the tab.
              key: 'Escape',
              run: () => {
                this.dispatchEvent(new CustomEvent('json-close', { bubbles: true, composed: true }))
                return true
              },
            },
            {
              // The draft is only staged at flush points, so ⌘S has to say so
              // before the panel looks at what is pending.
              key: 'Mod-s',
              run: () => {
                this.dispatchEvent(new CustomEvent('json-save', { bubbles: true, composed: true }))
                return true
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          json(),
          jsonDiagnostics,
          jsonTheme,
          oneDarkTheme,
          syntaxHighlighting(softHighlightStyle),
          EditorView.lineWrapping,
          EditorState.readOnly.of(this.readonly),
          EditorView.editable.of(!this.readonly),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            this._syncing = true
            this.value = update.state.doc.toString()
            this.dispatchEvent(new CustomEvent('json-change', {
              detail: { value: this.value },
              bubbles: true,
              composed: true,
            }))
            this._reportProblem(update.state)
            queueMicrotask(() => (this._syncing = false))
          }),
          EditorView.domEventHandlers({
            blur: () => {
              this.dispatchEvent(new CustomEvent('json-flush', { bubbles: true, composed: true }))
              return false
            },
          }),
        ],
      }),
    })
    // A stored document can already be broken (a text column widened to json),
    // and nothing has changed yet to report it.
    this._reportProblem(this._view.state)
    if (this._pendingFocus) {
      this._pendingFocus = false
      this._view.focus()
    }
  }

  protected updated(changed: PropertyValues) {
    const view = this._view
    if (!view) return
    // The panel rewrites the text on revert and when another cell is opened.
    if (changed.has('value') && !this._syncing && this.value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: this.value } })
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._view?.destroy()
    this._view = null
  }

  static styles = css`
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }

    .host,
    .host .cm-editor {
      height: 100%;
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'json-cell-editor': JsonCellEditor
  }
}
