import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceConfig } from '../src/electron'
import type { ConnectionManager } from './db/manager'
import {
  createWorkspaceFile,
  externalOpenAction,
  listWorkspaceFilesAsync,
  readWorkspaceFileAsync,
  renameWorkspaceFile,
  resolveContextRoot,
  resolveWorkspaceItem,
  saveWorkspaceFileAsync,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
} from './files'
import { historyItems, stringValue, workspaceConfig } from './ipc-validation'
import {
  isDirectory,
  openWorkspace,
  readGlobalConfig,
  readTheme,
  readWorkspaceConfigForRenderer,
  readWorkspaceHistory,
  writeWorkspaceConfig,
  writeWorkspaceHistory,
} from './workspace'

const IPC_PATH_LIMIT = 20_000
const IPC_FILE_LIMIT = 64 * 1024 * 1024
const IPC_SQL_FILE_LIMIT = 10 * 1024 * 1024

const fsMkdir = (dir: string) => {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // The save dialog falls back to a default location.
  }
}

export type WorkspaceIpcContext = {
  workspaceFor(contents: WebContents): string | null
  setWorkspace(contentsId: number, path: string): void
  clearWorkspace(contentsId: number): void
  managerFor(contentsId: number): ConnectionManager | undefined
  focusExistingWorkspace(path: string, requesterId: number): boolean
  isAuthorizedRecentWorkspace(path: string): boolean
  createWindow(): void
}

export function registerWorkspaceIpc(context: WorkspaceIpcContext) {
  const watchOpened = async (contents: WebContents, opened: ReturnType<typeof openWorkspace>) => {
    if (!opened.success) return
    await context.managerFor(contents.id)?.disconnectAll()
    context.setWorkspace(contents.id, opened.path)
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
    const [folder] = result.filePaths
    if (result.canceled || !folder) return { success: false, canceled: true }
    if (context.focusExistingWorkspace(folder, event.sender.id)) return { success: false, canceled: true }
    const opened = openWorkspace(folder)
    if (opened.success) window.setTitle(`SqlKit Studio — ${opened.name}`)
    await watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:open-path', async (event, wsPath: string) => {
    try {
      wsPath = stringValue(wsPath, 'Workspace path', IPC_PATH_LIMIT)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
    if (!context.isAuthorizedRecentWorkspace(wsPath)) {
      return { success: false, error: 'This workspace has not been authorized through the folder picker.' }
    }
    if (context.focusExistingWorkspace(wsPath, event.sender.id)) return { success: false, canceled: true }
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit Studio — ${opened.name}`)
    await watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:close', async (event) => {
    context.clearWorkspace(event.sender.id)
    stopWorkspaceWatcher(event.sender.id)
    await context.managerFor(event.sender.id)?.disconnectAll()
    BrowserWindow.fromWebContents(event.sender)?.setTitle('SqlKit Studio')
  })

  ipcMain.handle('app:new-window', () => context.createWindow())

  ipcMain.handle('file:list', (event, folder: string) =>
    listWorkspaceFilesAsync(context.workspaceFor(event.sender), stringValue(folder, 'Folder', IPC_PATH_LIMIT)))

  ipcMain.handle('file:read', (event, filePath: string) =>
    readWorkspaceFileAsync(context.workspaceFor(event.sender), stringValue(filePath, 'File path', IPC_PATH_LIMIT)))

  ipcMain.handle('file:save', (event, filePath: string, content: string) =>
    saveWorkspaceFileAsync(
      context.workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
      stringValue(content, 'File content', IPC_SQL_FILE_LIMIT),
    ))

  ipcMain.handle('file:create', (event, folder: string, relativePath: string) =>
    createWorkspaceFile(
      context.workspaceFor(event.sender),
      stringValue(folder, 'Folder', IPC_PATH_LIMIT),
      stringValue(relativePath, 'Relative path', IPC_PATH_LIMIT),
    ))

  ipcMain.handle('file:rename', (event, filePath: string, newName: string) =>
    renameWorkspaceFile(
      context.workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
      stringValue(newName, 'File name', 1_000),
    ))

  ipcMain.handle('file:delete', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(
      context.workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
      { allowRoot: false },
    )
    if ('error' in resolved) return { success: false, error: resolved.error }
    try {
      await shell.trashItem(resolved.path)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('file:open-external', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(
      context.workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
    )
    if ('error' in resolved) return { success: false, error: resolved.error }
    const action = externalOpenAction(resolved.path)
    if (action === 'reject') {
      return { success: false, error: "For safety, SqlKit Studio won't open this file type in an external app. Open it from your file manager if you trust it." }
    }
    if (action === 'reveal') {
      shell.showItemInFolder(resolved.path)
      return { success: true }
    }
    const error = await shell.openPath(resolved.path)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle('file:save-as', async (event, folder: string, suggestedName: string, content: string) => {
    folder = stringValue(folder, 'Folder', IPC_PATH_LIMIT)
    suggestedName = stringValue(suggestedName, 'Suggested file name', 1_000)
    content = stringValue(content, 'File content', IPC_SQL_FILE_LIMIT)
    const workspace = context.workspaceFor(event.sender)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!workspace || !window) return { success: false, error: 'No workspace open' }
    const contextRoot = folder ? resolveContextRoot(workspace, folder) : null
    if (contextRoot) fsMkdir(contextRoot)
    const result = await dialog.showSaveDialog(window, {
      title: 'Save Query',
      defaultPath: join(contextRoot ?? workspace, suggestedName || 'query.sql'),
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    const filePath = result.filePath.toLowerCase().endsWith('.sql') ? result.filePath : `${result.filePath}.sql`
    return saveWorkspaceFileAsync(workspace, filePath, content)
  })

  ipcMain.handle('file:export', async (event, suggestedName: string, content: string) => {
    suggestedName = stringValue(suggestedName, 'Suggested file name', 1_000)
    content = stringValue(content, 'Export content', IPC_FILE_LIMIT)
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

  ipcMain.handle('workspace:get-recent', () =>
    readGlobalConfig().recentWorkspaces.filter((workspace) => isDirectory(workspace.path)))
  ipcMain.handle('app:get-theme', () => readTheme())
  ipcMain.handle('workspace:get-config', (event) => readWorkspaceConfigForRenderer(context.workspaceFor(event.sender)))
  ipcMain.handle('workspace:save-config', (event, config: WorkspaceConfig) => {
    try {
      return writeWorkspaceConfig(context.workspaceFor(event.sender), workspaceConfig(config))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('workspace:history-read', (event) => readWorkspaceHistory(context.workspaceFor(event.sender)))
  ipcMain.handle('workspace:history-write', (event, items: unknown) => {
    try {
      return writeWorkspaceHistory(context.workspaceFor(event.sender), historyItems(items))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
}
