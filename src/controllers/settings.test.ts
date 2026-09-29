// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import { DEFAULT_APP_SETTINGS } from '../settings'
import { SettingsController } from './settings'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

describe('SettingsController.set', () => {
  // The change shows at once; a write that failed must say so instead of vanishing on the next launch.
  it('reports a save that failed', async () => {
    const setSettings = vi.fn(() => Promise.reject(new Error('EACCES: permission denied')))
    ;(window as never as { sqlkit: { setSettings: typeof setSettings } }).sqlkit = { setSettings }
    const onSaveFailed = vi.fn()
    const ctrl = new SettingsController(host(), { onSaveFailed })

    ctrl.set({ ...DEFAULT_APP_SETTINGS, editorFontSize: 15 })
    await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalledWith('EACCES: permission denied'))
    expect(ctrl.app.editorFontSize).toBe(15)
  })
})
