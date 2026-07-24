import { LitElement, css, html } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'

export type MenuItem = {
  id: string
  label: string
  danger?: boolean
  checked?: boolean
  shortcut?: string
  separatorBefore?: boolean
}
export type MenuPickDetail = { id: string }

// Floating right-click menu, shared by the file tree, table list, and
// whatever grows one next: a fixed-position item list over a full-viewport
// backdrop. The host mounts it at the pointer position and unmounts it on
// `menu-close`; a click on an item dispatches `menu-pick` first, then close.
@customElement('context-menu')
export class ContextMenu extends LitElement {
  @property({ type: Number })
  x = 0

  @property({ type: Number })
  y = 0

  @property({ attribute: false })
  items: MenuItem[] = []

  // Resolved position after clamping to the viewport; defaults to the raw x/y.
  @state()
  private _left = 0

  @state()
  private _top = 0

  @query('.menu')
  private _menuEl!: HTMLElement

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  render() {
    const hasChecks = this.items.some((item) => item.checked !== undefined)
    return html`
      <div
        class="backdrop"
        @mousedown=${this._close}
        @contextmenu=${(e: Event) => {
          e.preventDefault()
          this._close()
        }}
      ></div>
      <div class="menu ${hasChecks ? 'has-checks' : ''}" style="left: ${this._left}px; top: ${this._top}px" role="menu">
        ${this.items.map(
          (item) => html`
            ${item.separatorBefore ? html`<div class="separator" role="separator"></div>` : ''}
            <button
              class="menu-item ${item.danger ? 'danger' : ''}"
              role="menuitem"
              aria-checked=${item.checked === undefined ? undefined : item.checked ? 'true' : 'false'}
              @mousedown=${(e: Event) => e.preventDefault()}
              @click=${() => this._pick(item)}
            >
              ${hasChecks ? html`<span class="check" aria-hidden="true">${item.checked ? '✓' : ''}</span>` : ''}
              <span class="label">${item.label}</span>
              ${item.shortcut ? html`<kbd>${item.shortcut}</kbd>` : ''}
            </button>
          `,
        )}
      </div>
    `
  }

  willUpdate(changed: Map<string, unknown>) {
    // Paint at the pointer first; updated() then clamps once the menu has a size.
    if (changed.has('x')) this._left = this.x
    if (changed.has('y')) this._top = this.y
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('x') || changed.has('y') || changed.has('items')) this._clamp()
  }

  // Keep the menu inside the viewport: measure it and shift left/up so it
  // isn't clipped by the window edge when opened near the bottom or right.
  private _clamp() {
    const el = this._menuEl
    if (!el) return
    const margin = 4
    const { width, height } = el.getBoundingClientRect()
    const maxLeft = Math.max(margin, window.innerWidth - width - margin)
    const maxTop = Math.max(margin, window.innerHeight - height - margin)
    this._left = Math.min(Math.max(this.x, margin), maxLeft)
    this._top = Math.min(Math.max(this.y, margin), maxTop)
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._close()
    }
  }

  private _pick(item: MenuItem) {
    this.dispatchEvent(
      new CustomEvent<MenuPickDetail>('menu-pick', { detail: { id: item.id }, bubbles: true, composed: true }),
    )
    this._close()
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('menu-close', { bubbles: true, composed: true }))
  }

  static styles = css`
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 90;
    }

    .menu {
      position: fixed;
      z-index: 91;
      min-width: 196px;
      max-width: min(320px, calc(100vw - 8px));
      max-height: calc(100vh - 8px);
      overflow-y: auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      background: var(--overlay-bg);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.28),
        0 1px 3px rgba(0, 0, 0, 0.2);
      font-family: var(--ui-font);
    }

    .check {
      width: 14px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      text-align: center;
    }

    .menu-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 18px;
      width: 100%;
      min-height: 26px;
      padding: 3px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: var(--font-size);
      line-height: 20px;
      text-align: left;
      cursor: pointer;
    }

    .has-checks .menu-item {
      grid-template-columns: 14px minmax(0, 1fr) auto;
      column-gap: 8px;
    }

    .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    kbd {
      color: var(--text-3);
      font: var(--font-size-sm) / 1 var(--ui-font);
      white-space: nowrap;
    }

    /* Full-bleed hairline across the panel, past the container padding.
       --border (not -subtle): the menu surface is lighter than the app bg. */
    .separator {
      height: 1px;
      margin: 4px -4px;
      flex-shrink: 0;
      background: var(--border);
    }

    /* Neutral text-tinted overlay so the highlight tracks any theme, light or dark. */
    .menu-item:hover,
    .menu-item:focus-visible {
      background: color-mix(in srgb, var(--text) 9%, transparent);
      outline: none;
    }

    .menu-item.danger {
      color: color-mix(in srgb, var(--status-dot-error) 82%, var(--text));
    }

    .menu-item.danger:hover,
    .menu-item.danger:focus-visible {
      background: color-mix(in srgb, var(--status-dot-error) 16%, transparent);
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'context-menu': ContextMenu
  }
}
