import { LitElement, css, html } from 'lit'
import { customElement } from 'lit/decorators.js'
import { codicons, controls, typography } from '../shared-styles'

export type EmptyAction = 'add-database' | 'close-workspace'

// Actions grow as features land (New Query, Quick Open, Command Palette in
// the reference); keybind chips return with the keyboard shortcuts.
const ACTIONS: { action: EmptyAction; label: string }[] = [
  { action: 'add-database', label: 'Add Database' },
  { action: 'close-workspace', label: 'Close Workspace' },
]

// Empty-editor placeholder, ported from the reference: brand mark over a list
// of starting actions. Emits `empty-action` with the chosen action; the
// workbench decides what each action runs.
@customElement('editor-empty')
export class EditorEmpty extends LitElement {
  render() {
    return html`
      <div class="mark"><i class="codicon codicon-database" aria-hidden="true"></i></div>
      <h2>SqlKit</h2>
      <p>No query editor is open.</p>
      <div class="actions">
        ${ACTIONS.map(
          (entry) => html`
            <button type="button" @click=${() => this._emit(entry.action)}>
              <span>${entry.label}</span>
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
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-empty': EditorEmpty
  }
}
