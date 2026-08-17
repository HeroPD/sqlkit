import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { APP_ICONS } from '../icons/app-icons'
import { controls, icons, scrollbars, typography } from '../shared-styles'
import type { RecentWorkspace } from '../electron'
import { isMac } from '../platform'
import { t } from '../i18n'

const CURRENT_VERSION = '0.1.0'

const recentAge = (lastOpened: string): string => {
  const opened = Date.parse(lastOpened)
  if (!Number.isFinite(opened)) return ''
  const elapsed = Math.max(0, Date.now() - opened)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return t('welcome.yesterday')
  if (days < 14) return `${days}d`
  if (days < 56) return `${Math.floor(days / 7)}w`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(opened)
}

// Editor-native welcome view: one real start action, recent workspaces, and a
// compact release summary. Opening remains owned by <app-root>; this component
// only emits intents.
@customElement('welcome-screen')
export class WelcomeScreen extends LitElement {
  @property({ attribute: false })
  recents: RecentWorkspace[] = []

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    document.removeEventListener('keydown', this._onKeydown)
  }

  render() {
    return html`
      <div class="workspace">
        <main class="main">
          <div class="brand">
            <span class="brand-mark">${unsafeHTML(APP_ICONS.appicon)}</span>
            <div>
              <h1>${t('app.name')}</h1>
              <p>${t('app.tagline')}</p>
            </div>
          </div>

          <section class="section">
            <div class="section-head">
              <h2>${t('welcome.start')}</h2>
              <span>${t('welcome.workspaceActions')}</span>
            </div>
            <div class="actions">
              <button class="action featured" type="button" @click=${this._onOpenFolder}>
                <span class="action-icon"><i class="icon icon-folder" aria-hidden="true"></i></span>
                <span class="action-label">${t('welcome.openFolder')}</span>
                <kbd>${isMac ? '⌘O' : 'Ctrl+O'}</kbd>
              </button>
            </div>
          </section>

          <section class="section recent-section">
            <div class="section-head">
              <h2>${t('welcome.recent')}</h2>
              <span>${t('welcome.recentHint')}</span>
            </div>
            ${this.recents.length
              ? html`
                  <div class="recent-list">
                    ${this.recents.map((workspace) => {
                      const age = recentAge(workspace.lastOpened)
                      const profiles = workspace.profileCount
                        ? t(workspace.profileCount === 1 ? 'welcome.oneProfile' : 'welcome.manyProfiles', {
                            count: workspace.profileCount,
                          })
                        : ''
                      return html`
                        <button class="recent" type="button" title=${workspace.path} @click=${() => this._onOpenRecent(workspace)}>
                          <span class="recent-icon"><i class="icon icon-folder" aria-hidden="true"></i></span>
                          <span class="recent-name">${workspace.name}</span>
                          <span class="recent-path">${workspace.path}</span>
                          <span class="recent-time">${profiles}${profiles && age ? ' · ' : ''}${age}</span>
                        </button>
                      `
                    })}
                  </div>
                `
              : html`<div class="empty">${t('welcome.noRecent')}</div>`}
          </section>
        </main>

        <aside class="updates">
          <div class="update-title">
            <h2>${t('welcome.releaseNotes')}</h2>
            <span class="badge">v${CURRENT_VERSION}</span>
          </div>
          <div class="release-head">
            <div class="release-meta">v${CURRENT_VERSION} · ${t('welcome.initialRelease')}</div>
            <h3>${t('welcome.releaseTitle')}</h3>
            <p>${t('welcome.releaseIntro')}</p>
          </div>
          <ul class="change-list">
            <li class="change"><strong>${t('welcome.releaseEditorTitle')}</strong> ${t('welcome.releaseEditorDetail')}</li>
            <li class="change"><strong>${t('welcome.releaseEnginesTitle')}</strong> ${t('welcome.releaseEnginesDetail')}</li>
            <li class="change"><strong>${t('welcome.releaseResultsTitle')}</strong> ${t('welcome.releaseResultsDetail')}</li>
            <li class="change"><strong>${t('welcome.releaseWorkspaceTitle')}</strong> ${t('welcome.releaseWorkspaceDetail')}</li>
          </ul>
        </aside>
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (!this.classList.contains('active')) return
    if (event.key.toLowerCase() !== 'o' || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    this._onOpenFolder()
  }

  private _onOpenFolder() {
    this.dispatchEvent(new CustomEvent('open-folder', { bubbles: true, composed: true }))
  }

  private _onOpenRecent(workspace: RecentWorkspace) {
    this.dispatchEvent(
      new CustomEvent('open-recent', { detail: { path: workspace.path }, bubbles: true, composed: true }),
    )
  }

  static styles = [
    typography,
    controls,
    icons,
    scrollbars,
    css`
      :host {
        min-width: 0;
        min-height: 0;
      }

      .workspace {
        position: relative;
        overflow: hidden;
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: minmax(400px, 1fr) minmax(300px, 380px);
        background: var(--editor-bg);
      }

      .workspace::before {
        content: 'SELECT  *  FROM  your_next_idea;';
        position: absolute;
        left: 52px;
        bottom: 23px;
        color: color-mix(in srgb, var(--text-3) 5%, transparent);
        font: 36px/1 var(--mono-font);
        white-space: nowrap;
        pointer-events: none;
      }

      .main {
        min-width: 0;
        min-height: 0;
        overflow: auto;
        display: flex;
        flex-direction: column;
        padding: 50px 58px 38px;
        box-sizing: border-box;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 37px;
      }

      .brand-mark {
        width: 46px;
        height: 46px;
        flex: none;
      }

      .brand-mark svg {
        display: block;
        width: 100%;
        height: 100%;
      }

      .brand h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 520;
        letter-spacing: -0.025em;
      }

      .brand p {
        margin: 3px 0 0;
        color: var(--text-3);
        font-size: var(--font-size);
      }

      .section {
        margin-bottom: 31px;
      }

      .section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 9px;
      }

      .section-head h2 {
        color: var(--text-2);
        font-size: var(--font-size-sm);
        font-weight: 650;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }

      .section-head span {
        color: var(--text-3);
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .actions {
        display: grid;
        grid-template-columns: minmax(0, 360px);
        gap: 6px;
      }

      .action {
        min-width: 0;
        height: 48px;
        display: grid;
        grid-template-columns: 29px minmax(0, 1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 0 11px;
        color: var(--text);
        text-align: left;
        background: var(--sidebar-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
      }

      .action:hover {
        background: var(--list-hover);
        border-color: var(--border);
      }

      .action.featured {
        color: var(--text);
        background: color-mix(in srgb, var(--accent) 10%, var(--editor-bg));
        border-color: color-mix(in srgb, var(--accent) 42%, var(--border-subtle));
      }

      .action.featured:hover {
        background: color-mix(in srgb, var(--accent) 15%, var(--editor-bg));
      }

      .action-icon {
        width: 29px;
        height: 29px;
        display: grid;
        place-items: center;
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 9%, transparent);
        border-radius: 4px;
        --icon-size: 19px;
      }

      .action-label {
        overflow: hidden;
        font-size: var(--font-size);
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      kbd {
        padding: 2px 5px;
        color: var(--text-3);
        background: color-mix(in srgb, var(--bg) 80%, black);
        border: 1px solid var(--border);
        border-bottom-color: color-mix(in srgb, var(--border) 80%, var(--text-2));
        border-radius: 3px;
        font: var(--font-size-sm)/1.3 var(--mono-font);
      }

      .recent-list {
        max-height: 246px;
        overflow: auto;
        display: flex;
        flex-direction: column;
      }

      .recent {
        width: 100%;
        height: 41px;
        display: grid;
        grid-template-columns: 25px minmax(110px, auto) minmax(80px, 1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 0 7px;
        color: var(--text);
        text-align: left;
        background: transparent;
        border: 0;
        border-radius: 3px;
      }

      .recent:hover {
        background: var(--list-hover);
      }

      .recent-icon {
        display: grid;
        place-items: center;
        color: var(--text-3);
        --icon-size: 15px;
      }

      .recent-name {
        overflow: hidden;
        font-size: var(--font-size);
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .recent-path {
        overflow: hidden;
        color: var(--text-3);
        font: var(--font-size-sm)/1 var(--mono-font);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .recent-time {
        color: var(--text-3);
        font-size: var(--font-size-sm);
      }

      .empty {
        padding: 13px 8px;
        color: var(--text-3);
        font-size: var(--font-size);
      }

      .updates {
        min-width: 0;
        min-height: 0;
        overflow: auto;
        padding: 52px 34px 38px;
        background: var(--editor-bg);
        border-left: 1px solid var(--border-subtle);
        box-sizing: border-box;
      }

      .update-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 21px;
      }

      .update-title h2 {
        font-size: var(--font-size);
        font-weight: 550;
      }

      .badge {
        padding: 2px 5px;
        color: color-mix(in srgb, var(--accent) 55%, white);
        background: color-mix(in srgb, var(--accent) 13%, var(--editor-bg));
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        border-radius: 3px;
        font: var(--font-size-sm)/1.4 var(--mono-font);
      }

      .release-head {
        margin-bottom: 17px;
        padding-bottom: 17px;
        border-bottom: 1px solid var(--border-subtle);
      }

      .release-meta {
        margin-bottom: 7px;
        color: var(--text-3);
        font: var(--font-size-sm)/1.4 var(--mono-font);
      }

      .release-head h3 {
        margin: 0 0 6px;
        color: var(--text);
        font-size: var(--font-size);
        font-weight: 550;
        letter-spacing: 0;
        text-transform: none;
      }

      .release-head p {
        color: var(--text-3);
        font-size: var(--font-size);
        line-height: 1.5;
      }

      .change-list {
        display: flex;
        flex-direction: column;
        gap: 11px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .change {
        position: relative;
        padding-left: 14px;
        color: var(--text-3);
        font-size: var(--font-size);
        line-height: 1.45;
      }

      .change::before {
        content: '';
        position: absolute;
        left: 0;
        top: 7px;
        width: 5px;
        height: 5px;
        background: var(--accent);
        border-radius: 50%;
      }

      .change strong {
        color: var(--text-2);
        font-weight: 550;
      }

      @media (max-width: 900px) {
        .workspace {
          grid-template-columns: 1fr 300px;
        }

        .main {
          padding-right: 38px;
          padding-left: 38px;
        }

        .actions {
          grid-template-columns: 1fr;
        }
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'welcome-screen': WelcomeScreen
  }
}
