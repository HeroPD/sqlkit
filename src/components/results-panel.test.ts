// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import './results-panel'

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: (text: string) => ({ width: text.length * 8 }) }),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

async function mount() {
  const el = document.createElement('results-panel')
  el.editable = true
  el.run = {
    phase: 'done',
    result: {
      columns: ['editable', 'readonly'],
      rows: [['old', 'locked']],
      rowCount: 1,
      durationMs: 1,
    },
  }
  document.body.append(el)
  await el.updateComplete
  return el
}

describe('results-panel editability', () => {
  it('opens inline editing for any result cell', async () => {
    const el = await mount()
    const cells = el.shadowRoot!.querySelectorAll<HTMLTableCellElement>('tbody tr[data-row] td:not(.num)')

    cells[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')?.value).toBe('locked')

    cells[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('.cell-edit')?.value).toBe('old')
    el.remove()
  })
})

describe('results-panel collapse toggle', () => {
  const collapseButton = (el: HTMLElement) =>
    el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label$="results panel"]')!

  it('toggles the chevron and dispatches toggle-collapse on click', async () => {
    const el = await mount()
    const toggled = vi.fn()
    el.addEventListener('toggle-collapse', toggled)

    const button = collapseButton(el)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.querySelector('.codicon-chevron-down')).toBeTruthy()

    button.click()
    expect(toggled).toHaveBeenCalledOnce()

    // The owner drives the collapsed state back down; the chevron follows it.
    ;(el as unknown as { collapsed: boolean }).collapsed = true
    await el.updateComplete
    const flipped = collapseButton(el)
    expect(flipped.getAttribute('aria-expanded')).toBe('false')
    expect(flipped.querySelector('.codicon-chevron-up')).toBeTruthy()
    el.remove()
  })

  it('shows the collapse button even with no result', async () => {
    const el = document.createElement('results-panel')
    el.run = { phase: 'idle' }
    document.body.append(el)
    await el.updateComplete
    expect(collapseButton(el)).toBeTruthy()
    el.remove()
  })
})
