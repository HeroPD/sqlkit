import { LitElement, css, html } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'

export type MenuItem = { id: string; label: string; danger?: boolean }
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
    return html`
      <div
        class="backdrop"
        @mousedown=${this._close}
        @contextmenu=${(e: Event) => {
          e.preventDefault()
          this._close()
        }}
      ></div>
      <div class="menu" style="left: ${this._left}px; top: ${this._top}px" role="menu">
        ${this.items.map(
          (item) => html`
            <button
              class="menu-item ${item.danger ? 'danger' : ''}"
              role="menuitem"
              @mousedown=${(e: Event) => e.preventDefault()}
              @click=${() => this._pick(item)}
            >
              ${item.label}
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
      min-width: 160px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      background: var(--sidebar-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .menu-item {
      display: block;
      width: 100%;
      padding: 5px 10px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--text);
      font-size: var(--font-size);
      text-align: left;
      cursor: pointer;
    }

    .menu-item:hover {
      background: var(--list-hover);
    }

    .menu-item.danger:hover {
      background: color-mix(in srgb, var(--status-dot-error) 22%, transparent);
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'context-menu': ContextMenu
  }
}
