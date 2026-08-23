// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
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

  // jsdom reports a non-mac platform, so these are the Ctrl spellings.
  it('displays a stored binding in the platform spelling', () => {
    expect(displayKeybinding('Mod-Enter')).toBe('Ctrl+Enter')
    expect(displayKeybinding('Shift-Alt-f')).toBe('Shift+Alt+F')
    expect(displayKeybinding('Mod-Shift-p')).toBe('Ctrl+Shift+P')
  })
})
