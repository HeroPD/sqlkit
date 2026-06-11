import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { scrollbars } from '../shared-styles'
import { basicSetup } from 'codemirror'
import { Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'

// oneDark supplies the syntax palette; this override pulls the chrome
// (background, gutters, selection) onto the app's tokens so the editor sits
// flush in the workbench.
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
  },
  { dark: true },
)

export type RunQueryDetail = { sql: string }

// CodeMirror 6 SQL editor. Controlled from the outside (`value`), emits
// `editor-change` per edit and `run-query` on Mod-Enter with the selection —
// or the whole document when nothing is selected. `tables` feeds schema
// completion and is hot-swapped via a compartment when the context changes.
@customElement('sql-editor')
export class SqlEditor extends LitElement {
  @property()
  value = ''

  @property({ attribute: false })
  tables: string[] = []

  private _view: EditorView | null = null

  private _language = new Compartment()

  render() {
    return html`<div class="host"></div>`
  }

  protected firstUpdated() {
    const container = this.shadowRoot!.querySelector('.host')!
    this._view = new EditorView({
      doc: this.value,
      parent: container,
      extensions: [
        // Before basicSetup so Mod-Enter wins over the default insert-newline.
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              this._emitRun(view)
              return true
            },
          },
        ]),
        basicSetup,
        this._language.of(this._sqlExtension()),
        oneDark,
        appTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          this.dispatchEvent(
            new CustomEvent('editor-change', {
              detail: { value: update.state.doc.toString() },
              bubbles: true,
              composed: true,
            }),
          )
        }),
      ],
    })
  }

  protected updated(changed: PropertyValues) {
    const view = this._view
    if (!view) return

    if (changed.has('value') && this.value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: this.value } })
    }
    if (changed.has('tables')) {
      view.dispatch({ effects: this._language.reconfigure(this._sqlExtension()) })
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
    return sql({
      dialect: PostgreSQL,
      schema: Object.fromEntries(this.tables.map((table) => [table, []])),
    })
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
    // CodeMirror's .cm-scroller lives in this shadow root.
    scrollbars,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }

      .host {
        height: 100%;
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
