import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, controls, scrollbars, typography } from '../shared-styles'

export type PaletteMode = 'commands' | 'quick' | 'databases'

// One row. The palette is presentation-only: the owner computes the entries
// for the current mode and decides what a pick means.
export type PaletteEntry = {
  id: string
  label: string
  detail?: string
  /** Codicon name, e.g. 'codicon-database'. */
  icon?: string
  keybind?: string
  /**
   * A non-pickable group label; the entries after it (until the next header)
   * are its children. Hidden when no child survives the filter; a matching
   * header reveals all of its children.
   */
  header?: boolean
  /** Renders nested under a group header. */
  indent?: boolean
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: 'Type a command…',
  quick: 'Search files…',
  databases: 'Switch database…',
}

// Every whitespace-separated term must appear somewhere in the entry's text.
function matches(query: string, entry: PaletteEntry): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = `${entry.label} ${entry.detail ?? ''} ${entry.id}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

// Filters while preserving group structure: a header stays while any of its
// children match, and a header that matches by itself reveals all of them.
function filterEntries(query: string, entries: PaletteEntry[]): PaletteEntry[] {
  const visible: PaletteEntry[] = []
  let index = 0
  while (index < entries.length) {
    const entry = entries[index]
    if (!entry) break
    if (!entry.header) {
      if (matches(query, entry)) visible.push(entry)
      index += 1
      continue
    }

    const children: PaletteEntry[] = []
    let next = index + 1
    while (next < entries.length) {
      const child = entries[next]
      if (!child || child.header) break
      children.push(child)
      next += 1
    }
    const kept = matches(query, entry) ? children : children.filter((child) => matches(query, child))
    if (kept.length) visible.push(entry, ...kept)
    index = next
  }
  return visible
}

/** The nearest pickable index at or after `from`, stepping by `step`. */
function pickable(entries: PaletteEntry[], from: number, step: 1 | -1): number {
  if (!entries.some((entry) => !entry.header)) return 0
  let index = ((from % entries.length) + entries.length) % entries.length
  while (entries[index]?.header) index = (index + step + entries.length) % entries.length
  return index
}

// Modal quick-pick overlay (VS Code-style): an input over a filtered list,
// arrow keys + Enter to pick, Escape or backdrop click to close. Dispatches
// `palette-pick` with { mode, id } and `palette-close`.
@customElement('command-palette')
export class CommandPalette extends LitElement {
  @property({ type: Boolean, reflect: true })
  open = false

  @property()
  mode: PaletteMode = 'commands'

  @property({ attribute: false })
  entries: PaletteEntry[] = []

  @state()
  private _query = ''

  @state()
  private _active = 0

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('open') || changed.has('mode')) {
      this._query = ''
      this._active = 0
    }
  }

  protected updated(changed: PropertyValues) {
    if ((changed.has('open') || changed.has('mode')) && this.open) {
      const input = this.shadowRoot?.querySelector('input')
      input?.focus()
    }
  }

  render() {
    if (!this.open) return nothing
    const filtered = filterEntries(this._query, this.entries)

    // The active row can never be a header; normalize after filtering moved it.
    const active = pickable(filtered, this._active, 1)
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel">
          <input
            type="text"
            placeholder=${PLACEHOLDERS[this.mode]}
            .value=${this._query}
            @input=${this._onInput}
            @keydown=${(e: KeyboardEvent) => this._onKeydown(e, filtered, active)}
            autocomplete="off"
            spellcheck="false"
          />
          <div class="list" role="listbox">
            ${filtered.length
              ? filtered.map((entry, index) => this._renderEntry(entry, index, active))
              : html`<div class="empty muted">${this._emptyMessage()}</div>`}
          </div>
        </div>
      </div>
    `
  }

  private _emptyMessage() {
    if (this.entries.length) return 'No matches'
    return this.mode === 'quick'
      ? 'No .sql files in this workspace'
      : this.mode === 'databases'
        ? 'No database connections yet'
        : 'No commands'
  }

  private _renderEntry(entry: PaletteEntry, index: number, active: number) {
    if (entry.header) {
      return html`
        <div class="row group" role="presentation">
          <i class="codicon ${entry.icon ?? 'codicon-circle-small'}" aria-hidden="true"></i>
          <span class="label">${this._highlight(entry.label)}</span>
          ${entry.detail ? html`<span class="detail">${entry.detail}</span>` : ''}
        </div>
      `
    }
    return html`
      <div
        class="row ${entry.indent ? 'indent' : ''} ${index === active ? 'active' : ''}"
        role="option"
        aria-selected=${index === active}
        @click=${() => this._pick(entry)}
        @mousemove=${() => this._setActive(index)}
      >
        <i class="codicon ${entry.icon ?? 'codicon-circle-small'}" aria-hidden="true"></i>
        <span class="label">${this._highlight(entry.label)}</span>
        ${entry.detail ? html`<span class="detail">${entry.detail}</span>` : ''}
        ${entry.keybind ? html`<span class="keybind">${entry.keybind}</span>` : ''}
      </div>
    `
  }

  private _highlight(label: string) {
    const first = this._query.trim().split(/\s+/)[0] ?? ''
    if (!first) return label
    const at = label.toLowerCase().indexOf(first.toLowerCase())
    if (at < 0) return label
    return html`${label.slice(0, at)}<mark>${label.slice(at, at + first.length)}</mark>${label.slice(at + first.length)}`
  }

  private _setActive(index: number) {
    if (this._active !== index) this._active = index
  }

  private _onInput(event: Event) {
    this._query = (event.target as HTMLInputElement).value
    this._active = 0
  }

  private _onKeydown(event: KeyboardEvent, filtered: PaletteEntry[], active: number) {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!filtered.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      this._active = pickable(filtered, active + step, step)
      void this.updateComplete.then(() => {
        this.shadowRoot?.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' })
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const entry = filtered[active]
      if (entry && !entry.header) this._pick(entry)
    }
  }

  private _onBackdropDown(event: MouseEvent) {
    if (event.target === event.currentTarget) this._close()
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('palette-close', { bubbles: true, composed: true }))
  }

  private _pick(entry: PaletteEntry) {
    this.dispatchEvent(
      new CustomEvent('palette-pick', {
        detail: { mode: this.mode, id: entry.id },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    typography,
    controls,
    codicons,
    scrollbars,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }

      .panel {
        width: min(560px, calc(100vw - 80px));
        margin-top: 64px;
        display: flex;
        flex-direction: column;
        background: var(--sidebar-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
        overflow: hidden;
      }

      input {
        border-radius: 0;
        border-left: none;
        border-right: none;
        border-top: none;
      }

      .list {
        max-height: 320px;
        overflow-y: auto;
        padding: 4px 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px;
        cursor: pointer;
        color: var(--text);
        font-size: var(--font-size);
        white-space: nowrap;
      }

      .row.active {
        background: var(--list-selection);
        color: var(--list-selection-fg);
      }

      .row.indent {
        padding-left: 30px;
      }

      .row.group {
        cursor: default;
        color: var(--text-2);
      }

      .row.group .label {
        font-weight: 600;
      }

      .row .codicon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .row.active .codicon,
      .row.active .detail {
        color: var(--list-selection-fg);
      }

      .label {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .label mark {
        background: transparent;
        color: var(--accent);
        font-weight: 700;
      }

      .row.active .label mark {
        color: var(--list-selection-fg);
        text-decoration: underline;
      }

      .detail {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .keybind {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .empty {
        padding: 10px 12px;
        font-size: var(--font-size);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'command-palette': CommandPalette
  }
}
