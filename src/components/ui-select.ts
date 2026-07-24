import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { ifDefined } from 'lit/directives/if-defined.js'
import { icons, popover, scrollbars } from '../shared-styles'

export type UiSelectOption = { value: string; label?: string; disabled?: boolean }

// Custom themed replacement for native <select>: an input-styled trigger plus
// the app's standard popover listbox (select-only combobox pattern — focus
// stays on the trigger, the active option tracks via aria-activedescendant).
// Emits `change` with { value } on pick. Closed plain ArrowUp/Down is left to
// bubble so form-level field navigation (db-config-form) keeps working.
@customElement('ui-select')
export class UiSelect extends LitElement {
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true }

  @property()
  value = ''

  @property({ attribute: false })
  options: UiSelectOption[] = []

  @property({ type: Boolean, reflect: true })
  disabled = false

  @property()
  label = ''

  @state() private _open = false
  @state() private _active = 0
  // null until the menu has been measured; flip direction decides then.
  @state() private _pos: { left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null = null

  private _typeahead = ''
  private _typeaheadAt = 0

  render() {
    const selected = this.options.find((option) => option.value === this.value)
    return html`
      <button
        type="button"
        class="trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded=${this._open ? 'true' : 'false'}
        aria-controls="listbox"
        aria-activedescendant=${this._open ? `option-${this._active}` : ''}
        aria-label=${ifDefined(this.label || undefined)}
        ?disabled=${this.disabled}
        @click=${this._toggle}
        @keydown=${this._onKeydown}
      >
        <span class="trigger-label">${selected ? selected.label ?? selected.value : this.value}</span>
        <i class="icon icon-chevron-down" aria-hidden="true"></i>
      </button>
      ${this._open ? this._renderMenu() : ''}
    `
  }

  private _renderMenu() {
    const pos = this._pos
    const style = pos
      ? `left:${pos.left}px;min-width:${pos.width}px;max-height:${pos.maxHeight}px;` +
        (pos.top !== undefined ? `top:${pos.top}px;` : `bottom:${pos.bottom}px;`)
      : 'visibility:hidden;top:0;left:0;'
    return html`
      <div class="pop-backdrop" @mousedown=${this._close}></div>
      <div class="pop" id="listbox" role="listbox" aria-label=${this.label} style=${style}>
        ${this.options.map(
          (option, index) => html`
            <button
              type="button"
              class="pop-item ${index === this._active ? 'active' : ''}"
              id="option-${index}"
              role="option"
              aria-selected=${option.value === this.value ? 'true' : 'false'}
              ?disabled=${option.disabled ?? false}
              @mouseenter=${() => (this._active = index)}
              @mousedown=${(event: MouseEvent) => event.preventDefault()}
              @click=${() => this._pick(index)}
            >
              <span class="check" aria-hidden="true">${option.value === this.value ? '✓' : ''}</span>
              <span class="label">${option.label ?? option.value}</span>
            </button>
          `,
        )}
      </div>
    `
  }

  updated() {
    if (!this._open) return
    // First open pass renders hidden; measure the menu, then place it.
    if (!this._pos) this._place()
    this.renderRoot.querySelector('.pop-item.active')?.scrollIntoView({ block: 'nearest' })
  }

  private _place() {
    const trigger = this.renderRoot.querySelector('.trigger')
    const pop = this.renderRoot.querySelector('.pop')
    if (!trigger || !pop) return
    const rect = trigger.getBoundingClientRect()
    const menuHeight = pop.getBoundingClientRect().height
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const openUp = below < menuHeight && above > below
    this._pos = {
      left: Math.max(6, Math.min(rect.left, window.innerWidth - rect.width - 6)),
      width: rect.width,
      maxHeight: Math.min(320, (openUp ? above : below) - 4),
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    }
  }

  private _toggle() {
    if (this._open) this._close()
    else this._openMenu()
  }

  private _openMenu() {
    if (this.disabled || !this.options.length) return
    const selected = this.options.findIndex((option) => option.value === this.value && !option.disabled)
    this._active = selected >= 0 ? selected : this._firstEnabled(0, 1)
    this._pos = null
    this._open = true
    window.addEventListener('resize', this._close)
    window.addEventListener('blur', this._close)
  }

  private _close = () => {
    this._open = false
    window.removeEventListener('resize', this._close)
    window.removeEventListener('blur', this._close)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._close()
  }

  private _firstEnabled(from: number, step: 1 | -1) {
    for (let i = from; i >= 0 && i < this.options.length; i += step) {
      if (!this.options[i]!.disabled) return i
    }
    return from
  }

  private _step(step: 1 | -1) {
    let index = this._active
    do index += step
    while (index >= 0 && index < this.options.length && this.options[index]!.disabled)
    if (index >= 0 && index < this.options.length) this._active = index
  }

  private _onKeydown(event: KeyboardEvent) {
    if (!this._open) {
      // Plain arrows bubble on purpose: forms use them for field navigation.
      if (event.key === 'Enter' || event.key === ' ' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))) {
        event.preventDefault()
        event.stopPropagation()
        this._openMenu()
      }
      return
    }

    if (event.key === 'Tab') {
      this._close()
      return
    }
    event.stopPropagation()
    if (event.key === 'ArrowDown') this._step(1)
    else if (event.key === 'ArrowUp') this._step(-1)
    else if (event.key === 'Home') this._active = this._firstEnabled(0, 1)
    else if (event.key === 'End') this._active = this._firstEnabled(this.options.length - 1, -1)
    else if (event.key === 'Enter' || event.key === ' ') this._pick(this._active)
    else if (event.key === 'Escape') this._close()
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this._typeaheadJump(event.key)
      return
    } else return
    event.preventDefault()
  }

  private _typeaheadJump(char: string) {
    const now = Date.now()
    this._typeahead = now - this._typeaheadAt > 600 ? char.toLowerCase() : this._typeahead + char.toLowerCase()
    this._typeaheadAt = now
    const match = this.options.findIndex(
      (option) => !option.disabled && (option.label ?? option.value).toLowerCase().startsWith(this._typeahead),
    )
    if (match >= 0) this._active = match
  }

  private _pick(index: number) {
    const option = this.options[index]
    if (!option || option.disabled) return
    this._close()
    if (option.value !== this.value) {
      this.value = option.value
      this.dispatchEvent(new CustomEvent('change', { detail: { value: option.value }, bubbles: true, composed: true }))
    }
    this.renderRoot.querySelector<HTMLButtonElement>('.trigger')?.focus()
  }

  static styles = [
    ...icons,
    scrollbars,
    popover,
    css`
      :host {
        display: block;
        min-width: 0;
      }

      :host([disabled]) {
        pointer-events: none;
      }

      /* Trigger mirrors the shared \`controls\` input look. */
      .trigger {
        width: 100%;
        height: var(--control-h);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 10px 0 12px;
        font-size: var(--font-size);
        font-family: var(--ui-font);
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: 6px;
        box-sizing: border-box;
        outline: none;
        cursor: pointer;
        text-align: left;
      }

      .trigger:focus-visible,
      .trigger[aria-expanded='true'] {
        border-color: var(--input-focus-border);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--input-focus-border) 35%, transparent);
      }

      .trigger:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .trigger-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .trigger .icon {
        flex-shrink: 0;
        font-size: 14px;
        color: var(--text-3);
      }

      /* Above dialog backdrops (z-100), matching picker-input. */
      .pop-backdrop {
        z-index: 209;
      }

      .pop {
        z-index: 210;
        max-width: min(420px, calc(100vw - 12px));
      }

      /* Keyboard-tracked row: a notch above hover, matching the command palette. */
      .pop-item.active {
        background: color-mix(in srgb, var(--text) 12%, transparent);
      }

      .pop-item:disabled {
        color: var(--text-3);
        cursor: not-allowed;
        background: transparent;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'ui-select': UiSelect
  }
}
