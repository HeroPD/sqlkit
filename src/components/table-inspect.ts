import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import type { DbObject, DbObjectKind, Engine, TableInspection, TableRef } from '../electron'
import { abbreviateType } from '../sql-types'
import { dialectFor } from '../dialect'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import { TABLE_KIND_ICONS, TABLE_KIND_LABELS } from '../table-kinds'

// The DDL words that show up in constraint/index/trigger/policy definitions;
// matched case-insensitively so SQLite's hand-written DDL highlights too.
const SQL_KEYWORDS = new Set(
  `PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK NOT NULL DEFAULT ON UPDATE DELETE INSERT SELECT
   CASCADE RESTRICT SET USING CREATE INDEX TRIGGER BEFORE AFTER INSTEAD OF FOR EACH ROW STATEMENT
   EXECUTE FUNCTION PROCEDURE WHEN WHERE AND OR IN IS LIKE BETWEEN EXISTS TO WITH AS VALUES
   PARTITION BY RANGE LIST HASH FROM MINVALUE MAXVALUE ASC DESC NULLS FIRST LAST ALL
   DEFERRABLE INITIALLY DEFERRED IMMEDIATE MATCH FULL SIMPLE PARTIAL GENERATED ALWAYS STORED DO ALSO`
    .split(/\s+/)
    .filter(Boolean),
)

// Splitting on word runs keeps every character of the original text; only
// keyword tokens get wrapped, everything else passes through verbatim.
const highlightDefinition = (text: string) =>
  text.split(/(\w+)/).map((part) => (SQL_KEYWORDS.has(part.toUpperCase()) ? html`<span class="kw">${part}</span>` : part))

// The Inspect tab's body: one table's structure — columns up top, then the
// engine's sections (foreign keys, constraints, indexes, partitions,
// triggers, rules, policies). Fetches its own data from the profile so the
// workbench only mounts it; re-fetches when retargeted to another table.
@customElement('table-inspect')
export class TableInspect extends LitElement {
  @property()
  profileId = ''

  /** Child database this inspect tab belongs to (all-databases mode); null otherwise. */
  @property()
  childDb: string | null = null

  @property({ attribute: false })
  table: TableRef | null = null

  /** Alternative target: a schema object (function/type) instead of a table. */
  @property({ attribute: false })
  object: DbObject | null = null

  @property()
  objectKind: DbObjectKind | null = null

  @property()
  engine: Engine | null = null

  @state()
  private _state: { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'done'; inspection: TableInspection } = {
    phase: 'loading',
  }

  @state()
  private _menu: { x: number; y: number; name: string; definition: string | null } | null = null

  protected willUpdate(changed: PropertyValues) {
    if (
      changed.has('profileId') ||
      changed.has('childDb') ||
      changed.has('table') ||
      changed.has('object') ||
      changed.has('objectKind')
    ) {
      void this._load()
    }
  }

  private async _load() {
    const profileId = this.profileId
    const childDb = this.childDb
    const table = this.table
    const object = this.object
    const objectKind = this.objectKind
    if (!profileId || (!table && !object)) return
    this._state = { phase: 'loading' }
    const result =
      object && objectKind
        ? await window.sqlkit.inspectObject(profileId, childDb, object, objectKind)
        : await window.sqlkit.inspectTable(profileId, childDb, table!)
    // Stale guard: the tab may have been retargeted (profile, child, or target)
    // while this was in flight.
    if (
      this.profileId !== profileId ||
      this.childDb !== childDb ||
      this.table !== table ||
      this.object !== object ||
      this.objectKind !== objectKind
    ) {
      return
    }
    this._state = result.success ? { phase: 'done', inspection: result.inspection } : { phase: 'error', error: result.error }
  }

  render() {
    const target = this.object ?? this.table
    if (!target) return ''
    const label = target.schema ? `${target.schema}.${target.name}` : target.name
    const icon = this.object
      ? this.objectKind === 'function'
        ? 'codicon-symbol-method'
        : this.object.detail === 'enum'
          ? 'codicon-symbol-enum'
          : 'codicon-symbol-structure'
      : (TABLE_KIND_ICONS[this.table!.kind] ?? 'codicon-table')
    const badge = this.object
      ? this.objectKind === 'function'
        ? 'function'
        : this.object.detail
      : this.table!.kind !== 'table'
        ? TABLE_KIND_LABELS[this.table!.kind]
        : ''
    return html`
      <div class="scroll">
        <div class="head">
          <i class="codicon ${icon}" aria-hidden="true"></i>
          <h3>${label}</h3>
          ${badge ? html`<span class="kind">${badge}</span>` : ''}
          <button class="refresh" title="Reload structure" aria-label="Reload structure" @click=${() => void this._load()}>
            <i class="codicon codicon-refresh" aria-hidden="true"></i>
          </button>
        </div>
        ${this._renderBody()}
      </div>
      ${this._renderMenu()}
    `
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const items: MenuItem[] = [
      { id: 'copy-name', label: 'Copy Name' },
      ...(menu.definition ? [{ id: 'copy-definition', label: 'Copy Definition' }] : []),
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) =>
          void navigator.clipboard.writeText(e.detail.id === 'copy-name' ? menu.name : (menu.definition ?? ''))}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _onRowMenu(event: MouseEvent, name: string, definition: string | null = null) {
    event.preventDefault()
    this._menu = { x: event.clientX, y: event.clientY, name, definition }
  }

  private _renderBody() {
    const state = this._state
    if (state.phase === 'loading') {
      return html`<p class="muted hint">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i> Loading structure…
      </p>`
    }
    if (state.phase === 'error') return html`<pre class="error">${state.error}</pre>`

    const { columns, sections } = state.inspection
    return html`
      ${columns.length ? this._renderColumnsTable(columns) : ''}
      ${sections.map(
        (section) => html`
          <h4>
            ${section.title} <span class="count">${section.rows.length}</span>
            <button class="add-btn" type="button" title="Add ${section.title}" aria-label="Add ${section.title}">
              <i class="codicon codicon-add" aria-hidden="true"></i>
            </button>
          </h4>
          <table class="section-table">
            <colgroup>
              <col class="name-col" />
              <col />
            </colgroup>
            <tbody>
              ${section.rows.map(
                (row) => html`
                  <tr @contextmenu=${(event: MouseEvent) => this._onRowMenu(event, row.name, row.definition)}>
                    <td class="mono name-cell" title=${row.name}>
                      ${this.engine ? dialectFor(this.engine).displayConstraintName(row.name) : row.name}
                    </td>
                    <td class="mono def" title=${row.definition}>${highlightDefinition(row.definition)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `,
      )}
      ${sections.length
        ? ''
        : this.object
          ? columns.length
            ? ''
            : html`<p class="muted hint">Nothing to show.</p>`
          : html`<p class="muted hint">No constraints, indexes, or triggers.</p>`}
    `
  }

  private _renderColumnsTable(columns: TableInspection['columns']) {
    const hasComments = this.engine ? dialectFor(this.engine).supportsColumnComments : false
    return html`
      <h4>${this.object ? 'Attributes' : 'Columns'} <span class="count">${columns.length}</span></h4>
      <table class="columns-table">
        <colgroup>
          <col class="icon-col" />
          <col class="name-col" />
          <col class="type-col" />
          <col class="nullable-col" />
          <col />
          ${hasComments ? html`<col />` : ''}
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            ${hasComments ? html`<th>Comment</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${columns.map(
            (column) => html`
              <tr @contextmenu=${(event: MouseEvent) => this._onRowMenu(event, column.name)}>
                <td class="icon-cell">
                  ${column.primaryKey ? html`<i class="codicon codicon-key pk" aria-hidden="true" title="Primary key"></i>` : ''}
                </td>
                <td class="mono clip" title=${column.name}>${column.name}</td>
                <td class="mono type clip" title=${column.dataType}>${abbreviateType(column.dataType, this.engine)}</td>
                <td class="muted">${column.nullable ? 'yes' : 'no'}</td>
                <td class="mono muted clip" title=${column.default ?? ''}>${column.default ?? ''}</td>
                ${hasComments ? html`<td class="muted clip" title=${column.comment ?? ''}>${column.comment ?? ''}</td>` : ''}
              </tr>
            `,
          )}
        </tbody>
      </table>
    `
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }

      .scroll {
        height: 100%;
        overflow-y: auto;
        padding: 14px 18px 24px;
        box-sizing: border-box;
      }

      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }

      .head h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }

      .kind {
        padding: 1px 6px;
        border: 1px solid var(--border);
        border-radius: 3px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-3);
      }

      .refresh {
        display: inline-flex;
        padding: 3px;
        margin-left: auto;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .refresh:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      h4 {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 18px 0 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-2);
      }

      .count {
        font-weight: 400;
        color: var(--text-3);
      }

      .add-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 1px;
        color: var(--on-accent);
        background: var(--accent);
        border: none;
        border-radius: 50%;
        cursor: pointer;
        letter-spacing: normal;
        line-height: 1;
      }

      .add-btn .codicon {
        font-size: 11px;
        margin: 1px 0 0 1px;
        -webkit-text-stroke: 0.6px currentColor;
      }

      .add-btn:hover {
        background: var(--accent-hover);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      td,
      th {
        padding: 3px 10px 3px 0;
        text-align: left;
        border-bottom: 1px solid var(--border-subtle, var(--border));
        vertical-align: top;
      }

      th {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3);
      }

      .mono {
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      }

      .muted {
        color: var(--text-3);
      }

      .type {
        color: var(--text-2);
      }

      .icon-cell {
        width: 18px;
      }

      .icon-cell .pk {
        font-size: 12px;
        color: var(--status-dot-warning);
      }

      /* Fixed layout + a shared name-column width keeps every section's
         columns aligned with each other, however long one name gets. */
      .section-table,
      .columns-table {
        table-layout: fixed;
      }

      .icon-col {
        width: 18px;
      }

      .type-col {
        width: 140px;
      }

      .nullable-col {
        width: 70px;
      }

      .clip {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .name-col {
        width: 280px;
      }

      .name-cell {
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .def {
        color: var(--text-2);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .def .kw {
        font-weight: 600;
        /* The editor's keyword violet (sql-editor.ts softHighlightStyle), so
           definitions read as the same language as the editor. */
        color: #a163b5;
      }

      .hint {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
      }

      .error {
        margin: 10px 0;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--status-dot-error);
        white-space: pre-wrap;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'table-inspect': TableInspect
  }
}
