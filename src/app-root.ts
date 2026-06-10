import { LitElement, css, html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './components/welcome-screen'
import './components/workbench-screen'
import type { RecentWorkspace, WorkspaceResult } from './electron'

type Screen = 'welcome' | 'workbench'
type Workspace = { name: string; path: string }

// The application root: owns which screen is shown, the open workspace, and
// the recents list. Both screens stay mounted as siblings and the active one
// is toggled with CSS, so each keeps its state. The screens are dumb — they
// dispatch `open-folder` / `open-recent` / `close-workspace` intents and the
// root decides what happens.
@customElement('app-root')
export class AppRoot extends LitElement {
  @state()
  private _screen: Screen = 'welcome'

  @state()
  private _workspace: Workspace | null = null

  @state()
  private _recents: RecentWorkspace[] = []

  connectedCallback() {
    super.connectedCallback()
    void this._loadRecents()
  }

  render() {
    const welcome = this._screen === 'welcome'
    return html`
      <div
        id="app"
        @open-folder=${this._onOpenFolder}
        @open-recent=${this._onOpenRecent}
        @close-workspace=${this._onCloseWorkspace}
      >
        <welcome-screen class="screen ${welcome ? 'active' : ''}" .recents=${this._recents}></welcome-screen>
        <workbench-screen class="screen ${welcome ? '' : 'active'}" .workspace=${this._workspace}></workbench-screen>
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
    this._workspace = null
    this._screen = 'welcome'
  }

  static styles = css`
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

    .screen {
      display: none;
    }

    .screen.active {
      display: flex;
      flex: 1;
      min-height: 0;
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot
  }
}
