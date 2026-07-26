// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import './task-sparkline'
import './task-meter'
const mountSparkline = async (values: number[]) => {
  const el = document.createElement('task-sparkline')
  el.values = values
  el.summary = 'summary'
  document.body.append(el)
  await el.updateComplete
  return el
}

const mountMeter = async (used: number, max: number | null) => {
  const el = document.createElement('task-meter')
  el.used = used
  el.max = max
  document.body.append(el)
  await el.updateComplete
  return el
}

const paths = (el: HTMLElement) => ({
  history: el.shadowRoot!.querySelector('.history')?.getAttribute('d') ?? '',
  latest: el.shadowRoot!.querySelector('.latest')?.getAttribute('d') ?? '',
})

describe('task-sparkline', () => {
  it('draws nothing below two points — one run is not a trend', async () => {
    for (const values of [[], [5]]) {
      const el = await mountSparkline(values)
      expect(el.shadowRoot!.querySelector('svg')).toBeNull()
      el.remove()
    }
  })

  it('scales against zero, so height reads as magnitude', async () => {
    const el = await mountSparkline([0, 100])
    const { history } = paths(el)
    const ys = [...history.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((match) => Number(match[1]))
    // 24px box, 1px inset for the stroke cap: zero sits at the bottom, the max at the top.
    expect(ys[0]).toBeCloseTo(23, 1)
    expect(ys[1]).toBeCloseTo(1, 1)
    el.remove()
  })

  it('does not zoom into a narrow band of large values', async () => {
    // With a zero baseline these near-equal values stay near-equal in height,
    // rather than being stretched into a dramatic-looking wiggle.
    const el = await mountSparkline([100, 101, 102])
    const ys = [...paths(el).history.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((match) => Number(match[1]))
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
    el.remove()
  })

  it('carries the most recent run on its own accent path', async () => {
    const el = await mountSparkline([1, 2, 3, 4])
    const { history, latest } = paths(el)
    // The tail is the last segment only: two points, both shared with the history.
    expect(latest.match(/[ML]/g)).toHaveLength(2)
    expect(history.match(/[ML]/g)).toHaveLength(4)
    el.remove()
  })

  it('exposes the summary for assistive tech, since the marks carry no labels', async () => {
    const el = await mountSparkline([1, 2])
    expect(el.shadowRoot!.querySelector('svg')?.getAttribute('aria-label')).toBe('summary')
    expect(el.shadowRoot!.querySelector('title')?.textContent).toBe('summary')
    el.remove()
  })
})

describe('task-meter', () => {
  it('shows a bare track when the server sets no limit', async () => {
    for (const max of [null, 0]) {
      const el = await mountMeter(7, max)
      expect(el.shadowRoot!.querySelector('.track')).not.toBeNull()
      expect(el.shadowRoot!.querySelector('.fill')).toBeNull()
      el.remove()
    }
  })

  it('fills proportionally and reports itself as a meter', async () => {
    const el = await mountMeter(25, 100)
    const fill = el.shadowRoot!.querySelector<HTMLElement>('.fill')!
    expect(fill.style.width).toBe('25%')
    expect(el.shadowRoot!.querySelector('.track')?.getAttribute('aria-valuemax')).toBe('100')
    el.remove()
  })

  it('escalates the fill from accent through warning to danger', async () => {
    for (const [used, level] of [[10, 'ok'], [80, 'warning'], [95, 'danger']] as const) {
      const el = await mountMeter(used, 100)
      expect(el.shadowRoot!.querySelector('.fill')?.className).toContain(level)
      el.remove()
    }
  })

  it('clamps a count that exceeds its own limit', async () => {
    const el = await mountMeter(150, 100)
    expect(el.shadowRoot!.querySelector<HTMLElement>('.fill')!.style.width).toBe('100%')
    el.remove()
  })
})
