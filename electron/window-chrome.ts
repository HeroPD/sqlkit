import type { ThemeId } from '../src/electron'

/** Title bar height; mirrors --titlebar-h. */
export const TITLEBAR_HEIGHT = 38

/**
 * The window's own chrome is themed before the renderer exists — the paint
 * behind the first frame, and the Window Controls Overlay on Windows/Linux —
 * so these mirror --bg / --titlebar-bg / --titlebar-fg from src/index.css.
 * window-chrome.test.ts pins the two copies to each other.
 */
export const WINDOW_CHROME: Record<ThemeId, { background: string; titleBar: string; symbol: string }> = {
  dark: { background: '#13161d', titleBar: '#151820', symbol: '#afb4bd' },
  'midnight-blue': { background: '#0b1420', titleBar: '#0b1622', symbol: '#aebdcc' },
  'warm-dark': { background: '#161311', titleBar: '#181411', symbol: '#b4aaa1' },
  light: { background: '#f4f5f7', titleBar: '#eceef1', symbol: '#474c55' },
}

/** Window Controls Overlay styling; macOS draws its own inset traffic lights. */
export const titleBarOverlay = (theme: ThemeId) => ({
  color: WINDOW_CHROME[theme].titleBar,
  symbolColor: WINDOW_CHROME[theme].symbol,
  height: TITLEBAR_HEIGHT,
})
