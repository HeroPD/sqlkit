import { LitElement, css, html, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'
import type { ConnectionProfile, Engine } from '../electron'

const ENGINES: ReadonlyArray<{ engine: Engine; label: string }> = [
  { engine: 'postgresql', label: 'PostgreSQL' },
  { engine: 'mysql', label: 'MySQL' },
  { engine: 'sqlserver', label: 'SQL Server' },
]

// Scoped-down port of the reference config form: connection profile fields
// with save/cancel. Connect/test flows arrive with the database drivers. The
// form edits a local draft and only emits it on save — `config-save` with the
// profile, or `config-cancel`.
@customElement('db-config-form')
export class DbConfigForm extends LitElement {
  @property({ attribute: false })
  profile: ConnectionProfile | null = null

  @state()
  private _draft: ConnectionProfile | null = null

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('profile')) {
      this._draft = this.profile ? { ...this.profile } : null
    }
  }

  render() {
    const draft = this._draft
    if (!draft) return html``

    return html`
      <div class="card">
        <header>
          <h1>${draft.name.trim() || 'New Database'}</h1>
          <p class="muted">Connection settings are saved into this workspace's .sqlkit folder.</p>
        </header>

        <section>
          <div class="section-head">
            <h4>Engine</h4>
            <p class="muted small">Pick the database driver</p>
          </div>
          ${this._field(
            'Driver',
            html`
              <select @change=${(e: Event) => this._patch('engine', (e.target as HTMLSelectElement).value as Engine)}>
                ${ENGINES.map(
                  (entry) => html`
                    <option value=${entry.engine} ?selected=${entry.engine === draft.engine}>${entry.label}</option>
                  `,
                )}
              </select>
            `,
          )}
        </section>

        <section>
          <div class="section-head">
            <h4>Connection</h4>
            <p class="muted small">Server location and credentials</p>
          </div>
          ${this._field('Name', this._input(draft, 'name'), 'Shown in the Databases list.')}
          ${this._field('Host', this._input(draft, 'host'), 'Hostname, IP, or server name.')}
          ${this._field('Port', this._input(draft, 'port'))}
          ${this._field('User', this._input(draft, 'username'))}
          ${this._field('Password', this._input(draft, 'password', 'password'))}
          ${this._field('Database', this._input(draft, 'database'))}
        </section>

        <footer>
          <button class="primary" @click=${this._onSave}>Save</button>
          <button class="secondary" @click=${this._onCancel}>Cancel</button>
        </footer>
      </div>
    `
  }

  private _input(
    draft: ConnectionProfile,
    key: Exclude<keyof ConnectionProfile, 'id' | 'engine'>,
    type: 'text' | 'password' = 'text',
  ) {
    return html`
      <input
        type=${type}
        .value=${draft[key]}
        @input=${(e: Event) => this._patch(key, (e.target as HTMLInputElement).value)}
        autocomplete="off"
        spellcheck="false"
      />
    `
  }

  private _field(label: string, control: TemplateResult, helper = '') {
    return html`
      <div class="field">
        <span class="field-label">${label}</span>
        <div class="field-control">${control}</div>
        ${helper ? html`<div class="field-helper muted small">${helper}</div>` : ''}
      </div>
    `
  }

  private _patch<K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) {
    if (this._draft) this._draft = { ...this._draft, [key]: value }
  }

  private _onSave() {
    if (!this._draft) return
    const profile = { ...this._draft, name: this._draft.name.trim() || 'Untitled' }
    this.dispatchEvent(new CustomEvent('config-save', { detail: { profile }, bubbles: true, composed: true }))
  }

  private _onCancel() {
    this.dispatchEvent(new CustomEvent('config-cancel', { bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    css`
      :host {
        display: block;
      }

      .card {
        width: min(100%, 720px);
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 30px;
        padding: 32px 42px;
        box-sizing: border-box;
      }

      header p {
        margin-top: 6px;
      }

      section {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .section-head {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .field {
        display: grid;
        grid-template-columns: 170px minmax(0, 1fr);
        align-items: start;
        gap: 6px 14px;
      }

      .field-label {
        min-height: var(--control-h);
        display: flex;
        align-items: center;
        justify-content: flex-end;
        font-size: var(--font-size);
        color: var(--text-2);
      }

      .field-control {
        min-width: 0;
      }

      .field-helper {
        grid-column: 2;
        line-height: 1.35;
      }

      footer {
        display: flex;
        gap: 8px;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'db-config-form': DbConfigForm
  }
}
