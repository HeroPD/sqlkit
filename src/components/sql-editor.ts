import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { scrollbars } from '../shared-styles'

import { Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  acceptCompletion,
  closeCompletion,
  startCompletion,
  completionStatus,
  ifNotIn,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { sql } from '@codemirror/lang-sql'
import { runQuery } from '../codemirror/run-query'
import { KEYWORD_BOOSTS, resolveDialect, type SqlDialectName } from '../codemirror/dialects'
import { oneDarkTheme } from '@codemirror/theme-one-dark'

// One Dark's highlight palette pre-blended 20% toward --editor-bg (#0f1117),
// matching the softened contrast of the app theme tokens in index.css.
const chalky = '#ba9d67',
  coral = '#b65a62',
  cyan = '#4895a0',
  invalid = '#cfcfd1',
  ivory = '#8c929d',
  stone = '#676f7f',
  malibu = '#518fc4',
  sage = '#7d9f65',
  whiskey = '#aa7f56',
  violet = '#a163b5'

// Same tag mapping as oneDarkHighlightStyle, only the colors are softened.
const softHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: violet },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: coral },
  { tag: [t.function(t.variableName), t.labelName], color: malibu },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: whiskey },
  { tag: [t.definition(t.name), t.separator], color: ivory },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: chalky },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: cyan },
  { tag: [t.meta, t.comment], color: stone },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: stone, textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: coral },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: whiskey },
  { tag: [t.processingInstruction, t.string, t.inserted], color: sage },
  { tag: t.invalid, color: invalid },
])

const appTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13px',
      backgroundColor: 'var(--editor-bg)',
    },

    '.cm-scroller': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5',
      overscrollBehavior: 'none',
    },

    '.cm-content': {
      padding: '10px 0',
    },

    '.cm-line': {
      padding: '0 12px',
    },

    '.cm-gutters': {
      backgroundColor: 'var(--editor-bg)',
      color: 'var(--text-3)',
      borderRight: '1px solid var(--border-subtle)',
    },

    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--text)',
    },

    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.03)',
    },

    '&.cm-focused': {
      outline: 'none',
    },

    '.cm-tooltip': {
      zIndex: '10000',
    },

    '.cm-tooltip-autocomplete': {
      border: '1px solid var(--border-subtle)',
      backgroundColor: 'var(--editor-bg)',
      overflow: 'hidden',
    },

    '.cm-tooltip-autocomplete > ul': {
      display: 'block',
      position: 'relative',
      margin: '0',
      padding: '2px',
      maxHeight: '260px',
      minWidth: '220px',
      maxWidth: 'min(720px, 90vw)',
      overflowY: 'auto',
      listStyle: 'none',
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: '13px',
      lineHeight: '1.4',
    },

    '.cm-tooltip-autocomplete > ul > li': {
      display: 'block',
      position: 'relative',
      margin: '0',
      padding: '2px 8px',
      whiteSpace: 'nowrap',
      cursor: 'default',
    },

    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'rgba(255, 255, 255, 0.10)',
      color: 'var(--text)',
    },

    '.cm-completionLabel': {
      display: 'inline',
    },
    '.cm-completionIcon': {
      display: 'none',
    }
  },
  { dark: true },
)

export type RunQueryDetail = { sql: string }

@customElement('sql-editor')
export class SqlEditor extends LitElement {
  @property()
  value = ''

  @property({ attribute: false })
  tables: string[] = []

  @property()
  dialect: SqlDialectName = 'postgres'

  private _view: EditorView | null = null

  private _language = new Compartment()
  private _autocomplete = new Compartment()

  private _tablesKey = ''
  private _lastEmittedValue = ''
  private _syncingFromEditor = false

  render() {
    return html`<div class="host"></div>`
  }

  protected firstUpdated() {
    const container = this.shadowRoot!.querySelector('.host')
    if (!container) return

    this._tablesKey = this._makeTablesKey(this.tables)
    this._lastEmittedValue = this.value

    this._view = new EditorView({
      doc: this.value,
      parent: container,
      extensions: [
        runQuery((sql) => this._emitRun(sql)),

        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),

        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),

        this._autocomplete.of(this._autocompleteExtension()),

        keymap.of([
          {
            key: 'Ctrl-Space',
            run: startCompletion,
          },
          {
            key: 'Escape',
            run: closeCompletion,
          },
          {
            key: 'Enter',
            run: (view) => {
              if (completionStatus(view.state) === 'active') {
                return acceptCompletion(view)
              }

              return false
            },
          },
          {
            key: 'Tab',
            run: (view) => {
              if (completionStatus(view.state) === 'active') {
                return acceptCompletion(view)
              }

              return indentWithTab.run?.(view) ?? false
            },
          },

          ...closeBracketsKeymap,

          /**
           * Keep completion navigation, but remove Enter because we handle it
           * ourselves above.
           */
          ...completionKeymap.filter((binding) => binding.key !== 'Enter'),

          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),

        this._language.of(this._sqlExtension()),

        oneDarkTheme,
        syntaxHighlighting(softHighlightStyle),

        appTheme,

        EditorView.lineWrapping,

        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return

          const nextValue = update.state.doc.toString()
          this._lastEmittedValue = nextValue
          this._syncingFromEditor = true

          this.dispatchEvent(
            new CustomEvent('editor-change', {
              detail: { value: nextValue },
              bubbles: true,
              composed: true,
            }),
          )

          queueMicrotask(() => {
            this._syncingFromEditor = false
          })
        }),
      ],
    })
  }

  protected updated(changed: PropertyValues) {
    const view = this._view
    if (!view) return

    if (
      changed.has('value') &&
      !this._syncingFromEditor &&
      this.value !== this._lastEmittedValue &&
      this.value !== view.state.doc.toString()
    ) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: this.value,
        },
      })

      this._lastEmittedValue = this.value
    }

    if (changed.has('tables') || changed.has('dialect')) {
      const nextTablesKey = this._makeTablesKey(this.tables)
      const tablesChanged = nextTablesKey !== this._tablesKey

      if (tablesChanged || changed.has('dialect')) {
        this._tablesKey = nextTablesKey

        view.dispatch({
          effects: [
            this._language.reconfigure(this._sqlExtension()),
            this._autocomplete.reconfigure(this._autocompleteExtension()),
          ],
        })
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._view?.destroy()
    this._view = null
  }

  focusEditor() {
    this._view?.focus()
  }

  private _sqlExtension() {
    /**
     * SQL language support for the configured dialect's parsing/highlighting.
     *
     * Do not pass schema here if you do not want CodeMirror's built-in SQL
     * keyword/schema autocomplete to leak noisy parser keywords like SELECTIVE.
     * Table completions are handled by _completionSource instead.
     */
    return sql({
      dialect: resolveDialect(this.dialect).dialect,
      upperCaseKeywords: true,
    })
  }

  private _autocompleteExtension() {
    return autocompletion({
      activateOnTyping: true,
      defaultKeymap: false,
      interactionDelay: 75,
      override: [this._completionSource()],
    })
  }

  private _completionSource() {
    const tableOptions: Completion[] = [...new Set(this.tables)]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((table) => ({
        label: table,
        type: 'type',
        boost: 60,
      }))

    const keywordOptions: Completion[] = resolveDialect(this.dialect).keywords.map((keyword) => ({
      label: keyword,
      type: 'keyword',
      apply: keyword,
      boost: KEYWORD_BOOSTS[keyword] ?? 0,
    }))

    return ifNotIn(
      ['String', 'LineComment', 'BlockComment'],
      (context: CompletionContext) => {
        const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)

        if (!word && !context.explicit) return null

        const from = word ? word.from : context.pos
        const typed = word ? word.text.toLowerCase() : ''

        const options = [...keywordOptions, ...tableOptions].filter((option) =>
          option.label.toLowerCase().startsWith(typed),
        )

        if (!options.length) return null

        return {
          from,
          options,
          validFor: /^[A-Za-z_][A-Za-z0-9_]*$/,
        }
      },
    )
  }

  private _makeTablesKey(tables: string[]) {
    return [...new Set(tables)]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join('\0')
  }

  private _emitRun(sql: string) {
    this.dispatchEvent(
      new CustomEvent<RunQueryDetail>('run-query', {
        detail: { sql },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    scrollbars,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }

      .host {
        height: 100%;
        min-height: 0;
      }

      .host .cm-editor {
        height: 100%;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'sql-editor': SqlEditor
  }
}
