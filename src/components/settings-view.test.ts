// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, DEFAULT_WORKSPACE_PREFERENCES, KEYMAP_COMMANDS, KEYMAP_DEFAULTS, type AppSettings } from '../settings'
import './settings-view'
import type { SettingsView } from './settings-view'

const press = (init: KeyboardEventInit) =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

describe('settings-view', () => {
  let view: SettingsView
  let changes: AppSettings[]

  const show = async (category: string) => {
    const button = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.categories button')]
      .find((entry) => entry.textContent?.includes(category))!
    button.click()
    await view.updateComplete
  }

  beforeEach(async () => {
    document.body.innerHTML = '<settings-view></settings-view>'
    view = document.querySelector('settings-view')!
    view.settings = DEFAULT_APP_SETTINGS
    view.workspacePreferences = DEFAULT_WORKSPACE_PREFERENCES
    changes = []
    view.addEventListener('app-settings-change', (event) => {
      changes.push((event as CustomEvent<AppSettings>).detail)
      view.settings = (event as CustomEvent<AppSettings>).detail
    })
    await view.updateComplete
  })

  it('emits a normalized update when a theme is selected', () => {
    view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.theme')[1]!.click()
    expect(changes).toHaveLength(1)
    expect(changes[0]!.theme).toBe('midnight-blue')
  })

  it('disables workspace settings when no workspace is open', async () => {
    view.workspaceAvailable = false
    await view.updateComplete
    const history = [...view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.categories button')]
      .find((button) => button.textContent?.includes('History'))
    expect(history?.disabled).toBe(true)
  })

  it('turns off the rows a sibling setting governs', async () => {
    view.workspacePreferences = { ...DEFAULT_WORKSPACE_PREFERENCES, saveHistory: false }
    await show('History')
    const controls = view.shadowRoot!.querySelectorAll<HTMLSelectElement | HTMLInputElement>('.control select, .control .number')
    expect(controls.length).toBeGreaterThan(0)
    expect([...controls].every((control) => control.disabled)).toBe(true)
  })

  it('clamps a number back into range and re-shows the accepted value', async () => {
    await show('Editor')
    const input = view.shadowRoot!.querySelector<HTMLInputElement>('.number')!
    input.value = '90'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await view.updateComplete
    expect(changes.at(-1)!.editorFontSize).toBe(20)
    expect(view.shadowRoot!.querySelector<HTMLInputElement>('.number')!.value).toBe('20')
  })

  it('resets only the current category, and disables the button when it is default', async () => {
    view.settings = { ...DEFAULT_APP_SETTINGS, editorFontSize: 18, confirmDestructive: false }
    await show('Editor')
    const reset = view.shadowRoot!.querySelector<HTMLButtonElement>('.reset')!
    expect(reset.disabled).toBe(false)
    reset.click()
    await view.updateComplete
    expect(changes.at(-1)!.editorFontSize).toBe(DEFAULT_APP_SETTINGS.editorFontSize)
    expect(changes.at(-1)!.confirmDestructive).toBe(false)
    expect(view.shadowRoot!.querySelector<HTMLButtonElement>('.reset')!.disabled).toBe(true)
  })

  it('compares object settings structurally, not by key order', async () => {
    view.settings = { ...DEFAULT_APP_SETTINGS, keymapOverrides: { formatSql: 'Mod-Shift-l', runQuery: 'Mod-Shift-e' } }
    await show('Keymap')
    expect(view.shadowRoot!.querySelector<HTMLButtonElement>('.reset')!.disabled).toBe(false)
    view.settings = { ...DEFAULT_APP_SETTINGS, keymapOverrides: {} }
    await view.updateComplete
    expect(view.shadowRoot!.querySelector<HTMLButtonElement>('.reset')!.disabled).toBe(true)
  })

  it('filters row by row, and points at pages that do match', async () => {
    await show('Editor')
    const search = view.shadowRoot!.querySelector<HTMLInputElement>('.search input')!
    search.value = 'wrap'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await view.updateComplete
    const labels = [...view.shadowRoot!.querySelectorAll('.setting-row strong')].map((row) => row.textContent)
    expect(labels).toEqual(['Word wrap'])

    search.value = 'zebra'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await view.updateComplete
    expect(view.shadowRoot!.querySelector('.empty')).toBeTruthy()
    expect(view.shadowRoot!.querySelector('.empty .elsewhere button')?.textContent).toBe('Results')
  })

  describe('shortcut capture', () => {
    const binding = async () => {
      await show('Keymap')
      return view.shadowRoot!.querySelector<HTMLButtonElement>('.binding')!
    }

    it('records a chord only while that row is capturing', async () => {
      const button = await binding()
      // Not capturing: a keystroke passing through must not rebind anything.
      button.dispatchEvent(press({ key: 's', code: 'KeyS', metaKey: true }))
      await view.updateComplete
      expect(changes).toHaveLength(0)

      button.click()
      await view.updateComplete
      button.dispatchEvent(press({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true }))
      await view.updateComplete
      expect(changes.at(-1)!.keymapOverrides.runQuery).toBe('Mod-Shift-e')
    })

    it('cancels on Escape without rebinding, and stays cancelled', async () => {
      const button = await binding()
      button.click()
      await view.updateComplete
      button.dispatchEvent(press({ key: 'Escape', code: 'Escape' }))
      await view.updateComplete
      expect(changes).toHaveLength(0)

      button.dispatchEvent(press({ key: 's', code: 'KeyS', metaKey: true }))
      await view.updateComplete
      expect(changes).toHaveLength(0)
    })

    it('ignores a chord with no modifier and restores the default', async () => {
      const button = await binding()
      button.click()
      await view.updateComplete
      button.dispatchEvent(press({ key: 'a', code: 'KeyA' }))
      await view.updateComplete
      expect(changes).toHaveLength(0)

      view.settings = { ...DEFAULT_APP_SETTINGS, keymapOverrides: { runQuery: 'Mod-Shift-e' } }
      await view.updateComplete
      const again = view.shadowRoot!.querySelector<HTMLButtonElement>('.binding')!
      again.click()
      await view.updateComplete
      again.dispatchEvent(press({ key: 'Enter', code: 'Enter', metaKey: true }))
      await view.updateComplete
      expect(changes.at(-1)!.keymapOverrides).toEqual({})
      expect(KEYMAP_DEFAULTS.runQuery).toBe('Mod-Enter')
    })

    it('narrows the list to the command searched for', async () => {
      await show('Keymap')
      const search = view.shadowRoot!.querySelector<HTMLInputElement>('.search input')!
      search.value = 'format'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await view.updateComplete
      expect([...view.shadowRoot!.querySelectorAll('.key-row strong')].map((row) => row.textContent)).toEqual(['Format SQL'])

      // A term that matches the row itself, not one command, keeps them all.
      search.value = 'hotkey'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await view.updateComplete
      expect(view.shadowRoot!.querySelectorAll('.key-row')).toHaveLength(KEYMAP_COMMANDS.length)
    })

    it('warns when a binding would shadow one of the app\'s fixed chords', async () => {
      // A menu chord no command owns, so only the shadowing check can flag it.
      view.reservedBindings = [{ binding: 'Mod-o', label: 'Open Workspace' }]
      view.settings = { ...DEFAULT_APP_SETTINGS, keymapOverrides: { runQuery: 'Mod-o' } }
      await show('Keymap')
      expect(view.shadowRoot!.querySelectorAll('.binding.conflict')).toHaveLength(1)
      expect(view.shadowRoot!.textContent).toContain('Open Workspace')
    })

    it('keeps waiting, with a hint, when the chord has no modifier', async () => {
      const button = await binding()
      button.click()
      await view.updateComplete
      button.dispatchEvent(press({ key: 'a', code: 'KeyA' }))
      await view.updateComplete
      expect(changes).toHaveLength(0)
      expect(view.shadowRoot!.querySelector('.key-note')?.textContent).toContain('Add')
      // Still capturing: a valid chord straight after is what gets stored.
      button.dispatchEvent(press({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true }))
      await view.updateComplete
      expect(changes.at(-1)!.keymapOverrides.runQuery).toBe('Mod-Shift-e')
    })

    it('marks the commands that share a chord', async () => {
      view.settings = { ...DEFAULT_APP_SETTINGS, keymapOverrides: { runQuery: KEYMAP_DEFAULTS.commandPalette } }
      await show('Keymap')
      expect(view.shadowRoot!.querySelectorAll('.binding.conflict')).toHaveLength(2)
      expect(view.shadowRoot!.querySelector('.key-note')?.classList.contains('conflict')).toBe(true)
    })
  })

  it('asks the host to clear history rather than doing it', async () => {
    const cleared = vi.fn()
    view.addEventListener('settings-clear-history', cleared)
    await show('History')
    view.shadowRoot!.querySelector<HTMLButtonElement>('.danger')!.click()
    expect(cleared).toHaveBeenCalledOnce()
  })
})
