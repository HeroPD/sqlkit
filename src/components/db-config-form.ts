import { LitElement, css, html, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'
import { UiSelect } from './ui-select'
import type { ConnectionProfile, DatabaseMode, Engine, EngineFlavor, SshAuthType, SshConfig, SslConfig, SslMode } from '../electron'
import { connectionUrlFromProfile, profileFromConnectionUrl } from '../connection-url'
import { CONNECTION_LABEL_COLORS } from '../connection-label-colors'
import { t } from '../i18n'

// Verified wire-compatible variants (Supabase, MariaDB) ride their parent
// engine's driver, distinguished only by `flavor`. Roadmapped engines are
// listed disabled and stay out of the Engine type until a driver exists.
type EngineOption = { id: string; engine?: Engine; flavor?: EngineFlavor; label: string; disabled?: boolean }
const ENGINES: ReadonlyArray<EngineOption> = [
  { id: 'postgresql', engine: 'postgresql', label: 'PostgreSQL' },
  { id: 'mysql', engine: 'mysql', label: 'MySQL' },
  { id: 'sqlite', engine: 'sqlite', label: 'SQLite' },
  { id: 'sqlserver', engine: 'sqlserver', label: 'SQL Server' },
  { id: 'supabase', engine: 'postgresql', flavor: 'supabase', label: 'Supabase (Postgres)' },
  { id: 'mariadb', engine: 'mysql', flavor: 'mariadb', label: 'MariaDB (MySQL)' },
  { id: 'clickhouse', label: `ClickHouse (${t('config.comingSoon')})`, disabled: true },
  { id: 'oracle', label: `Oracle (${t('config.comingSoon')})`, disabled: true },
]

const DEFAULT_PORTS: Partial<Record<Engine, string>> = {
  postgresql: '5432',
  mysql: '3306',
  sqlserver: '1433',
}
const SAVED_SECRET_MASK = '••••••••'

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; message: string }
  | { phase: 'error'; message: string }

const defaultSsh = (): SshConfig => ({
  enabled: false,
  host: '',
  port: '22',
  username: '',
  authType: 'key',
  password: '',
  keyPath: '~/.ssh/id_ed25519',
  passphrase: '',
})

const defaultSsl = (): SslConfig => ({
  mode: 'disable',
  ca: '',
})

// Connection profile fields with test/save/cancel. The form is controlled:
// the draft lives in the owner (the workbench's tab), each edit emits
// `config-change` with the updated profile, and `config-save` /
// `config-cancel` carry the commit/discard intents. Test Connection runs
// against the current draft, saved or not.
@customElement('db-config-form')
export class DbConfigForm extends LitElement {
  @property({ attribute: false })
  profile: ConnectionProfile | null = null

  @state()
  private _test: TestState = { phase: 'idle' }

  @state()
  private _sshTest: TestState = { phase: 'idle' }

  // Raw URL text while the user edits it; null shows the URL derived from the fields.
  @state()
  private _urlDraft: string | null = null

  @state()
  private _urlError = ''

  // The form element is reused across connections (one instance, swapped
  // `profile`), so transient test/URL feedback must clear when the connection
  // changes — otherwise one connection shows the previous one's error.
  private _shownProfileId: string | null = null

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has('profile') && (this.profile?.id ?? null) !== this._shownProfileId) {
      this._shownProfileId = this.profile?.id ?? null
      this._test = { phase: 'idle' }
      this._sshTest = { phase: 'idle' }
      this._urlDraft = null
      this._urlError = ''
    }
  }

  render() {
    const draft = this.profile
    if (!draft) return html``

    return html`
      <div class="card" @keydown=${this._onFieldKeydown}>
        <header>
          <h1>${draft.name.trim() || t('config.newDatabase')}</h1>
          <p class="muted">${t('config.savedLocation')}</p>
        </header>

        <section>
          <div class="section-head">
            <h4>${t('config.engine')}</h4>
            <p class="muted small">${t('config.engineHelp')}</p>
          </div>
          ${this._field(
            t('config.driver'),
            html`
              <ui-select
                .value=${draft.flavor ?? draft.engine}
                .options=${ENGINES.map((entry) => ({ value: entry.id, label: entry.label, disabled: entry.disabled }))}
                @change=${(e: CustomEvent<{ value: string }>) => this._onEngineChange(e.detail.value)}
              ></ui-select>
            `,
          )}
        </section>

        ${this._appearanceSection(draft)}
        ${draft.engine === 'sqlite' ? this._sqliteSection(draft) : this._serverSection(draft)}
        ${draft.engine === 'sqlite' ? '' : this._sslSection(draft)}
        ${draft.engine === 'sqlite' ? '' : this._sshSection(draft)}

        <footer>
          <button class="primary" @click=${this._onSave}>${t('common.save')}</button>
          <button class="secondary" @click=${this._onCancel}>${t('common.cancel')}</button>
          <span class="spacer"></span>
          <span class="test-result ${this._test.phase}" title=${'message' in this._test ? this._test.message : ''}>
            ${'message' in this._test ? this._test.message : ''}
          </span>
          <button class="secondary" @click=${this._onTest} ?disabled=${this._test.phase === 'testing'}>
            ${this._test.phase === 'testing' ? t('config.testing') : t('config.testConnection')}
          </button>
        </footer>
      </div>
    `
  }

  private _appearanceSection(draft: ConnectionProfile) {
    return html`
      <section>
        <div class="section-head">
          <h4>${t('config.appearance')}</h4>
          <p class="muted small">${t('config.appearanceHelp')}</p>
        </div>
        ${this._field(
          t('config.labelColor'),
          html`
            <div class="label-colors" role="radiogroup" aria-label=${t('config.labelColor')}>
              <button
                type="button"
                class="label-color-none ${draft.labelColor ? '' : 'selected'}"
                role="radio"
                aria-checked=${String(!draft.labelColor)}
                title=${t('config.noLabelColor')}
                @click=${() => this._patch({ labelColor: undefined })}
              >
                <span aria-hidden="true"></span>
              </button>
              ${CONNECTION_LABEL_COLORS.map((color) => html`
                <button
                  type="button"
                  class="label-color ${draft.labelColor === color.id ? 'selected' : ''}"
                  style="--label-color: ${color.value}"
                  role="radio"
                  aria-checked=${String(draft.labelColor === color.id)}
                  aria-label=${color.label}
                  title=${color.label}
                  @click=${() => this._patch({ labelColor: color.id })}
                >
                  <span aria-hidden="true"></span>
                </button>
              `)}
            </div>
          `,
          t('config.labelColorHelp'),
        )}
      </section>
    `
  }

  private _serverSection(draft: ConnectionProfile) {
    return html`
      <section>
        <div class="section-head">
          <h4>${t('config.connection')}</h4>
          <p class="muted small">${t('config.connectionHelp')}</p>
        </div>
        ${this._field(
          t('config.connectionUrl'),
          html`
            <input
              type="text"
              placeholder="postgresql://user:password@host/database"
              .value=${this._urlDraft ?? connectionUrlFromProfile(draft)}
              @input=${(e: Event) => this._onUrlInput((e.target as HTMLInputElement).value)}
              @blur=${this._onUrlBlur}
              autocomplete="off"
              spellcheck="false"
            />
          `,
          this._urlError || t('config.urlHelp'),
        )}
        ${this._field(t('config.name'), this._input(draft, 'name'), t('config.nameHelp'))}
        ${this._field(t('config.host'), this._input(draft, 'host'), t('config.hostHelp'))}
        ${this._field(t('config.port'), this._input(draft, 'port'))}
        ${this._field(t('config.user'), this._input(draft, 'username'))}
        ${this._field(
          t('config.password'),
          this._input(draft, 'password', 'password'),
          draft.passwordSaved ? t('config.passwordSaved') : '',
        )}
        ${this._field(t('config.database'), this._input(draft, 'database'))}
        ${this._field(
          t('config.mode'),
          html`
            <ui-select
              .value=${draft.databaseMode ?? 'single'}
              .options=${[
                { value: 'single', label: t('config.singleDatabase') },
                { value: 'all', label: t('config.allDatabases') },
              ]}
              @change=${(e: CustomEvent<{ value: string }>) => this._patch({ databaseMode: e.detail.value as DatabaseMode })}
            ></ui-select>
          `,
          t('config.allDatabasesHelp'),
        )}
      </section>
    `
  }

  private _sqliteSection(draft: ConnectionProfile) {
    return html`
      <section>
        <div class="section-head">
          <h4>${t('config.connection')}</h4>
          <p class="muted small">${t('config.fileHelp')}</p>
        </div>
        ${this._field(t('config.name'), this._input(draft, 'name'), t('config.nameHelp'))}
        ${this._field(
          t('config.file'),
          html`
            <div class="file-row">
              ${this._input(draft, 'file')}
              <button class="secondary" @click=${this._onBrowse}>${t('config.browse')}</button>
            </div>
          `,
          t('config.filePathHelp'),
        )}
      </section>
    `
  }

  private _sslSection(draft: ConnectionProfile) {
    const ssl = draft.ssl ?? defaultSsl()
    return html`
      <section>
        <div class="section-head">
          <h4>${t('config.sslTitle')}</h4>
          <p class="muted small">${t('config.sslHelp')}</p>
        </div>
        ${this._field(
          t('config.mode'),
          html`
            <ui-select
              .value=${ssl.mode}
              .options=${[
                { value: 'disable', label: t('config.disable') },
                { value: 'require', label: t('config.requireEncryption') },
                { value: 'verify-ca', label: t('config.verifyCa'), disabled: draft.engine === 'sqlserver' },
                { value: 'verify-full', label: t('config.verifyFull') },
              ]}
              @change=${(e: CustomEvent<{ value: string }>) => this._patchSsl(ssl, { mode: e.detail.value as SslMode })}
            ></ui-select>
          `,
          ssl.mode === 'require' ? '' : t('config.verifyFullHelp'),
        )}
        ${ssl.mode === 'require'
          ? html`<p class="ssl-warning" role="alert">
              <span aria-hidden="true">⚠</span>
              <span
                ><strong>${t('config.requireWarningStrong')}</strong>${t('config.requireWarningTail')}</span
              >
            </p>`
          : ''}
        ${ssl.mode === 'verify-ca' || ssl.mode === 'verify-full'
          ? this._field(t('config.caCertificate'), this._sslInput(ssl, 'ca'), t('config.caHelp'))
          : ''}
      </section>
    `
  }

  private _sslInput(ssl: SslConfig, key: keyof Pick<SslConfig, 'ca'>) {
    return html`
      <input
        type="text"
        .value=${ssl[key]}
        @input=${(e: Event) => this._patchSsl(ssl, { [key]: (e.target as HTMLInputElement).value })}
        autocomplete="off"
        spellcheck="false"
      />
    `
  }

  private _patchSsl(current: SslConfig, partial: Partial<SslConfig>) {
    this._patch({ ssl: { ...current, ...partial } })
  }

  private _onFieldKeydown(event: KeyboardEvent) {
    // ui-select opens itself on Enter and swallows its arrows while open.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof UiSelect)) return

    const controls = [...this.renderRoot.querySelectorAll<HTMLInputElement | UiSelect>('.field-control input, .field-control ui-select')]
      .filter((control) => !control.disabled && control.getClientRects().length > 0)
    const index = controls.indexOf(target)
    if (index < 0) return

    event.preventDefault()
    const next = controls[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    next.focus()
    if (next instanceof HTMLInputElement && next.type !== 'checkbox') next.select()
  }

  private _sshSection(draft: ConnectionProfile) {
    const ssh = draft.ssh ?? defaultSsh()
    return html`
      <section>
        <div class="section-head">
          <h4>${t('config.sshTunnel')}</h4>
          <p class="muted small">${t('config.sshHelp')}</p>
        </div>
        ${this._field(
          t('config.tunnel'),
          html`
            <label class="toggle">
              <input
                type="checkbox"
                .checked=${ssh.enabled}
                @change=${(e: Event) => this._patchSsh(ssh, { enabled: (e.target as HTMLInputElement).checked })}
              />
              <span>${t('config.tunnelToggle')}</span>
            </label>
          `,
        )}
        ${ssh.enabled ? this._sshFields(ssh) : ''}
      </section>
    `
  }

  private _sshFields(ssh: SshConfig) {
    return html`
      ${this._field(t('config.sshHost'), this._sshInput(ssh, 'host'), t('config.sshHostHelp'))}
      ${this._field(t('config.sshPort'), this._sshInput(ssh, 'port'))}
      ${this._field(t('config.sshUser'), this._sshInput(ssh, 'username'))}
      ${this._field(
        t('config.authMethod'),
        html`
          <ui-select
            .value=${ssh.authType}
            .options=${[
              { value: 'key', label: t('config.privateKey') },
              { value: 'password', label: t('config.password') },
            ]}
            @change=${(e: CustomEvent<{ value: string }>) => this._patchSsh(ssh, {
              authType: e.detail.value as SshAuthType,
              passwordSaved: false,
              passphraseSaved: false,
            })}
          ></ui-select>
        `,
      )}
      ${ssh.authType === 'key'
        ? html`
            ${this._field(t('config.keyPath'), this._sshInput(ssh, 'keyPath'), t('config.keyPathHelp'))}
            ${this._field(t('config.passphrase'), this._sshInput(ssh, 'passphrase', 'password'), t('config.passphraseHelp'))}
          `
        : this._field(t('config.sshPassword'), this._sshInput(ssh, 'password', 'password'))}
      ${this._field(
        '',
        html`
          <div class="test-row">
            <button class="secondary" @click=${this._onTestSsh} ?disabled=${this._sshTest.phase === 'testing'}>
              ${this._sshTest.phase === 'testing' ? t('config.testing') : t('config.testSsh')}
            </button>
            <span class="test-result ${this._sshTest.phase}" title=${'message' in this._sshTest ? this._sshTest.message : ''}>
              ${'message' in this._sshTest ? this._sshTest.message : ''}
            </span>
          </div>
        `,
      )}
    `
  }

  private _sshInput(
    ssh: SshConfig,
    key: Exclude<keyof SshConfig, 'enabled' | 'authType' | 'passwordSaved' | 'passphraseSaved'>,
    type: 'text' | 'password' = 'text',
  ) {
    return html`
      <input
        type=${type}
        .value=${ssh[key]}
        placeholder=${type === 'password' && (key === 'password' ? ssh.passwordSaved : ssh.passphraseSaved)
          ? SAVED_SECRET_MASK
          : ''}
        @input=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value
          const targetChanged = key === 'host' || key === 'port' || key === 'username' || key === 'keyPath'
          const marker = key === 'password'
            ? { passwordSaved: false }
            : key === 'passphrase'
              ? { passphraseSaved: false }
              : targetChanged
                ? { passwordSaved: false, passphraseSaved: false }
                : {}
          this._patchSsh(ssh, { [key]: value, ...marker })
        }}
        autocomplete="off"
        spellcheck="false"
      />
    `
  }

  private _patchSsh(current: SshConfig, partial: Partial<SshConfig>) {
    this._sshTest = { phase: 'idle' }
    this._patch({ ssh: { ...current, ...partial } })
  }

  private async _onTestSsh() {
    if (!this.profile) return
    this._sshTest = { phase: 'testing' }
    const result = await window.sqlkit.testSshTunnel(this.profile)
    this._sshTest = result.success
      ? { phase: 'ok', message: t('config.tunnelOk', { duration: result.tookMs }) }
      : { phase: 'error', message: result.error }
  }

  private _input(
    draft: ConnectionProfile,
    key: Exclude<keyof ConnectionProfile, 'id' | 'engine' | 'passwordSaved'>,
    type: 'text' | 'password' = 'text',
  ) {
    return html`
      <input
        type=${type}
        .value=${draft[key]}
        placeholder=${type === 'password' && draft.passwordSaved ? SAVED_SECRET_MASK : ''}
        @input=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value
          const targetChanged = key === 'host' || key === 'port' || key === 'username'
          this._patch(key === 'password' || targetChanged ? { [key]: value, passwordSaved: false } : { [key]: value })
        }}
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

  private _patch(partial: Partial<ConnectionProfile>) {
    if (!this.profile) return
    this._test = { phase: 'idle' }
    // Field edits re-derive the URL text, so drop any leftover draft.
    this._urlDraft = null
    this._urlError = ''
    const profile = { ...this.profile, ...partial }
    this.dispatchEvent(new CustomEvent('config-change', { detail: { profile }, bubbles: true, composed: true }))
  }

  private _onEngineChange(id: string) {
    const entry = ENGINES.find((option) => option.id === id)
    if (!this.profile || !entry?.engine) return
    // Carry the port along only if the user hasn't customized it.
    const ports = Object.values(DEFAULT_PORTS)
    const port =
      this.profile.port === '' || ports.includes(this.profile.port)
        ? (DEFAULT_PORTS[entry.engine] ?? this.profile.port)
        : this.profile.port
    // flavor is set for variants and explicitly cleared for plain engines.
    this._patch({ engine: entry.engine, flavor: entry.flavor, port, passwordSaved: false })
  }

  // The URL field and the fields below are two views of the same profile:
  // a parseable URL patches the fields as it is typed, and blur snaps the
  // text back to the canonical form. Mid-typing parse failures stay silent.
  private _onUrlInput(value: string) {
    this._urlDraft = value
    this._urlError = ''
    if (!this.profile || !value.trim()) return
    try {
      const profile = profileFromConnectionUrl(value, this.profile)
      this._test = { phase: 'idle' }
      this.dispatchEvent(new CustomEvent('config-change', { detail: { profile }, bubbles: true, composed: true }))
    } catch {
      // Incomplete URLs are expected while typing; _onUrlBlur reports them.
    }
  }

  private _onUrlBlur = () => {
    const draft = this._urlDraft
    this._urlDraft = null
    if (!draft?.trim() || !this.profile) return
    try {
      profileFromConnectionUrl(draft, this.profile)
    } catch (error) {
      this._urlDraft = draft
      this._urlError = (error as Error).message
    }
  }

  private async _onBrowse() {
    const file = await window.sqlkit.pickSqliteFile()
    if (file) this._patch({ file })
  }

  private async _onTest() {
    if (!this.profile) return
    this._test = { phase: 'testing' }
    const result = await window.sqlkit.testConnection(this.profile)
    this._test = result.success
      ? { phase: 'ok', message: t('config.connectedVersion', { version: result.serverVersion, duration: result.tookMs }) }
      : { phase: 'error', message: result.error }
  }

  private _onSave() {
    if (!this.profile) return
    const profile = { ...this.profile, name: this.profile.name.trim() || t('config.untitled') }
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
        width: 100%;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 30px;
        padding: 32px 64px;
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

      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: var(--control-h);
        font-size: var(--font-size);
        color: var(--text);
        cursor: pointer;
        user-select: none;
      }

      .label-colors {
        min-height: var(--control-h);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
      }

      .label-color,
      .label-color-none {
        width: 26px;
        height: 26px;
        display: grid;
        place-items: center;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 5px;
        cursor: pointer;
      }

      .label-color:hover,
      .label-color-none:hover {
        background: var(--btn-secondary-hover);
      }

      .label-color.selected,
      .label-color-none.selected {
        border-color: var(--focus-border);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--focus-border) 35%, transparent);
      }

      .label-color span,
      .label-color-none span {
        width: 14px;
        height: 14px;
        display: block;
        border-radius: 4px;
      }

      .label-color span {
        background: var(--label-color);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, white 12%, transparent);
      }

      .label-color-none span {
        position: relative;
        overflow: hidden;
        background: var(--input-bg);
        border: 1px solid var(--border);
      }

      .label-color-none span::after {
        content: '';
        position: absolute;
        width: 20px;
        height: 1px;
        left: -4px;
        top: 6px;
        background: var(--text-3);
        transform: rotate(-45deg);
      }

      .test-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .test-row .test-result {
        flex: 1;
        max-width: none;
        text-align: left;
      }

      .file-row {
        display: flex;
        gap: 8px;
      }

      .file-row input {
        flex: 1;
        min-width: 0;
      }

      .file-row button {
        flex-shrink: 0;
      }

      footer {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .spacer {
        flex: 1;
      }

      .test-result {
        font-size: var(--font-size-sm);
        text-align: right;
        max-width: min(520px, 45vw);
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        line-height: 1.35;
        overflow-wrap: anywhere;
        white-space: normal;
      }

      .test-result.ok {
        color: var(--status-dot-connected);
      }

      .test-result.error {
        color: var(--status-dot-error);
      }

      .ssl-warning {
        display: flex;
        gap: 8px;
        margin: 0;
        padding: 8px 11px;
        font-size: var(--font-size-sm);
        line-height: 1.45;
        color: var(--status-dot-warning);
        background: color-mix(in srgb, var(--status-dot-warning) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--status-dot-warning) 35%, transparent);
        border-radius: 4px;
      }

      .ssl-warning strong {
        font-weight: 600;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'db-config-form': DbConfigForm
  }
}
