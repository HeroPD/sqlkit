import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

// Activity-bar button: an icon (slotted) that selects a sidebar view. It only
// dispatches `activity-select` with its view id; the workbench owns which
// view is active and reflects it back via the `active` property.
@customElement('activity-button')
export class ActivityButton extends LitElement {
  @property({ reflect: true })
  view = ''

  @property({ type: Boolean, reflect: true })
  active = false

  /** Count bubble over the icon (VS Code style); hidden at 0. */
  @property({ type: Number })
  badge = 0

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onClick)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener('click', this._onClick)
  }

  render() {
    return html`
      <slot></slot>
      ${this.badge > 0 ? html`<span class="badge">${this.badge > 9 ? '9+' : this.badge}</span>` : ''}
    `
  }

  private _onClick = () => {
    this.dispatchEvent(
      new CustomEvent('activity-select', { detail: { view: this.view }, bubbles: true, composed: true }),
    )
  }

  static styles = css`
    :host {
      width: var(--activity-bar-w);
      height: var(--activity-bar-w);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--activity-bar-inactive);
      position: relative;
      transition: color 0.1s;
    }

    :host(:hover),
    :host([active]) {
      color: var(--activity-bar-fg);
    }

    .badge {
      position: absolute;
      right: 5px;
      bottom: 5px;
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      box-sizing: border-box;
      border-radius: 7px;
      background: var(--accent);
      color: #fff;
      font-size: 9px;
      font-weight: 600;
      line-height: 14px;
      text-align: center;
      pointer-events: none;
    }

    :host([active])::before {
      content: '';
      position: absolute;
      left: 0;
      top: 8px;
      bottom: 8px;
      width: 2px;
      background: var(--activity-bar-indicator);
      border-radius: 0 1px 1px 0;
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'activity-button': ActivityButton
  }
}
