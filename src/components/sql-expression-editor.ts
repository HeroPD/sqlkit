import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { sql } from '@codemirror/lang-sql'
import { oneDarkTheme } from '@codemirror/theme-one-dark'
import type { Engine } from '../electron'
import { dialectForEngine, KEYWORD_BOOSTS, SQL_FUNCTIONS, matchesCompletionTerm, resolveDialect } from '../codemirror/dialects'
import { softHighlightStyle } from '../codemirror/highlight'

const configCompartment = new Compartment()
const EXPRESSION_TERMS = new Set([
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL',
  'IN', 'NOT IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'TRUE', 'FALSE', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'NOW', 'GETDATE',
])

export function expressionCompletionOptions(engine: Engine, columns: string[]): Completion[] {
  const config = resolveDialect(dialectForEngine[engine])
  const reservedWords = new Set(config.keywords.flatMap((keyword) => keyword.toUpperCase().split(/\s+/)))
  // Boost falls with position so equal matches list in result order, not alphabetically.
  const columnOptions = columns.map((column, index) => ({
    label: column,
    apply: /^[A-Za-z_][\w$]*$/.test(column) && !reservedWords.has(column.toUpperCase()) ? column : config.quoteIdent(column),
    type: 'property',
    boost: 99 - index * 0.01,
  }))
  const keywordOptions = [...new Set(config.keywords)].filter((keyword) => EXPRESSION_TERMS.has(keyword)).map((keyword) => ({
    label: keyword,
    type: SQL_FUNCTIONS.has(keyword) ? 'function' : 'keyword',
    boost: KEYWORD_BOOSTS[keyword] ?? 0,
  }))
  return [...columnOptions, ...keywordOptions]
}

const expressionTheme = EditorView.theme(
  {
    '&': {
      height: '86px',
      color: 'var(--input-fg)',
      backgroundColor: 'var(--input-bg)',
      fontSize: 'var(--font-size)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono-font)', fontFeatureSettings: "'liga' 0, 'calt' 0", lineHeight: '1.45' },
    '.cm-content': { padding: '5px 0', caretColor: 'var(--input-fg)' },
    '.cm-line': { padding: '0 8px' },
    '.cm-placeholder': { color: 'var(--input-placeholder)', fontStyle: 'normal' },
    '.cm-gutters': { display: 'none' },
    '.cm-tooltip': { zIndex: '200' },
    '.cm-tooltip-autocomplete': {
      color: 'var(--text)',
      backgroundColor: 'var(--sidebar-bg)',
      border: '1px solid var(--border)',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono-font)', fontSize: 'var(--font-size)' },
    '.cm-completionIcon': { display: 'none' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      color: 'var(--list-selection-fg)',
      backgroundColor: 'var(--list-selection)',
    },
  },
  { dark: true },
)

@customElement('sql-expression-editor')
export class SqlExpressionEditor extends LitElement {
  @property()
  value = ''

  @property()
  engine: Engine = 'postgresql'

  @property({ attribute: false })
  columns: string[] = []

  @property({ type: Boolean, reflect: true })
  compact = false

  @property({ type: Boolean })
  submitOnEnter = false

  @property()
  placeholderText = 'age >= 0'

  private _view: EditorView | null = null
  private _syncing = false

  render() {
    return html`<div class="host"></div>`
  }

  focusEditor() {
    this._view?.focus()
  }

  protected firstUpdated() {
    const parent = this.shadowRoot?.querySelector<HTMLElement>('.host')
    if (!parent) return
    this._view = new EditorView({
      parent,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          history(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([
            ...completionKeymap,
            {
              key: 'Enter',
              run: () => {
                if (!this.submitOnEnter) return false
                this.dispatchEvent(new CustomEvent('expression-submit', { bubbles: true, composed: true }))
                return true
              },
            },
            {
              key: 'Escape',
              run: () => {
                if (!this.compact) return false
                this.dispatchEvent(new CustomEvent('expression-cancel', { bubbles: true, composed: true }))
                return true
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          configCompartment.of(this._configuration()),
          expressionTheme,
          oneDarkTheme,
          syntaxHighlighting(softHighlightStyle),
          EditorView.lineWrapping,
          placeholder(this.placeholderText),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            this._syncing = true
            this.value = update.state.doc.toString()
            this.dispatchEvent(new CustomEvent('expression-change', {
              detail: { value: this.value },
              bubbles: true,
              composed: true,
            }))
            queueMicrotask(() => (this._syncing = false))
          }),
        ],
      }),
    })
  }

  protected updated(changed: PropertyValues) {
    const view = this._view
    if (!view) return
    if (changed.has('value') && !this._syncing && this.value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: this.value } })
    }
    if (changed.has('engine') || changed.has('columns')) {
      view.dispatch({ effects: configCompartment.reconfigure(this._configuration()) })
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._view?.destroy()
    this._view = null
  }

  private _configuration() {
    const dialect = resolveDialect(dialectForEngine[this.engine]).dialect
    return [
      sql({ dialect }),
      autocompletion({
        activateOnTyping: true,
        override: [(context: CompletionContext) => {
          const word = context.matchBefore(/[\w$]*/)
          if (!context.explicit && (!word || word.from === word.to)) return null
          const options = expressionCompletionOptions(this.engine, this.columns)
            .filter((option) => matchesCompletionTerm(option.label, word?.text ?? ''))
          return { from: word?.from ?? context.pos, options }
        }],
      }),
    ]
  }

  static styles = css`
    :host {
      display: block;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--input-bg);
    }

    :host(:focus-within) {
      border-color: var(--input-focus-border);
    }

    :host([compact]) {
      box-sizing: border-box;
      min-width: 0;
      overflow: visible;
      border-radius: 3px;
    }

    :host([compact]) .host .cm-editor {
      height: auto;
      min-height: 22px;
      max-height: 84px;
    }

    :host([compact]) .host .cm-scroller {
      overflow-x: hidden;
      overflow-y: auto;
    }

    :host([compact]) .host .cm-content {
      padding: 1px 0;
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'sql-expression-editor': SqlExpressionEditor
  }
}
