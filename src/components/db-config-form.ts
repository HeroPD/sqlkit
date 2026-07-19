import { LitElement, css, html, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { controls, typography } from '../shared-styles'
import type { ConnectionProfile, DatabaseMode, Engine, EngineFlavor, SshAuthType, SshConfig, SslConfig, SslMode } from '../electron'
import { connectionUrlFromProfile, profileFromConnectionUrl } from '../connection-url'

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
  { id: 'clickhouse', label: 'ClickHouse (coming soon)', disabled: true },
  { id: 'oracle', label: 'Oracle (coming soon)', disabled: true },
]

const DEFAULT_PORTS: Partial<Record<Engine, string>> = {
  postgresql: '5432',
  mysql: '3306',
  sqlserver: '1433',
}

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

  render() {
    const draft = this.profile
    if (!draft) return html``

    return html`
      <div class="card" @keydown=${this._onFieldKeydown}>
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
              <select @change=${(e: Event) => this._onEngineChange((e.target as HTMLSelectElement).value)}>
                ${ENGINES.map(
                  (entry) => html`
                    <option
                      value=${entry.id}
                      ?selected=${entry.id === (draft.flavor ?? draft.engine)}
                      ?disabled=${entry.disabled ?? false}
                    >
                      ${entry.label}
                    </option>
                  `,
                )}
              </select>
            `,
          )}
        </section>

        ${draft.engine === 'sqlite' ? this._sqliteSection(draft) : this._serverSection(draft)}
        ${draft.engine === 'sqlite' ? '' : this._sslSection(draft)}
        ${draft.engine === 'sqlite' ? '' : this._sshSection(draft)}

        <footer>
          <button class="primary" @click=${this._onSave}>Save</button>
          <button class="secondary" @click=${this._onCancel}>Cancel</button>
          <span class="spacer"></span>
          <span class="test-result ${this._test.phase}" title=${'message' in this._test ? this._test.message : ''}>
            ${'message' in this._test ? this._test.message : ''}
          </span>
          <button class="secondary" @click=${this._onTest} ?disabled=${this._test.phase === 'testing'}>
            ${this._test.phase === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
        </footer>
      </div>
    `
  }

  private _serverSection(draft: ConnectionProfile) {
    return html`
      <section>
        <div class="section-head">
          <h4>Connection</h4>
          <p class="muted small">Server location and credentials</p>
        </div>
        ${this._field(
          'Connection URL',
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
          this._urlError || 'Synced with the fields below — paste a PostgreSQL, MySQL/MariaDB, or SQL Server URL to fill them.',
        )}
        ${this._field('Name', this._input(draft, 'name'), 'Shown in the Databases list.')}
        ${this._field('Host', this._input(draft, 'host'), 'Hostname, IP, or server name.')}
        ${this._field('Port', this._input(draft, 'port'))}
        ${this._field('User', this._input(draft, 'username'))}
        ${this._field(
          'Password',
          this._input(draft, 'password', 'password'),
          draft.passwordSaved ? 'A password is saved. Leave blank to keep it; typing replaces it.' : '',
        )}
        ${this._field('Database', this._input(draft, 'database'))}
        ${this._field(
          'Mode',
          html`
            <select
              @change=${(e: Event) =>
                this._patch({ databaseMode: (e.target as HTMLSelectElement).value as DatabaseMode })}
            >
              <option value="single" ?selected=${(draft.databaseMode ?? 'single') === 'single'}>Single database</option>
              <option value="all" ?selected=${draft.databaseMode === 'all'}>All databases</option>
            </select>
          `,
          'All databases lists every database on the server; switch the active one in the sidebar.',
        )}
      </section>
    `
  }

  private _sqliteSection(draft: ConnectionProfile) {
    return html`
      <section>
        <div class="section-head">
          <h4>Connection</h4>
          <p class="muted small">Database file on disk</p>
        </div>
        ${this._field('Name', this._input(draft, 'name'), 'Shown in the Databases list.')}
        ${this._field(
          'File',
          html`
            <div class="file-row">
              ${this._input(draft, 'file')}
              <button class="secondary" @click=${this._onBrowse}>Browse…</button>
            </div>
          `,
          'Path to the database file. A new file is created if it does not exist.',
        )}
      </section>
    `
  }

  private _sslSection(draft: ConnectionProfile) {
    const ssl = draft.ssl ?? defaultSsl()
    return html`
      <section>
        <div class="section-head">
          <h4>SSL</h4>
          <p class="muted small">Encrypt the database connection</p>
        </div>
        ${this._field(
          'Mode',
          html`
            <select @change=${(e: Event) => this._patchSsl(ssl, { mode: (e.target as HTMLSelectElement).value as SslMode })}>
              <option value="disable" ?selected=${ssl.mode === 'disable'}>Disable</option>
              <option value="require" ?selected=${ssl.mode === 'require'}>Require encryption (no certificate check)</option>
              <option value="verify-ca" ?selected=${ssl.mode === 'verify-ca'} ?disabled=${draft.engine === 'sqlserver'}>Verify CA</option>
              <option value="verify-full" ?selected=${ssl.mode === 'verify-full'}>Verify full</option>
            </select>
          `,
          ssl.mode === 'require' ? '' : 'Verify full validates both the certificate chain and hostname.',
        )}
        ${ssl.mode === 'require'
          ? html`<p class="ssl-warning" role="alert">
              <span aria-hidden="true">⚠</span>
              <span
                ><strong>“Require” encrypts but does not verify the server’s certificate</strong>, so it can’t stop a
                man-in-the-middle on an untrusted network. Use <strong>Verify full</strong> for that.</span
              >
            </p>`
          : ''}
        ${ssl.mode === 'verify-ca' || ssl.mode === 'verify-full'
          ? this._field('CA certificate', this._sslInput(ssl, 'ca'), 'Optional path to a custom root CA certificate. System roots are used when empty.')
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
    if (event.key === 'Enter') {
      const target = event.target
      if (!(target instanceof HTMLSelectElement)) return
      event.preventDefault()
      const picker = target as HTMLSelectElement & { showPicker?: () => void }
      // showPicker() returns void, so `?? click()` would fire both; branch instead.
      if (picker.showPicker) picker.showPicker()
      else target.click()
      return
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return

    const controls = [...this.renderRoot.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.field-control input, .field-control select')]
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
          <h4>SSH Tunnel</h4>
          <p class="muted small">Reach the server through a bastion host</p>
        </div>
        ${this._field(
          'Tunnel',
          html`
            <label class="toggle">
              <input
                type="checkbox"
                .checked=${ssh.enabled}
                @change=${(e: Event) => this._patchSsh(ssh, { enabled: (e.target as HTMLInputElement).checked })}
              />
              <span>Connect through an SSH tunnel</span>
            </label>
          `,
        )}
        ${ssh.enabled ? this._sshFields(ssh) : ''}
      </section>
    `
  }

  private _sshFields(ssh: SshConfig) {
    return html`
      ${this._field('SSH host', this._sshInput(ssh, 'host'), 'Bastion hostname or IP.')}
      ${this._field('SSH port', this._sshInput(ssh, 'port'))}
      ${this._field('SSH user', this._sshInput(ssh, 'username'))}
      ${this._field(
        'Auth method',
        html`
          <select
            @change=${(e: Event) => this._patchSsh(ssh, {
              authType: (e.target as HTMLSelectElement).value as SshAuthType,
              passwordSaved: false,
              passphraseSaved: false,
            })}
          >
            <option value="key" ?selected=${ssh.authType === 'key'}>Private key</option>
            <option value="password" ?selected=${ssh.authType === 'password'}>Password</option>
          </select>
        `,
      )}
      ${ssh.authType === 'key'
        ? html`
            ${this._field('Key path', this._sshInput(ssh, 'keyPath'), 'Private key file; ~ expands to your home folder.')}
            ${this._field('Passphrase', this._sshInput(ssh, 'passphrase', 'password'), 'Leave empty for unencrypted keys.')}
          `
        : this._field('SSH password', this._sshInput(ssh, 'password', 'password'))}
      ${this._field(
        '',
        html`
          <div class="test-row">
            <button class="secondary" @click=${this._onTestSsh} ?disabled=${this._sshTest.phase === 'testing'}>
              ${this._sshTest.phase === 'testing' ? 'Testing…' : 'Test SSH'}
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
      ? { phase: 'ok', message: `Tunnel OK (${result.tookMs} ms)` }
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
      ? { phase: 'ok', message: `Connected — ${result.serverVersion} (${result.tookMs} ms)` }
      : { phase: 'error', message: result.error }
  }

  private _onSave() {
    if (!this.profile) return
    const profile = { ...this.profile, name: this.profile.name.trim() || 'Untitled' }
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

      .toggle input[type='checkbox'] {
        width: auto;
        height: auto;
        margin: 0;
        accent-color: var(--accent);
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
