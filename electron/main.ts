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
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ConnectionStatus, ThemeId } from '../src/electron'
import { t } from '../src/i18n'
import { createConnectionManager, type ConnectionManager } from './db/manager'
import { stopWorkspaceWatcher } from './files'
import { registerDbIpc } from './ipc-db'
import { registerWorkspaceIpc } from './ipc-workspace'
import { readGlobalConfig, readTheme, writeTheme } from './workspace'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const smokeTest = process.argv.includes('--smoke-test')
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
const workspacePaths = new Map<number, string>()
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

const workspaceFor = (contents: WebContents) => workspacePaths.get(contents.id) ?? null
const normalizeWorkspacePath = (wsPath: string) => {
  try {
    return resolve(realpathSync(wsPath))
  } catch {
    return resolve(wsPath)
  }
}

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
  const target = normalizeWorkspacePath(wsPath)
  for (const [contentsId, openedPath] of workspacePaths) {
    if (normalizeWorkspacePath(openedPath) !== target) continue
    if (contentsId === requesterId) return false
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
  workspacePaths.delete(contentsId)
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

function createWindow() {
  if (BrowserWindow.getAllWindows().length >= MAX_WINDOWS) return
  const theme = readTheme()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: theme === 'light'
      ? '#f4f5f7'
      : theme === 'midnight-blue'
        ? '#0b1420'
        : theme === 'warm-dark'
          ? '#161311'
          : '#13161d',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const contentsId = window.webContents.id
  window.on('closed', () => cleanupWindow(contentsId))
  if (smokeTest) {
    window.webContents.once('did-finish-load', () => app.exit(0))
    window.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`Renderer smoke test failed (${code}): ${description}`)
      app.exit(1)
    })
  }
  window.once('ready-to-show', () => { if (!smokeTest) window.show() })
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
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Clipboard text must be a string')
    clipboard.writeText(text)
  })
  registerWorkspaceIpc({
    workspaceFor,
    setWorkspace: (contentsId, path) => workspacePaths.set(contentsId, path),
    clearWorkspace: (contentsId) => { workspacePaths.delete(contentsId) },
    managerFor: (contentsId) => dbManagers.get(contentsId),
    focusExistingWorkspace,
    isAuthorizedRecentWorkspace,
    createWindow,
  })
  registerDbIpc({
    workspaceFor,
    managerFor: dbManagerFor,
    existingManagerFor: (contentsId) => dbManagers.get(contentsId),
  })
}

function installQuitHandler() {
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopWorkspaceWatcher()
    const closed = Promise.all([
      ...[...dbManagers.values()].map((active) => active.disconnectAll().catch(() => {})),
      ...pendingDisconnects,
    ])
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    void Promise.race([closed, deadline]).finally(() => app.quit())
  })
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const selectedTheme = readTheme()
  const menuAction = (action: string) => (_item: unknown, window: unknown) => {
    if (window instanceof BrowserWindow) window.webContents.send('app:menu', action)
  }
  const selectTheme = (theme: ThemeId) => {
    writeTheme(theme)
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('app:menu', `theme:${theme}`)
    buildAppMenu()
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newWindow'), accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: t('menu.newQuery'), accelerator: 'CmdOrCtrl+N', click: menuAction('new-query') },
        { type: 'separator' },
        { label: t('menu.save'), accelerator: 'CmdOrCtrl+S', click: menuAction('save') },
        { label: t('menu.saveAs'), accelerator: 'Shift+CmdOrCtrl+S', click: menuAction('save-as') },
        { type: 'separator' },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: menuAction('close-tab') },
        { label: t('menu.closeWindow'), accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.refreshResults'), accelerator: 'CmdOrCtrl+R', click: menuAction('refresh-results') },
        {
          label: t('menu.theme'),
          submenu: [
            { label: t('menu.theme.dark'), type: 'radio', checked: selectedTheme === 'dark', click: () => selectTheme('dark') },
            { label: t('menu.theme.light'), type: 'radio', checked: selectedTheme === 'light', click: () => selectTheme('light') },
            { label: t('menu.theme.midnightBlue'), type: 'radio', checked: selectedTheme === 'midnight-blue', click: () => selectTheme('midnight-blue') },
            { label: t('menu.theme.warmDark'), type: 'radio', checked: selectedTheme === 'warm-dark', click: () => selectTheme('warm-dark') },
          ],
        },
        { type: 'separator' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
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
  installContentSecurityPolicy()
  buildAppMenu()
  registerIpc()
  installQuitHandler()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  console.error('SqlKit Studio failed to start:', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
