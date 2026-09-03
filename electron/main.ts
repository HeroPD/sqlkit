import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConnectionStatus, MenuAction, SharedWorkspaceFile, ThemeId } from '../src/electron'
import { t } from '../src/i18n'
import { createConnectionManager, type ConnectionManager } from './db/manager'
import { stopWorkspaceWatcher } from './files'
import { registerDbIpc } from './ipc-db'
import { appSettings as validateAppSettings } from './ipc-validation'
import { THEMES, acceleratorFor, effectiveKeymapBindings, type MenuKeymapCommand } from '../src/settings'
import { THEME_IDS, isThemeId } from '../src/themes'
import { inspectionSwitch } from './hardening'
import { registerWorkspaceIpc } from './ipc-workspace'
import { markSessionClean } from './session'
import { normalizeWorkspacePath, WorkspaceWindows } from './workspace-windows'
import { readAppSettings, readGlobalConfig, readTheme, writeAppSettings, writeTheme } from './workspace'
import { titleBarOverlay, WINDOW_CHROME } from './window-chrome'

const __dirname = dirname(fileURLToPath(import.meta.url))
app.setName(t('app.name'))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const smokeTest = process.argv.includes('--smoke-test')
// Only unpackaged runs may be inspected; see hardening.ts for why. A release
// build refuses to start rather than come up debuggable.
const inspectable = !app.isPackaged
if (!inspectable) {
  const offending = inspectionSwitch(process.argv, process.env.NODE_OPTIONS)
  if (offending) {
    console.error(`${t('app.name')} does not run with ${offending}.`)
    app.exit(1)
  }
}
// Dev runs get their own profile: two Electron processes sharing one userData
// fight over the localStorage LevelDB lock (~4s renderer stall on first read)
// and the loser silently falls back to empty storage.
if (devServerUrl) app.setPath('userData', `${app.getPath('userData')}-dev`)
// For the same reason a second launch of the same flavour joins the running
// instance (second-instance below) instead of starting a contending process.
// Smoke tests skip the lock so they can run alongside a normal instance.
const primaryInstance = smokeTest || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
const devParentPid = Number(process.env.SQLKIT_DEV_PARENT_PID)
if (devServerUrl && Number.isInteger(devParentPid) && devParentPid > 0) {
  const parentMonitor = setInterval(() => {
    if (process.ppid === devParentPid) return
    clearInterval(parentMonitor)
    app.quit()
  }, 250)
}
if (smokeTest) app.commandLine.appendSwitch('no-sandbox')
const appFileUrl = pathToFileURL(join(__dirname, '../dist/index.html')).href
const workspaceWindows = new WorkspaceWindows()
const dbManagers = new Map<number, ConnectionManager>()
const pendingDisconnects = new Set<Promise<void>>()
let quitting = false

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const openExternalSafely = (url: string) => {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url).catch(() => {})
  } catch {
    // Unparseable URL — ignore.
  }
}

const isAppUrl = (url: string) => {
  if (!devServerUrl) return url === appFileUrl || url.startsWith(`${appFileUrl}#`) || url.startsWith(`${appFileUrl}?`)
  try {
    const candidate = new URL(url)
    const appUrl = new URL(devServerUrl)
    const basePath = appUrl.pathname.endsWith('/') ? appUrl.pathname : `${appUrl.pathname}/`
    return candidate.origin === appUrl.origin
      && (candidate.pathname === appUrl.pathname || candidate.pathname.startsWith(basePath))
  } catch {
    return false
  }
}

function contentSecurityPolicy(): string {
  const base = [
    `default-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ]
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin
    const wsOrigin = origin.replace(/^http/, 'ws')
    return [
      ...base,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      `connect-src 'self' ${origin} ${wsOrigin}`,
    ].join('; ')
  }
  return [...base, `script-src 'self'`, `connect-src 'self'`].join('; ')
}

function installContentSecurityPolicy() {
  const csp = contentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // The renderer never needs a Chromium permission (camera, geolocation, …);
  // deny them all rather than inherit Electron's grant-by-default.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

const workspaceFor = (contents: WebContents) => workspaceWindows.pathFor(contents.id)

const isAuthorizedRecentWorkspace = (wsPath: string) => {
  const target = normalizeWorkspacePath(wsPath)
  return readGlobalConfig().recentWorkspaces.some((workspace) => normalizeWorkspacePath(workspace.path) === target)
}

function focusWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function focusExistingWorkspace(wsPath: string, requesterId: number) {
  for (const contentsId of workspaceWindows.raiseInstead(wsPath, requesterId)) {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.id === contentsId)
    if (!window) {
      cleanupWindow(contentsId)
      continue
    }
    focusWindow(window)
    return true
  }
  return false
}

function cleanupWindow(contentsId: number) {
  workspaceWindows.close(contentsId)
  stopWorkspaceWatcher(contentsId)
  const manager = dbManagers.get(contentsId)
  dbManagers.delete(contentsId)
  if (!manager) return
  const closing = manager.disconnectAll().catch(() => {})
  pendingDisconnects.add(closing)
  void closing.finally(() => pendingDisconnects.delete(closing))
}

function dbManagerFor(contents: WebContents) {
  let manager = dbManagers.get(contents.id)
  if (!manager) {
    manager = createConnectionManager((statuses: ConnectionStatus[]) => {
      if (!contents.isDestroyed()) contents.send('db:status', statuses)
    })
    dbManagers.set(contents.id, manager)
  }
  return manager
}

const MAX_WINDOWS = 8

// Windows waiting for their renderer's first real frame, by webContents id.
const pendingShows = new Map<number, () => void>()
// Backstop so a renderer that breaks before its first render still gets a
// window; matching the old show-on-first-paint timing, just delayed.
const SHOW_FALLBACK_MS = 1_000

function createWindow() {
  if (BrowserWindow.getAllWindows().length >= MAX_WINDOWS) return
  const theme = readTheme()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: WINDOW_CHROME[theme].background,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: titleBarOverlay(theme) }),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: inspectable,
    },
  })

  const contentsId = window.webContents.id
  window.on('closed', () => {
    pendingShows.delete(contentsId)
    notifySessionFlushed(contentsId)
    // Closing a window is an orderly exit from its workspace, and on macOS the
    // app outlives it — so the crash marker comes off here, not only at quit.
    // Before cleanupWindow, which is what forgets the workspace this window had.
    markSessionClean(workspaceWindows.pathFor(contentsId), workspaceWindows.slotFor(contentsId))
    cleanupWindow(contentsId)
  })

  // macOS hides the traffic lights in fullscreen, so the renderer's title bar
  // has to give back the gutter it reserves for them. Sent on load too: a
  // reload of a fullscreen window starts a renderer that knows nothing.
  const sendFullScreen = () => window.webContents.send('window:fullscreen', window.isFullScreen())
  window.on('enter-full-screen', sendFullScreen)
  window.on('leave-full-screen', sendFullScreen)
  window.webContents.on('did-finish-load', sendFullScreen)

  if (smokeTest) {
    window.webContents.once('did-finish-load', () => app.exit(0))
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`Renderer smoke test failed (${code}): ${description}`)
      app.exit(1)
    })
  }
  // Shown on the renderer's app:rendered signal, not ready-to-show — that fires
  // on the first paint of the still-empty document, flashing a blank window the
  // welcome screen then pops over.
  const show = () => {
    pendingShows.delete(contentsId)
    if (!smokeTest && !window.isDestroyed() && !window.isVisible()) window.show()
  }
  pendingShows.set(contentsId, show)
  window.once('ready-to-show', () => setTimeout(show, SHOW_FALLBACK_MS))
  // devTools: false already refuses this; closing on the event covers anything
  // that reaches openDevTools() by another route (an extension, a future menu).
  if (!inspectable) {
    window.webContents.on('devtools-opened', () => window.webContents.closeDevTools())
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })
  if (devServerUrl) {
    void window.loadURL(devServerUrl).catch((error) => { if (smokeTest) console.error(error) })
    window.webContents.openDevTools({ mode: 'detach' })
    return
  }
  void window.loadFile(join(__dirname, '../dist/index.html')).catch((error) => { if (smokeTest) console.error(error) })
}

function registerIpc() {
  ipcMain.handle('app:rendered', (event) => { pendingShows.get(event.sender.id)?.() })
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Clipboard text must be a string')
    clipboard.writeText(text)
  })
  ipcMain.handle('app:set-theme', (_event, theme: unknown) => {
    if (!isThemeId(theme)) throw new Error('Unknown theme')
    selectTheme(theme)
  })
  ipcMain.handle('app:get-settings', () => readAppSettings())
  ipcMain.handle('app:set-settings', (_event, settings: unknown) => {
    const parsed = validateAppSettings(settings)
    const before = readAppSettings()
    writeAppSettings(parsed)
    selectTheme(parsed.theme)
    // The menu owns a few of the keymap's chords; a rebind only takes effect
    // once its accelerator is re-registered. Safe here because this arrives by
    // IPC rather than from a menu click.
    if (JSON.stringify(before.keymapOverrides) !== JSON.stringify(parsed.keymapOverrides)) buildAppMenu()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('app:settings', parsed)
  })
  registerWorkspaceIpc({
    workspaceFor,
    setWorkspace: (contentsId, path) => workspaceWindows.open(contentsId, path),
    clearWorkspace: (contentsId) => workspaceWindows.close(contentsId),
    sessionSlotFor: (contents) => workspaceWindows.slotFor(contents.id),
    notifySharedChanged,
    managerFor: (contentsId) => dbManagers.get(contentsId),
    focusExistingWorkspace,
    isAuthorizedRecentWorkspace,
    createWindow,
    notifySessionFlushed,
    flushSession: flushRendererSession,
  })
  registerDbIpc({
    workspaceFor,
    managerFor: dbManagerFor,
    existingManagerFor: (contentsId) => dbManagers.get(contentsId),
  })
}

// How long a renderer gets to write out whatever its debounce still holds. The
// buffers are already on disk within a second of the last keystroke, so this
// only catches the tail — a hung renderer must never hold the app open for it.
const SESSION_FLUSH_MS = 1_000

const pendingSessionFlushes = new Map<number, () => void>()
// Captured when the quit starts: closing each window clears its entry from
// the window registry, and the crash marker has to be cleared after that.
let quittingWorkspaces: Array<{ path: string; slot: number }> = []

function notifySessionFlushed(contentsId: number) {
  const resolve = pendingSessionFlushes.get(contentsId)
  if (!resolve) return
  pendingSessionFlushes.delete(contentsId)
  resolve()
}

// Asks one renderer to write out whatever its debounce still holds, and waits
// for the reply. Also used before a workspace switch: the tabs being flushed
// belong to the workspace that is on its way out, so they have to reach disk
// before this window's path is repointed at the new one.
function flushRendererSession(contents: WebContents): Promise<void> {
  if (contents.isDestroyed() || !workspaceWindows.has(contents.id)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    pendingSessionFlushes.set(contents.id, resolve)
    contents.send('app:flush-session')
    setTimeout(() => {
      pendingSessionFlushes.delete(contents.id)
      resolve()
    }, SESSION_FLUSH_MS)
  })
}

// The config and the history are one file per workspace, whatever it has open
// on it, so a window that saves one tells its siblings to re-read: a window
// writing from a list it loaded before their change would write over it.
function notifySharedChanged(contentsId: number, kind: SharedWorkspaceFile) {
  const openedPath = workspaceWindows.pathFor(contentsId)
  if (!openedPath) return
  for (const id of workspaceWindows.owners(openedPath, contentsId)) {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.id === id)
    if (window && !window.webContents.isDestroyed()) window.webContents.send('workspace:shared-changed', kind)
  }
}

function flushRendererSessions(): Promise<unknown> {
  return Promise.all(BrowserWindow.getAllWindows().map((window) => flushRendererSession(window.webContents)))
}

function installQuitHandler() {
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopWorkspaceWatcher()
    quittingWorkspaces = workspaceWindows.all()
    const closed = Promise.all([
      flushRendererSessions(),
      ...[...dbManagers.values()].map((active) => active.disconnectAll().catch(() => {})),
      ...pendingDisconnects,
    ])
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    void Promise.race([closed, deadline]).finally(() => app.quit())
  })

  // After every window is gone, so the flush each one fires as it tears down
  // can't re-mark the session it just cleared. The marker is what tells the
  // next launch whether this exit was orderly.
  app.on('will-quit', () => {
    for (const { path, slot } of quittingWorkspaces) markSessionClean(path, slot)
    quittingWorkspaces = []
  })
}

// Persist the theme, repaint the Windows title bar, and tell every renderer.
// Reached from the View menu and from the command palette, so the radio item is
// checked here rather than left to the click Electron would have handled.
function selectTheme(theme: ThemeId) {
  writeTheme(theme)
  const item = Menu.getApplicationMenu()?.getMenuItemById(`theme:${theme}`)
  if (item) item.checked = true
  for (const window of BrowserWindow.getAllWindows()) {
    if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarOverlay(theme))
    window.webContents.send('app:menu', `theme:${theme}`)
  }
  // Rebuilding the native menu inside a click callback can release the pointer
  // into the renderer and leave the window covered by a native text selection.
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const selectedTheme = readTheme()
  // The menu registers these chords, so they come from the keymap settings —
  // the accelerator shown here is the one the settings page lists.
  const bindings = effectiveKeymapBindings(readAppSettings())
  const chord = (command: MenuKeymapCommand) => acceleratorFor(bindings[command])
  const menuAction = (action: MenuAction) => (_item: unknown, window: unknown) => {
    if (window instanceof BrowserWindow) window.webContents.send('app:menu', action)
  }
  // Selection items display their shortcut but must NOT register it: the keys
  // belong to CodeMirror's keymap, and a registered accelerator would swallow
  // them app-wide — breaking ⌘D and friends in inputs and the result grid.
  const selectionItem = (label: string, accelerator: string, action: MenuAction): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: menuAction(action),
  })
  // macOS keeps Settings in the app menu, where ⌘, lives by convention; the
  // other platforms have no app menu, so it leads the View menu instead.
  const settingsItem: MenuItemConstructorOptions = {
    label: t('menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: menuAction('settings'),
  }
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newQuery'), accelerator: chord('newQuery'), click: menuAction('new-query') },
        { label: t('menu.newWindow'), accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: t('menu.openWorkspace'), accelerator: 'CmdOrCtrl+O', click: menuAction('open-workspace') },
        { label: isMac ? t('action.revealInFinder') : t('action.revealInExplorer'), click: menuAction('reveal-workspace') },
        { label: t('menu.closeWorkspace'), click: menuAction('close-workspace') },
        { type: 'separator' },
        { label: t('menu.save'), accelerator: chord('saveFile'), click: menuAction('save') },
        { label: t('menu.saveAs'), accelerator: 'Shift+CmdOrCtrl+S', click: menuAction('save-as') },
        { type: 'separator' },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: menuAction('close-tab') },
        { label: t('menu.closeWindow'), accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.selection'),
      submenu: [
        // Native role: it selects all in whatever is focused — editor, input, or grid.
        { role: 'selectAll' },
        { type: 'separator' },
        selectionItem(t('menu.expandSelection'), 'CmdOrCtrl+I', 'selection:expand'),
        { type: 'separator' },
        selectionItem(t('menu.copyLineUp'), 'Shift+Alt+Up', 'selection:copy-line-up'),
        selectionItem(t('menu.copyLineDown'), 'Shift+Alt+Down', 'selection:copy-line-down'),
        selectionItem(t('menu.moveLineUp'), 'Alt+Up', 'selection:move-line-up'),
        selectionItem(t('menu.moveLineDown'), 'Alt+Down', 'selection:move-line-down'),
        { type: 'separator' },
        selectionItem(t('menu.addCursorAbove'), 'CmdOrCtrl+Alt+Up', 'selection:add-cursor-above'),
        selectionItem(t('menu.addCursorBelow'), 'CmdOrCtrl+Alt+Down', 'selection:add-cursor-below'),
        selectionItem(t('menu.addCursorsToLineEnds'), 'Shift+Alt+I', 'selection:add-cursors-to-line-ends'),
        selectionItem(t('menu.addNextOccurrence'), 'CmdOrCtrl+D', 'selection:add-next-occurrence'),
        selectionItem(t('menu.selectAllOccurrences'), 'Shift+CmdOrCtrl+L', 'selection:select-all-occurrences'),
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        ...(isMac ? [] : [settingsItem, { type: 'separator' } as MenuItemConstructorOptions]),
        { label: t('menu.refreshResults'), accelerator: chord('refreshResults'), click: menuAction('refresh-results') },
        {
          label: t('menu.theme'),
          submenu: THEME_IDS.map((id): MenuItemConstructorOptions => ({
            id: `theme:${id}`,
            label: THEMES[id].label,
            type: 'radio',
            checked: selectedTheme === id,
            click: () => selectTheme(id),
          })),
        },
        { type: 'separator' },
        { role: 'forceReload' },
        ...(inspectable ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(() => {
  if (!primaryInstance) return
  installContentSecurityPolicy()
  buildAppMenu()
  registerIpc()
  installQuitHandler()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('second-instance', () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (window) focusWindow(window)
    else createWindow()
  })
}).catch((error: unknown) => {
  console.error('SqlKit Studio failed to start:', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
