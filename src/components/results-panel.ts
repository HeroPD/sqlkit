import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { isMac } from '../platform'
import type { QueryResult } from '../electron'
import { rowToTsv, toDelimited, toJson } from '../result-export'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'
import './export-dialog'
import type { ExportConfirmDetail } from './export-dialog'

/** What the results panel is currently showing. */
export type QueryRun =
  | { phase: 'idle' }
  | { phase: 'running'; note?: string }
  | { phase: 'done'; result: QueryResult }
  | { phase: 'error'; error: string }

const MAX_DISPLAY_ROWS = 500
const NUM_COL_WIDTH = 48

const formatCell = (value: unknown) => {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

// Results-table column sizing (reference approach): measure the header and
// the displayed rows once per result set, clamp, and pin the widths through
// table-layout: fixed — so columns never reflow while scrolling. min-width:
// 100% lets the fixed layout stretch the columns proportionally when they
// don't fill the panel.
function measureColumnWidths(columns: string[], rows: unknown[][]): number[] {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return columns.map(() => 120)

  // Mirrors the table CSS: 11px uppercase semibold UI headers, 12px mono cells.
  const headerFont = `600 11px ${getComputedStyle(document.body).fontFamily}`
  const bodyFont = "12px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
  const MIN_WIDTH = 60
  const MAX_WIDTH = 320
  const PADDING = 22
  const HEADER_SLACK = 1.08

  return columns.map((column, index) => {
    ctx.font = headerFont
    let max = ctx.measureText(column.toUpperCase()).width * HEADER_SLACK

    ctx.font = bodyFont
    for (const row of rows) {
      const value = row[index]
      const text = value === null || value === undefined ? 'NULL' : formatCell(value)
      if (text.length > 80) {
        max = MAX_WIDTH
        break
      }
      const width = ctx.measureText(text).width
      if (width > max) max = width
    }

    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(max) + PADDING))
  })
}

// The panel under the SQL editor: header with row count + timing, body
// showing the latest run (hint, spinner, error, or the results grid). The
// host sets the panel's height; everything inside is this component's.
@customElement('results-panel')
export class ResultsPanel extends LitElement {
  @property({ attribute: false })
  run: QueryRun = { phase: 'idle' }

  /** Whether the active connection's engine supports cancelling a run. */
  @property({ attribute: false })
  canCancel = false

  /** Cell the context menu was opened on: row/col index into the result
   * (col -1 on the # column, row -1 on the header row). */
  @state()
  private _menu: { x: number; y: number; row: number; col: number } | null = null

  @state()
  private _exportOpen = false

  // Widths are measured once per result set; re-renders reuse the memo.
  private _widthsCache: { result: QueryResult; widths: number[] } | null = null

  private _cancel() {
    this.dispatchEvent(new CustomEvent('cancel-query', { bubbles: true, composed: true }))
  }

  render() {
    const exportable = this.run.phase === 'done' && this.run.result.columns.length > 0
    return html`
      <div class="head">
        <span>Results</span>
        <span class="status">${this._status()}</span>
        ${exportable
          ? html`
              <button
                class="head-action"
                title="Export results…"
                aria-label="Export results"
                @click=${() => (this._exportOpen = true)}
              >
                <i class="codicon codicon-desktop-download" aria-hidden="true"></i>
              </button>
            `
          : ''}
      </div>
      <div class="body">${this._renderBody()}</div>
      ${this._renderMenu()}
      ${this._exportOpen && this.run.phase === 'done'
        ? html`
            <export-dialog
              .total=${this.run.result.rows.length}
              .truncated=${this.run.result.truncated ?? false}
              @dialog-cancel=${() => (this._exportOpen = false)}
              @export-confirm=${this._onExportConfirm}
            ></export-dialog>
          `
        : ''}
    `
  }

  private _onExportConfirm = (event: CustomEvent<ExportConfirmDetail>) => {
    this._exportOpen = false
    if (this.run.phase !== 'done') return
    const { format, rows } = event.detail
    const { result } = this.run
    const slice = result.rows.slice(0, rows)
    const content =
      format === 'json' ? toJson(result.columns, slice) : toDelimited(result.columns, slice, format === 'tsv' ? '\t' : ',')
    void window.sqlkit.exportFile(`results.${format}`, content)
  }

  // One delegated listener instead of one per cell; indexes recovered from
  // the DOM table coordinates (# column shifts data columns right by one).
  private _onTableContextMenu(event: MouseEvent) {
    if (this.run.phase !== 'done') return
    const cell = (event.target as HTMLElement).closest('td, th') as HTMLTableCellElement | null
    if (!cell) return
    event.preventDefault()
    const rowEl = cell.closest('tr') as HTMLTableRowElement
    const row = cell.tagName === 'TH' ? -1 : rowEl.sectionRowIndex
    this._menu = { x: event.clientX, y: event.clientY, row, col: cell.cellIndex - 1 }
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu || this.run.phase !== 'done') return ''
    const { result } = this.run
    const items: MenuItem[] = [
      ...(menu.row >= 0 && menu.col >= 0 ? [{ id: 'copy-cell', label: 'Copy Cell' }] : []),
      ...(menu.row >= 0 ? [{ id: 'copy-row', label: 'Copy Row' }] : []),
      ...(menu.col >= 0 ? [{ id: 'copy-column-name', label: 'Copy Column Name' }] : []),
      { id: 'copy-csv', label: 'Copy All as CSV' },
      { id: 'copy-tsv', label: 'Copy All as TSV' },
      { id: 'copy-json', label: 'Copy All as JSON' },
      { id: 'export', label: 'Export…' },
    ]
    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onMenuPick(e.detail.id, result, menu)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  private _onMenuPick(action: string, result: QueryResult, at: { row: number; col: number }) {
    const copy = (text: string) => void navigator.clipboard.writeText(text)
    if (action === 'copy-cell') {
      const value = result.rows[at.row]?.[at.col]
      copy(value === null || value === undefined ? '' : formatCell(value))
    }
    if (action === 'copy-row') copy(rowToTsv(result.rows[at.row] ?? []))
    if (action === 'copy-column-name') copy(result.columns[at.col] ?? '')
    if (action === 'copy-csv') copy(toDelimited(result.columns, result.rows, ','))
    if (action === 'copy-tsv') copy(toDelimited(result.columns, result.rows, '\t'))
    if (action === 'copy-json') copy(toJson(result.columns, result.rows))
    if (action === 'export') this._exportOpen = true
  }

  private _status() {
    if (this.run.phase !== 'done') return ''
    const { result } = this.run
    const rows = `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`
    const shown = Math.min(result.rows.length, MAX_DISPLAY_ROWS)
    const truncated = result.truncated || shown < result.rows.length ? ` (showing first ${shown})` : ''
    const pace = result.durationMs < 500 ? 'fast' : result.durationMs < 2000 ? 'medium' : 'slow'
    return html`${rows}${truncated} · <span class="duration ${pace}">${Math.max(1, Math.round(result.durationMs))} ms</span>`
  }

  private _renderBody() {
    const run = this.run
    if (run.phase === 'idle') {
      return html`<p class="hint">Run a query with ${isMac ? '⌘↵' : 'Ctrl+↵'}; selection runs alone, otherwise nearest block.</p>`
    }
    if (run.phase === 'running') {
      // A note means connecting, which has no backend to cancel yet.
      const cancellable = !run.note && this.canCancel
      return html`
        <p class="hint">
          <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
          ${run.note ?? 'Running…'}
          ${cancellable ? html`<button class="stop" @click=${this._cancel}>Stop</button>` : ''}
        </p>
      `
    }
    if (run.phase === 'error') {
      return html`<pre class="error">${run.error}</pre>`
    }

    const { result } = run
    if (!result.columns.length) {
      return html`<p class="hint">OK — ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected.</p>`
    }
    const widths = this._columnWidths(result)
    return html`
      <table @contextmenu=${this._onTableContextMenu}>
        <colgroup>
          <col style="width: ${NUM_COL_WIDTH}px" />
          ${widths.map((width) => html`<col style="width: ${width}px" />`)}
        </colgroup>
        <thead>
          <tr>
            <th class="num">#</th>
            ${result.columns.map((column) => html`<th>${column}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${result.rows.slice(0, MAX_DISPLAY_ROWS).map(
            (row, index) => html`
              <tr>
                <td class="num">${index + 1}</td>
                ${row.map((cell) =>
                  cell === null || cell === undefined
                    ? html`<td><span class="null">NULL</span></td>`
                    : html`<td title=${formatCell(cell)}>${formatCell(cell)}</td>`,
                )}
              </tr>
            `,
          )}
        </tbody>
      </table>
    `
  }

  private _columnWidths(result: QueryResult): number[] {
    if (this._widthsCache?.result !== result) {
      this._widthsCache = { result, widths: measureColumnWidths(result.columns, result.rows.slice(0, MAX_DISPLAY_ROWS)) }
    }
    return this._widthsCache.widths
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--editor-bg);
      }

      .head {
        height: 28px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 12px;
        font-size: var(--font-size-sm);
        font-weight: 700;
        color: var(--text-2);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-bottom: 1px solid var(--border-subtle);
        user-select: none;
      }

      .head-action {
        display: inline-flex;
        flex-shrink: 0;
        padding: 3px;
        color: var(--text-3);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .head-action:hover {
        color: var(--text);
        background: var(--list-hover);
      }

      .status {
        margin-left: auto;
        font-weight: 400;
        text-transform: none;
        letter-spacing: normal;
        color: var(--text-3);
      }

      /* Timing at a glance: green under 500 ms, orange under 2 s, red above. */
      .duration.fast {
        color: var(--status-dot-connected);
      }

      .duration.medium {
        color: var(--status-dot-warning);
      }

      .duration.slow {
        color: var(--status-dot-error);
      }

      .body {
        flex: 1;
        overflow: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .hint {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 10px 12px;
        color: var(--text-3);
      }

      .stop {
        padding: 2px 10px;
        font: inherit;
        font-size: 11px;
        color: var(--status-dot-error);
        background: transparent;
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        cursor: pointer;
      }

      .stop:hover {
        border-color: var(--status-dot-error);
      }

      .error {
        margin: 0;
        padding: 10px 12px;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--status-dot-error);
        white-space: pre-wrap;
      }

      /* Reference-style grid: fixed layout with measured colgroup widths,
         uppercase UI-font headers, mono cells, zebra rows, row hover. */
      table {
        min-width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
      }

      th,
      td {
        padding: 3px 10px;
        text-align: left;
        border-bottom: 1px solid var(--grid-border);
        border-right: 1px solid var(--grid-border);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 4px 10px;
        background: var(--header-bg);
        color: var(--text-2);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      td {
        color: var(--text);
      }

      tbody tr:nth-child(even) td {
        background: var(--row-alt);
      }

      tbody tr:hover td {
        background: var(--row-hover);
      }

      .num {
        color: var(--text-3);
        text-align: right;
        font-size: var(--font-size-sm);
        user-select: none;
      }

      td.num,
      tbody tr:hover td.num {
        background: var(--row-num-bg);
      }

      .null {
        color: var(--text-3);
        font-style: italic;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'results-panel': ResultsPanel
  }
}
