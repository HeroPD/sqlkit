import { isMac } from './platform'
import { parseKeyBinding } from './settings'

// Bindings are stored the way CodeMirror parses them — modifier prefixes plus a
// key name, single characters lowercased — so the same string drives an editor
// keymap and the window-level matcher below. `event.code` names the physical
// key, which keeps a binding working through Option-composed characters (⌥⇧F
// reports "Ï") and non-US layouts.
const eventKeyName = (event: KeyboardEvent) => {
  if (event.code.startsWith('Key')) return event.code.slice(3).toLowerCase()
  if (event.code.startsWith('Digit')) return event.code.slice(5)
  if (event.key === ' ') return 'space'
  return event.key.toLowerCase()
}

export const eventMatchesBinding = (event: KeyboardEvent, binding: string) => {
  const parsed = parseKeyBinding(binding)
  if (!parsed) return false
  return eventKeyName(event) === parsed.key.toLowerCase()
    && (event.metaKey || event.ctrlKey) === parsed.modifiers.includes('Mod')
    && event.altKey === parsed.modifiers.includes('Alt')
    && event.shiftKey === parsed.modifiers.includes('Shift')
}

export const keybindingFromEvent = (event: KeyboardEvent): string | null => {
  if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return null
  const modifiers = [
    event.metaKey || event.ctrlKey ? 'Mod' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean)
  const key = eventKeyName(event)
  const named = key === 'space' ? 'Space' : key.length === 1 ? key : event.key
  const binding = [...modifiers, named].join('-')
  return parseKeyBinding(binding) ? binding : null
}

/** Bindings need a modifier: a bare key would swallow ordinary typing. */
export const isBindable = (binding: string) => (parseKeyBinding(binding)?.modifiers.length ?? 0) > 0

const MAC_SYMBOLS: Record<string, string> = { Alt: '⌥', Shift: '⇧', Mod: '⌘' }
// ⌃⌥⇧⌘ order on macOS, with ⌘ closest to the key.
const MAC_ORDER = ['Alt', 'Shift', 'Mod']

export function displayKeybinding(binding: string) {
  const parsed = parseKeyBinding(binding)
  if (!parsed) return binding
  const { modifiers, key } = parsed
  const name = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  if (!isMac) return [...modifiers.map((modifier) => (modifier === 'Mod' ? 'Ctrl' : modifier)), name].join('+')
  const prefix = MAC_ORDER.filter((modifier) => modifiers.includes(modifier)).map((modifier) => MAC_SYMBOLS[modifier]).join('')
  return prefix + (name === 'Enter' ? '↵' : name)
}
