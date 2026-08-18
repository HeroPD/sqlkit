import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceConfig } from '../src/electron'
import type { ConnectionManager } from './db/manager'
import { t } from '../src/i18n'
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
import { historyItems, stringValue, workspaceConfig, workspaceSession } from './ipc-validation'
import { recoverableContexts } from '../src/session-recovery'
import {
  dropBackup,
  markSessionClean,
  readBackup,
  readSession,
  writeBackup,
  writeSession,
  writeShutdownBackup,
} from './session'
import {
  isDirectory,
  openWorkspace,
  readGlobalConfig,
  readTheme,
  readWorkspaceConfigForRenderer,
  readWorkspaceHistory,
  workspaceProfileCount,
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
  /** A renderer finished its pre-quit session flush; releases main's wait. */
  notifySessionFlushed(contentsId: number): void
  /** Waits for a renderer to persist its open tabs, bounded by main. */
  flushSession(contents: WebContents): Promise<void>
}

export function registerWorkspaceIpc(context: WorkspaceIpcContext) {
  const watchOpened = async (contents: WebContents, opened: ReturnType<typeof openWorkspace>) => {
    if (!opened.success) return
    // Before this window points at the new workspace: the tabs it still holds
    // belong to the old one, and a write that lands after the swap would file
    // them under the wrong folder. Leaving a workspace deliberately is an
    // orderly exit from it, so its crash marker comes off too.
    await context.flushSession(contents)
    markSessionClean(context.workspaceFor(contents))
    await context.managerFor(contents.id)?.disconnectAll()
    context.setWorkspace(contents.id, opened.path)
    startWorkspaceWatcher(contents.id, opened.path, () => {
      if (!contents.isDestroyed()) contents.send('workspace:files-changed')
    })
  }

  ipcMain.handle('workspace:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false, error: t('workspace.windowNotReady') }
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: t('workspace.openTitle'),
      buttonLabel: t('workspace.openButton'),
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
      return { success: false, error: t('workspace.unauthorized') }
    }
    if (context.focusExistingWorkspace(wsPath, event.sender.id)) return { success: false, canceled: true }
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit Studio — ${opened.name}`)
    await watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:close', async (event) => {
    await context.flushSession(event.sender)
    markSessionClean(context.workspaceFor(event.sender))
    context.clearWorkspace(event.sender.id)
    stopWorkspaceWatcher(event.sender.id)
    await context.managerFor(event.sender.id)?.disconnectAll()
    BrowserWindow.fromWebContents(event.sender)?.setTitle(t('app.name'))
  })

  // Reveals the open workspace root in the OS file manager. The path comes from
  // the trusted session map, never the renderer, so there is nothing to validate.
  ipcMain.handle('workspace:reveal', (event) => {
    const workspace = context.workspaceFor(event.sender)
    if (workspace) shell.showItemInFolder(workspace)
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
      return { success: false, error: t('file.externalOpenBlocked') }
    }
    if (action === 'reveal') {
      shell.showItemInFolder(resolved.path)
      return { success: true }
    }
    const error = await shell.openPath(resolved.path)
    return error ? { success: false, error } : { success: true }
  })

  // Selects a workspace file or folder in the OS file manager. Unlike
  // open-external this needs no extension allowlist: showItemInFolder only
  // highlights the item, so there is nothing for the OS to launch.
  ipcMain.handle('file:reveal', (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(
      context.workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
    )
    if ('error' in resolved) return { success: false, error: resolved.error }
    shell.showItemInFolder(resolved.path)
    return { success: true }
  })

  ipcMain.handle('file:save-as', async (event, folder: string, suggestedName: string, content: string) => {
    folder = stringValue(folder, 'Folder', IPC_PATH_LIMIT)
    suggestedName = stringValue(suggestedName, 'Suggested file name', 1_000)
    content = stringValue(content, 'File content', IPC_SQL_FILE_LIMIT)
    const workspace = context.workspaceFor(event.sender)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!workspace || !window) return { success: false, error: t('file.noWorkspace') }
    const contextRoot = folder ? resolveContextRoot(workspace, folder) : null
    if (contextRoot) fsMkdir(contextRoot)
    const result = await dialog.showSaveDialog(window, {
      title: t('workspace.saveQuery'),
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
    if (!window) return { success: false, error: t('workspace.windowNotReady') }
    const extension = (suggestedName.split('.').pop() || 'csv').toLowerCase()
    const result = await dialog.showSaveDialog(window, {
      title: t('workspace.exportResults'),
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
    readGlobalConfig().recentWorkspaces
      .filter((workspace) => isDirectory(workspace.path))
      .map((workspace) => ({ ...workspace, profileCount: workspaceProfileCount(workspace.path) })))
  ipcMain.handle('app:get-theme', () => readTheme())
  ipcMain.handle('workspace:get-config', (event) => readWorkspaceConfigForRenderer(context.workspaceFor(event.sender)))
  ipcMain.handle('workspace:save-config', (event, config: WorkspaceConfig) => {
    try {
      return writeWorkspaceConfig(context.workspaceFor(event.sender), workspaceConfig(config))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('session:read', (event) => readSession(context.workspaceFor(event.sender)))
  ipcMain.handle('session:write', (event, session: unknown) => {
    try {
      return writeSession(context.workspaceFor(event.sender), workspaceSession(session))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('session:read-backup', (event, tabId: unknown) => {
    try {
      return readBackup(context.workspaceFor(event.sender), stringValue(tabId, 'Tab id', IPC_PATH_LIMIT))
    } catch {
      return null
    }
  })
  ipcMain.handle('session:write-backup', (event, tabId: unknown, content: unknown) => {
    try {
      return writeBackup(
        context.workspaceFor(event.sender),
        stringValue(tabId, 'Tab id', IPC_PATH_LIMIT),
        stringValue(content, 'Buffer', IPC_SQL_FILE_LIMIT),
      )
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('session:drop-backup', (event, tabId: unknown) => {
    try {
      dropBackup(context.workspaceFor(event.sender), stringValue(tabId, 'Tab id', IPC_PATH_LIMIT))
    } catch {
      // A malformed id has no backup to drop.
    }
  })

  // Synchronous by necessity: this runs from the renderer's `pagehide`, where an
  // async invoke would be torn down before it lands. Everything it writes is
  // already covered by the debounced path — it only catches the last keystrokes.
  ipcMain.on('session:flush', (event, payload: unknown) => {
    event.returnValue = true
    try {
      const workspacePath = context.workspaceFor(event.sender)
      const flush = payload as { session?: unknown; backups?: unknown }
      const unbacked = new Set<string>()
      if (Array.isArray(flush?.backups)) {
        for (const entry of flush.backups.slice(0, 500)) {
          const backup = entry as { tabId?: unknown; content?: unknown }
          const tabId = stringValue(backup.tabId, 'Tab id', IPC_PATH_LIMIT)
          const written = writeShutdownBackup(workspacePath, tabId, stringValue(backup.content, 'Buffer', IPC_SQL_FILE_LIMIT))
          if (written.unbacked) unbacked.add(tabId)
        }
      }
      if (flush?.session !== undefined) {
        // Only this side knows which of those writes landed, so the claims of
        // the ones that didn't are dropped here — otherwise a shutdown would
        // replace a session the renderer had already filtered with one
        // promising text that no backup holds.
        const session = workspaceSession(flush.session)
        writeSession(workspacePath, { ...session, contexts: recoverableContexts(session.contexts, unbacked) })
      }
    } catch {
      // A shutdown is the worst moment to throw; the debounced writes stand.
    } finally {
      context.notifySessionFlushed(event.sender.id)
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
