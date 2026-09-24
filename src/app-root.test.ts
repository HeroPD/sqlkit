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

  it('holds Open Workspace while a workbench dialog is waiting on an answer', () => {
    const root = new AppRoot() as never as {
      _onOpenFolder: ReturnType<typeof vi.fn>
      _workbench(): { hasModal(): boolean } | null
      _onMenuAction(action: 'open-workspace'): void
    }
    root._onOpenFolder = vi.fn()
    let modal = true
    root._workbench = () => ({ hasModal: () => modal })

    root._onMenuAction('open-workspace')
    expect(root._onOpenFolder).not.toHaveBeenCalled()

    modal = false
    root._onMenuAction('open-workspace')
    expect(root._onOpenFolder).toHaveBeenCalledOnce()
  })

  it('opens the workspace a window was created to restore', async () => {
    const root = new AppRoot() as never as {
      _screen: string
      _workspace: { name: string; path: string } | null
      _loadRecents(): Promise<void>
      _openPending(): Promise<void>
    }
    root._loadRecents = () => Promise.resolve()
    ;(window as unknown as { sqlkit: unknown }).sqlkit = {
      openPendingWorkspace: () => Promise.resolve({ success: true, path: '/ws', name: 'ws' }),
    }
    await root._openPending()
    expect(root._screen).toBe('workbench')
    expect(root._workspace).toEqual({ name: 'ws', path: '/ws' })
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
