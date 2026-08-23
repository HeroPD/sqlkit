import { LitElement, css, html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './components/welcome-screen'
import './components/workbench-screen'
import type { MenuAction, RecentWorkspace, WorkspaceResult } from './electron'
import { t } from './i18n'
import { isMac } from './platform'
import { titlebar } from './shared-styles'

type Screen = 'welcome' | 'workbench' | 'settings'
type Workspace = { name: string; path: string }

// Width the macOS traffic lights occupy over a `hiddenInset` title bar, plus
// the gap before the first control.
const TRAFFIC_LIGHT_GUTTER = '82px'

// The application root: owns which screen is shown, the open workspace, and
// the recents list. Both screens stay mounted as siblings and the active one
// is toggled with CSS, so each keeps its state. The screens are dumb — they
// dispatch `open-folder` / `open-recent` / `close-workspace` intents and the
// root decides what happens.
@customElement('app-root')
export class AppRoot extends LitElement {
  private _unsubscribeMenu: (() => void) | null = null
  private _unsubscribeFullScreen: (() => void) | null = null
  @state()
  private _screen: Screen = 'welcome'

  @state()
  private _workspace: Workspace | null = null
  private _settingsReturn: Exclude<Screen, 'settings'> = 'welcome'

  @state()
  private _recents: RecentWorkspace[] = []

  connectedCallback() {
    super.connectedCallback()
    this._unsubscribeMenu = window.sqlkit.onMenuAction((action) => this._onMenuAction(action))
    this._applyTitlebarInset(false)
    this._unsubscribeFullScreen = window.sqlkit.onFullScreenChange((full) => this._applyTitlebarInset(full))
    void this._loadRecents()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unsubscribeMenu?.()
    this._unsubscribeMenu = null
    this._unsubscribeFullScreen?.()
    this._unsubscribeFullScreen = null
  }

  protected firstUpdated() {
    // The frame carrying this render is what the window should first show;
    // signalling from its rAF keeps main from showing an earlier, blank one.
    requestAnimationFrame(() => void window.sqlkit.notifyRendered())
  }

  private _onMenuAction(action: MenuAction) {
    if (action === 'open-workspace') void this._onOpenFolder()
    if (action === 'settings') this._onOpenSettings()
  }

  // Document-level so both title bars (welcome and workbench) inherit it.
  private _applyTitlebarInset(fullScreen: boolean) {
    const inset = isMac && !fullScreen ? TRAFFIC_LIGHT_GUTTER : '0px'
    document.documentElement.style.setProperty('--titlebar-inset', inset)
  }

  render() {
    const welcome = this._screen === 'welcome'
    const workbench = this._screen !== 'welcome'
    return html`
      <div
        id="app"
        @open-folder=${this._onOpenFolder}
        @open-recent=${this._onOpenRecent}
        @close-workspace=${this._onCloseWorkspace}
        @open-settings=${this._onOpenSettings}
        @settings-close=${this._onSettingsClose}
      >
        ${welcome
          ? html`
              <header class="app-titlebar">
                <div class="titlebar-inner"><span>${t('app.name')}</span></div>
              </header>
            `
          : ''}
        <welcome-screen class="screen ${welcome ? 'active' : ''}" .recents=${this._recents}></welcome-screen>
        <workbench-screen
          class="screen ${workbench ? 'active' : ''}"
          .workspace=${this._workspace}
          .settingsOpen=${this._screen === 'settings'}
        ></workbench-screen>
      </div>
    `
  }

  private async _loadRecents() {
    this._recents = await window.sqlkit.getRecentWorkspaces()
  }

  private _enter(result: WorkspaceResult) {
    if (!result.success) {
      if (result.error) console.error('Failed to open workspace:', result.error)
      return
    }

    this._workspace = { name: result.name, path: result.path }
    this._screen = 'workbench'
    void this._loadRecents()
  }

  private async _onOpenFolder() {
    this._enter(await window.sqlkit.openWorkspace())
  }

  private async _onOpenRecent(event: Event) {
    const { path } = (event as CustomEvent<{ path: string }>).detail
    this._enter(await window.sqlkit.openWorkspacePath(path))
  }

  private _onCloseWorkspace() {
    void window.sqlkit.closeWorkspace()
    this._workspace = null
    this._screen = 'welcome'
    void this._loadRecents()
  }

  private _onSettingsClose() {
    if (this._screen === 'settings') this._screen = this._settingsReturn
  }

  // Both entry points (⌘, and the activity-bar toggle) land here, so the screen
  // to return to is remembered once and re-entering settings never loses it.
  private _onOpenSettings() {
    if (this._screen !== 'settings') this._settingsReturn = this._screen
    this._screen = 'settings'
  }

  static styles = [
    titlebar,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      #app {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      .titlebar-inner {
        font-size: var(--font-size-sm);
        font-weight: 500;
      }

      .screen {
        display: none;
      }

      .screen.active {
        display: flex;
        flex: 1;
        min-height: 0;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot
  }
}
