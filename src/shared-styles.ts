import { css, unsafeCSS } from 'lit'
import iconCss from './icons/lucide.css?inline'

// The Lucide icon classes (.icon, .icon-files etc.), for use inside shadow
// roots. The @font-face registers at document level (imported in index.css);
// the 'lucide' family is then usable everywhere, so this module just carries
// the class rules. Sizing follows font-size, driven by --icon-size set on any
// ancestor (it inherits) — see the `.icon` base rule in lucide.css.
export const icons = [unsafeCSS(iconCss)]

// App-wide scrollbar standard (matches the reference app): thin, transparent
// track, rounded thumb inset by a 2px transparent border. Document-level
// scrollbar styles don't reach into shadow roots, so every component with a
// scroll area composes this; index.css carries the same rules for the
// document itself.
export const scrollbars = css`
  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: var(--scrollbar-thumb-hover);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  ::-webkit-scrollbar-corner {
    background: transparent;
  }
`

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

// App-wide overlay standard: the dimmed backdrop and floating panel every
// modal composes. The surface matches context-menu (elevated bg, subtle
// border, 10px radius, soft shadow); content text runs at 13px like the menus
// and result grid, with .small staying at --font-size-sm. Dialogs add only
// layout (width, padding, gap, overflow) on top.
export const overlay = css`
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .panel {
    display: flex;
    flex-direction: column;
    font-size: 13px;
    background: var(--overlay-bg);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.28),
      0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .panel :is(p, input, select, button) {
    font-size: 13px;
  }

  .panel .small {
    font-size: var(--font-size-sm);
  }
`

// App-wide control standard: every input, select, and button looks the same.
// Buttons are bordered tinted surfaces matching the overlay aesthetic —
// `primary` (accent tint), `secondary` (neutral tint), and `link` (borderless
// accent text, used in lists/sidebars). Components add only layout on top.
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
    border-radius: 6px;
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
    padding: 0 12px;
    font-family: var(--ui-font);
    font-size: var(--font-size);
    border: 1px solid transparent;
    border-radius: 6px;
    box-sizing: border-box;
    cursor: pointer;
  }

  button:focus-visible {
    outline: 1px solid var(--focus-border);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.primary {
    color: var(--on-accent);
    background: var(--accent);
  }

  button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  button.secondary {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 5%, transparent);
    border-color: var(--border-subtle);
  }

  button.secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 10%, transparent);
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

// App-wide hover tooltip: any element with a data-tooltip attribute grows a
// delayed floating label. Defaults to below-center; add .tooltip-up to open
// above (bottom bars), .tooltip-start / .tooltip-end to hug an edge instead
// of centering (elements near a window edge). Font resets keep the label
// legible inside uppercase/spaced contexts like panel heads.
export const tooltip = css`
  [data-tooltip] {
    position: relative;
  }

  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    top: calc(100% + 7px);
    left: 50%;
    z-index: 20;
    padding: 5px 7px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
    font-family: var(--ui-font);
    font-size: var(--font-size-sm);
    font-weight: 400;
    letter-spacing: normal;
    line-height: 1.25;
    text-transform: none;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    translate: -50% -2px;
    transition:
      opacity 80ms ease,
      visibility 0s linear 80ms,
      translate 80ms ease;
  }

  [data-tooltip]:hover::after,
  [data-tooltip]:focus-visible::after {
    opacity: 1;
    visibility: visible;
    translate: -50% 0;
    transition-delay: 400ms;
  }

  .tooltip-up[data-tooltip]::after {
    top: auto;
    bottom: calc(100% + 7px);
    translate: -50% 2px;
  }

  :is(.tooltip-start, .tooltip-end)[data-tooltip]::after {
    translate: 0 -2px;
  }

  .tooltip-up:is(.tooltip-start, .tooltip-end)[data-tooltip]::after {
    translate: 0 2px;
  }

  .tooltip-start[data-tooltip]::after {
    left: 0;
  }

  .tooltip-end[data-tooltip]::after {
    right: 0;
    left: auto;
  }

  .tooltip-up[data-tooltip]:hover::after,
  .tooltip-up[data-tooltip]:focus-visible::after {
    translate: -50% 0;
  }

  :is(.tooltip-start, .tooltip-end)[data-tooltip]:hover::after,
  :is(.tooltip-start, .tooltip-end)[data-tooltip]:focus-visible::after {
    translate: 0 0;
  }
`
