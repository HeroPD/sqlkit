import type { ThemeId } from './electron'

// The theme roster, kept free of i18n and every other import so the pre-paint
// bootstrap can read it without pulling the app bundle into that path. Labels
// live with the setting schema; ids, order, and swatches live here.
export const THEME_SWATCHES: Record<ThemeId, readonly [string, string, string]> = {
  dark: ['#11141a', '#181c25', '#151820'],
  'midnight-blue': ['#08111c', '#121f2e', '#0d1724'],
  'warm-dark': ['#120f0e', '#201b18', '#181513'],
  light: ['#e5e7ea', '#f0f1f3', '#ffffff'],
}

export const THEME_IDS = Object.keys(THEME_SWATCHES) as ThemeId[]

export const DEFAULT_THEME: ThemeId = 'dark'

export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === 'string' && Object.hasOwn(THEME_SWATCHES, value)

export const themeOrDefault = (value: unknown): ThemeId => (isThemeId(value) ? value : DEFAULT_THEME)
