import type { ThemeId } from './electron'
import { t } from './i18n'
import { DEFAULT_THEME, THEME_IDS, THEME_SWATCHES } from './themes'

export type EditorLineHeight = 'compact' | 'comfortable' | 'spacious'

/** Commands the SQL editor binds inside CodeMirror. */
export type EditorKeymapCommand = 'runQuery' | 'formatSql' | 'commandPalette'
/** Commands whose shortcut the native menu registers; rebinding rebuilds it. */
export type MenuKeymapCommand = 'newQuery' | 'saveFile' | 'refreshResults'
type ViewCommandId = 'explorer' | 'search' | 'databases' | 'history' | 'tasks' | 'server'
type TabIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type KeymapCommand =
  | EditorKeymapCommand
  | MenuKeymapCommand
  | 'quickOpen'
  | 'switchDatabase'
  | 'toggleSidebar'
  | 'toggleResults'
  | 'undoChange'
  | 'redoChange'
  | `view:${ViewCommandId}`
  | `tab:${TabIndex}`

/** Everything the workbench's own keydown handles: all of them but Run query,
 * which only means anything with a cursor in the editor. */
export type WindowKeymapCommand = Exclude<KeymapCommand, 'runQuery'>

export type AppSettings = {
  theme: ThemeId
  editorFontSize: number
  editorLineHeight: EditorLineHeight
  editorTabSize: 2 | 4 | 8
  editorWordWrap: boolean
  editorAutocomplete: boolean
  editorHighlightActiveLine: boolean
  confirmDestructive: boolean
  resultFetchSize: 200 | 500 | 1000 | 2500 | 5000
  alternateRowShading: boolean
  keymapOverrides: Partial<Record<KeymapCommand, string>>
}

export type WorkspacePreferences = {
  saveHistory: boolean
  historyRetentionDays: 7 | 30 | 90 | 0
  maxHistoryPerContext: number
}

export type SettingCategory = 'general' | 'editor' | 'keymap' | 'query' | 'results' | 'history'
export type SettingScope = 'app' | 'workspace'

export type SettingOption<T> = { value: T; label: string }

/** Both scopes, so a row can depend on a setting stored in the other one. */
export type SettingValues = { app: AppSettings; workspace: WorkspacePreferences }

/** One row of a keymap field. Ids are free-form so a second keymap can exist. */
export type KeymapCommandDef = { id: string; label: string; description?: string; group: string }

/** Events a settings action button may fire; the host listens for these. */
export type SettingActionEvent = 'settings-clear-history'

type FieldBase<T> = {
  category: SettingCategory
  /** Section heading the row sits under, in declaration order. */
  group: string
  label: string
  description: string
  /** Extra search terms; label, description, and group are always searched. */
  keywords?: string
  default: T
  /** Rows another setting turns off, e.g. retention while history is off. */
  enabledWhen?: (values: SettingValues) => boolean
}

// One descriptor per setting. Defaults, on-disk repair, IPC validation, the
// settings UI, its search, and per-category reset are all derived from these,
// so a new option is one entry here plus its strings — nothing to keep in sync.
export type SettingField<T = unknown> =
  | (FieldBase<T> & { kind: 'toggle' })
  | (FieldBase<T> & { kind: 'number'; min: number; max: number })
  | (FieldBase<T> & { kind: 'select'; options: ReadonlyArray<SettingOption<T>>; display?: 'cards' })
  | (FieldBase<T> & { kind: 'keymap'; commands: readonly KeymapCommandDef[]; defaults: Readonly<Record<string, string>> })

// -? so a new key on the settings type is a compile error until it has a field.
export type SettingsSchema<T> = { [K in keyof T]-?: SettingField<T[K]> }

export class SettingsError extends Error {}

// Adding a theme: an entry in themes.ts and a label here reaches the settings
// picker, the View menu, and both validators.
export const THEMES: Record<ThemeId, { label: string; swatch: readonly [string, string, string] }> = {
  dark: { label: t('menu.theme.dark'), swatch: THEME_SWATCHES.dark },
  'midnight-blue': { label: t('menu.theme.midnightBlue'), swatch: THEME_SWATCHES['midnight-blue'] },
  'warm-dark': { label: t('menu.theme.warmDark'), swatch: THEME_SWATCHES['warm-dark'] },
  light: { label: t('menu.theme.light'), swatch: THEME_SWATCHES.light },
}

const withoutEllipsis = (label: string) => label.replace(/…$/, '')

const COMMAND_GROUP = t('settings.group.commands')
const NAV_GROUP = t('settings.group.navigation')
const VIEW_GROUP = t('settings.group.views')
const FILE_GROUP = t('settings.group.files')
const RESULT_GROUP = t('settings.group.results')
const TAB_GROUP = t('settings.group.tabs')

// Every rebindable command, in the order the keymap page lists them. Adding one
// is an entry here plus the handler it names: the defaults, the page, both
// validators, and the shadowing check all read this table.
const KEYMAP_COMMAND_DEFS: Record<KeymapCommand, { binding: string; label: string; description?: string; group: string }> = {
  runQuery: { binding: 'Mod-Enter', label: t('settings.command.runQuery'), description: t('settings.command.runQueryDetail'), group: COMMAND_GROUP },
  formatSql: { binding: 'Shift-Alt-f', label: t('settings.command.formatSql'), description: t('settings.command.formatSqlDetail'), group: COMMAND_GROUP },
  commandPalette: { binding: 'Mod-Shift-p', label: t('settings.command.commandPalette'), description: t('settings.command.commandPaletteDetail'), group: COMMAND_GROUP },

  quickOpen: { binding: 'Mod-p', label: withoutEllipsis(t('action.quickOpen')), group: NAV_GROUP },
  switchDatabase: { binding: 'Mod-k', label: withoutEllipsis(t('action.switchDatabase')), group: NAV_GROUP },
  toggleSidebar: { binding: 'Mod-b', label: t('action.toggleSidebar'), group: NAV_GROUP },
  toggleResults: { binding: 'Mod-j', label: t('action.toggleResults'), group: NAV_GROUP },

  'view:explorer': { binding: 'Mod-Shift-e', label: t('action.showView', { view: t('view.explorer') }), group: VIEW_GROUP },
  'view:search': { binding: 'Mod-Shift-f', label: t('action.showView', { view: t('view.search') }), group: VIEW_GROUP },
  'view:databases': { binding: 'Mod-Shift-d', label: t('action.showView', { view: t('view.databases') }), group: VIEW_GROUP },
  'view:history': { binding: 'Mod-Shift-h', label: t('action.showView', { view: t('view.history') }), group: VIEW_GROUP },
  'view:tasks': { binding: 'Mod-Shift-t', label: t('action.showView', { view: t('view.tasks') }), group: VIEW_GROUP },
  'view:server': { binding: 'Mod-Shift-g', label: t('action.showView', { view: t('view.server') }), group: VIEW_GROUP },

  newQuery: { binding: 'Mod-n', label: t('action.newQuery'), group: FILE_GROUP },
  saveFile: { binding: 'Mod-s', label: t('action.saveFile'), group: FILE_GROUP },

  refreshResults: { binding: 'Mod-r', label: t('menu.refreshResults'), group: RESULT_GROUP },
  undoChange: { binding: 'Mod-z', label: t('action.undoChange'), group: RESULT_GROUP },
  redoChange: { binding: 'Mod-Shift-z', label: t('action.redoChange'), group: RESULT_GROUP },

  'tab:1': { binding: 'Mod-1', label: t('action.selectTab', { index: 1 }), group: TAB_GROUP },
  'tab:2': { binding: 'Mod-2', label: t('action.selectTab', { index: 2 }), group: TAB_GROUP },
  'tab:3': { binding: 'Mod-3', label: t('action.selectTab', { index: 3 }), group: TAB_GROUP },
  'tab:4': { binding: 'Mod-4', label: t('action.selectTab', { index: 4 }), group: TAB_GROUP },
  'tab:5': { binding: 'Mod-5', label: t('action.selectTab', { index: 5 }), group: TAB_GROUP },
  'tab:6': { binding: 'Mod-6', label: t('action.selectTab', { index: 6 }), group: TAB_GROUP },
  'tab:7': { binding: 'Mod-7', label: t('action.selectTab', { index: 7 }), group: TAB_GROUP },
  'tab:8': { binding: 'Mod-8', label: t('action.selectTab', { index: 8 }), group: TAB_GROUP },
  'tab:9': { binding: 'Mod-9', label: t('action.selectLastTab'), group: TAB_GROUP },
}

/** Shortcuts the menu bar registers, so a rebind has to reach the menu too. */
export const MENU_KEYMAP_COMMANDS: readonly MenuKeymapCommand[] = ['newQuery', 'saveFile', 'refreshResults']

export const KEYMAP_DEFAULTS = Object.fromEntries(
  Object.entries(KEYMAP_COMMAND_DEFS).map(([id, def]) => [id, def.binding]),
) as Record<KeymapCommand, string>

export const KEYMAP_COMMANDS: readonly KeymapCommandDef[] = Object.entries(KEYMAP_COMMAND_DEFS).map(([id, def]) => ({
  id,
  label: def.label,
  ...(def.description ? { description: def.description } : {}),
  group: def.group,
}))

// Chords the app keeps for itself: the menu registers them, so a command bound
// to one would never see the key. Kept beside the roster so the keymap page can
// name what would win; electron/main.ts declares the same accelerators.
export const RESERVED_BINDINGS: ReadonlyArray<{ binding: string; label: string }> = [
  { binding: 'F5', label: t('menu.refreshResults') },
  { binding: 'Mod-o', label: t('menu.openWorkspace') },
  { binding: 'Mod-w', label: t('menu.closeTab') },
  { binding: 'Mod-Shift-n', label: t('menu.newWindow') },
  { binding: 'Mod-Shift-s', label: t('menu.saveAs') },
  { binding: 'Mod-Shift-w', label: t('menu.closeWindow') },
  { binding: 'Mod-,', label: t('menu.settings') },
]

const KEY_MODIFIERS = ['Mod', 'Alt', 'Shift']
const MAX_KEY_NAME = 20

// The stored binding grammar, shared by the matcher and both validators: zero
// or more modifier prefixes and a key name. CodeMirror parses these strings
// directly, so anything it would reject must never reach a keymap.
export function parseKeyBinding(binding: string): { modifiers: string[]; key: string } | null {
  const parts = binding.split('-')
  // Two empty tails are the "-" key itself ("Mod--"); one is a dangling
  // separator, and its prefix must still be read as a modifier so it fails.
  const dashKey = parts.length > 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === ''
  const key = dashKey ? '-' : parts[parts.length - 1]
  const modifiers = parts.slice(0, dashKey ? -2 : -1)
  if (!key || key.length > MAX_KEY_NAME) return null
  if (!modifiers.every((modifier) => KEY_MODIFIERS.includes(modifier))) return null
  return { modifiers, key }
}

export const SETTING_CATEGORIES: ReadonlyArray<{
  id: SettingCategory
  label: string
  description: string
  icon: string
  scope: SettingScope
}> = [
  { id: 'general', label: t('settings.category.general'), description: t('settings.category.generalDetail'), icon: 'filter', scope: 'app' },
  { id: 'editor', label: t('settings.category.editor'), description: t('settings.category.editorDetail'), icon: 'code', scope: 'app' },
  { id: 'keymap', label: t('settings.category.keymap'), description: t('settings.category.keymapDetail'), icon: 'key', scope: 'app' },
  { id: 'query', label: t('settings.category.query'), description: t('settings.category.queryDetail'), icon: 'braces', scope: 'app' },
  { id: 'results', label: t('settings.category.results'), description: t('settings.category.resultsDetail'), icon: 'table', scope: 'app' },
  { id: 'history', label: t('settings.category.history'), description: t('settings.category.historyDetail'), icon: 'history', scope: 'workspace' },
]

// Buttons that belong on a settings page without being a stored value; the
// view renders them after that category's rows and fires `event` on click.
export const SETTING_ACTIONS: ReadonlyArray<{
  category: SettingCategory
  label: string
  description: string
  button: string
  event: SettingActionEvent
  danger?: boolean
}> = [
  {
    category: 'history',
    label: t('settings.clearHistory.label'),
    description: t('settings.clearHistory.description'),
    button: t('settings.clearHistory.button'),
    event: 'settings-clear-history',
    danger: true,
  },
]

export const APP_SETTING_FIELDS: SettingsSchema<AppSettings> = {
  theme: {
    kind: 'select',
    display: 'cards',
    category: 'general',
    group: t('settings.group.appearance'),
    label: t('settings.theme.label'),
    description: t('settings.theme.description'),
    keywords: 'dark light colour color',
    default: DEFAULT_THEME,
    options: THEME_IDS.map((id) => ({ value: id, label: THEMES[id].label })),
  },
  editorFontSize: {
    kind: 'number',
    category: 'editor',
    group: t('settings.group.typography'),
    label: t('settings.editorFontSize.label'),
    description: t('settings.editorFontSize.description'),
    default: 14,
    min: 11,
    max: 20,
  },
  editorLineHeight: {
    kind: 'select',
    category: 'editor',
    group: t('settings.group.typography'),
    label: t('settings.editorLineHeight.label'),
    description: t('settings.editorLineHeight.description'),
    keywords: 'spacing leading',
    default: 'comfortable',
    options: [
      { value: 'compact', label: t('settings.editorLineHeight.compact') },
      { value: 'comfortable', label: t('settings.editorLineHeight.comfortable') },
      { value: 'spacious', label: t('settings.editorLineHeight.spacious') },
    ],
  },
  editorTabSize: {
    kind: 'select',
    category: 'editor',
    group: t('settings.group.editing'),
    label: t('settings.editorTabSize.label'),
    description: t('settings.editorTabSize.description'),
    keywords: 'indent indentation',
    default: 4,
    options: [2, 4, 8].map((value) => ({ value, label: t('settings.editorTabSize.spaces', { count: value }) })) as ReadonlyArray<SettingOption<2 | 4 | 8>>,
  },
  editorWordWrap: {
    kind: 'toggle',
    category: 'editor',
    group: t('settings.group.editing'),
    label: t('settings.editorWordWrap.label'),
    description: t('settings.editorWordWrap.description'),
    default: true,
  },
  editorAutocomplete: {
    kind: 'toggle',
    category: 'editor',
    group: t('settings.group.editing'),
    label: t('settings.editorAutocomplete.label'),
    description: t('settings.editorAutocomplete.description'),
    keywords: 'completion suggestions intellisense',
    default: true,
  },
  editorHighlightActiveLine: {
    kind: 'toggle',
    category: 'editor',
    group: t('settings.group.editing'),
    label: t('settings.editorHighlightActiveLine.label'),
    description: t('settings.editorHighlightActiveLine.description'),
    keywords: 'cursor',
    default: true,
  },
  keymapOverrides: {
    kind: 'keymap',
    commands: KEYMAP_COMMANDS,
    defaults: KEYMAP_DEFAULTS,
    category: 'keymap',
    group: t('settings.group.commands'),
    label: t('settings.keymap.label'),
    description: t('settings.keymap.description'),
    keywords: 'shortcut keybinding hotkey',
    default: {},
  },
  confirmDestructive: {
    kind: 'toggle',
    category: 'query',
    group: t('settings.group.safety'),
    label: t('settings.confirmDestructive.label'),
    description: t('settings.confirmDestructive.description'),
    keywords: 'drop truncate update delete preflight',
    default: true,
  },
  resultFetchSize: {
    kind: 'select',
    category: 'results',
    group: t('settings.group.resultGrid'),
    label: t('settings.resultFetchSize.label'),
    description: t('settings.resultFetchSize.description'),
    keywords: 'page paging scroll',
    default: 200,
    options: [200, 500, 1000, 2500, 5000].map((value) => ({ value, label: t('settings.resultFetchSize.rows', { count: value }) })) as ReadonlyArray<SettingOption<200 | 500 | 1000 | 2500 | 5000>>,
  },
  alternateRowShading: {
    kind: 'toggle',
    category: 'results',
    group: t('settings.group.resultGrid'),
    label: t('settings.alternateRowShading.label'),
    description: t('settings.alternateRowShading.description'),
    keywords: 'zebra striping',
    default: true,
  },
}

export const WORKSPACE_SETTING_FIELDS: SettingsSchema<WorkspacePreferences> = {
  saveHistory: {
    kind: 'toggle',
    category: 'history',
    group: t('settings.group.queryHistory'),
    label: t('settings.saveHistory.label'),
    description: t('settings.saveHistory.description'),
    keywords: 'privacy record',
    default: true,
  },
  historyRetentionDays: {
    kind: 'select',
    category: 'history',
    group: t('settings.group.queryHistory'),
    label: t('settings.historyRetention.label'),
    description: t('settings.historyRetention.description'),
    keywords: 'expire prune age',
    default: 30,
    enabledWhen: ({ workspace }) => workspace.saveHistory,
    options: [
      { value: 7, label: t('settings.historyRetention.days', { count: 7 }) },
      { value: 30, label: t('settings.historyRetention.days', { count: 30 }) },
      { value: 90, label: t('settings.historyRetention.days', { count: 90 }) },
      { value: 0, label: t('settings.historyRetention.forever') },
    ],
  },
  maxHistoryPerContext: {
    kind: 'number',
    category: 'history',
    group: t('settings.group.queryHistory'),
    label: t('settings.maxHistory.label'),
    description: t('settings.maxHistory.description'),
    keywords: 'limit entries cap',
    default: 200,
    min: 50,
    max: 5000,
    enabledWhen: ({ workspace }) => workspace.saveHistory,
  },
}

const fieldEntries = <T>(schema: SettingsSchema<T>) =>
  Object.entries(schema) as Array<[keyof T & string, SettingField<T[keyof T]>]>

/** Rows of one category, app-scope first, in declaration order. */
export const fieldsForCategory = (category: SettingCategory) => [
  ...fieldEntries(APP_SETTING_FIELDS)
    .filter(([, field]) => field.category === category)
    .map(([key, field]) => ({ scope: 'app' as const, key, field })),
  ...fieldEntries(WORKSPACE_SETTING_FIELDS)
    .filter(([, field]) => field.category === category)
    .map(([key, field]) => ({ scope: 'workspace' as const, key, field })),
]

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const coerceKeymap = (defaults: Readonly<Record<string, string>>, value: unknown) => {
  const input = record(value)
  const overrides: Record<string, string> = {}
  for (const command of Object.keys(defaults)) {
    const binding = input[command]
    if (typeof binding === 'string' && parseKeyBinding(binding)) overrides[command] = binding
  }
  return overrides
}

// Repairs whatever is on disk: out-of-range and unknown values fall back rather
// than throwing, so a hand-edited config never blocks startup.
function coerceField<T>(field: SettingField<T>, value: unknown): T {
  switch (field.kind) {
    case 'toggle':
      return (typeof value === 'boolean' ? value : field.default) as T
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return field.default
      return Math.min(field.max, Math.max(field.min, Math.round(value))) as T
    }
    case 'select':
      return field.options.some((option) => option.value === value) ? (value as T) : field.default
    case 'keymap':
      return coerceKeymap(field.defaults, value) as T
  }
}

// The IPC boundary instead rejects: the renderer sends whole settings objects,
// and a bad one is a bug or an attack, not a stale file to repair.
function checkField<T>(field: SettingField<T>, label: string, value: unknown): T {
  switch (field.kind) {
    case 'toggle':
      if (typeof value !== 'boolean') throw new SettingsError(`${label} must be true or false`)
      return value as T
    case 'number':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < field.min || value > field.max) {
        throw new SettingsError(`${label} must be a whole number between ${field.min} and ${field.max}`)
      }
      return value as T
    case 'select':
      if (!field.options.some((option) => option.value === value)) throw new SettingsError(`${label} is invalid`)
      return value as T
    case 'keymap': {
      const input = record(value)
      const overrides: Record<string, string> = {}
      for (const [command, binding] of Object.entries(input)) {
        if (!Object.hasOwn(field.defaults, command)) throw new SettingsError(`${label} names an unknown command`)
        if (typeof binding !== 'string' || !parseKeyBinding(binding)) throw new SettingsError(`${label} is invalid`)
        overrides[command] = binding
      }
      return overrides as T
    }
  }
}

const defaultsOf = <T>(schema: SettingsSchema<T>): T =>
  Object.fromEntries(fieldEntries(schema).map(([key, field]) => [key, field.default])) as T

const coerceAll = <T>(schema: SettingsSchema<T>, value: unknown): T => {
  const input = record(value)
  return Object.fromEntries(
    fieldEntries(schema).map(([key, field]) => [key, coerceField(field, input[key])]),
  ) as T
}

const checkAll = <T>(schema: SettingsSchema<T>, value: unknown, label: string): T => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError(`${label} is invalid`)
  const input = value as Record<string, unknown>
  return Object.fromEntries(
    fieldEntries(schema).map(([key, field]) => [key, checkField(field, field.label, input[key])]),
  ) as T
}

/** Each entry migrates the stored blob one version forward; the array's length
 * is the current version, so adding one bumps it. Values still pass through
 * coercion afterwards — a migration only handles what coercion cannot, such as
 * a renamed key whose old value would otherwise be dropped for its default. */
export const APP_SETTINGS_MIGRATIONS: ReadonlyArray<(raw: Record<string, unknown>) => Record<string, unknown>> = []

export const APP_SETTINGS_VERSION = APP_SETTINGS_MIGRATIONS.length

export function migrateAppSettings(
  value: unknown,
  fromVersion: number,
  migrations: ReadonlyArray<(raw: Record<string, unknown>) => Record<string, unknown>> = APP_SETTINGS_MIGRATIONS,
): unknown {
  if (!Number.isInteger(fromVersion) || fromVersion < 0 || fromVersion >= migrations.length) return value
  return migrations.slice(fromVersion).reduce<Record<string, unknown>>((raw, migrate) => migrate(raw), record(value))
}

export const DEFAULT_APP_SETTINGS: AppSettings = defaultsOf(APP_SETTING_FIELDS)
export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = defaultsOf(WORKSPACE_SETTING_FIELDS)

export const normalizeAppSettings = (value: unknown): AppSettings => coerceAll(APP_SETTING_FIELDS, value)
export const normalizeWorkspacePreferences = (value: unknown): WorkspacePreferences =>
  coerceAll(WORKSPACE_SETTING_FIELDS, value)

export const validateAppSettings = (value: unknown): AppSettings =>
  checkAll(APP_SETTING_FIELDS, value, 'App settings')
export const validateWorkspacePreferences = (value: unknown): WorkspacePreferences =>
  checkAll(WORKSPACE_SETTING_FIELDS, value, 'Workspace preferences')

// Electron spells accelerators its own way; the menu's registered chord has to
// be the one the keymap page shows, so it is converted rather than restated.
export function acceleratorFor(binding: string): string | undefined {
  const parsed = parseKeyBinding(binding)
  if (!parsed) return undefined
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key
  const order = ['Alt', 'Shift', 'Mod']
  const modifiers = order
    .filter((modifier) => parsed.modifiers.includes(modifier))
    .map((modifier) => (modifier === 'Mod' ? 'CmdOrCtrl' : modifier))
  return [...modifiers, key].join('+')
}

export const editorLineHeightValue = (value: EditorLineHeight) =>
  value === 'compact' ? 1.35 : value === 'spacious' ? 1.7 : 1.5

export const effectiveKeymapBindings = (settings: AppSettings): Record<KeymapCommand, string> => ({
  ...KEYMAP_DEFAULTS,
  ...settings.keymapOverrides,
})
