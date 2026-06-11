import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

// One tab in the editor tab bar. Dispatches `tab-select` on click and
// `tab-close` from the × button, both with { tabId }; the workbench owns the
// tab list and active state.
@customElement('editor-tab')
export class EditorTab extends LitElement {
  @property()
  tabId = ''

  @property()
  name = ''

  @property({ type: Boolean, reflect: true })
  active = false

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onSelect)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener('click', this._onSelect)
  }

  render() {
    return html`
      <span class="label">${this.name}</span>
      <span class="close" title="Close" @click=${this._onClose}>&times;</span>
    `
  }

  private _onSelect = () => {
    this.dispatchEvent(new CustomEvent('tab-select', { detail: { tabId: this.tabId }, bubbles: true, composed: true }))
  }

  private _onClose = (event: Event) => {
    event.stopPropagation()
    this.dispatchEvent(new CustomEvent('tab-close', { detail: { tabId: this.tabId }, bubbles: true, composed: true }))
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      min-width: 100px;
      max-width: 200px;
      font-size: var(--font-size);
      color: var(--tab-inactive-fg);
      background: var(--tab-inactive-bg);
      border-right: 1px solid var(--tab-border);
      cursor: pointer;
      position: relative;
      user-select: none;
    }

    :host(:hover) {
      background: var(--tab-hover-bg);
    }

    :host([active]) {
      color: var(--tab-active-fg);
      background: var(--tab-active-bg);
    }

    :host([active])::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: var(--tab-active-top);
    }

    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .close {
      font-size: 16px;
      line-height: 1;
      color: var(--text-3);
      border-radius: 3px;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .close:hover {
      background: var(--list-hover);
      color: var(--text);
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-tab': EditorTab
  }
}
