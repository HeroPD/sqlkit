import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

// One row in the Databases sidebar list. Dispatches `db-select` with its
// profile id; the workbench decides what selecting it means (open the form).
@customElement('db-list-item')
export class DbListItem extends LitElement {
  @property()
  dbId = ''

  @property()
  name = ''

  @property()
  detail = ''

  @property({ type: Boolean, reflect: true })
  active = false

  connectedCallback() {
    super.connectedCallback()
    this.tabIndex = 0
    this.setAttribute('role', 'button')
    this.addEventListener('click', this._onSelect)
    this.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener('click', this._onSelect)
    this.removeEventListener('keydown', this._onKeydown)
  }

  render() {
    return html`
      <span class="icon">DB</span>
      <span class="meta">
        <span class="name">${this.name}</span>
        <span class="detail">${this.detail}</span>
      </span>
    `
  }

  private _onSelect = () => {
    this.dispatchEvent(new CustomEvent('db-select', { detail: { id: this.dbId }, bubbles: true, composed: true }))
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    this._onSelect()
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      color: var(--text);
      cursor: pointer;
    }

    :host(:hover) {
      background: var(--list-hover);
    }

    :host([active]) {
      background: var(--list-selection);
    }

    :host([active]) .name,
    :host([active]) .detail {
      color: var(--list-selection-fg);
    }

    .icon {
      width: 18px;
      height: 14px;
      flex-shrink: 0;
      border-radius: 2px;
      background: var(--accent);
      color: var(--on-accent);
      font-size: 7px;
      font-weight: 700;
      line-height: 14px;
      text-align: center;
    }

    .meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }

    .name,
    .detail {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .name {
      font-size: var(--font-size);
    }

    .detail {
      color: var(--text-2);
      font-size: var(--font-size-sm);
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'db-list-item': DbListItem
  }
}
