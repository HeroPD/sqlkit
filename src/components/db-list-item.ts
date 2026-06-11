import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { codicons } from '../shared-styles'
import type { ConnectionPhase, Engine } from '../electron'
import './engine-badge'

// One row in the Databases sidebar list. Dispatches `db-select` with its
// profile id; the workbench decides what selecting it means (open the form).
// The plug action dispatches `db-connect` / `db-disconnect`; the status dot
// mirrors the live connection phase pushed from the main process.
@customElement('db-list-item')
export class DbListItem extends LitElement {
  @property()
  dbId = ''

  @property()
  name = ''

  @property()
  detail = ''

  @property()
  engine: Engine | '' = ''

  @property({ reflect: true })
  status: ConnectionPhase | '' = ''

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
    const live = this.status === 'connected' || this.status === 'connecting'
    return html`
      <span class="icon">
        <engine-badge engine=${this.engine}></engine-badge>
        <span class="dot"></span>
      </span>
      <span class="meta">
        <span class="name">${this.name}</span>
        <span class="detail">${this.detail}</span>
      </span>
      <button
        class="action"
        title=${live ? 'Disconnect' : 'Connect'}
        aria-label=${live ? 'Disconnect' : 'Connect'}
        @click=${this._onToggleConnection}
      >
        ${this.status === 'connecting'
          ? html`<i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>`
          : html`<i class="codicon ${live ? 'codicon-debug-disconnect' : 'codicon-plug'}" aria-hidden="true"></i>`}
      </button>
    `
  }

  private _onToggleConnection = (event: Event) => {
    event.stopPropagation()
    const live = this.status === 'connected' || this.status === 'connecting'
    const type = live ? 'db-disconnect' : 'db-connect'
    this.dispatchEvent(new CustomEvent(type, { detail: { id: this.dbId }, bubbles: true, composed: true }))
  }

  private _onSelect = () => {
    this.dispatchEvent(new CustomEvent('db-select', { detail: { id: this.dbId }, bubbles: true, composed: true }))
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    this._onSelect()
  }

  static styles = [
    codicons,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
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
        position: relative;
        display: flex;
        flex-shrink: 0;
      }

      .dot {
        display: none;
        position: absolute;
        right: -2px;
        bottom: -2px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1px solid var(--sidebar-bg);
        box-sizing: border-box;
      }

      :host([status='connected']) .dot {
        display: block;
        background: var(--status-dot-connected);
      }

      :host([status='error']) .dot {
        display: block;
        background: var(--status-dot-error);
      }

      .meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
      }

      .name,
      .detail {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.3;
      }

      .name {
        font-size: var(--font-size);
      }

      .detail {
        color: var(--text-2);
        font-size: var(--font-size-sm);
      }

      :host([status='error']) .detail {
        color: var(--status-dot-error);
      }

      .action {
        display: none;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        flex-shrink: 0;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--text-2);
        cursor: pointer;
      }

      :host(:hover) .action,
      :host([status='connecting']) .action,
      .action:focus-visible {
        display: flex;
      }

      .action:hover {
        background: var(--btn-secondary-hover);
        color: var(--text);
      }

      .action .codicon {
        font-size: 14px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'db-list-item': DbListItem
  }
}
