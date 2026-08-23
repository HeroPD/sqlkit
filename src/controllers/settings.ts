import type { ReactiveController, ReactiveControllerHost } from 'lit'
import {
  DEFAULT_APP_SETTINGS,
  editorLineHeightValue,
  effectiveKeymapBindings,
  normalizeAppSettings,
  type AppSettings,
  type KeymapCommand,
} from '../settings'

// Owns the app-wide settings for a window: loads them at startup, follows the
// main-process broadcast so every window agrees, writes changes back, and
// applies the document-level part (theme, editor metrics) in one place. Values
// scoped to a workspace live in ConfigController with the rest of its config.
export class SettingsController implements ReactiveController {
  private host: ReactiveControllerHost
  private _settings: AppSettings = DEFAULT_APP_SETTINGS
  private unsubscribe: (() => void) | null = null

  constructor(host: ReactiveControllerHost) {
    this.host = host
    host.addController(this)
  }

  get app(): AppSettings {
    return this._settings
  }

  get bindings(): Record<KeymapCommand, string> {
    return effectiveKeymapBindings(this._settings)
  }

  hostConnected() {
    this.unsubscribe = window.sqlkit.onSettingsChange((settings) => this.apply(settings))
    void window.sqlkit.getSettings().then((settings) => this.apply(settings)).catch(() => {})
  }

  hostDisconnected() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** A change made in this window: shown at once, then persisted and broadcast. */
  set(settings: AppSettings) {
    this.apply(settings)
    void window.sqlkit.setSettings(this._settings).catch(() => {})
  }

  /** A change main has already stored — the View menu's theme items. */
  applyBroadcast(settings: AppSettings) {
    this.apply(settings)
  }

  patch(patch: Partial<AppSettings>) {
    this.set(normalizeAppSettings({ ...this._settings, ...patch }))
  }

  // Theme and editor metrics ride on the document so CodeMirror (and anything
  // else in a shadow root) can read them as inherited custom properties.
  private apply(settings: AppSettings) {
    this._settings = normalizeAppSettings(settings)
    const root = document.documentElement
    root.dataset.theme = this._settings.theme
    // Matches theme-bootstrap: the next launch paints before settings arrive.
    try {
      localStorage.setItem('sqlkit-theme', this._settings.theme)
    } catch {
      // A blocked or full store only costs the pre-paint theme.
    }
    root.style.setProperty('--editor-font-size', `${this._settings.editorFontSize}px`)
    root.style.setProperty('--editor-line-height', String(editorLineHeightValue(this._settings.editorLineHeight)))
    this.host.requestUpdate()
  }
}
