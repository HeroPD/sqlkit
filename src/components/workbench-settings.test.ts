// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WorkbenchScreen } from './workbench-screen'

// The settings page covers the sidebar and the editor. Anything reached from
// behind it has to bring that surface back before acting on it, and the view
// commands have to show what was asked for rather than toggle the selection
// the user could not see.
type Probe = {
  settingsOpen: boolean
  _activeView: string | null
  _showView(view: string): void
  _toggleSidebar(): void
  _onActivitySelect(event: CustomEvent<{ view: string }>): void
}

const workbench = (settingsOpen: boolean, activeView: string | null) => {
  const screen = new WorkbenchScreen() as never as Probe
  screen.settingsOpen = settingsOpen
  screen._activeView = activeView
  return screen
}

const select = (screen: Probe, view: string) =>
  screen._onActivitySelect(new CustomEvent('activity-select', { detail: { view } }))

describe('leaving the settings page', () => {
  it('shows the view that was clicked, including the one still marked active', () => {
    const screen = workbench(true, 'explorer')
    select(screen, 'explorer')
    expect(screen).toMatchObject({ settingsOpen: false, _activeView: 'explorer' })

    const other = workbench(true, 'explorer')
    select(other, 'databases')
    expect(other).toMatchObject({ settingsOpen: false, _activeView: 'databases' })
  })

  it('still toggles a view off when settings is not in the way', () => {
    const screen = workbench(false, 'explorer')
    select(screen, 'explorer')
    expect(screen._activeView).toBeNull()
  })

  it('reveals the sidebar rather than toggling it', () => {
    const screen = workbench(true, 'explorer')
    screen._toggleSidebar()
    expect(screen).toMatchObject({ settingsOpen: false, _activeView: 'explorer' })

    const collapsed = workbench(true, null)
    collapsed._toggleSidebar()
    expect(collapsed).toMatchObject({ settingsOpen: false, _activeView: 'explorer' })
  })

  it('keeps toggling the sidebar shut when settings is not open', () => {
    const screen = workbench(false, 'explorer')
    screen._toggleSidebar()
    expect(screen._activeView).toBeNull()
  })

  it('closes settings when the activity bar toggle is used again', () => {
    const screen = workbench(true, 'explorer')
    select(screen, 'settings')
    expect(screen.settingsOpen).toBe(false)
  })
})
