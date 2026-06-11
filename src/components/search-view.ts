import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'
import type { FileInfo } from '../electron'

export type SearchOpenDetail = { file: FileInfo; line: number }

type Match = { line: number; before: string; hit: string; after: string }
type FileMatches = { file: FileInfo; matches: Match[] }

const MAX_MATCHES = 250
const CONTEXT_CHARS = 24
const DEBOUNCE_MS = 200

// The Search sidebar view: case-insensitive text search over the in-use
// context's .sql files, read from disk per (debounced) search so results
// reflect what's saved. Match rows dispatch `search-open` with the file and
// 1-based line; the workbench opens the tab and reveals the line.
@customElement('search-view')
export class SearchView extends LitElement {
  @property({ attribute: false })
  files: FileInfo[] = []

  @state()
  private _query = ''

  @state()
  private _results: FileMatches[] = []

  @state()
  private _total = 0

  @state()
  private _capped = false

  private _timer: number | null = null

  // Searches run file-by-file over IPC; a stale run must not clobber the
  // results of the one the user typed after it.
  private _seq = 0

  protected willUpdate(changed: PropertyValues) {
    // Context switch swaps the file set under us: redo the search against it.
    if (changed.has('files') && this._query.trim()) void this._run()
  }

  protected firstUpdated() {
    this.shadowRoot?.querySelector('input')?.focus()
  }

  render() {
    return html`
      <div class="search-box">
        <input
          type="text"
          placeholder="Search .sql files"
          spellcheck="false"
          .value=${this._query}
          @input=${this._onInput}
        />
      </div>
      <div class="results">${this._renderResults()}</div>
    `
  }

  private _renderResults() {
    if (!this._query.trim()) {
      return html`<p class="muted hint">Matches in the context's .sql files show here.</p>`
    }
    if (!this._results.length) return html`<p class="muted hint">No results.</p>`
    const files = this._results.length
    return html`
      <p class="muted hint summary">
        ${this._total}${this._capped ? '+' : ''} result${this._total === 1 ? '' : 's'} in ${files}
        file${files === 1 ? '' : 's'}
      </p>
      ${this._results.map(
        (group) => html`
          <div class="file-row" title=${group.file.relativePath}>
            <i class="codicon codicon-file-code" aria-hidden="true"></i>
            <span class="fname">${group.file.name}</span>
            <span class="count">${group.matches.length}</span>
          </div>
          ${group.matches.map(
            (match) => html`
              <div
                class="match-row"
                title="${group.file.relativePath}:${match.line}"
                @click=${() => this._open(group.file, match.line)}
              >
                <span class="line-no">${match.line}</span>
                <span class="line-text">${match.before}<span class="hl">${match.hit}</span>${match.after}</span>
              </div>
            `,
          )}
        `,
      )}
    `
  }

  private _onInput(event: Event) {
    this._query = (event.target as HTMLInputElement).value
    if (this._timer !== null) clearTimeout(this._timer)
    this._timer = window.setTimeout(() => void this._run(), DEBOUNCE_MS)
  }

  private async _run() {
    const seq = ++this._seq
    const needle = this._query.trim().toLowerCase()
    if (!needle) {
      this._results = []
      this._total = 0
      this._capped = false
      return
    }

    const targets = this.files.filter((file) => file.type === 'file' && file.name.toLowerCase().endsWith('.sql'))
    const results: FileMatches[] = []
    let total = 0
    let capped = false

    for (const file of targets) {
      const read = await window.sqlkit.readFile(file.path)
      if (seq !== this._seq) return
      if (!read.success) continue

      const lines = read.content.split('\n')
      const matches: Match[] = []
      for (let index = 0; index < lines.length && !capped; index++) {
        const line = lines[index]
        const at = line.toLowerCase().indexOf(needle)
        if (at < 0) continue
        const start = Math.max(0, at - CONTEXT_CHARS)
        matches.push({
          line: index + 1,
          before: (start > 0 ? '…' : '') + line.slice(start, at),
          hit: line.slice(at, at + needle.length),
          after: line.slice(at + needle.length, at + needle.length + 160),
        })
        total++
        if (total >= MAX_MATCHES) capped = true
      }
      if (matches.length) results.push({ file, matches })
      if (capped) break
    }

    this._results = results
    this._total = total
    this._capped = capped
  }

  private _open(file: FileInfo, line: number) {
    this.dispatchEvent(
      new CustomEvent<SearchOpenDetail>('search-open', { detail: { file, line }, bubbles: true, composed: true }),
    )
  }

  static styles = [
    typography,
    controls,
    codicons,
    scrollbars,
    css`
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      .search-box {
        flex-shrink: 0;
        padding: 4px 10px 8px;
      }

      .results {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .hint {
        padding: 0 20px;
      }

      .summary {
        padding: 0 10px 6px;
        font-size: var(--font-size-sm);
      }

      .file-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        font-size: var(--font-size);
        color: var(--text);
        white-space: nowrap;
        user-select: none;
        --codicon-size: 14px;
      }

      .file-row .codicon {
        flex-shrink: 0;
        color: var(--text-2);
      }

      .fname {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .count {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .match-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 2px 10px 2px 26px;
        cursor: pointer;
        white-space: nowrap;
      }

      .match-row:hover {
        background: var(--list-hover);
      }

      .line-no {
        flex-shrink: 0;
        min-width: 2ch;
        text-align: right;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .line-text {
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-2);
        font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 12px;
      }

      .hl {
        color: var(--text);
        background: color-mix(in srgb, var(--accent) 40%, transparent);
        border-radius: 2px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'search-view': SearchView
  }
}
