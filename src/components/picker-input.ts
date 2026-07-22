import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'

export type PickerInputItem = { value: string; detail?: string }

@customElement('picker-input')
export class PickerInput extends LitElement {
  @property()
  value = ''

  @property()
  placeholder = ''

  @property({ type: Boolean })
  multiple = false

  @property({ attribute: false })
  items: PickerInputItem[] = []

  @state() private _open = false
  @state() private _active = 0

  render() {
    const items = this._filtered()
    return html`
      <input
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder=${this.placeholder}
        .value=${this.value}
        @focus=${() => (this._open = true)}
        @blur=${() => setTimeout(() => (this._open = false), 0)}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      />
      ${this._open && items.length
        ? html`<div class="picker" role="listbox">
            ${items.map((item, index) => html`
              <button
                type="button"
                class=${index === this._active ? 'active' : ''}
                @mousedown=${(event: MouseEvent) => {
                  event.preventDefault()
                  this._pick(item.value)
                }}
              >
                <span class="value">${item.value}</span>
                ${item.detail ? html`<span class="detail">${item.detail}</span>` : ''}
              </button>
            `)}
          </div>`
        : ''}
    `
  }

  private _filter() {
    return (this.multiple ? this.value.split(',').at(-1) ?? '' : this.value).trim().toLowerCase()
  }

  private _filtered() {
    const filter = this._filter()
    return this.items.filter((item) => !filter || item.value.toLowerCase().includes(filter)).slice(0, 100)
  }

  private _onInput(event: Event) {
    this.value = (event.target as HTMLInputElement).value
    this._active = 0
    this._open = true
    this._emit()
  }

  private _onKeydown(event: KeyboardEvent) {
    const items = this._filtered()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      this._active = (this._active + step + items.length) % items.length
    } else if (event.key === 'Enter' && this._open && items[this._active]) {
      event.preventDefault()
      this._pick(items[this._active]!.value)
    } else if (event.key === 'Escape' && this._open) {
      event.preventDefault()
      event.stopPropagation()
      this._open = false
    } else if (event.key === ' ' && event.ctrlKey) {
      event.preventDefault()
      this._open = true
    }
  }

  private _pick(value: string) {
    if (this.multiple) {
      const parts = this.value.split(',')
      parts[parts.length - 1] = ` ${value}`
      this.value = parts.join(',').trimStart()
    } else {
      this.value = value
    }
    this._open = false
    this._emit()
  }

  private _emit() {
    this.dispatchEvent(new CustomEvent('value-change', { detail: { value: this.value }, bubbles: true, composed: true }))
  }

  static styles = css`
    :host {
      position: relative;
      display: block;
    }

    input {
      width: 100%;
      height: var(--control-h);
      box-sizing: border-box;
      padding: 0 8px;
      color: var(--input-fg);
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      outline: none;
      font-family: var(--mono-font);
      font-size: var(--font-size);
    }

    input:focus {
      border-color: var(--input-focus-border);
    }

    input::placeholder {
      color: var(--input-placeholder);
    }

    .picker {
      position: absolute;
      z-index: 210;
      top: calc(100% + 2px);
      left: 0;
      width: max(100%, 260px);
      max-height: 220px;
      overflow-y: auto;
      padding: 4px;
      background: var(--overlay-bg);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.28),
        0 1px 3px rgba(0, 0, 0, 0.2);
    }

    button {
      width: 100%;
      min-height: 24px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 3px 7px;
      color: var(--text);
      background: transparent;
      border: 0;
      border-radius: 4px;
      font-family: var(--mono-font);
      text-align: left;
    }

    /* Pointer hover stays neutral; .active (keyboard-tracked) keeps the accent. */
    button:hover {
      background: color-mix(in srgb, var(--text) 9%, transparent);
    }

    button.active {
      color: var(--list-selection-fg);
      background: var(--list-selection);
    }

    .detail {
      overflow: hidden;
      color: var(--text-3);
      font-size: var(--font-size-sm);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'picker-input': PickerInput
  }
}
