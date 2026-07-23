import { LitElement, css, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icons, tooltip } from '../shared-styles'
import { t } from '../i18n'
import { mod } from '../platform'

export type StatusConnection = {
  profileId: string
  name: string
  /** In-use child database (all-databases mode), if any. */
  childDb: string | null
  /** Short server banner, e.g. "PostgreSQL 17". */
  version: string | null
  /** True when this is the workbench's active context. */
  active: boolean
}

// The workbench footer, Zed-style: flat items that highlight on hover when
// they lead somewhere. Dock toggles bookend the bar; the context segment opens
// the database switcher; the connection summary opens a popover of live
// connections to jump between.
@customElement('status-bar')
export class StatusBar extends LitElement {
  @property()
  workspaceName = ''

  @property({ type: Boolean })
  sidebarOpen = false

  @property({ type: Boolean })
  panelOpen = false

  /** False when no editor tab is open, so there is no panel to toggle. */
  @property({ type: Boolean })
  panelEnabled = true

  /** Name of the ⌘K context; empty hides the segment. */
  @property()
  contextName = ''

  @property({ attribute: false })
  connections: StatusConnection[] = []

  @state()
  private _open = false

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this._onKeydown)
  }

  willUpdate() {
    // A disconnect can empty the list while the popover is up.
    if (!this.connections.length) this._open = false
  }

  render() {
    const count = this.connections.length
    const summary =
      count === 0
        ? t('status.notConnected')
        : count === 1
          ? (this.connections[0]?.name ?? t('status.oneConnected'))
          : t('status.manyConnected', { count })

    return html`
      <footer>
        <button
          class="item toggle tooltip-up tooltip-start ${this.sidebarOpen ? 'on' : ''}"
          data-tooltip="${t('action.toggleSidebar')} (${mod('B')})"
          aria-label="${t('action.toggleSidebar')} (${mod('B')})"
          aria-pressed=${String(this.sidebarOpen)}
          @click=${() => this._emit('status-toggle-sidebar')}
        >
          <i class="icon icon-panel-left" aria-hidden="true"></i>
        </button>
        <span class="item static">${this.workspaceName || t('app.name')}</span>
        ${this.contextName
          ? html`
              <button class="item tooltip-up" data-tooltip=${t('action.switchDatabase')} @click=${this._switchDatabase}>
                <i class="icon icon-database" aria-hidden="true"></i>
                ${this.contextName}
              </button>
            `
          : ''}
        <span class="spacer"></span>
        <button
          class="item tooltip-up"
          data-tooltip=${count ? t('status.connections') : t('action.switchDatabase')}
          aria-haspopup=${count ? 'menu' : undefined}
          aria-expanded=${count ? String(this._open) : undefined}
          @click=${count ? this._togglePopover : this._switchDatabase}
        >
          <span class="dot ${count ? 'live' : ''}" aria-hidden="true"></span>
          ${summary}
          ${count === 1 && this.connections[0]?.version
            ? html`<span class="version">${this.connections[0].version}</span>`
            : ''}
        </button>
        <button
          class="item toggle tooltip-up tooltip-end ${this.panelOpen ? 'on' : ''}"
          data-tooltip="${t('action.toggleResults')} (${mod('J')})"
          aria-label="${t('action.toggleResults')} (${mod('J')})"
          aria-pressed=${String(this.panelOpen)}
          ?disabled=${!this.panelEnabled}
          @click=${() => this._emit('status-toggle-panel')}
        >
          <i class="icon icon-panel-bottom" aria-hidden="true"></i>
        </button>
      </footer>
      ${this._open ? this._renderPopover() : ''}
    `
  }

  // Anchored above the summary item, styled like the shared context menu.
  private _renderPopover() {
    return html`
      <div class="pop-backdrop" @mousedown=${() => (this._open = false)}></div>
      <div class="pop" role="menu" aria-label=${t('status.connections')}>
        ${this.connections.map(
          (connection) => html`
            <button
              class="pop-item"
              role="menuitem"
              @mousedown=${(e: Event) => e.preventDefault()}
              @click=${() => this._pick(connection)}
            >
              <span class="check" aria-hidden="true">${connection.active ? '✓' : ''}</span>
              <span class="label">${connection.name}</span>
              ${connection.childDb || connection.version
                ? html`<span class="meta">
                    ${[connection.childDb, connection.version].filter(Boolean).join(' · ')}
                  </span>`
                : ''}
            </button>
          `,
        )}
      </div>
    `
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this._open) {
      event.preventDefault()
      this._open = false
    }
  }

  private _togglePopover() {
    this._open = !this._open
  }

  private _switchDatabase() {
    this._emit('status-switch-database')
  }

  private _emit(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }))
  }

  private _pick(connection: StatusConnection) {
    this._open = false
    this.dispatchEvent(
      new CustomEvent<{ profileId: string }>('status-pick-connection', {
        detail: { profileId: connection.profileId },
        bubbles: true,
        composed: true,
      }),
    )
  }

  static styles = [
    icons,
    tooltip,
    css`
      :host {
        display: block;
        flex-shrink: 0;
      }

      footer {
        box-sizing: border-box;
        height: var(--status-bar-h);
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 5px;
        font-size: var(--font-size-sm);
        --icon-size: var(--font-size-sm);
        color: var(--status-bar-fg);
        background: var(--status-bar-bg);
        border-top: 1px solid var(--border-subtle);
      }

      .item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 22px;
        padding: 0 6px;
        border: none;
        border-radius: 5px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .item.static {
        cursor: default;
      }

      /* Dock toggles: dim when their surface is hidden, full text tint when shown. */
      .toggle {
        --icon-size: 14px;
        color: var(--text-3);
      }

      .toggle.on {
        color: var(--text);
      }

      button.item:hover:not(:disabled),
      button.item:focus-visible:not(:disabled) {
        background: color-mix(in srgb, var(--text) 9%, transparent);
        outline: none;
      }

      button.item:disabled {
        color: var(--text-3);
        opacity: 0.45;
        cursor: default;
      }

      .icon {
        vertical-align: -1px;
      }

      .spacer {
        flex: 1;
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-3);
      }

      .dot.live {
        background: var(--status-dot-connected);
      }

      .pop-backdrop {
        position: fixed;
        inset: 0;
        z-index: 90;
      }

      .pop {
        position: fixed;
        right: 6px;
        bottom: calc(var(--status-bar-h) + 4px);
        z-index: 91;
        min-width: 220px;
        max-width: min(320px, calc(100vw - 12px));
        max-height: calc(100vh - var(--status-bar-h) - 12px);
        overflow-y: auto;
        padding: 4px;
        display: flex;
        flex-direction: column;
        background: var(--overlay-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 10px;
        box-shadow:
          0 8px 24px rgba(0, 0, 0, 0.28),
          0 1px 3px rgba(0, 0, 0, 0.2);
      }

      .pop-item {
        display: grid;
        grid-template-columns: 14px minmax(0, 1fr) auto;
        align-items: center;
        column-gap: 8px;
        width: 100%;
        min-height: 26px;
        padding: 3px 8px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 13px;
        line-height: 20px;
        text-align: left;
        cursor: pointer;
      }

      .pop-item:hover,
      .pop-item:focus-visible {
        background: color-mix(in srgb, var(--text) 9%, transparent);
        outline: none;
      }

      .check {
        color: var(--accent);
        font-size: 12px;
        font-weight: 600;
        text-align: center;
      }

      .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .meta {
        color: var(--text-3);
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      .version {
        color: var(--text-3);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'status-bar': StatusBar
  }
}
