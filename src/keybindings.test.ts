// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { displayKeybinding, eventMatchesBinding, isBindable, keybindingFromEvent } from './keybindings'
import { KEYMAP_DEFAULTS } from './settings'

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('key bindings', () => {
  it('matches modifiers and the physical key', () => {
    const optionShiftF = press({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true })
    expect(eventMatchesBinding(optionShiftF, KEYMAP_DEFAULTS.formatSql)).toBe(true)
    expect(eventMatchesBinding(optionShiftF, 'Mod-f')).toBe(false)
    expect(eventMatchesBinding(press({ key: 'Enter', code: 'Enter', metaKey: true }), 'Mod-Enter')).toBe(true)
  })

  // The capture field and the matcher have to agree, or a recorded shortcut is
  // stored looking right and never fires.
  it('records what the matcher will match, through composed keys and case', () => {
    for (const event of [
      press({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true }),
      press({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true }),
      press({ key: 'e', code: 'KeyE', metaKey: true }),
      press({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true }),
      press({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }),
    ]) {
      const binding = keybindingFromEvent(event)
      expect(binding).toBeTruthy()
      expect(eventMatchesBinding(event, binding!), binding!).toBe(true)
    }
  })

  it('stores letters lowercased, the form CodeMirror also parses', () => {
    expect(keybindingFromEvent(press({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true }))).toBe('Mod-Shift-e')
    expect(keybindingFromEvent(press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull()
  })

  it('requires a modifier so a bare key cannot swallow typing', () => {
    expect(isBindable('Mod-Shift-e')).toBe(true)
    expect(isBindable('f')).toBe(false)
  })

  it('treats Ctrl as Mod off macOS', () => {
    expect(eventMatchesBinding(press({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }), 'Mod-Shift-p')).toBe(true)
  })

  // ⌃P, ⌃N and ⌃B move the caret in every macOS text field; only ⌘ is Mod there.
  it('leaves Control to the text field on macOS', async () => {
    vi.resetModules()
    vi.doMock('./platform', () => ({ isMac: true, mod: (key: string) => `⌘${key}` }))
    try {
      const mac = await import('./keybindings')
      const controlP = press({ key: 'p', code: 'KeyP', ctrlKey: true })
      expect(mac.eventMatchesBinding(controlP, 'Mod-p')).toBe(false)
      expect(mac.keybindingFromEvent(controlP)).toBeNull()
      expect(mac.eventMatchesBinding(press({ key: 'p', code: 'KeyP', ctrlKey: true, metaKey: true }), 'Mod-p')).toBe(false)
      expect(mac.eventMatchesBinding(press({ key: 'p', code: 'KeyP', metaKey: true }), 'Mod-p')).toBe(true)
      expect(mac.keybindingFromEvent(press({ key: 'p', code: 'KeyP', metaKey: true }))).toBe('Mod-p')
    } finally {
      vi.doUnmock('./platform')
      vi.resetModules()
    }
  })

  // jsdom reports a non-mac platform, so these are the Ctrl spellings.
  it('displays a stored binding in the platform spelling', () => {
    expect(displayKeybinding('Mod-Enter')).toBe('Ctrl+Enter')
    expect(displayKeybinding('Shift-Alt-f')).toBe('Shift+Alt+F')
    expect(displayKeybinding('Mod-Shift-p')).toBe('Ctrl+Shift+P')
  })
})
