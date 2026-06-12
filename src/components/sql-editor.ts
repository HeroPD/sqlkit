import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { codicons, scrollbars } from '../shared-styles'

import { Compartment, EditorState } from '@codemirror/state'
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
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { sql } from '@codemirror/lang-sql'
import { runQuery } from '../codemirror/run-query'
import { createFindPanel } from '../codemirror/find-panel'
import type { ColumnRef } from '../electron'
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

    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--text)',
    },

    '&.cm-focused': {
      outline: 'none',
    },

    '.cm-tooltip': {
      zIndex: '10000',
    },

    /* VS Code-style find widget: the search panel floats over the top-right
       corner of the editor instead of docking full-width. */
    '.cm-panels': {
      backgroundColor: 'transparent',
      color: 'var(--text)',
      zIndex: '10',
    },

    '.cm-panels-top': {
      position: 'absolute',
      top: '0',
      left: 'auto',
      right: '14px',
      borderBottom: 'none',
    },

    /* VS Code dark match colors: current match vs. the rest, plus passive
       same-as-selection highlights. */
    '.cm-searchMatch': {
      background: '#ea5c0055',
    },

    '.cm-searchMatch.cm-searchMatch-selected': {
      background: '#515c6acc',
    },

    '.cm-selectionMatch': {
      background: '#add6ff26',
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

// One editor view serves every tab: tab switches swap immutable EditorStates
// via setState() instead of tearing the view down and re-parsing, which also
// preserves each tab's undo history, selection, and scroll position. States
// are cached here (module level, so remounts restore too), LRU-capped.
const stateCache = new Map<string, EditorState>()
const MAX_CACHED_STATES = 20

// Compartments are lookup keys, shared by all states so a state restored
// across component instances can still be reconfigured.
const languageCompartment = new Compartment()
const autocompleteCompartment = new Compartment()

// Everything per-state that doesn't capture component state, built once.
const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),

  history(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),

  search({ top: true, createPanel: createFindPanel }),
  highlightSelectionMatches(),
]

const baseKeymap = keymap.of([
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
])

// Theme precedence in CodeMirror is earlier-wins: appTheme must come BEFORE
// oneDarkTheme or every app override (editor bg, tooltip, panel placement)
// silently loses to One Dark's rules.
const themeExtensions = [appTheme, oneDarkTheme, syntaxHighlighting(softHighlightStyle), EditorView.lineWrapping]

// Words that can follow a table reference without being its alias.
const ALIAS_STOPWORDS = new Set([
  'as', 'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'intersect', 'except', 'set',
  'using', 'returning', 'values', 'select', 'from', 'into', 'and', 'or', 'not', 'when',
  'then', 'else', 'end', 'case', 'by', 'asc', 'desc', 'for', 'with', 'window',
])

// Finds what table `alias` is bound to in FROM/JOIN/UPDATE/INTO clauses
// (`from postings p`, `join users as u`, old-style `from a x, b y`). Returns
// the bare table name (schema stripped), or null when the alias is unbound.
function findAliasTarget(sql: string, alias: string): string | null {
  const pattern = /\b(?:from|join|update|into|,)\s*([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)\s+(?:as\s+)?([a-z_][\w$]*)/gi
  for (const match of sql.matchAll(pattern)) {
    const candidate = match[2].toLowerCase()
    if (candidate !== alias || ALIAS_STOPWORDS.has(candidate)) continue
    const table = match[1].toLowerCase()
    const dot = table.lastIndexOf('.')
    return dot >= 0 ? table.slice(dot + 1) : table
  }
  return null
}

@customElement('sql-editor')
export class SqlEditor extends LitElement {
  @property()
  value = ''

  /** Identity of the document shown; changing it swaps the EditorState. */
  @property()
  tabId = ''

  @property({ attribute: false })
  tables: string[] = []

  /** Column metadata of the context, for member and bare-name completion. */
  @property({ attribute: false })
  columns: ColumnRef[] | null = null

  @property()
  dialect: SqlDialectName = 'postgres'

  private _view: EditorView | null = null

  private _renderedTabId = ''
  private _tablesKey = ''
  private _lastEmittedValue = ''
  private _syncingFromEditor = false

  // Built once per component: captures `this` for the change events.
  private _changeListener = EditorView.updateListener.of((update) => {
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
  })

  render() {
    return html`<div class="host"></div>`
  }

  /** Moves the cursor to a 1-based line, scrolls it into view, and focuses. */
  revealLine(line: number) {
    const view = this._view
    if (!view) return
    const doc = view.state.doc
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    })
    view.focus()
  }

  protected firstUpdated() {
    const container = this.shadowRoot!.querySelector('.host')
    if (!container) return

    this._tablesKey = this._makeTablesKey(this.tables)
    this._lastEmittedValue = this.value
    this._renderedTabId = this.tabId

    this._view = new EditorView({ state: this._restoredState(), parent: container })
  }

  // The full extension set of a fresh document state.
  private _stateExtensions() {
    return [
      runQuery((sql) => this._emitRun(sql)),
      baseExtensions,
      autocompleteCompartment.of(this._autocompleteExtension()),
      baseKeymap,
      languageCompartment.of(this._sqlExtension()),
      themeExtensions,
      this._changeListener,
    ]
  }

  private _makeState(doc: string) {
    return EditorState.create({ doc, extensions: this._stateExtensions() })
  }

  // The cached state of the tab, but only when its document still matches
  // what the host passes in — otherwise (file rewritten, id reused) a stale
  // doc with a misleading undo history must not resurface.
  private _restoredState() {
    const cached = this.tabId ? stateCache.get(this.tabId) : undefined
    if (cached && cached.doc.toString() === this.value) {
      stateCache.delete(this.tabId)
      return cached
    }
    return this._makeState(this.value)
  }

  /** Saves the shown tab's state so switching back restores it. */
  private _stashState() {
    if (!this._view || !this._renderedTabId) return
    stateCache.delete(this._renderedTabId)
    stateCache.set(this._renderedTabId, this._view.state)
    while (stateCache.size > MAX_CACHED_STATES) {
      const oldest = stateCache.keys().next().value
      if (oldest === undefined) break
      stateCache.delete(oldest)
    }
  }

  protected updated(changed: PropertyValues) {
    const view = this._view
    if (!view) return

    // Tab switch: stash the outgoing state, restore (or create) the incoming
    // one, and re-point its compartments at the current tables/dialect — a
    // restored state still carries the config it was created under.
    if (changed.has('tabId') && this.tabId !== this._renderedTabId) {
      this._stashState()
      this._renderedTabId = this.tabId
      view.setState(this._restoredState())
      this._lastEmittedValue = this.value
      this._tablesKey = this._makeTablesKey(this.tables)
      view.dispatch({
        effects: [
          languageCompartment.reconfigure(this._sqlExtension()),
          autocompleteCompartment.reconfigure(this._autocompleteExtension()),
        ],
      })
      return
    }

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

    if (changed.has('tables') || changed.has('dialect') || changed.has('columns')) {
      const nextTablesKey = this._makeTablesKey(this.tables)
      const tablesChanged = nextTablesKey !== this._tablesKey

      // `columns` is the controller's stable array; a reference change means
      // fresh metadata.
      if (tablesChanged || changed.has('dialect') || changed.has('columns')) {
        this._tablesKey = nextTablesKey

        view.dispatch({
          effects: [
            languageCompartment.reconfigure(this._sqlExtension()),
            autocompleteCompartment.reconfigure(this._autocompleteExtension()),
          ],
        })
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    // The element is dropped whenever a non-SQL tab takes the editor area;
    // stashing here lets the remounted editor pick the tab back up.
    this._stashState()
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

    // Column metadata: per-table lists drive `table.` member completion;
    // bare-word completion gets the names deduped across tables.
    const columnsByTable = new Map<string, Completion[]>()
    const bareColumns = new Map<string, Completion>()
    for (const column of this.columns ?? []) {
      const option: Completion = { label: column.name, type: 'property', detail: column.dataType, boost: 30 }
      const tableLower = column.table.toLowerCase()
      const list = columnsByTable.get(tableLower)
      if (list) list.push(option)
      else columnsByTable.set(tableLower, [option])
      if (!bareColumns.has(column.name)) bareColumns.set(column.name, { label: column.name, type: 'property', boost: 30 })
    }

    // Lowercased once here, not per keystroke in the source below.
    const entries = [...keywordOptions, ...tableOptions, ...bareColumns.values()].map(
      (option) => [option.label.toLowerCase(), option] as const,
    )

    return ifNotIn(
      ['String', 'LineComment', 'BlockComment'],
      (context: CompletionContext) => {
        // `x.` completes columns of the table x names — directly, through a
        // FROM/JOIN alias, or as a unique prefix of one table name.
        const dotted = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]*/)
        if (dotted) {
          const dot = dotted.text.indexOf('.')
          const prefix = dotted.text.slice(0, dot).toLowerCase()
          let tableColumns = columnsByTable.get(prefix)
          if (!tableColumns) {
            const aliased = findAliasTarget(context.state.doc.toString(), prefix)
            if (aliased) tableColumns = columnsByTable.get(aliased)
          }
          if (!tableColumns) {
            const candidates = [...columnsByTable.keys()].filter((table) => table.startsWith(prefix))
            if (candidates.length === 1) tableColumns = columnsByTable.get(candidates[0])
          }
          if (!tableColumns) return null
          const typedColumn = dotted.text.slice(dot + 1).toLowerCase()
          const options = tableColumns.filter((option) => option.label.toLowerCase().startsWith(typedColumn))
          if (!options.length) return null
          return { from: dotted.from + dot + 1, options, validFor: /^[A-Za-z0-9_]*$/ }
        }

        const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)

        if (!word && !context.explicit) return null

        const from = word ? word.from : context.pos
        const typed = word ? word.text.toLowerCase() : ''

        const options: Completion[] = []
        for (const [lower, option] of entries) {
          if (lower.startsWith(typed)) options.push(option)
        }

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
    codicons,
    scrollbars,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }

      /* The find widget (codemirror/find-panel.ts) — VS Code's find UI. */
      .find-widget {
        display: flex;
        align-items: stretch;
        gap: 2px;
        padding: 4px 4px 4px 0;
        background: var(--header-bg);
        border: 1px solid var(--border-subtle);
        border-top: none;
        border-radius: 0 0 4px 4px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        color: var(--text);
      }

      .toggle-replace {
        width: 16px;
        padding: 0;
        border: none;
        border-radius: 2px;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
        --codicon-size: 14px;
      }

      .toggle-replace:hover {
        background: var(--list-hover);
      }

      .find-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .find-row {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .replace-row {
        display: none;
      }

      .find-widget.replace-on .replace-row {
        display: flex;
      }

      .find-input-box {
        display: flex;
        align-items: center;
        gap: 2px;
        padding-right: 2px;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: 3px;
      }

      .find-input-box:focus-within {
        border-color: var(--focus-border);
      }

      .find-input-box.invalid {
        border-color: var(--status-dot-error);
      }

      /* Standard control text size (13px), like every other input. */
      .find-input-box input {
        width: 150px;
        height: 22px;
        padding: 0 6px;
        border: none;
        background: transparent;
        color: var(--input-fg);
        font-family: inherit;
        font-size: var(--font-size);
        outline: none;
      }

      .find-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 3px;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
        --codicon-size: 14px;
      }

      .find-toggle:hover {
        background: var(--list-hover);
      }

      .find-toggle.on {
        background: color-mix(in srgb, var(--accent) 35%, transparent);
        border-color: var(--accent);
        color: var(--text);
      }

      .find-count {
        padding: 0 4px;
        color: var(--text-2);
        white-space: nowrap;
      }

      /* No reserved space before a query exists — empty counter, no gap. */
      .find-count:empty {
        display: none;
      }

      .find-count.no-results {
        color: var(--status-dot-error);
      }

      .find-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text);
        cursor: pointer;
        --codicon-size: 14px;
      }

      .find-btn:hover:not(:disabled) {
        background: var(--list-hover);
      }

      .find-btn:disabled {
        opacity: 0.35;
        cursor: default;
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
