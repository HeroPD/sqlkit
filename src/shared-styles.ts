import { css, unsafeCSS } from 'lit'
import codiconCss from './codicons/codicon.css?inline'

// The codicon icon classes (.codicon-files etc.), for use inside shadow
// roots. The @font-face itself only registers at document level (imported in
// index.css); this module carries the per-icon class rules.
export const codicons = unsafeCSS(codiconCss)

// App-wide typography standard. Every component composes this into its styles
// (`static styles = [typography, css\`...\`]`) so h1/h2/h3/p look identical
// everywhere; components add only layout (margins, gaps) on top.
//
// Scale (matches the token comments in index.css):
//   h1 — page & brand titles        (--font-size-2xl)
//   h2 — inline / empty-state heads (--font-size-xl)
//   h3 — uppercase section labels   (--font-size-sm)
//   p  — body text; add .muted for helper text
export const typography = css`
  h1 {
    font-size: var(--font-size-2xl);
    font-weight: 300;
    letter-spacing: -0.02em;
    color: var(--text);
    margin: 0;
  }

  h2 {
    font-size: var(--font-size-xl);
    font-weight: 600;
    color: var(--text);
    margin: 0;
  }

  h3 {
    font-size: var(--font-size-sm);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin: 0;
  }

  h4 {
    font-size: var(--font-size);
    font-weight: 700;
    color: var(--text);
    margin: 0;
  }

  p {
    font-size: var(--font-size);
    color: var(--text-2);
    margin: 0;
  }

  .muted {
    color: var(--text-3);
  }

  .small {
    font-size: var(--font-size-sm);
  }
`

// App-wide control standard: every input, select, and button looks the same.
// Buttons come in three variants — `primary` (accent fill), `secondary`
// (subtle fill), and `link` (borderless accent text, used in lists/sidebars).
// Components add only layout (margins, widths) on top.
export const controls = css`
  input,
  select {
    width: 100%;
    height: var(--control-h);
    padding: 0 12px;
    font-size: var(--font-size);
    font-family: var(--ui-font);
    color: var(--input-fg);
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    box-sizing: border-box;
    outline: none;
  }

  select {
    color-scheme: dark;
  }

  input::placeholder {
    color: var(--input-placeholder);
  }

  input:focus,
  select:focus {
    border-color: var(--input-focus-border);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--input-focus-border) 35%, transparent);
  }

  input:disabled,
  select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  button {
    height: var(--control-h);
    padding: 0 14px;
    font-family: inherit;
    font-size: var(--font-size);
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }

  button:focus-visible {
    outline: 1px solid var(--focus-border);
  }

  button.primary {
    color: var(--btn-fg);
    background: var(--btn-bg);
  }

  button.primary:hover {
    background: var(--btn-hover);
  }

  button.secondary {
    color: var(--btn-secondary-fg);
    background: var(--btn-secondary-bg);
  }

  button.secondary:hover {
    background: var(--btn-secondary-hover);
  }

  button.link {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: auto;
    padding: 6px 10px;
    color: var(--accent);
    background: transparent;
    text-align: left;
  }

  button.link:hover {
    background: var(--list-hover);
  }
`
