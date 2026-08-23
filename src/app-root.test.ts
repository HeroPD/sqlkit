// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { AppRoot } from './app-root'

describe('AppRoot menu actions', () => {
  it('routes Open Workspace through the shared folder picker flow', () => {
    const root = new AppRoot() as never as {
      _onOpenFolder: ReturnType<typeof vi.fn>
      _onMenuAction(action: 'open-workspace'): void
    }
    root._onOpenFolder = vi.fn()

    root._onMenuAction('open-workspace')

    expect(root._onOpenFolder).toHaveBeenCalledOnce()
  })

  it('opens settings from the menu and remembers the screen to return to', () => {
    const root = new AppRoot() as never as {
      _screen: string
      _settingsReturn: string
      _onMenuAction(action: 'settings'): void
    }
    root._screen = 'welcome'

    root._onMenuAction('settings')

    expect(root._screen).toBe('settings')
    expect(root._settingsReturn).toBe('welcome')
  })
})
