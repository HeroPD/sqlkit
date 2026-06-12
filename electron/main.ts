import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fsMkdir = (dir: string) => {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // The save dialog falls back to a default location.
  }
}
import {
  currentWorkspacePath,
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
import { createConnectionManager, testConnection } from './db/manager'
import { testSshTunnel } from './db/transport'
import type { ConnectionProfile, ConnectionStatus, DbObject, DbObjectKind, TableRef, WorkspaceConfig } from '../src/electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL

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

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Reloads of the app itself (Vite full-reload in dev, Cmd+R in prod) must
    // stay in-window; only genuinely external URLs go to the browser.
    const isAppUrl = url.startsWith('file://') || (devServerUrl !== undefined && url.startsWith(devServerUrl))
    if (isAppUrl) return

    event.preventDefault()
    void shell.openExternal(url)
  })

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
    window.webContents.openDevTools({ mode: 'detach' })
    return
  }

  void window.loadFile(join(__dirname, '../dist/index.html'))
}

function broadcast(channel: string, ...args: unknown[]) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, ...args)
  }
}

function registerWorkspaceIpc() {
  const watchOpened = (opened: ReturnType<typeof openWorkspace>) => {
    if (opened.success) startWorkspaceWatcher(opened.path, () => broadcast('workspace:files-changed'))
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

    const opened = openWorkspace(result.filePaths[0])
    if (opened.success) window.setTitle(`SqlKit — ${opened.name}`)
    watchOpened(opened)
    return opened
  })

  ipcMain.handle('workspace:open-path', (event, wsPath: string) => {
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit — ${opened.name}`)
    watchOpened(opened)
    return opened
  })

  ipcMain.handle('file:list', (_event, folder: string) => listWorkspaceFiles(currentWorkspacePath(), folder))

  ipcMain.handle('file:read', (_event, filePath: string) => readWorkspaceFile(currentWorkspacePath(), filePath))

  ipcMain.handle('file:save', (_event, filePath: string, content: string) =>
    saveWorkspaceFile(currentWorkspacePath(), filePath, content),
  )

  ipcMain.handle('file:create', (_event, folder: string, relativePath: string) =>
    createWorkspaceFile(currentWorkspacePath(), folder, relativePath),
  )

  ipcMain.handle('file:rename', (_event, filePath: string, newName: string) =>
    renameWorkspaceFile(currentWorkspacePath(), filePath, newName),
  )

  // Confirmation happens in the renderer (in-app modal); this just validates
  // and moves the target to the Trash.
  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    const resolved = resolveWorkspaceItem(currentWorkspacePath(), filePath)
    if ('error' in resolved) return { success: false, error: resolved.error }

    try {
      await shell.trashItem(resolved.path)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Non-.sql files (spreadsheets, exports…) open with the system default app.
  ipcMain.handle('file:open-external', async (_event, filePath: string) => {
    const resolved = resolveWorkspaceItem(currentWorkspacePath(), filePath)
    if ('error' in resolved) return { success: false, error: resolved.error }
    const error = await shell.openPath(resolved.path)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle('file:save-as', async (event, folder: string, suggestedName: string, content: string) => {
    const workspace = currentWorkspacePath()
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

  ipcMain.handle('workspace:get-config', () => readWorkspaceConfig())

  ipcMain.handle('workspace:save-config', (_event, config: WorkspaceConfig) => writeWorkspaceConfig(config))
}

function registerDbIpc() {
  const manager = createConnectionManager((statuses: ConnectionStatus[]) => broadcast('db:status', statuses))

  ipcMain.handle('db:test', (_event, profile: ConnectionProfile) => testConnection(profile))
  ipcMain.handle('db:test-ssh', (_event, profile: ConnectionProfile) => testSshTunnel(profile))
  ipcMain.handle('db:connect', (_event, profile: ConnectionProfile) => manager.connect(profile))
  ipcMain.handle('db:disconnect', (_event, profileId: string) => manager.disconnect(profileId))
  ipcMain.handle('db:disconnect-all', () => manager.disconnectAll())
  ipcMain.handle('db:set-active-child', (_event, profileId: string, database: string) =>
    manager.setActiveChild(profileId, database),
  )
  ipcMain.handle('db:statuses', () => manager.statuses())
  ipcMain.handle('db:query', (_event, profileId: string, sql: string, params?: unknown[]) =>
    manager.query(profileId, sql, params),
  )
  ipcMain.handle('db:cancel', (_event, profileId: string) => manager.cancelQuery(profileId))
  ipcMain.handle('db:create-database', (_event, profileId: string, name: string) =>
    manager.createDatabase(profileId, name),
  )
  ipcMain.handle('db:drop-database', (_event, profileId: string, name: string) =>
    manager.dropDatabase(profileId, name),
  )
  ipcMain.handle('db:list-tables', (_event, profileId: string) => manager.listTables(profileId))
  ipcMain.handle('db:list-columns', (_event, profileId: string) => manager.listColumns(profileId))
  ipcMain.handle('db:inspect-table', (_event, profileId: string, table: TableRef) =>
    manager.inspectTable(profileId, table),
  )
  ipcMain.handle('db:list-objects', (_event, profileId: string) => manager.listObjects(profileId))
  ipcMain.handle('db:inspect-object', (_event, profileId: string, object: DbObject, objectKind: DbObjectKind) =>
    manager.inspectObject(profileId, object, objectKind),
  )
  ipcMain.handle('db:inspect-server', (_event, profileId: string) => manager.inspectServer(profileId))

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
    stopWorkspaceWatcher()
    void manager.disconnectAll()
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
