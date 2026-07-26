import { LitElement, css, html, svg } from 'lit'
import { customElement, property } from 'lit/decorators.js'

// A sidebar-width trend line: no axes, no legend (one series, the label names
// it), 2px round-capped stroke in the de-emphasis hue with the most recent
// segment in the accent — the stat-tile trend contract. At ~4px per point a
// per-point tooltip would be unhittable, so the summary rides on <title>.
@customElement('task-sparkline')
export class TaskSparkline extends LitElement {
  /** Oldest → newest. Fewer than two points renders nothing. */
  @property({ attribute: false })
  values: number[] = []

  /** Read out by assistive tech and on hover, since the marks carry no labels. */
  @property()
  summary = ''

  render() {
    const values = this.values
    if (values.length < 2) return html`<div class="empty" aria-hidden="true"></div>`

    const width = 100
    const height = 24
    // Baseline at zero so the line's height reads as magnitude, not as a
    // zoomed-in wiggle around the minimum.
    const max = Math.max(...values, 1)
    const stepX = width / (values.length - 1)
    const points = values.map((value, index) => {
      const x = index * stepX
      // Inset by the stroke's half-width so the cap never clips at the edges.
      const y = height - 1 - (value / max) * (height - 2)
      return [x, y] as const
    })
    const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
    // The last segment carries the accent: "where it is now" against its history.
    const tail = points.slice(-2)
    const tailPath = tail.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')

    return html`
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label=${this.summary}>
        ${svg`<title>${this.summary}</title>
          <path class="history" d=${path} />
          <path class="latest" d=${tailPath} />`}
      </svg>
    `
  }

  static styles = css`
    :host {
      display: block;
      height: 24px;
    }

    .empty {
      height: 24px;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
      /* preserveAspectRatio="none" would scale the stroke with the box; this
         keeps it 2px however wide the sidebar is dragged. */
      vector-effect: non-scaling-stroke;
      overflow: visible;
    }

    path {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }

    .history {
      stroke: var(--text-3);
    }

    .latest {
      stroke: var(--accent);
    }
  `
}

declare global {
  interface HTMLElementTagNameMap {
    'task-sparkline': TaskSparkline
  }
}
