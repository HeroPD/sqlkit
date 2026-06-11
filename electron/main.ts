import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  currentWorkspacePath,
  isDirectory,
  openWorkspace,
  readGlobalConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from './workspace'
import { listSqlFiles, readWorkspaceFile, startWorkspaceWatcher, stopWorkspaceWatcher } from './files'
import { createConnectionManager, testConnection } from './db/manager'
import { testSshTunnel } from './db/transport'
import type { ConnectionProfile, ConnectionStatus, WorkspaceConfig } from '../src/electron'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 320,
    minHeight: 480,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

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

  ipcMain.handle('file:list', (_event, folder: string) => listSqlFiles(currentWorkspacePath(), folder))

  ipcMain.handle('file:read', (_event, filePath: string) => readWorkspaceFile(currentWorkspacePath(), filePath))

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
  ipcMain.handle('db:statuses', () => manager.statuses())
  ipcMain.handle('db:query', (_event, profileId: string, sql: string, params?: unknown[]) =>
    manager.query(profileId, sql, params),
  )
  ipcMain.handle('db:list-tables', (_event, profileId: string) => manager.listTables(profileId))

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

app.whenReady().then(() => {
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
