// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import './status-bar'
import type { StatusBar } from './status-bar'

const internals = (bar: StatusBar) => bar as never as { _open: boolean }

// Escape from a focused control, which that control may claim first (the grid's double-Esc, completion).
const escapeFrom = (target: HTMLElement, claimed: boolean) => {
  const claim = (event: Event) => event.preventDefault()
  if (claimed) target.addEventListener('keydown', claim)
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  target.removeEventListener('keydown', claim)
}

afterEach(() => document.body.replaceChildren())

describe('status-bar popover Escape', () => {
  it('leaves the popover open when the focused control already handled the Escape', async () => {
    const bar = document.createElement('status-bar')
    const grid = document.createElement('div')
    bar.connections = [{ profileId: 'p1', name: 'local', childDb: null, version: null, active: true }]
    document.body.append(bar, grid)
    internals(bar)._open = true
    await bar.updateComplete

    escapeFrom(grid, true)
    expect(internals(bar)._open).toBe(true)

    escapeFrom(grid, false)
    expect(internals(bar)._open).toBe(false)
  })
})
