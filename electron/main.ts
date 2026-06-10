import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isDirectory,
  openWorkspace,
  readGlobalConfig,
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from './workspace'
import type { WorkspaceConfig } from '../src/electron'

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

function registerWorkspaceIpc() {
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
    return opened
  })

  ipcMain.handle('workspace:open-path', (event, wsPath: string) => {
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit — ${opened.name}`)
    return opened
  })

  ipcMain.handle('workspace:get-recent', () => {
    return readGlobalConfig().recentWorkspaces.filter((workspace) => isDirectory(workspace.path))
  })

  ipcMain.handle('workspace:get-config', () => readWorkspaceConfig())

  ipcMain.handle('workspace:save-config', (_event, config: WorkspaceConfig) => writeWorkspaceConfig(config))
}

app.whenReady().then(() => {
  registerWorkspaceIpc()

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
