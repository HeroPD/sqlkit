import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fsMkdir = (dir: string) => {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // The save dialog falls back to a default location.
  }
}
import {
  isDirectory,
  openWorkspace,
  readGlobalConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from './workspace'
import {
  createWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  resolveContextRoot,
  resolveWorkspaceItem,
  saveWorkspaceFile,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
} from './files'
import { createConnectionManager, testConnection, type ConnectionManager } from './db/manager'
import { testSshTunnel } from './db/transport'
import type { ConnectionProfile, ConnectionStatus, DbObject, DbObjectKind, TableRef, WorkspaceConfig } from '../src/electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const appFileUrl = pathToFileURL(join(__dirname, '../dist/index.html')).href
const workspacePaths = new Map<number, string>()
const dbManagers = new Map<number, ConnectionManager>()

// Only these schemes are ever handed to the OS; a renderer navigated somewhere
// unexpected can't use this to launch arbitrary protocol handlers.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const openExternalSafely = (url: string) => {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // Unparseable URL — ignore.
  }
}

// The app's own document: the dev server in dev, the built index.html in prod.
// Navigation to anything else (including other file:// paths) is not the app.
const isAppUrl = (url: string) =>
  devServerUrl
    ? url.startsWith(devServerUrl)
    : url === appFileUrl || url.startsWith(`${appFileUrl}#`) || url.startsWith(`${appFileUrl}?`)

const workspaceFor = (contents: WebContents) => workspacePaths.get(contents.id) ?? null
const normalizeWorkspacePath = (wsPath: string) => {
  try {
    return resolve(realpathSync(wsPath))
  } catch {
    return resolve(wsPath)
  }
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
  void manager?.disconnectAll()
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    // Matches --bg in index.css; with show-on-ready this kills the white
    // flash before the renderer paints.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const contentsId = window.webContents.id
  window.on('closed', () => cleanupWindow(contentsId))

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Reloads of the app itself (Vite full-reload in dev, Cmd+R in prod) must
    // stay in-window; a navigation anywhere else is blocked and, when it's a
    // real web link, handed to the browser. Pinning to the exact app URL stops
    // a stray navigation to another file:// page from inheriting window.sqlkit.
    if (isAppUrl(url)) return

    event.preventDefault()
    openExternalSafely(url)
  })

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
    window.webContents.openDevTools({ mode: 'detach' })
    return
  }

  void window.loadFile(join(__dirname, '../dist/index.html'))
}

function registerWorkspaceIpc() {
  const watchOpened = (contents: WebContents, opened: ReturnType<typeof openWorkspace>) => {
    if (!opened.success) return
    workspacePaths.set(contents.id, opened.path)
    startWorkspaceWatcher(contents.id, opened.path, () => {
      if (!contents.isDestroyed()) contents.send('workspace:files-changed')
    })
  }

  ipcMain.handle('workspace:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false, error: 'Window not ready' }

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open Workspace Folder',
      buttonLabel: 'Open',
    })
    if (result.canceled) return { success: false, canceled: true }
    if (focusExistingWorkspace(result.filePaths[0], event.sender.id)) return { success: false, canceled: true }

    const opened = openWorkspace(result.filePaths[0])
    if (opened.success) window.setTitle(`SqlKit — ${opened.name}`)
    watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:open-path', (event, wsPath: string) => {
    if (focusExistingWorkspace(wsPath, event.sender.id)) return { success: false, canceled: true }
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit — ${opened.name}`)
    watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:close', (event) => {
    workspacePaths.delete(event.sender.id)
    stopWorkspaceWatcher(event.sender.id)
    BrowserWindow.fromWebContents(event.sender)?.setTitle('SqlKit')
  })

  ipcMain.handle('app:new-window', () => {
    createWindow()
  })

  ipcMain.handle('file:list', (event, folder: string) => listWorkspaceFiles(workspaceFor(event.sender), folder))

  ipcMain.handle('file:read', (event, filePath: string) => readWorkspaceFile(workspaceFor(event.sender), filePath))

  ipcMain.handle('file:save', (event, filePath: string, content: string) =>
    saveWorkspaceFile(workspaceFor(event.sender), filePath, content),
  )

  ipcMain.handle('file:create', (event, folder: string, relativePath: string) =>
    createWorkspaceFile(workspaceFor(event.sender), folder, relativePath),
  )

  ipcMain.handle('file:rename', (event, filePath: string, newName: string) =>
    renameWorkspaceFile(workspaceFor(event.sender), filePath, newName),
  )

  // Confirmation happens in the renderer (in-app modal); this just validates
  // and moves the target to the Trash.
  ipcMain.handle('file:delete', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(workspaceFor(event.sender), filePath)
    if ('error' in resolved) return { success: false, error: resolved.error }

    try {
      await shell.trashItem(resolved.path)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Non-.sql files (spreadsheets, exports…) open with the system default app.
  ipcMain.handle('file:open-external', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(workspaceFor(event.sender), filePath)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const error = await shell.openPath(resolved.path)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle('file:save-as', async (event, folder: string, suggestedName: string, content: string) => {
    const workspace = workspaceFor(event.sender)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!workspace || !window) return { success: false, error: 'No workspace open' }

    // Default into the context folder (connection/child); create it so the
    // dialog can actually start there.
    const contextRoot = folder ? resolveContextRoot(workspace, folder) : null
    if (contextRoot) fsMkdir(contextRoot)
    const result = await dialog.showSaveDialog(window, {
      title: 'Save Query',
      defaultPath: join(contextRoot ?? workspace, suggestedName || 'query.sql'),
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }

    const filePath = result.filePath.toLowerCase().endsWith('.sql') ? result.filePath : `${result.filePath}.sql`
    return saveWorkspaceFile(workspace, filePath, content)
  })

  // Results export: anywhere on disk (not workspace-rooted like save-as).
  ipcMain.handle('file:export', async (event, suggestedName: string, content: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false, error: 'No window' }
    const extension = (suggestedName.split('.').pop() || 'csv').toLowerCase()
    const result = await dialog.showSaveDialog(window, {
      title: 'Export Results',
      defaultPath: join(app.getPath('downloads'), suggestedName || 'results.csv'),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    try {
      await writeFile(result.filePath, content, 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('workspace:get-recent', () => {
    return readGlobalConfig().recentWorkspaces.filter((workspace) => isDirectory(workspace.path))
  })

  ipcMain.handle('workspace:get-config', (event) => readWorkspaceConfig(workspaceFor(event.sender)))

  ipcMain.handle('workspace:save-config', (event, config: WorkspaceConfig) =>
    writeWorkspaceConfig(workspaceFor(event.sender), config),
  )
}

function registerDbIpc() {
  const manager = (event: IpcMainInvokeEvent) => dbManagerFor(event.sender)
  const existingManager = (event: IpcMainInvokeEvent) => dbManagers.get(event.sender.id)

  ipcMain.handle('db:test', (_event, profile: ConnectionProfile) => testConnection(profile))
  ipcMain.handle('db:test-ssh', (_event, profile: ConnectionProfile) => testSshTunnel(profile))
  ipcMain.handle('db:connect', (event, profile: ConnectionProfile) => manager(event).connect(profile))
  ipcMain.handle('db:disconnect', (event, profileId: string) => existingManager(event)?.disconnect(profileId))
  ipcMain.handle('db:disconnect-all', (event) => existingManager(event)?.disconnectAll())
  ipcMain.handle('db:set-active-child', (event, profileId: string, database: string) =>
    manager(event).setActiveChild(profileId, database),
  )
  ipcMain.handle('db:statuses', (event) => existingManager(event)?.statuses() ?? [])
  ipcMain.handle('db:query', (event, profileId: string, sql: string, params?: unknown[]) =>
    manager(event).query(profileId, sql, params),
  )
  ipcMain.handle('db:cancel', (event, profileId: string) => manager(event).cancelQuery(profileId))
  ipcMain.handle('db:create-database', (event, profileId: string, name: string) =>
    manager(event).createDatabase(profileId, name),
  )
  ipcMain.handle('db:drop-database', (event, profileId: string, name: string) =>
    manager(event).dropDatabase(profileId, name),
  )
  ipcMain.handle('db:list-tables', (event, profileId: string) => manager(event).listTables(profileId))
  ipcMain.handle('db:list-columns', (event, profileId: string) => manager(event).listColumns(profileId))
  ipcMain.handle('db:inspect-table', (event, profileId: string, table: TableRef) =>
    manager(event).inspectTable(profileId, table),
  )
  ipcMain.handle('db:list-objects', (event, profileId: string) => manager(event).listObjects(profileId))
  ipcMain.handle('db:inspect-object', (event, profileId: string, object: DbObject, objectKind: DbObjectKind) =>
    manager(event).inspectObject(profileId, object, objectKind),
  )
  ipcMain.handle('db:inspect-server', (event, profileId: string) => manager(event).inspectServer(profileId))

  ipcMain.handle('db:pick-sqlite-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Choose SQLite Database',
      buttonLabel: 'Choose',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  app.on('before-quit', () => {
    // Window 'closed' cleanup normally handles this; keep this belt-and-suspenders path for quit races.
    stopWorkspaceWatcher()
    void Promise.all([...dbManagers.values()].map((active) => active.disconnectAll()))
  })
}

// The default menu binds ⌘W to Close Window, swallowing it before the
// renderer sees the key. Rebind: ⌘W closes the active tab (sent to the
// renderer), ⇧⌘W closes the window — the editor-app convention. File items
// route to the renderer over one channel; the workbench maps the action ids
// to its tab/save logic.
function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const menuAction = (action: string) => (_item: unknown, window: unknown) => {
    if (window instanceof BrowserWindow) window.webContents.send('app:menu', action)
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'New Query', accelerator: 'CmdOrCtrl+N', click: menuAction('new-query') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuAction('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: menuAction('save-as') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuAction('close-tab') },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      // Hand-rolled window menu: the windowMenu role would re-register ⌘W.
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  buildAppMenu()
  registerWorkspaceIpc()
  registerDbIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
