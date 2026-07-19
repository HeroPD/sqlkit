import { LitElement, css, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { codicons, controls, typography } from '../shared-styles'
import { isMac, mod } from '../platform'
import { t } from '../i18n'

export type EmptyAction =
  | 'new-query'
  | 'quick-open'
  | 'switch-database'
  | 'command-palette'
  | 'add-database'
  | 'close-workspace'

const ACTIONS: { action: EmptyAction; label: string; kbd?: string }[] = [
  { action: 'new-query', label: t('action.newQuery'), kbd: mod('N') },
  { action: 'quick-open', label: t('action.quickOpen').replace(/…$/, ''), kbd: mod('P') },
  { action: 'switch-database', label: t('action.switchDatabase').replace(/…$/, ''), kbd: mod('K') },
  { action: 'command-palette', label: t('action.commandPalette'), kbd: isMac ? '⇧⌘P' : 'Ctrl+Shift+P' },
  { action: 'add-database', label: t('action.addDatabase') },
  { action: 'close-workspace', label: t('action.closeWorkspace') },
]

// Empty-editor placeholder, ported from the reference: brand mark over a list
// of starting actions. Emits `empty-action` with the chosen action; the
// workbench decides what each action runs.
@customElement('editor-empty')
export class EditorEmpty extends LitElement {
  render() {
    return html`
      <div class="mark"><i class="codicon codicon-database" aria-hidden="true"></i></div>
      <h2>${t('app.name')}</h2>
      <p>${t('empty.noEditor')}</p>
      <div class="actions">
        ${ACTIONS.map(
          (entry) => html`
            <button type="button" @click=${() => this._emit(entry.action)}>
              <span>${entry.label}</span>
              ${entry.kbd ? html`<kbd>${entry.kbd}</kbd>` : ''}
            </button>
          `,
        )}
      </div>
    `
  }

  private _emit(action: EmptyAction) {
    this.dispatchEvent(new CustomEvent('empty-action', { detail: { action }, bubbles: true, composed: true }))
  }

  static styles = [
    typography,
    controls,
    codicons,
    css`
      :host {
        display: block;
        width: min(360px, calc(100% - 48px));
        margin-top: -32px;
        text-align: center;
        color: var(--text-2);
      }

      .mark {
        width: 54px;
        height: 54px;
        margin: 0 auto 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
        background: var(--sidebar-bg);
        color: var(--accent);
      }

      .mark .codicon {
        font-size: 26px;
      }

      h2 {
        margin-bottom: 6px;
      }

      p {
        margin-bottom: 18px;
      }

      .actions {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .actions button {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        width: 100%;
        height: auto;
        padding: 7px 9px 7px 12px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--text-2);
        text-align: left;
      }

      .actions button:hover,
      .actions button:focus-visible {
        background: var(--list-hover);
        color: var(--text);
        outline: none;
      }

      .actions kbd {
        flex-shrink: 0;
        padding: 1px 6px;
        font-family: inherit;
        font-size: var(--font-size-sm);
        color: var(--text-3);
        background: var(--btn-secondary-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 3px;
      }

      .actions button:hover kbd {
        color: var(--text-2);
      }
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-empty': EditorEmpty
  }
}
