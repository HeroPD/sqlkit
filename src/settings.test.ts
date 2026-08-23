import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_MIGRATIONS,
  APP_SETTINGS_VERSION,
  APP_SETTING_FIELDS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_WORKSPACE_PREFERENCES,
  KEYMAP_COMMANDS,
  KEYMAP_DEFAULTS,
  MENU_KEYMAP_COMMANDS,
  RESERVED_BINDINGS,
  SETTING_ACTIONS,
  SETTING_CATEGORIES,
  WORKSPACE_SETTING_FIELDS,
  effectiveKeymapBindings,
  acceleratorFor,
  fieldsForCategory,
  migrateAppSettings,
  normalizeAppSettings,
  normalizeWorkspacePreferences,
  parseKeyBinding,
  validateAppSettings,
  validateWorkspacePreferences,
  type SettingField,
} from './settings'

const allFields = [...Object.values(APP_SETTING_FIELDS), ...Object.values(WORKSPACE_SETTING_FIELDS)] as SettingField[]

// Guards that hold for any field added later, so a new option cannot quietly
// land in a page that never renders it or with a default its own rules reject.
describe('setting schema', () => {
  it('places every field in a declared category and reachable page', () => {
    const categories = new Set(SETTING_CATEGORIES.map((category) => category.id))
    for (const field of allFields) {
      expect(categories, field.label).toContain(field.category)
      expect(field.label.length, field.label).toBeGreaterThan(0)
      expect(field.description.length, field.label).toBeGreaterThan(0)
    }
    for (const field of allFields) {
      // A keymap field must describe what it governs, or its page renders blank.
      if (field.kind !== 'keymap') continue
      expect(field.commands.length, field.label).toBeGreaterThan(0)
      for (const command of field.commands) expect(field.defaults, command.id).toHaveProperty(command.id)
    }
    for (const category of SETTING_CATEGORIES) {
      const rows = fieldsForCategory(category.id).length
      const actions = SETTING_ACTIONS.filter((action) => action.category === category.id).length
      expect(rows + actions, category.id).toBeGreaterThan(0)
    }
  })

  it('gives every command a distinct, usable default chord', () => {
    const seen = new Map<string, string>()
    for (const command of KEYMAP_COMMANDS) {
      const binding = KEYMAP_DEFAULTS[command.id as keyof typeof KEYMAP_DEFAULTS]
      expect(binding, command.id).toBeTruthy()
      expect(parseKeyBinding(binding), `${command.id}: ${binding}`).not.toBeNull()
      expect(seen.get(binding), `${binding} is also ${seen.get(binding)}`).toBeUndefined()
      seen.set(binding, command.id)
    }
    // A default must not sit on a chord the menu bar keeps for itself.
    for (const reserved of RESERVED_BINDINGS) {
      expect(seen.get(reserved.binding), `${reserved.binding} (${reserved.label})`).toBeUndefined()
    }
  })

  it('accepts its own defaults through both validators', () => {
    expect(validateAppSettings(DEFAULT_APP_SETTINGS)).toEqual(DEFAULT_APP_SETTINGS)
    expect(validateWorkspacePreferences(DEFAULT_WORKSPACE_PREFERENCES)).toEqual(DEFAULT_WORKSPACE_PREFERENCES)
    expect(normalizeAppSettings(DEFAULT_APP_SETTINGS)).toEqual(DEFAULT_APP_SETTINGS)
    for (const field of allFields) {
      if (field.kind === 'select') expect(field.options.map((option) => option.value), field.label).toContain(field.default)
      if (field.kind === 'number') {
        expect(field.default, field.label).toBeGreaterThanOrEqual(field.min)
        expect(field.default, field.label).toBeLessThanOrEqual(field.max)
      }
    }
  })
})

describe('app settings', () => {
  it('repairs missing and malformed values instead of throwing', () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(normalizeAppSettings({ editorFontSize: 500, resultFetchSize: 13, theme: 'neon' })).toMatchObject({
      editorFontSize: 20,
      resultFetchSize: DEFAULT_APP_SETTINGS.resultFetchSize,
      theme: DEFAULT_APP_SETTINGS.theme,
    })
  })

  it('rejects the same values at the IPC boundary', () => {
    expect(() => validateAppSettings(null)).toThrow(/invalid/i)
    expect(() => validateAppSettings({ ...DEFAULT_APP_SETTINGS, editorFontSize: 500 })).toThrow(/font size/i)
    expect(() => validateAppSettings({ ...DEFAULT_APP_SETTINGS, theme: 'neon' })).toThrow(/theme/i)
    expect(() => validateAppSettings({ ...DEFAULT_APP_SETTINGS, editorWordWrap: 'yes' })).toThrow(/word wrap/i)
  })

  it('layers custom key bindings over the defaults and drops unusable ones', () => {
    const settings = normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, keymapOverrides: { runQuery: 'Mod-r' } })
    expect(effectiveKeymapBindings(settings)).toEqual({ ...KEYMAP_DEFAULTS, runQuery: 'Mod-r' })
    expect(normalizeAppSettings({ keymapOverrides: { runQuery: 'Ctrl-Alt-r', formatSql: '' } }).keymapOverrides).toEqual({})
    expect(() => validateAppSettings({ ...DEFAULT_APP_SETTINGS, keymapOverrides: { runQuery: 'Bogus-r' } })).toThrow()
    expect(() => validateAppSettings({ ...DEFAULT_APP_SETTINGS, keymapOverrides: { nope: 'Mod-r' } })).toThrow(/unknown command/i)
  })
})

describe('settings migrations', () => {
  const migrations = [
    (raw: Record<string, unknown>) => ({ ...raw, editorFontSize: 17 }),
    (raw: Record<string, unknown>) => ({ ...raw, editorWordWrap: false }),
  ]

  it('runs only the migrations the stored version has not seen', () => {
    expect(migrateAppSettings({}, 0, migrations)).toEqual({ editorFontSize: 17, editorWordWrap: false })
    expect(migrateAppSettings({}, 1, migrations)).toEqual({ editorWordWrap: false })
    expect(migrateAppSettings({ a: 1 }, 2, migrations)).toEqual({ a: 1 })
  })

  it('ignores a version from the future or from a hand edit', () => {
    expect(migrateAppSettings({ a: 1 }, 99, migrations)).toEqual({ a: 1 })
    expect(migrateAppSettings({ a: 1 }, -1, migrations)).toEqual({ a: 1 })
    expect(migrateAppSettings({ a: 1 }, 1.5, migrations)).toEqual({ a: 1 })
  })

  it('ships at the version its own migration list defines', () => {
    expect(APP_SETTINGS_VERSION).toBe(APP_SETTINGS_MIGRATIONS.length)
  })
})

describe('menu accelerators', () => {
  it('spells a stored binding the way Electron registers it', () => {
    expect(acceleratorFor('Mod-s')).toBe('CmdOrCtrl+S')
    expect(acceleratorFor('Mod-Shift-p')).toBe('Shift+CmdOrCtrl+P')
    expect(acceleratorFor('Shift-Alt-f')).toBe('Alt+Shift+F')
    expect(acceleratorFor('Mod-Enter')).toBe('CmdOrCtrl+Enter')
    expect(acceleratorFor('F5')).toBe('F5')
    expect(acceleratorFor('nonsense-')).toBeUndefined()
  })

  it('can express every menu-owned command\'s default', () => {
    for (const command of MENU_KEYMAP_COMMANDS) {
      expect(acceleratorFor(KEYMAP_DEFAULTS[command]), command).toBeTruthy()
    }
  })
})

describe('binding grammar', () => {
  it('accepts modifier prefixes and the "-" key, and rejects anything else', () => {
    expect(parseKeyBinding('Mod-Shift-p')).toEqual({ modifiers: ['Mod', 'Shift'], key: 'p' })
    expect(parseKeyBinding('Enter')).toEqual({ modifiers: [], key: 'Enter' })
    expect(parseKeyBinding('Mod--')).toEqual({ modifiers: ['Mod'], key: '-' })
    expect(parseKeyBinding('Cmd-p')).toBeNull()
    expect(parseKeyBinding('')).toBeNull()
    // A dangling separator is not the "-" key: its prefix still has to parse.
    expect(parseKeyBinding('nonsense-')).toBeNull()
    expect(parseKeyBinding('Mod-')).toBeNull()
  })
})

describe('workspace preferences', () => {
  it('defaults invalid retention values and bounds the history limit', () => {
    expect(normalizeWorkspacePreferences(null)).toEqual(DEFAULT_WORKSPACE_PREFERENCES)
    expect(normalizeWorkspacePreferences({ saveHistory: false, historyRetentionDays: 12, maxHistoryPerContext: 99_000 })).toEqual({
      saveHistory: false,
      historyRetentionDays: 30,
      maxHistoryPerContext: 5000,
    })
    expect(() => validateWorkspacePreferences({ ...DEFAULT_WORKSPACE_PREFERENCES, historyRetentionDays: 12 })).toThrow(/retention/i)
  })
})
