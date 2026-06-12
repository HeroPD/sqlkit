import { LitElement, css, html, type PropertyValues } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import { mod } from '../platform'
import type { InspectSection } from '../electron'

// The Server sidebar view: cluster/database-scoped reference — extensions,
// roles, tablespaces, non-default settings — as collapsible groups with
// counts, the value/description in each row's tooltip. Fetches its own data
// for the active context; remounting (view switches) refreshes it.
@customElement('server-view')
export class ServerView extends LitElement {
  /** Connected profile to describe; null shows the connect hint. */
  @property()
  profileId: string | null = null

  @state()
  private _state:
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'error'; error: string }
    | { phase: 'done'; sections: InspectSection[] } = { phase: 'idle' }

  @state()
  private _expanded = new Set<string>()

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('profileId')) void this._load()
  }

  private async _load() {
    const profileId = this.profileId
    if (!profileId) {
      this._state = { phase: 'idle' }
      return
    }
    this._state = { phase: 'loading' }
    const result = await window.sqlkit.inspectServer(profileId)
    if (this.profileId !== profileId) return
    this._state = result.success ? { phase: 'done', sections: result.sections } : { phase: 'error', error: result.error }
  }

  render() {
    const state = this._state
    if (state.phase === 'idle') {
      return html`<p class="muted hint">Connect a database to see its server (${mod('K')}).</p>`
    }
    if (state.phase === 'loading') {
      return html`<p class="muted hint">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i> Loading server info…
      </p>`
    }
    if (state.phase === 'error') return html`<p class="muted hint error">${state.error}</p>`

    return html`
      <div class="list">
        ${state.sections.map((section) => this._renderSection(section))}
      </div>
    `
  }

  private _renderSection(section: InspectSection) {
    const expanded = this._expanded.has(section.title)
    return html`
      <button class="group" @click=${() => this._toggle(section.title)}>
        <i class="codicon codicon-chevron-right chevron ${expanded ? 'expanded' : ''}" aria-hidden="true"></i>
        <span>${section.title}</span>
        <span class="count">${section.rows.length}</span>
      </button>
      ${expanded
        ? section.rows.map(
            (row) => html`
              <div class="row" title="${row.name}${row.definition ? ` — ${row.definition}` : ''}">
                <span class="name">${row.name}</span>
                ${row.definition ? html`<span class="detail">${row.definition}</span>` : ''}
              </div>
            `,
          )
        : ''}
    `
  }

  private _toggle(title: string) {
    const expanded = new Set(this._expanded)
    if (!expanded.delete(title)) expanded.add(title)
    this._expanded = expanded
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }

      .hint {
        padding: 0 20px;
      }

      .hint.error {
        color: var(--status-dot-error);
      }

      .list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .group {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        padding: 3px 10px 3px 8px;
        border: none;
        background: transparent;
        color: var(--text);
        font-size: var(--font-size);
        font-family: inherit;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        flex-shrink: 0;
      }

      .group:hover {
        background: var(--list-hover);
      }

      .chevron {
        font-size: 14px;
        transition: transform 0.1s;
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .count {
        margin-left: auto;
        font-size: var(--font-size-sm);
        color: var(--text-3);
      }

      .row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 2px 10px 2px 28px;
        white-space: nowrap;
        user-select: none;
      }

      .row:hover {
        background: var(--list-hover);
      }

      .name {
        flex-shrink: 0;
        font-size: var(--font-size);
        color: var(--text-2);
      }

      .detail {
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: var(--font-size);
        color: var(--text-2);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'server-view': ServerView
  }
}
