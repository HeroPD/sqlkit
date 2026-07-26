import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

// Severity thresholds for a usage meter: comfortable, getting tight, nearly out.
const WARNING_AT = 0.75
const DANGER_AT = 0.9

// A single-bar usage meter. The fill carries severity (accent → warning →
// danger) and the track is a faint step of the accent, so the state reads across
// the whole bar rather than only where the fill ends.
@customElement('task-meter')
export class TaskMeter extends LitElement {
  @property({ type: Number })
  used = 0

  /** null when the server sets no limit — then there is no ratio to draw. */
  @property({ type: Number })
  max: number | null = null

  render() {
    const max = this.max
    if (!max || max <= 0) return html`<div class="track" aria-hidden="true"></div>`
    const ratio = Math.max(0, Math.min(1, this.used / max))
    const level = ratio >= DANGER_AT ? 'danger' : ratio >= WARNING_AT ? 'warning' : 'ok'
    return html`
      <div
        class="track"
        role="meter"
        aria-valuenow=${this.used}
        aria-valuemin="0"
        aria-valuemax=${max}
      >
        <div class="fill ${level}" style=${`width: ${(ratio * 100).toFixed(1)}%`}></div>
      </div>
    `
  }

  static styles = css`
    :host {
      display: block;
    }

    .track {
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      /* A faint step of the accent, not a neutral gray: the unfilled remainder
         still belongs to the same measure. */
      background: color-mix(in srgb, var(--accent) 20%, transparent);
    }

    .fill {
      height: 100%;
      /* Square where it meets the start, rounded at the data end. */
      border-radius: 0 3px 3px 0;
      background: var(--accent);
      transition: width 160ms ease-out;
    }

    .fill.warning {
      background: var(--status-dot-warning);
    }

    .fill.danger {
      background: var(--status-dot-error);
    }

    @media (prefers-reduced-motion: reduce) {
      .fill {
        transition: none;
      }
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'task-meter': TaskMeter
  }
}
