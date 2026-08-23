import { LitElement, css, html, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, icons, scrollbars } from '../shared-styles'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_WORKSPACE_PREFERENCES,
  KEYMAP_DEFAULTS,
  SETTING_ACTIONS,
  SETTING_CATEGORIES,
  THEMES,
  fieldsForCategory,
  normalizeAppSettings,
  normalizeWorkspacePreferences,
  type AppSettings,
  type KeymapCommand,
  type KeymapCommandDef,
  type SettingCategory,
  type SettingField,
  type SettingScope,
  type SettingValues,
  type WorkspacePreferences,
} from '../settings'
import type { ThemeId } from '../electron'
import { displayKeybinding, isBindable, keybindingFromEvent } from '../keybindings'
import { t } from '../i18n'

type Row = { scope: SettingScope; key: string; field: SettingField }

// Structural, not JSON: key order must not decide whether "reset to defaults"
// lights up for an object-valued setting.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => sameValue(left[key], right[key]))
}

// Every page is rendered from the setting schema: rows, their controls, the
// search index, "reset to defaults", and the enabled/disabled state all come
// from the field descriptors, so a new option needs no change in here.
@customElement('settings-view')
export class SettingsView extends LitElement {
  @property({ attribute: false })
  settings: AppSettings = DEFAULT_APP_SETTINGS

  @property({ attribute: false })
  workspacePreferences: WorkspacePreferences = DEFAULT_WORKSPACE_PREFERENCES

  @property({ type: Boolean })
  workspaceAvailable = true

  /** The host's fixed chords, so a custom binding can be flagged as shadowing
   * one. Empty by default: the component stands alone without a workbench. */
  @property({ attribute: false })
  reservedBindings: ReadonlyArray<{ binding: string; label: string }> = []

  @state() private _category: SettingCategory = 'general'
  @state() private _filter = ''
  @state() private _capturing: string | null = null
  @state() private _captureHint: string | null = null

  private _valuesFor(scope: SettingScope): Record<string, unknown> {
    return scope === 'app' ? this.settings : this.workspacePreferences
  }

  private _allValues(): SettingValues {
    return { app: this.settings, workspace: this.workspacePreferences }
  }

  private _patch(scope: SettingScope, patch: Record<string, unknown>) {
    if (scope === 'app') {
      const detail = normalizeAppSettings({ ...this.settings, ...patch })
      this.dispatchEvent(new CustomEvent('app-settings-change', { detail, bubbles: true, composed: true }))
      return
    }
    const detail = normalizeWorkspacePreferences({ ...this.workspacePreferences, ...patch })
    this.dispatchEvent(new CustomEvent('workspace-preferences-change', { detail, bubbles: true, composed: true }))
  }

  private _hit(...parts: string[]) {
    if (!this._filter) return true
    return parts.join(' ').toLowerCase().includes(this._filter.toLowerCase())
  }

  private _matches(row: Row) {
    const { field } = row
    if (this._hit(field.label, field.description, field.group, field.keywords ?? '')) return true
    // The keymap row is a list of commands: searching one of them keeps it.
    return field.kind === 'keymap' && field.commands.some((command) => this._hit(command.label, command.description ?? ''))
  }

  private _rows(category: SettingCategory) {
    return fieldsForCategory(category).filter((row) => this._matches(row))
  }

  private _enabled(row: Row) {
    return row.field.enabledWhen?.(this._allValues()) ?? true
  }

  private _isDefault() {
    return fieldsForCategory(this._category).every((row) =>
      sameValue(this._valuesFor(row.scope)[row.key], row.field.default))
  }

  private _reset() {
    for (const scope of ['app', 'workspace'] as const) {
      const patch = Object.fromEntries(
        fieldsForCategory(this._category)
          .filter((row) => row.scope === scope)
          .map((row) => [row.key, row.field.default]),
      )
      if (Object.keys(patch).length) this._patch(scope, patch)
    }
  }

  // --- controls --------------------------------------------------------------

  private _renderToggle(row: Row) {
    const value = this._valuesFor(row.scope)[row.key] === true
    return html`<button
      class="switch"
      role="switch"
      aria-checked=${String(value)}
      aria-label=${row.field.label}
      ?disabled=${!this._enabled(row)}
      @click=${() => this._patch(row.scope, { [row.key]: !value })}
    ></button>`
  }

  private _renderNumber(row: Row) {
    const field = row.field
    if (field.kind !== 'number') return ''
    return html`<input
      class="number"
      type="number"
      min=${field.min}
      max=${field.max}
      aria-label=${field.label}
      ?disabled=${!this._enabled(row)}
      .value=${String(this._valuesFor(row.scope)[row.key])}
      @change=${(event: Event) => {
        const input = event.target as HTMLInputElement
        const raw = Number(input.value)
        const value = Number.isFinite(raw) ? Math.min(field.max, Math.max(field.min, Math.round(raw))) : field.default
        // Re-show the clamped value: Lit skips the DOM write when the property
        // it binds is unchanged, which would leave the rejected text in place.
        input.value = String(value)
        this._patch(row.scope, { [row.key]: value })
      }}
    >`
  }

  private _renderSelect(row: Row) {
    const field = row.field
    if (field.kind !== 'select') return ''
    const current = this._valuesFor(row.scope)[row.key]
    return html`<select
      aria-label=${field.label}
      ?disabled=${!this._enabled(row)}
      @change=${(event: Event) => {
        const picked = (event.target as HTMLSelectElement).value
        const option = field.options.find((candidate) => String(candidate.value) === picked)
        if (option) this._patch(row.scope, { [row.key]: option.value })
      }}
    >
      ${field.options.map((option) => html`<option value=${String(option.value)} .selected=${option.value === current}>${option.label}</option>`)}
    </select>`
  }

  private _renderThemeCards(row: Row) {
    const field = row.field
    if (field.kind !== 'select') return ''
    const current = this._valuesFor(row.scope)[row.key]
    return html`<div class="themes">
      ${field.options.map((option) => {
        const id = option.value as ThemeId
        const [rail, side, editor] = THEMES[id].swatch
        const active = current === id
        return html`
          <button class="theme ${active ? 'active' : ''}" aria-pressed=${String(active)} @click=${() => this._patch(row.scope, { [row.key]: id })}>
            <span class="theme-preview" style=${`--rail:${rail};--side:${side};--editor:${editor}`}><i></i><b></b><em>SELECT<br>FROM</em></span>
            <span>${option.label}</span>${active ? html`<i class="icon icon-check"></i>` : ''}
          </button>
        `
      })}
    </div>`
  }

  private _capture(event: KeyboardEvent, command: string) {
    // Only while this row is capturing: otherwise a keystroke aimed at the app
    // (⌘S, Tab, Enter) would land here and silently rebind the command.
    if (this._capturing !== command) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      this._stopCapture(event.target)
      return
    }
    const binding = keybindingFromEvent(event)
    if (!binding) return
    if (!isBindable(binding)) {
      // Keep waiting rather than storing a bare key that would swallow typing.
      this._captureHint = t('settings.keymap.needsModifier')
      return
    }
    const keymapOverrides = { ...this.settings.keymapOverrides } as Record<string, string>
    if (binding === KEYMAP_DEFAULTS[command as KeymapCommand]) delete keymapOverrides[command]
    else keymapOverrides[command] = binding
    this._stopCapture(event.target)
    this._patch('app', { keymapOverrides })
  }

  private _startCapture(command: string) {
    this._capturing = command
    this._captureHint = null
  }

  private _stopCapture(target: EventTarget | null) {
    this._capturing = null
    this._captureHint = null
    if (target instanceof HTMLElement) target.blur()
  }

  /** The fixed workbench chord a binding would shadow, if any. */
  private _reserved(binding: string) {
    return this.reservedBindings.find((entry) => entry.binding === binding)
  }

  private _renderKeymap(field: SettingField) {
    if (field.kind !== 'keymap') return ''
    const overrides = (this.settings.keymapOverrides ?? {}) as Record<string, string>
    const bindings: Record<string, string> = { ...field.defaults, ...overrides }
    const uses = new Map<string, number>()
    for (const binding of Object.values(bindings)) uses.set(binding, (uses.get(binding) ?? 0) + 1)
    // A filter naming a command narrows the list; one that matched the row
    // itself ("hotkey") leaves every command in place.
    const named = field.commands.filter((command) => this._hit(command.label, command.description ?? ''))
    const visible = named.length ? named : field.commands
    const conflicting = field.commands.filter((command) => (uses.get(bindings[command.id] ?? '') ?? 0) > 1)
    const shadowing = field.commands
      .map((command) => ({ command, reserved: this._reserved(bindings[command.id] ?? '') }))
      .filter((entry) => entry.reserved)
    const groups: Array<{ name: string; commands: KeymapCommandDef[] }> = []
    for (const command of visible) {
      const last = groups[groups.length - 1]
      if (last && last.name === command.group) last.commands.push(command)
      else groups.push({ name: command.group, commands: [command] })
    }
    const keyRow = (command: KeymapCommandDef) => {
      const binding = bindings[command.id] ?? ''
      const capturing = this._capturing === command.id
      const clash = conflicting.includes(command) || !!this._reserved(binding)
      return html`<div class="key-row">
            <div><strong>${command.label}</strong>${command.description ? html`<small>${command.description}</small>` : ''}</div>
            <button
              class="binding ${capturing ? 'capturing' : ''} ${clash ? 'conflict' : ''}"
              aria-label=${command.label}
              @click=${() => this._startCapture(command.id)}
              @blur=${() => { if (this._capturing === command.id) this._stopCapture(null) }}
              @keydown=${(event: KeyboardEvent) => this._capture(event, command.id)}
            >${capturing ? t('settings.keymap.press') : displayKeybinding(binding)}</button>
            <span>${overrides[command.id] === undefined ? t('settings.keymap.default') : t('settings.keymap.custom')}</span>
          </div>`
    }
    return html`
      <p class="group-note">${field.description}</p>
      ${groups.map((group) => html`
        <h4 class="key-group">${group.name}</h4>
        <div class="key-list">${group.commands.map((command) => keyRow(command))}</div>
      `)}
      <div class="key-notes" aria-live="polite">
        ${this._capturing
          ? html`<p class="key-note ${this._captureHint ? 'conflict' : ''}"><i></i>${this._captureHint ?? t('settings.keymap.cancelHint')}</p>`
          : html`
              <p class="key-note ${conflicting.length ? 'conflict' : ''}"><i></i>${
                conflicting.length === 0
                  ? t('settings.keymap.noConflicts')
                  : conflicting.length === 1
                    ? t('settings.keymap.conflictOne')
                    : t('settings.keymap.conflictMany', { count: conflicting.length })
              }</p>
              ${shadowing.map((entry) => html`<p class="key-note conflict"><i></i>${
                t('settings.keymap.reserved', { command: entry.reserved!.label })
              }</p>`)}
            `}
      </div>
    `
  }

  private _renderRow(row: Row): TemplateResult {
    const { field } = row
    if (field.kind === 'keymap') return html`${this._renderKeymap(field)}`
    if (field.kind === 'select' && field.display === 'cards') return html`${this._renderThemeCards(row)}`
    const control =
      field.kind === 'toggle' ? this._renderToggle(row)
        : field.kind === 'number' ? this._renderNumber(row)
          : this._renderSelect(row)
    return html`<div class="setting-row ${this._enabled(row) ? '' : 'off'}">
      <div><strong>${field.label}</strong><small>${field.description}</small></div>
      <div class="control">${control}</div>
    </div>`
  }

  private _renderActions(category: SettingCategory) {
    const actions = SETTING_ACTIONS.filter((action) =>
      action.category === category && this._hit(action.label, action.description))
    return actions.map((action) => html`
      <section class="danger-zone">
        <div class="setting-row">
          <div><strong>${action.label}</strong><small>${action.description}</small></div>
          <div class="control">
            <button
              class="secondary ${action.danger ? 'danger' : ''}"
              @click=${() => this.dispatchEvent(new CustomEvent(action.event, { bubbles: true, composed: true }))}
            >${action.button}</button>
          </div>
        </div>
      </section>
    `)
  }

  private _renderPage(category: SettingCategory) {
    const meta = SETTING_CATEGORIES.find((entry) => entry.id === category)!
    const rows = this._rows(category)
    const actions = this._renderActions(category)
    const groups: Array<{ name: string; rows: Row[] }> = []
    for (const row of rows) {
      const last = groups[groups.length - 1]
      if (last && last.name === row.field.group) last.rows.push(row)
      else groups.push({ name: row.field.group, rows: [row] })
    }
    return html`
      <header class="page-head">
        <div class="page-title">
          <h2>${meta.label}</h2>
          <span class="scope ${meta.scope}">${meta.scope === 'workspace' ? t('settings.scopeWorkspace') : t('settings.scopeApp')}</span>
        </div>
        <p>${meta.description}</p>
      </header>
      ${groups.map((group) => html`<section class="group">
        ${group.rows.every((row) => row.field.kind === 'keymap') ? '' : html`<h3>${group.name}</h3>`}
        ${group.rows.map((row) => this._renderRow(row))}
      </section>`)}
      ${actions}
      ${rows.length || actions.length ? '' : this._renderEmpty()}
    `
  }

  // A filter that matches nothing here often matches another page; name those
  // instead of dead-ending, since the filter is per page.
  private _renderEmpty() {
    const elsewhere = SETTING_CATEGORIES.filter((category) =>
      category.id !== this._category && this._rows(category.id).length)
    return html`<div class="empty">
      <p>${t('settings.noMatch', { query: this._filter })}</p>
      ${elsewhere.length
        ? html`<p class="elsewhere">${elsewhere.map((category) => html`<button @click=${() => { this._category = category.id }}>${category.label}</button>`)}</p>`
        : ''}
    </div>`
  }

  render() {
    const meta = SETTING_CATEGORIES.find((entry) => entry.id === this._category)!
    const locked = (category: (typeof SETTING_CATEGORIES)[number]) =>
      category.scope === 'workspace' && !this.workspaceAvailable
    return html`
      <aside class="nav">
        <header>${t('settings.title')}</header>
        <div class="categories">
          ${SETTING_CATEGORIES.map((category) => html`
            <button
              class=${this._category === category.id ? 'active' : ''}
              ?disabled=${locked(category)}
              title=${locked(category) ? t('settings.workspaceRequired') : ''}
              @click=${() => { this._category = category.id; this._filter = '' }}
            ><i class="icon icon-${category.icon}"></i><span>${category.label}</span></button>
          `)}
        </div>
        <p>${t('settings.navNote')}</p>
      </aside>
      <section class="content">
        <header class="toolbar">
          <strong>${meta.label}</strong>
          <button class="reset" ?disabled=${this._isDefault()} @click=${this._reset}>${t('settings.reset')}</button>
          <label class="search">
            <i class="icon icon-search"></i>
            <input
              type="search"
              placeholder=${this._category === 'keymap' ? t('settings.filterCommands') : t('settings.filter', { name: meta.label })}
              .value=${this._filter}
              @input=${(event: Event) => { this._filter = (event.target as HTMLInputElement).value }}
            >
          </label>
          <button class="close" aria-label=${t('settings.close')} @click=${() => this.dispatchEvent(new CustomEvent('settings-close', { bubbles: true, composed: true }))}>
            <i class="icon icon-x"></i>
          </button>
        </header>
        <div class="scroll">${this._renderPage(this._category)}</div>
      </section>
    `
  }

  static styles = [icons, controls, scrollbars, css`
    :host { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: 232px minmax(0, 1fr); background: var(--editor-bg); color: var(--text); font: var(--font-size)/1.4 var(--ui-font); }
    button, input, select { font: inherit; }
    .nav { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--sidebar-bg); border-right: 1px solid var(--border-subtle); }
    .nav header { height: 46px; display: flex; align-items: center; padding: 0 14px; color: var(--text-2); border-bottom: 1px solid var(--border-subtle); font-size: 11px; font-weight: 650; letter-spacing: .065em; text-transform: uppercase; }
    .categories { flex: 1; min-height: 0; overflow: auto; padding: 7px; }
    .categories button { width: 100%; height: 36px; display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: center; gap: 8px; padding: 0 10px; color: var(--text-2); text-align: left; background: transparent; border: 0; border-radius: 4px; font-size: 14px; }
    .categories button:hover { color: var(--text); background: var(--list-hover); }
    .categories button.active { color: var(--list-selection-fg); background: var(--list-selection); }
    .categories button:disabled { color: color-mix(in srgb, var(--text-3) 45%, transparent); background: transparent; }
    .categories .icon { font-size: 15px; }
    .nav > p { margin: 8px 12px; padding-top: 12px; color: var(--text-3); border-top: 1px solid var(--border-subtle); font-size: 12px; line-height: 1.5; }
    .content { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .toolbar { height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 16px 0 24px; border-bottom: 1px solid var(--border-subtle); }
    .toolbar > strong { min-width: 120px; font-size: 14px; font-weight: 550; }
    .reset, .secondary { height: 28px; padding: 0 10px; color: var(--text-2); background: transparent; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
    .reset:hover:not(:disabled), .secondary:hover { color: var(--text); background: var(--list-hover); }
    .reset:disabled { color: color-mix(in srgb, var(--text-3) 50%, transparent); border-color: var(--border-subtle); }
    .search { position: relative; width: min(340px, 42vw); margin-left: auto; }
    .search .icon { position: absolute; left: 9px; top: 7px; color: var(--text-3); font-size: 14px; }
    .search input { width: 100%; height: 30px; padding: 0 9px 0 29px; color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 4px; outline: 0; font-size: 13px; }
    .search input:focus { border-color: var(--focus-border); }
    .close { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; color: var(--text-3); background: transparent; border: 0; border-radius: 4px; }
    .close:hover { color: var(--text); background: var(--list-hover); }
    .scroll { flex: 1; overflow: auto; }
    .scroll > * { width: min(750px, calc(100% - 64px)); margin-inline: auto; }
    .page-head { padding-top: 26px; margin-bottom: 24px; }
    .page-title { display: flex; align-items: center; gap: 9px; margin-bottom: 5px; }
    .page-title h2 { margin: 0; font-size: var(--font-size-xl); font-weight: 560; }
    .page-head p { margin: 0; color: var(--text-3); font-size: 13px; }
    .scope { padding: 2px 5px; color: var(--text-3); background: var(--input-bg); border: 1px solid var(--border-subtle); border-radius: 3px; font-size: 8px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
    .scope.workspace { color: color-mix(in srgb, var(--accent) 55%, var(--text)); }
    .group { margin-top: 28px; margin-bottom: 38px; }
    .group > h3 { display: flex; align-items: center; gap: 9px; margin: 0 0 9px; color: var(--text-2); font-size: 11px; font-weight: 650; letter-spacing: .065em; text-transform: uppercase; }
    .group > h3::after { content: ''; height: 1px; flex: 1; background: var(--border-subtle); }
    .setting-row { min-height: 55px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 28px; padding: 9px 2px; border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent); }
    .setting-row:last-child { border-bottom: 0; }
    .setting-row.off strong, .setting-row.off small { opacity: .55; }
    .setting-row strong, .setting-row small { display: block; }
    .setting-row strong { font-size: 14px; font-weight: 500; }
    .setting-row small { margin-top: 3px; color: var(--text-3); font-size: 12px; line-height: 1.4; }
    .control select, .number { height: 30px; color: var(--input-fg); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 4px; font-size: 13px; }
    .control select { min-width: 150px; padding: 0 28px 0 9px; }
    .control :disabled { opacity: .5; }
    .number { width: 92px; padding: 0 9px; text-align: right; }
    .switch { position: relative; width: 32px; height: 18px; padding: 0; background: var(--border); border: 1px solid color-mix(in srgb, var(--border) 70%, var(--text)); border-radius: 999px; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; background: var(--text-2); border-radius: 50%; transition: 120ms ease; }
    .switch[aria-checked='true'] { background: var(--accent); border-color: var(--accent); }
    .switch[aria-checked='true']::after { left: 16px; background: var(--on-accent); }
    .themes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .theme { position: relative; padding: 5px; color: var(--text-2); text-align: left; background: transparent; border: 1px solid var(--border-subtle); border-radius: 5px; }
    .theme:hover { border-color: var(--border); }
    .theme.active { color: var(--text); border-color: var(--accent); }
    .theme > .icon { position: absolute; top: 9px; right: 9px; width: 16px; height: 16px; display: grid; place-items: center; color: white; background: var(--accent); border-radius: 50%; font-size: 10px; }
    .theme-preview { height: 63px; display: grid; grid-template-columns: 17px 34px 1fr; margin-bottom: 6px; overflow: hidden; background: var(--editor); border-radius: 3px; }
    .theme-preview > i { background: var(--rail); }.theme-preview > b { background: var(--side); }.theme-preview > em { padding: 14px 6px; color: #a163b5; font: 5px/1.8 var(--mono-font); font-style: normal; }
    .theme > span:nth-child(2) { padding: 0 2px 2px; font-size: 12px; }
    .group-note { margin: 0 0 10px; color: var(--text-3); font-size: 12px; }
    .key-group { margin: 18px 0 7px; color: var(--text-2); font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; }
    .key-group:first-of-type { margin-top: 0; }
    .key-list { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 5px; }
    .key-row { min-height: 48px; display: grid; grid-template-columns: minmax(180px, 1fr) 140px 64px; align-items: center; gap: 12px; padding: 5px 10px; border-bottom: 1px solid var(--border-subtle); }
    .key-row:last-child { border-bottom: 0; }.key-row strong,.key-row small { display:block; }.key-row strong { font-size: 14px; font-weight: 500; }.key-row small { margin-top: 2px; color: var(--text-3); font-size: 12px; }.key-row > span { color: var(--text-3); font-size: 12px; }
    .binding { min-width: 76px; min-height: 27px; justify-self: start; padding: 3px 6px; color: var(--text-2); background: var(--activity-bar-bg); border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
    .binding:hover { color: var(--text); border-color: var(--focus-border); }
    .binding.capturing { color: color-mix(in srgb, var(--accent) 55%, var(--text)); border-color: var(--accent); }
    .binding.conflict { color: var(--status-dot-warning); border-color: color-mix(in srgb, var(--status-dot-warning) 55%, var(--border)); }
    .key-notes { margin-top: 10px; }
    .key-note { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; color: var(--text-3); font-size: 12px; }.key-note i { width: 6px; height: 6px; background: var(--status-dot-connected); border-radius: 50%; }.key-note.conflict { color: var(--status-dot-warning); }.key-note.conflict i { background: var(--status-dot-warning); }
    .danger-zone { margin-top: 16px; padding: 8px 13px; background: color-mix(in srgb, var(--status-dot-error) 5%, transparent); border: 1px solid color-mix(in srgb, var(--status-dot-error) 18%, transparent); border-radius: 5px; }
    .danger-zone .setting-row { border: 0; }.danger:hover { color: var(--status-dot-error); }
    .empty { margin-top: 28px; padding: 22px; color: var(--text-3); border: 1px dashed var(--border); border-radius: 5px; font-size: 14px; text-align: center; }
    .empty p { margin: 0; }
    .empty .elsewhere { margin-top: 10px; display: flex; gap: 8px; justify-content: center; }
    .empty .elsewhere button { height: 26px; padding: 0 9px; color: var(--text-2); background: transparent; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; }
    .empty .elsewhere button:hover { color: var(--text); background: var(--list-hover); }
    @media (max-width: 1000px) { :host { grid-template-columns: 200px minmax(0,1fr); }.themes { grid-template-columns: repeat(2,1fr); }.scroll > * { width: calc(100% - 40px); } }
  `]
}

declare global { interface HTMLElementTagNameMap { 'settings-view': SettingsView } }
