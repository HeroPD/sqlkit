import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { icons, scrollbars } from '../shared-styles'

import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
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
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { sql } from '@codemirror/lang-sql'
import { runQuery } from '../codemirror/run-query'
import { createFindPanel } from '../codemirror/find-panel'
import type { ColumnRef } from '../electron'
import { quoteStyleFor } from '../dialect'
import { KEYWORD_BOOSTS, resolveDialect, type SqlDialectName } from '../codemirror/dialects'
import { oneDarkTheme } from '@codemirror/theme-one-dark'
import { softHighlightStyle } from '../codemirror/highlight'
import { t } from '../i18n'

const FORMAT_LANGUAGE = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mssql: 'transactsql',
} as const satisfies Record<SqlDialectName, string>

const appTheme = EditorView.theme(
  {
    // Override One Dark's #282c34 so the editor matches --editor-bg (and the
    // active tab) instead of sitting in a lighter gray box.
    '&': {
      backgroundColor: 'var(--editor-bg)',
    },

    '.cm-gutters': {
      backgroundColor: 'var(--editor-bg)',
    },

    '.cm-scroller': {
      fontFamily: 'var(--mono-font)',
      fontSize: 'var(--font-size)',
      fontFeatureSettings: "'liga' 0, 'calt' 0",
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
      fontFamily: 'var(--mono-font)',
      fontSize: 'var(--font-size)',
      fontFeatureSettings: "'liga' 0, 'calt' 0",
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

    /* Same selection tokens as the file tree / table list: an opaque,
       hue-shifted blue reads as "selected" where a white-alpha overlay is
       ambiguous against neighboring unselected rows. */
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--list-selection)',
      color: 'var(--list-selection-fg)',
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

/** `line` is the 1-based document line the run text starts on, for mapping a
 * driver-reported error line back to the editor. */
export type RunQueryDetail = { sql: string; line: number }

// One editor view serves every tab: tab switches swap immutable EditorStates
// via setState() instead of tearing the view down and re-parsing, which also
// preserves each tab's undo history, selection, and scroll position. States
// are cached here (module level, so remounts restore too), LRU-capped.
const stateCache = new Map<string, EditorState>()
const MAX_CACHED_STATES = 20

// Workspace close drops every tab; clear the cache too, or EditorStates (each
// holding a full document + undo history) from the closed workspace linger in
// the LRU until 20 newer states evict them.
export function clearEditorStateCache() {
  stateCache.clear()
}

// Compartments are lookup keys, shared by all states so a state restored
// across component instances can still be reconfigured.
const languageCompartment = new Compartment()
const autocompleteCompartment = new Compartment()
// run-query + change events close over the component instance; a cached
// state restored into a NEW element must be rebound to it, or those events
// fire on the old detached element and vanish.
const handlersCompartment = new Compartment()

// Everything per-state that doesn't capture component state, built once.
const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),

  history(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),

  // Multi-cursor: allow >1 selection, draw each ourselves (native draws only one), and box-select on Shift+Alt-drag to match VS Code.
  EditorState.allowMultipleSelections.of(true),
  drawSelection(),
  rectangularSelection({
    eventFilter: (e) => e.altKey && e.shiftKey && e.button === 0,
  }),

  search({ top: true, createPanel: createFindPanel }),
  highlightSelectionMatches(),
]

// "Add cursor above/below" (Cmd/Ctrl-Alt-Up/Down): grow from the cursor furthest in the travel direction so presses stack one way; the new cursor is main, so the view follows it.
function addCursorVertically(forward: boolean) {
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

const baseKeymap = keymap.of([
  { key: 'Mod-Alt-ArrowUp', run: addCursorVertically(false), preventDefault: true },
  { key: 'Mod-Alt-ArrowDown', run: addCursorVertically(true), preventDefault: true },

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

// One identifier segment: double-quoted, backticked, bracketed, or bare.
const IDENT_SEG = '"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][\\w$]*'
// The segment still being typed: its closing quote may be missing.
const IDENT_TAIL = '"[^"]*"?|`[^`]*`?|\\[[^\\]]*\\]?|[A-Za-z0-9_$]*'
// `schema.table.col` / `table.col` / `alias.col`, cursor inside the last segment.
const DOTTED_MATCH = new RegExp(`(?:(?:${IDENT_SEG})\\.){1,2}(?:${IDENT_TAIL})`)
const DOTTED_PARTS = new RegExp(`^(?:(${IDENT_SEG})\\.)?(${IDENT_SEG})\\.(${IDENT_TAIL})$`)

// What may still be typed after a quoted member completion opened, per quote char.
const QUOTE_VALID: Record<string, RegExp> = {
  '"': /^"[^"]*"?$/,
  '`': /^`[^`]*`?$/,
  '[': /^\[[^\]]*\]?$/,
}

// Strips any quote style and unescapes its doubled close char; lowercased for map keys.
function normIdent(seg: string): string {
  const open = seg[0]
  if (open !== '"' && open !== '`' && open !== '[') return seg.toLowerCase()
  const close = open === '[' ? ']' : open
  const body = seg.length > 1 && seg.endsWith(close) ? seg.slice(1, -1) : seg.slice(1)
  return body.replaceAll(close + close, close).toLowerCase()
}

const CLAUSE_KEYWORDS = /\b(from|join|where|on|select|set|group|order|having|union|intersect|except|limit|offset|values|returning|update|into|window|with)\b/gi

// Whether the nearest clause keyword before `index` is FROM — comma aliases only bind there.
function inFromList(sql: string, index: number): boolean {
  let last: string | undefined
  for (const match of sql.slice(0, index).matchAll(CLAUSE_KEYWORDS)) last = match[1]?.toLowerCase()
  return last === 'from'
}

// Finds what table `alias` (unquoted, lowercased) is bound to in FROM/JOIN/UPDATE/INTO
// clauses or old-style FROM lists. Returns `schema.table` or `table`, lowercased.
function findAliasTarget(sql: string, alias: string): string | null {
  const pattern = new RegExp(
    `(?:\\b(?:from|join|update|into)\\b|(,))\\s*(${IDENT_SEG})(?:\\.(${IDENT_SEG}))?\\s+(?:as\\s+)?(${IDENT_SEG})`,
    'gi',
  )
  for (const match of sql.matchAll(pattern)) {
    const [, comma, first, second, aliasSeg] = match
    if (first === undefined || aliasSeg === undefined) continue
    const candidate = normIdent(aliasSeg)
    if (candidate !== alias || ALIAS_STOPWORDS.has(candidate)) continue
    // A select-list comma must not bind "select a, b c" as alias c → table b.
    if (comma !== undefined && !inFromList(sql, match.index ?? 0)) continue
    return second !== undefined ? `${normIdent(first)}.${normIdent(second)}` : normIdent(first)
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

  /** Table refs of the context; schema drives `schema.` member completion. */
  @property({ attribute: false })
  tables: { schema: string | null; name: string }[] = []

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
    // The element was just (re)created: a cached state restored here is
    // bound to its previous element until rebound.
    this._rebindState(this._view)
  }

  // The full extension set of a fresh document state.
  private _stateExtensions() {
    return [
      handlersCompartment.of(this._handlerExtensions()),
      baseExtensions,
      autocompleteCompartment.of(this._autocompleteExtension()),
      baseKeymap,
      languageCompartment.of(this._sqlExtension()),
      themeExtensions,
    ]
  }

  // Everything that captures `this` — rebound whenever a state lands in a view.
  private _handlerExtensions() {
    return [
      runQuery((query, view) => this._emitRun(query.sql, view.state.doc.lineAt(query.from).number)),
      keymap.of([{ key: 'Shift-Alt-f', run: () => this.formatSql() }]),
      this._changeListener,
    ]
  }

  // A restored state carries the closures and config of the element/props it
  // was created under; re-point every compartment at the current ones.
  private _rebindState(view: EditorView) {
    view.dispatch({
      effects: [
        handlersCompartment.reconfigure(this._handlerExtensions()),
        languageCompartment.reconfigure(this._sqlExtension()),
        autocompleteCompartment.reconfigure(this._autocompleteExtension()),
      ],
    })
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
      this._rebindState(view)
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

  /** Formats the selection, or the whole document when the selection is empty. */
  formatSql(): boolean {
    const view = this._view
    if (!view) return false
    const selection = view.state.selection.main
    const from = selection.empty ? 0 : selection.from
    const to = selection.empty ? view.state.doc.length : selection.to
    const source = view.state.sliceDoc(from, to)
    if (!source.trim()) return false
    const originalDoc = view.state.doc.toString()
    const language = FORMAT_LANGUAGE[this.dialect]
    void import('sql-formatter')
      .then(({ format }) => {
        // Loading is lazy; never overwrite edits made while the formatter chunk arrived.
        if (this._view !== view || view.state.doc.toString() !== originalDoc) return
        const formatted = format(source, {
          language,
          keywordCase: 'upper',
          tabWidth: 2,
        })
        view.dispatch({
          changes: { from, to, insert: formatted },
          selection: selection.empty
            ? { anchor: Math.min(from + selection.head, from + formatted.length) }
            : { anchor: from, head: from + formatted.length },
          scrollIntoView: true,
        })
      })
      .catch((error: unknown) => {
        this.dispatchEvent(new CustomEvent('editor-notice', {
          detail: { title: t('sql.formatFailed'), detail: (error as Error).message },
          bubbles: true,
          composed: true,
        }))
      })
    return true
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
      override: [this._completionSource(), this._phraseSource()],
    })
  }

  private _completionSource() {
    const { keywords, quoteIdent } = resolveDialect(this.dialect)

    // Names that can't appear bare: invalid identifier chars, a reserved word,
    // or (Postgres folds unquoted names to lowercase) any uppercase letter.
    const reserved = new Set(keywords.filter((keyword) => !keyword.includes(' ')).map((keyword) => keyword.toLowerCase()))
    const needsQuotes = (name: string) =>
      !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ||
      reserved.has(name.toLowerCase()) ||
      (this.dialect === 'postgres' && /[A-Z]/.test(name))
    const ident = (name: string) => (needsQuotes(name) ? quoteIdent(name) : name)
    const makeOption = (name: string, type: string, boost: number): Completion =>
      needsQuotes(name) ? { label: name, type, boost, apply: quoteIdent(name) } : { label: name, type, boost }

    // Table metadata: display names for bare completion and unique-prefix
    // expansion, grouped per schema for `schema.` member completion.
    const tableNames = new Map<string, string>()
    const tablesBySchema = new Map<string, Completion[]>()
    for (const table of this.tables) {
      if (!table.name) continue
      tableNames.set(table.name.toLowerCase(), table.name)
      if (!table.schema) continue
      const option = makeOption(table.name, 'type', 60)
      const schemaLower = table.schema.toLowerCase()
      const list = tablesBySchema.get(schemaLower)
      if (list) list.push(option)
      else tablesBySchema.set(schemaLower, [option])
    }
    const tableOptions: Completion[] = [...tableNames.values()]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => makeOption(name, 'type', 60))

    // Single-word keywords only; multi-word ones live in _phraseSource.
    const keywordOptions: Completion[] = keywords
      .filter((keyword) => !keyword.includes(' '))
      .map((keyword) => ({
        label: keyword.toLowerCase(),
        displayLabel: keyword,
        type: 'keyword',
        apply: keyword,
        boost: KEYWORD_BOOSTS[keyword] ?? 0,
      }))

    // Column metadata: keyed by bare table name and, when known, schema.table;
    // bare-word completion gets the names deduped across tables.
    const columnsByTable = new Map<string, Completion[]>()
    const bareColumns = new Map<string, Completion>()
    const addColumn = (key: string, option: Completion) => {
      const list = columnsByTable.get(key)
      if (list) list.push(option)
      else columnsByTable.set(key, [option])
    }
    for (const column of this.columns ?? []) {
      const option = makeOption(column.name, 'property', 30)
      const tableLower = column.table.toLowerCase()
      addColumn(tableLower, option)
      if (column.schema) addColumn(`${column.schema.toLowerCase()}.${tableLower}`, option)
      if (!bareColumns.has(column.name)) bareColumns.set(column.name, option)
    }

    // Lowercased once here, not per keystroke in the source below.
    const entries = [...keywordOptions, ...tableOptions, ...bareColumns.values()].map(
      (option) => [option.label.toLowerCase(), option] as const,
    )

    return ifNotIn(
      ['String', 'LineComment', 'BlockComment'],
      (context: CompletionContext) => {
        // `x.` completes members of x: a table's (or FROM/JOIN alias's)
        // columns, a schema's tables, or a unique table-name prefix.
        const dotted = context.matchBefore(DOTTED_MATCH)
        if (dotted) {
          const parts = DOTTED_PARTS.exec(dotted.text)
          const [, qual, base, typedSeg] = parts ?? []
          if (base === undefined || typedSeg === undefined) return null
          const from = context.pos - typedSeg.length
          // The user opened a quote: show and insert labels in that style.
          const requote = quoteStyleFor[typedSeg[0] ?? '']
          const member = (options: Completion[]) => ({
            from,
            options: requote
              ? options.map((option) => ({ label: requote(option.label), type: option.type, boost: option.boost }))
              : options,
            validFor: requote ? QUOTE_VALID[typedSeg[0] ?? ''] : /^[A-Za-z0-9_$]*$/,
          })
          const baseKey = normIdent(base)
          if (qual !== undefined) {
            const cols = columnsByTable.get(`${normIdent(qual)}.${baseKey}`) ?? columnsByTable.get(baseKey)
            return cols ? member(cols) : null
          }
          let cols = columnsByTable.get(baseKey)
          if (!cols) {
            const target = findAliasTarget(context.state.doc.toString(), baseKey)
            if (target) cols = columnsByTable.get(target) ?? columnsByTable.get(target.slice(target.lastIndexOf('.') + 1))
          }
          if (cols) return member(cols)
          const schemaTables = tablesBySchema.get(baseKey)
          if (schemaTables) return member(schemaTables)
          // Unique prefix: complete `use.` as `users.<col>`, replacing the whole token.
          const candidates = [...tableNames.keys()].filter((name) => name.startsWith(baseKey))
          const onlyMatch = candidates.length === 1 ? candidates[0] : undefined
          const prefixCols = onlyMatch !== undefined && !requote ? columnsByTable.get(onlyMatch) : undefined
          const display = onlyMatch !== undefined ? tableNames.get(onlyMatch) : undefined
          if (!prefixCols || display === undefined) return null
          return {
            from: dotted.from,
            options: prefixCols.map((option) => {
              const label = `${display}.${option.label}`
              const applied = `${ident(display)}.${ident(option.label)}`
              return applied === label
                ? { label, type: 'property', boost: 30 }
                : { label, type: 'property', boost: 30, apply: applied }
            }),
            validFor: /^[A-Za-z_][\w$]*\.[A-Za-z0-9_$]*$/,
          }
        }

        const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_$]*/)

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
          validFor: /^[A-Za-z_][A-Za-z0-9_$]*$/,
        }
      },
    )
  }

  // Multi-word keywords ("GROUP BY", "IS NOT NULL") get their own source
  // anchored at the phrase start: the word-anchored source can't reach them
  // once a space is typed, and CM won't match a 1-char word mid-label.
  private _phraseSource() {
    const multiKeywords = resolveDialect(this.dialect)
      .keywords.filter((keyword) => keyword.includes(' '))
      .map((keyword) => ({
        lower: keyword.toLowerCase(),
        option: {
          label: keyword.toLowerCase(),
          displayLabel: keyword,
          type: 'keyword',
          apply: keyword,
          boost: KEYWORD_BOOSTS[keyword] ?? 0,
        },
      }))
    const phrasePattern = /^[A-Za-z_][\w$]*(?:\s+[\w$]*)*$/

    return ifNotIn(
      ['String', 'LineComment', 'BlockComment'],
      (context: CompletionContext) => {
        const line = context.state.doc.lineAt(context.pos)
        const before = line.text.slice(0, context.pos - line.from)
        const tokens = [...before.matchAll(/[A-Za-z_][\w$]*/g)]
        // Longest phrase first: "is not n" must beat "not n" (NOT IN).
        for (const back of [3, 2, 1]) {
          const token = tokens[tokens.length - back]
          if (token?.index === undefined) continue
          // A dot/quote right before the phrase means member access, not a keyword.
          const preceding = before[token.index - 1]
          if (preceding !== undefined && /["'`.[\]]/.test(preceding)) continue
          const phrase = before.slice(token.index)
          if (!phrasePattern.test(phrase)) continue
          const prefix = phrase.toLowerCase().replace(/\s+/g, ' ')
          const options = multiKeywords.filter(({ lower }) => lower.startsWith(prefix)).map(({ option }) => option)
          if (options.length) return { from: line.from + token.index, options, validFor: phrasePattern }
        }
        // Explicit completion still offers the multi-word set, except after a
        // dot/quote where member completion owns the spot.
        if (context.explicit) {
          const word = context.matchBefore(/[A-Za-z_][\w$]*/)
          const preceding = before[(word ? word.from : context.pos) - line.from - 1]
          if (preceding === undefined || !/["'`.[\]]/.test(preceding)) {
            return {
              from: word ? word.from : context.pos,
              options: multiKeywords.map(({ option }) => option),
              validFor: phrasePattern,
            }
          }
        }
        return null
      },
    )
  }

  private _makeTablesKey(tables: { schema: string | null; name: string }[]) {
    return [...new Set(tables.filter((table) => table.name).map((table) => `${table.schema ?? ''}.${table.name}`))]
      .sort((a, b) => a.localeCompare(b))
      .join('\0')
  }

  private _emitRun(sql: string, line: number) {
    this.dispatchEvent(
      new CustomEvent<RunQueryDetail>('run-query', {
        detail: { sql, line },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    icons,
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
        --icon-size: 14px;
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
        --icon-size: 14px;
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
        --icon-size: 14px;
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
