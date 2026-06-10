import { LitElement, css, html } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import './components/welcome-screen'
import './components/workbench-screen'

type Screen = 'welcome' | 'workbench'

// The application root: owns which screen is shown. Both screens stay mounted
// as siblings and the active one is toggled with CSS, so each keeps its state.
// The screens are dumb — they dispatch `open-folder` / `close-workspace`
// intents and the root decides what happens.
@customElement('app-root')
export class AppRoot extends LitElement {
  @state()
  private _screen: Screen = 'welcome'

  render() {
    const welcome = this._screen === 'welcome'
    return html`
      <div id="app" @open-folder=${this._onOpenFolder} @close-workspace=${this._onCloseWorkspace}>
        <welcome-screen class="screen ${welcome ? 'active' : ''}"></welcome-screen>
        <workbench-screen class="screen ${welcome ? '' : 'active'}"></workbench-screen>
      </div>
    `
  }

  private _onOpenFolder() {
    // TODO: folder-picker IPC lands here (window.sqlkit.openWorkspace()); for
    // now opening a workspace just enters the blank workbench.
    this._screen = 'workbench'
  }

  private _onCloseWorkspace() {
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
