import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, icons, overlay, scrollbars, tooltip, typography } from '../shared-styles'
import { t } from '../i18n'
import { isMac } from '../platform'
import type { Engine, EngineFlavor } from '../electron'
import './engine-badge'

export type PaletteMode = 'commands' | 'quick' | 'databases'
export type PaletteConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

// One row. The palette is presentation-only: the owner computes the entries
// for the current mode and decides what a pick means.
export type PaletteEntry = {
  id: string
  label: string
  detail?: string
  /** Lucide icon class, e.g. 'icon-database'. */
  icon?: string
  /** Uses the same branded database badge as the configuration list. */
  engine?: Engine
  flavor?: EngineFlavor
  keybind?: string
  /** Cmd+K connection row with a reserved identity/status layout. */
  connection?: boolean
  /** Validated profile accent resolved to a CSS color by the controller. */
  accentColor?: string
  status?: PaletteConnectionStatus
  statusLabel?: string
  statusError?: string
  inUse?: boolean
  /**
   * A non-pickable group label; the entries after it (until the next header)
   * are its children. Hidden when no child survives the filter; a matching
   * header reveals all of its children.
   */
  header?: boolean
  /** Renders nested under a group header. */
  indent?: boolean
  /** Optional trailing row action that does not pick the entry. */
  action?: { id: string; label: string; icon: string }
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: t('palette.commands'),
  quick: t('palette.quick'),
  databases: t('palette.databases'),
}

const SHORTCUTS: Record<PaletteMode, string> = {
  commands: isMac ? '⇧⌘P' : 'Ctrl Shift P',
  quick: isMac ? '⌘P' : 'Ctrl P',
  databases: isMac ? '⌘K' : 'Ctrl K',
}

const shortcutFor = (mode: PaletteMode, commandsShortcut: string) =>
  mode === 'commands' ? commandsShortcut : SHORTCUTS[mode]

// Every whitespace-separated term must appear somewhere in the entry's text.
function matches(query: string, entry: PaletteEntry): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    entry.label,
    entry.detail ?? '',
    entry.statusLabel ?? '',
    entry.statusError ?? '',
    entry.inUse ? t('palette.inUse') : '',
    entry.id,
  ].join(' ').toLowerCase()
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

  /** The configured chord for ⌘⇧P; the other modes are fixed keys. */
  @property()
  commandsShortcut = SHORTCUTS.commands

  @state()
  private _query = ''

  @state()
  private _active = 0

  @state()
  private _nameTooltip: { label: string; left: number; top: number } | null = null

  private _tooltipTimer: number | null = null

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('open') || changed.has('mode')) {
      this._query = ''
      this._active = 0
      this._hideNameTooltip()
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._hideNameTooltip()
  }

  protected updated(changed: PropertyValues) {
    if (!this.open) return
    const root = this.shadowRoot
    const shouldFocus = changed.has('open') || changed.has('mode') || (changed.has('entries') && !root?.activeElement)
    if (shouldFocus) root?.querySelector('input')?.focus()
  }

  render() {
    if (!this.open) return nothing
    const filtered = filterEntries(this._query, this.entries)

    // The active row can never be a header; normalize after filtering moved it.
    const active = pickable(filtered, this._active, 1)
    return html`
      <div class="backdrop" @mousedown=${this._onBackdropDown}>
        <div class="panel">
          <div class="search">
            <i class="icon icon-search search-icon" aria-hidden="true"></i>
            <input
              type="text"
              placeholder=${PLACEHOLDERS[this.mode]}
              .value=${this._query}
              @input=${this._onInput}
              @keydown=${(e: KeyboardEvent) => this._onKeydown(e, filtered, active)}
              autocomplete="off"
              spellcheck="false"
            />
            <span class="palette-shortcut" aria-hidden="true">${shortcutFor(this.mode, this.commandsShortcut)}</span>
          </div>
          <div class="list" role="listbox" @scroll=${this._hideNameTooltip}>
            ${filtered.length
              ? filtered.map((entry, index) => this._renderEntry(entry, index, active))
              : html`<div class="empty muted">${this._emptyMessage()}</div>`}
          </div>
          <div class="palette-footer" aria-hidden="true">
            <span><kbd>↑↓</kbd>${t('palette.navigate')}</span>
            <span><kbd>↵</kbd>${t('palette.select')}</span>
            <span><kbd>esc</kbd>${t('palette.close')}</span>
          </div>
        </div>
        ${this._nameTooltip
          ? html`
              <span
                class="name-tooltip-anchor tooltip-up tooltip-start"
                role="tooltip"
                aria-label=${this._nameTooltip.label}
                data-tooltip=${this._nameTooltip.label}
                style="left: ${this._nameTooltip.left}px; top: ${this._nameTooltip.top}px"
              ></span>
            `
          : nothing}
      </div>
    `
  }

  private _emptyMessage() {
    if (this.entries.length) return t('palette.noMatches')
    if (this.mode === 'quick') return t('palette.noFiles')
    if (this.mode === 'databases') return t('palette.noDatabases')
    return t('palette.noCommands')
  }

  private _renderEntry(entry: PaletteEntry, index: number, active: number) {
    if (entry.header) {
      return html`
        <div class="row group" role="presentation">
          ${this._renderEntryContent(entry)}
        </div>
      `
    }
    return html`
      <div
        class="row ${entry.connection ? 'connection' : ''} ${entry.indent ? 'indent' : ''} ${entry.status ? 'has-status' : ''} ${entry.statusError ? 'error-row' : ''} ${index === active ? 'active' : ''}"
        role="option"
        aria-selected=${index === active}
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
        @click=${() => this._pick(entry)}
        @mousemove=${() => this._setActive(index)}
      >
        ${this._renderEntryContent(entry)}
      </div>
    `
  }

  private _renderEntryContent(entry: PaletteEntry) {
    return html`
      ${entry.connection
        ? html`<span class="label-bar" style=${entry.accentColor ? `--label-color: ${entry.accentColor}` : ''} aria-hidden="true"></span>`
        : nothing}
      ${entry.engine
        ? html`<engine-badge .engine=${entry.engine} .flavor=${entry.flavor ?? ''}></engine-badge>`
        : nothing}
      ${entry.icon ? html`<i class="icon ${entry.icon}" aria-hidden="true"></i>` : nothing}
      ${entry.connection
        ? html`
            <span
              class="label-wrap"
              @mouseenter=${(event: MouseEvent) => this._showNameTooltip(event, entry.label)}
              @mouseleave=${this._hideNameTooltip}
            >
              <span class="label">${this._highlight(entry.label)}</span>
            </span>
          `
        : html`<span class="label">${this._highlight(entry.label)}</span>`}
      ${entry.detail ? html`<span class="detail">${entry.detail}</span>` : ''}
      ${entry.status
        ? html`
            <span class="connection-status ${entry.status}" title=${entry.statusError ?? ''}>
              ${entry.status === 'connecting' ? html`<span class="status-spinner"></span>` : html`<span class="status-dot"></span>`}
              ${entry.statusLabel}
            </span>
          `
        : ''}
      ${entry.inUse
        ? html`<span class="in-use"><i class="icon icon-check" aria-hidden="true"></i>${t('palette.inUse')}</span>`
        : ''}
      ${entry.keybind ? html`<span class="keybind">${entry.keybind}</span>` : ''}
      ${entry.statusError ? html`<span class="status-error">${entry.statusError}</span>` : ''}
      ${entry.action
        ? html`
            <button
              class="row-action"
              title=${entry.action.label}
              aria-label=${entry.action.label}
              @mousedown=${(event: MouseEvent) => event.preventDefault()}
              @click=${(event: MouseEvent) => this._action(event, entry)}
            >
              <i class="icon ${entry.action.icon}" aria-hidden="true"></i>
            </button>
          `
        : nothing}
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

  private _showNameTooltip(event: MouseEvent, label: string) {
    this._hideNameTooltip()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const maxWidth = Math.min(420, window.innerWidth - 80)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - maxWidth - 8))
    this._tooltipTimer = window.setTimeout(() => {
      this._tooltipTimer = null
      this._nameTooltip = { label, left, top: rect.top - 7 }
    }, 400)
  }

  private _hideNameTooltip() {
    if (this._tooltipTimer !== null) {
      window.clearTimeout(this._tooltipTimer)
      this._tooltipTimer = null
    }
    this._nameTooltip = null
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
        this.shadowRoot?.querySelector('.row.active')?.scrollIntoView?.({ block: 'nearest' })
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

  private _action(event: MouseEvent, entry: PaletteEntry) {
    event.stopPropagation()
    if (!entry.action) return
    this.dispatchEvent(
      new CustomEvent('palette-action', {
        detail: { mode: this.mode, id: entry.id, action: entry.action.id },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    typography,
    controls,
    icons,
    scrollbars,
    overlay,
    tooltip,
    css`
      :host {
        display: contents;
      }

      /* Palette docks near the top instead of centering like other overlays. */
      .backdrop {
        align-items: flex-start;
      }

      .panel {
        width: min(600px, calc(100vw - 40px));
        margin-top: 64px;
        overflow: hidden;
      }

      .search {
        position: relative;
        height: 36px;
        display: flex;
        align-items: center;
      }

      /* Flush divider under the input; no focus ring — the input owns focus
         the whole time the palette is open, so a ring is pure noise. */
      input {
        height: 100%;
        padding-left: 32px;
        padding-right: 70px;
        border-radius: 0;
        border-left: none;
        border-right: none;
        border-top: none;
        border-bottom-color: var(--border);
      }

      .search-icon {
        position: absolute;
        left: 10px;
        z-index: 1;
        color: var(--text-3);
        font-size: 15px;
        pointer-events: none;
      }

      input:focus {
        border-color: var(--border);
        box-shadow: none;
      }

      .palette-shortcut {
        position: absolute;
        right: 10px;
        color: var(--text-3);
        font-family: var(--ui-font);
        font-size: var(--font-size-sm);
      }

      .list {
        max-height: 405px;
        /* The list only scrolls vertically; name tooltips render on the
           fixed overlay layer below instead of inside this container. */
        overflow-x: hidden;
        overflow-y: auto;
        padding: 3px;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 26px;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--text);
        white-space: nowrap;
      }

      /* Identity left, status right: the name track takes the free width so
         "Connected" and "In use" line up down the right edge of every row. */
      .row.connection,
      .row.group {
        display: grid;
        min-height: 30px;
        grid-template-columns: 3px 19px minmax(0, 1fr) minmax(12px, 32px) 104px 72px 26px;
        column-gap: 7px;
      }

      /* Tracked row: a notch above the menus' 9% hover so Enter's target reads. */
      .row.active {
        background: color-mix(in srgb, var(--text) 12%, transparent);
      }

      .row.indent {
        padding-left: 18px;
      }

      .row.group {
        cursor: default;
        color: var(--text-2);
      }

      .row.group .label {
        font-weight: 600;
      }

      .row .icon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .row.connection > .icon,
      .row.group > .icon,
      .row.connection > engine-badge,
      .row.group > engine-badge {
        grid-column: 2;
      }

      .row.connection > engine-badge,
      .row.group > engine-badge {
        --engine-badge-size: 19px;
      }

      .label-bar {
        grid-column: 1;
        width: 3px;
        height: 17px;
        background: var(--label-color, transparent);
        border-radius: 2px;
      }

      .row.indent .label-bar {
        height: 11px;
        opacity: 0.55;
      }

      .label {
        min-width: 0;
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .label-wrap {
        grid-column: 3;
        min-width: 0;
      }

      /* A detached anchor lets the shared tooltip surface escape the scrolling
         list while retaining the same appearance used throughout the app. */
      .name-tooltip-anchor {
        position: fixed;
        z-index: 101;
        width: 0;
        height: 0;
        pointer-events: none;
      }

      .name-tooltip-anchor[data-tooltip]::after {
        width: max-content;
        max-width: min(420px, calc(100vw - 80px));
        box-sizing: border-box;
        white-space: normal;
        overflow-wrap: anywhere;
        opacity: 1;
        visibility: visible;
        translate: 0 0;
        transition: none;
      }

      .label mark {
        background: transparent;
        color: var(--accent);
        font-weight: 700;
      }

      .detail {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .row.connection .detail,
      .row.group .detail {
        flex: none;
        text-transform: capitalize;
      }

      .connection-status {
        grid-column: 5;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--text-2);
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        flex-shrink: 0;
        background: var(--status-color);
        border-radius: 50%;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-color) 12%, transparent);
      }

      .connection-status.connected {
        --status-color: var(--status-dot-connected);
      }

      .connection-status.disconnected {
        --status-color: var(--text-3);
      }

      .connection-status.error {
        --status-color: var(--status-dot-error);
        color: color-mix(in srgb, var(--status-dot-error) 78%, var(--text));
      }

      .status-spinner {
        width: 9px;
        height: 9px;
        flex-shrink: 0;
        border: 1.5px solid color-mix(in srgb, var(--status-dot-warning) 30%, transparent);
        border-top-color: var(--status-dot-warning);
        border-radius: 50%;
        animation: palette-spin 1s linear infinite;
      }

      @keyframes palette-spin {
        to { transform: rotate(360deg); }
      }

      .in-use {
        grid-column: 6;
        justify-self: end;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: color-mix(in srgb, var(--accent) 62%, var(--text));
        font-size: var(--font-size-sm);
        font-weight: 600;
        white-space: nowrap;
      }

      .in-use .icon {
        color: currentColor;
        font-size: 11px;
      }

      .row-action {
        grid-column: 7;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-3);
        opacity: 0;
      }

      .row:hover .row-action,
      .row.active .row-action,
      .row-action:focus-visible {
        opacity: 1;
      }

      .row-action:hover {
        background: color-mix(in srgb, var(--status-dot-error) 12%, transparent);
        color: var(--status-dot-error);
      }

      .row-action .icon {
        color: currentColor;
        font-size: 14px;
      }

      .keybind {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .status-error {
        grid-column: 3 / -1;
        margin-top: -4px;
        overflow: hidden;
        color: color-mix(in srgb, var(--status-dot-error) 72%, var(--text-3));
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .row.error-row {
        min-height: 42px;
        grid-template-rows: 24px 14px;
      }

      .empty {
        padding: 10px 12px;
      }

      .palette-footer {
        height: 30px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 8px;
        color: var(--text-3);
        background: color-mix(in srgb, var(--overlay-bg) 84%, var(--bg));
        border-top: 1px solid var(--border-subtle);
        font-size: 14px;
      }

      .palette-footer span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .palette-footer kbd {
        color: var(--text-2);
        font-family: var(--mono-font);
        font-size: 14px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'command-palette': CommandPalette
  }
}
