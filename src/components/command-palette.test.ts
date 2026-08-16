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
      action: { id: 'disconnect', label: 'Disconnect Database', icon: 'icon-unplug' },
    }]
    document.body.append(palette)
    await palette.updateComplete

    expect(palette.shadowRoot?.querySelector('.label-bar')?.getAttribute('style')).toContain('#b2054c')
    expect(palette.shadowRoot?.querySelector('engine-badge')).toBeTruthy()
    expect(palette.shadowRoot?.querySelector('.label-wrap')?.getAttribute('data-tooltip')).toBeNull()
    expect(palette.shadowRoot?.querySelector('.connection-status.connected')?.textContent).toContain('Connected')
    expect(palette.shadowRoot?.querySelector('.in-use')?.textContent).toContain('In use')
    expect(palette.shadowRoot?.querySelector('.row-action')?.getAttribute('aria-label')).toBe('Disconnect Database')
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

  it('dispatches a trailing action without picking its database row', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'databases'
    palette.entries = [{
      id: 'db:p1',
      label: 'Production',
      connection: true,
      action: { id: 'disconnect', label: 'Disconnect Database', icon: 'icon-unplug' },
    }]
    const actions: unknown[] = []
    const picks: unknown[] = []
    palette.addEventListener('palette-action', (event) => actions.push((event as CustomEvent).detail))
    palette.addEventListener('palette-pick', (event) => picks.push((event as CustomEvent).detail))
    document.body.append(palette)
    await palette.updateComplete

    palette.shadowRoot?.querySelector<HTMLElement>('.row-action')?.click()

    expect(actions).toEqual([{ mode: 'databases', id: 'db:p1', action: 'disconnect' }])
    expect(picks).toEqual([])
  })

  it('keeps keyboard focus through row clicks and asynchronous entry updates', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'databases'
    palette.entries = [{ id: 'db:p1', label: 'Production', connection: true, status: 'disconnected' }]
    document.body.append(palette)
    await palette.updateComplete

    const row = palette.shadowRoot!.querySelector('.row')!
    const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(pointerDown)
    expect(pointerDown.defaultPrevented).toBe(true)
    expect(palette.shadowRoot!.activeElement).toBe(palette.shadowRoot!.querySelector('input'))

    // Status pushes rebuild the entry list while a connection opens. If focus
    // escaped during that transition, the still-open modal takes it back.
    outside.focus()
    palette.entries = [
      { id: 'db:p1', label: 'Production', connection: true, status: 'connecting' },
      { id: 'db:p2', label: 'Analytics', connection: true, status: 'disconnected' },
    ]
    await palette.updateComplete
    const input = palette.shadowRoot!.querySelector('input')!
    expect(palette.shadowRoot!.activeElement).toBe(input)

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await palette.updateComplete
    expect(palette.shadowRoot!.querySelector('.row.active')?.textContent).toContain('Analytics')
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

  it('renders a commands section label without the connection tracks', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'commands'
    palette.entries = [
      { id: 'group:editor', label: 'Editor & Run', header: true },
      { id: 'new-query', label: 'New Query', keybind: '⌘N' },
    ]
    document.body.append(palette)
    await palette.updateComplete

    const header = palette.shadowRoot!.querySelector('.row.group')!
    expect(header.classList.contains('section')).toBe(true)
    expect(header.classList.contains('connection')).toBe(false)
    expect(header.getAttribute('role')).toBe('presentation')
    expect(header.querySelector('.label-bar')).toBeNull()
    // the first pickable row is the command, not the label above it
    expect(palette.shadowRoot!.querySelector('.row.active')?.textContent).toContain('New Query')
  })

  it('keeps the identity tracks on a ⌘K group header', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'databases'
    palette.entries = [
      { id: 'hdr:p1', label: 'Cluster', connection: true, header: true, accentColor: '#c45b18', status: 'connected' },
      { id: 'child:p1:app', label: 'app', connection: true, indent: true },
    ]
    document.body.append(palette)
    await palette.updateComplete

    const header = palette.shadowRoot!.querySelector('.row.group')!
    expect(header.classList.contains('connection')).toBe(true)
    expect(header.classList.contains('section')).toBe(false)
    expect(header.querySelector('.label-bar')?.getAttribute('style')).toContain('#c45b18')
  })

  it('drops the section labels as soon as something is typed', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'commands'
    palette.entries = [
      { id: 'group:recent', label: 'recently used', header: true },
      { id: 'toggle-sidebar', label: 'View: Toggle Sidebar' },
      { id: 'group:other', label: 'other commands', header: true },
      { id: 'new-query', label: 'File: New Query' },
      { id: 'toggle-results-panel', label: 'Results: Toggle Results Panel' },
    ]
    document.body.append(palette)
    await palette.updateComplete
    expect(palette.shadowRoot!.querySelectorAll('.row.group')).toHaveLength(2)

    const input = palette.shadowRoot!.querySelector('input')!
    input.value = 'tog'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await palette.updateComplete

    // a ranked list has nothing for a label to sit above
    expect(palette.shadowRoot!.querySelectorAll('.row.group')).toHaveLength(0)
    expect([...palette.shadowRoot!.querySelectorAll('.row')].map((row) => row.textContent?.trim()))
      .toEqual(['View: Toggle Sidebar', 'Results: Toggle Results Panel'])
    // the category is part of what is matched, not decoration
    input.value = 'results tog'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await palette.updateComplete
    expect(palette.shadowRoot!.querySelectorAll('.row')).toHaveLength(1)
  })

  it('keeps ⌘K group headers through a filter, unlike section labels', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'databases'
    palette.entries = [
      { id: 'hdr:p1', label: 'Cluster', connection: true, header: true },
      { id: 'child:p1:analytics', label: 'analytics', connection: true, indent: true },
      { id: 'child:p1:app', label: 'app', connection: true, indent: true },
    ]
    document.body.append(palette)
    await palette.updateComplete

    const input = palette.shadowRoot!.querySelector('input')!
    input.value = 'ana'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await palette.updateComplete

    expect(palette.shadowRoot!.querySelectorAll('.row.group')).toHaveLength(1)
    expect(palette.shadowRoot!.querySelectorAll('.row.indent')).toHaveLength(1)
  })

  it('keeps a section label out of the keyboard walk', async () => {
    const palette = new CommandPalette()
    palette.open = true
    palette.mode = 'commands'
    palette.entries = [
      { id: 'group:editor', label: 'Editor & Run', header: true },
      { id: 'new-query', label: 'New Query' },
      { id: 'group:view', label: 'View', header: true },
      { id: 'toggle-sidebar', label: 'Toggle Sidebar' },
    ]
    document.body.append(palette)
    await palette.updateComplete

    const input = palette.shadowRoot!.querySelector('input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await palette.updateComplete
    // one step past New Query skips the View label onto the row under it
    expect(palette.shadowRoot!.querySelector('.row.active')?.textContent).toContain('Toggle Sidebar')
  })
})
