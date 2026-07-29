// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './command-palette'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('CommandPalette', () => {
  it('renders connection identity, semantic status, in-use context, and keyboard hints', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'databases'
    palette.entries = [{
      id: 'db:p1',
      label: 'Production',
      engine: 'postgresql',
      connection: true,
      accentColor: '#b2054c',
      status: 'connected',
      statusLabel: 'Connected',
      inUse: true,
    }]
    document.body.append(palette)
    await palette.updateComplete

    expect(palette.shadowRoot?.querySelector('.label-bar')?.getAttribute('style')).toContain('#b2054c')
    expect(palette.shadowRoot?.querySelector('engine-badge')).toBeTruthy()
    expect(palette.shadowRoot?.querySelector('.label-wrap')?.getAttribute('data-tooltip')).toBeNull()
    expect(palette.shadowRoot?.querySelector('.connection-status.connected')?.textContent).toContain('Connected')
    expect(palette.shadowRoot?.querySelector('.in-use')?.textContent).toContain('In use')
    expect(palette.shadowRoot?.querySelector('.palette-shortcut')?.textContent).toMatch(/k$/i)
    expect(palette.shadowRoot?.querySelector('.palette-footer')?.textContent).toContain('↑↓Navigate')
    expect(palette.shadowRoot?.querySelector('.palette-footer')?.textContent).toContain('↵Select')
    expect(palette.shadowRoot?.querySelector('.palette-footer')?.textContent).toContain('escClose')

    vi.useFakeTimers()
    palette.shadowRoot?.querySelector('.label-wrap')?.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(400)
    await palette.updateComplete
    expect(palette.shadowRoot?.querySelector('.name-tooltip-anchor')?.getAttribute('data-tooltip')).toBe('Production')
    expect(palette.shadowRoot?.querySelector('.list .name-tooltip-anchor')).toBeNull()
  })

  it('shows the shortcut for the current palette mode in the field', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'quick'
    palette.entries = [{ id: 'file:a.sql', label: 'a.sql' }]
    document.body.append(palette)
    await palette.updateComplete

    expect(palette.shadowRoot?.querySelector('.palette-shortcut')?.textContent).toMatch(/p$/i)
  })
})
