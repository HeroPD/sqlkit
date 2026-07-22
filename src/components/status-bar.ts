import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { icons } from '../shared-styles'
import { t } from '../i18n'

// The workbench footer: workspace name, the in-use database context, and a
// connection summary that flips the bar's color when anything is live.
@customElement('status-bar')
export class StatusBar extends LitElement {
  @property()
  workspaceName = ''

  /** Name of the ⌘K context; empty hides the segment. */
  @property()
  contextName = ''

  @property({ type: Number })
  connectedCount = 0

  /** Name shown when exactly one database is connected. */
  @property()
  connectedName = ''

  render() {
    const summary =
      this.connectedCount === 0
        ? t('status.notConnected')
        : this.connectedCount === 1
          ? this.connectedName || t('status.oneConnected')
          : t('status.manyConnected', { count: this.connectedCount })

    return html`
      <footer class=${this.connectedCount ? 'connected' : ''}>
        <span>${this.workspaceName || t('app.name')}</span>
        ${this.contextName
          ? html`<span><i class="icon icon-database" aria-hidden="true"></i> ${this.contextName}</span>`
          : ''}
        <span class="spacer"></span>
        <span>${summary}</span>
      </footer>
    `
  }

  static styles = [
    icons,
    css`
      :host {
        display: block;
        flex-shrink: 0;
      }

      footer {
        height: var(--status-bar-h);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        font-size: var(--font-size-sm);
        --icon-size: var(--font-size-sm);
        color: var(--status-bar-fg);
        background: var(--status-bar-disconnected);
      }

      footer.connected {
        background: var(--status-bar-bg);
      }

      .icon {
        vertical-align: -1px;
      }

      .spacer {
        flex: 1;
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'status-bar': StatusBar
  }
}
