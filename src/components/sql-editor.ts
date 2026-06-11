import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { scrollbars } from '../shared-styles'

import { Compartment, Prec } from '@codemirror/state'
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
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
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
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import {
  oneDarkHighlightStyle,
  oneDarkTheme,
} from '@codemirror/theme-one-dark'

const POSTGRES_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',

  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'RETURNING',

  'WITH',
  'AS',
  'DISTINCT',

  'UNION',
  'UNION ALL',
  'EXCEPT',
  'INTERSECT',

  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',

  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS NULL',
  'IS NOT NULL',
  'IN',
  'NOT IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'EXISTS',

  'TRUE',
  'FALSE',

  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'NOW',
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',

  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'INDEX',
  'VIEW',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
] as const

const KEYWORD_BOOSTS: Record<string, number> = {
  SELECT: 100,
  FROM: 95,
  WHERE: 90,
  JOIN: 85,
  'LEFT JOIN': 80,
  'ORDER BY': 75,
  'GROUP BY': 75,
  LIMIT: 70,
  INSERT: 65,
  UPDATE: 65,
  DELETE: 65,
}

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
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: (view) => {
                this._emitRun(view)
                return true
              },
            },
          ]),
        ),

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
        syntaxHighlighting(oneDarkHighlightStyle),

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

    if (changed.has('tables')) {
      const nextTablesKey = this._makeTablesKey(this.tables)

      if (nextTablesKey !== this._tablesKey) {
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
     * Keep SQL language support for PostgreSQL parsing/highlighting.
     *
     * Do not pass schema here if you do not want CodeMirror's built-in SQL
     * keyword/schema autocomplete to leak noisy parser keywords like SELECTIVE.
     * Table completions are handled by _completionSource instead.
     */
    return sql({
      dialect: PostgreSQL,
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

    const keywordOptions: Completion[] = POSTGRES_KEYWORDS.map((keyword) => ({
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

  private _emitRun(view: EditorView) {
    const { from, to } = view.state.selection.main
    const selection = view.state.sliceDoc(from, to).trim()
    const statement = selection || view.state.doc.toString().trim()

    if (!statement) return

    this.dispatchEvent(
      new CustomEvent<RunQueryDetail>('run-query', {
        detail: { sql: statement },
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