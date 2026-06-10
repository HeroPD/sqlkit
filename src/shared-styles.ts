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
    font-weight: 400;
    color: var(--text-2);
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

  p {
    font-size: var(--font-size);
    color: var(--text-2);
    margin: 0;
  }

  .muted {
    color: var(--text-3);
  }
`
