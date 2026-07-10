import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
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
  readWorkspaceConfigForRenderer,
  hydrateConnectionProfile,
  writeWorkspaceConfig,
} from './workspace'
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
import { createConnectionManager, testConnection, type ConnectionManager } from './db/manager'
import { testSshTunnel } from './db/transport'
import type { BatchStatement, ConnectionProfile, ConnectionStatus, DbObject, DbObjectKind, QuerySort, TableRef, WorkspaceConfig } from '../src/electron'
import {
  batchStatements,
  connectionProfile,
  databaseObject,
  databaseObjectKind,
  ddlStatements,
  nullableStringValue,
  nonNegativeInteger,
  queryPayload,
  stringValue,
  tableReference,
  workspaceConfig,
} from './ipc-validation'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const smokeTest = process.argv.includes('--smoke-test')
if (smokeTest) app.commandLine.appendSwitch('no-sandbox')
const appFileUrl = pathToFileURL(join(__dirname, '../dist/index.html')).href
const workspacePaths = new Map<number, string>()
const dbManagers = new Map<number, ConnectionManager>()
let quitting = false
const IPC_PATH_LIMIT = 20_000
const IPC_FILE_LIMIT = 64 * 1024 * 1024
const IPC_SQL_FILE_LIMIT = 10 * 1024 * 1024

// Only these schemes are ever handed to the OS; a renderer navigated somewhere
// unexpected can't use this to launch arbitrary protocol handlers.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const openExternalSafely = (url: string) => {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url).catch(() => {})
  } catch {
    // Unparseable URL — ignore.
  }
}

// The app's own document: the dev server in dev, the built index.html in prod.
// Navigation to anything else (including other file:// paths) is not the app.
// Dev compares parsed origins — a prefix check would accept lookalike hosts
// such as localhost:5173.evil.example.
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

// Content-Security-Policy applied to every response (prod loads over file://,
// dev over the Vite server — webRequest intercepts both). Prod is strict: only
// same-origin scripts, no remote/inline JS, so a malicious DB cell or workspace
// file can't escalate to script execution even if an HTML sink slipped in.
// Dev must stay loose enough for Vite: its HMR client is an inline module
// script that connects over websocket and uses eval for transforms, so the dev
// server origin (http + ws) and 'unsafe-inline'/'unsafe-eval' are allowed there
// only. style-src keeps 'unsafe-inline' both ways — Lit/components emit inline
// styles. font/img allow data: for embedded assets.
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
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    })
  })
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
      // Explicit, not just the modern default: the renderer runs user SQL and
      // renders DB cells, so keep it in the OS sandbox even if a default changes.
      // The preload is CJS and uses only contextBridge/ipcRenderer, both sandbox-safe.
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
    // Reloads of the app itself (Vite full-reload in dev, Cmd+R in prod) must
    // stay in-window; a navigation anywhere else is blocked and, when it's a
    // real web link, handed to the browser. Pinning to the exact app URL stops
    // a stray navigation to another file:// page from inheriting window.sqlkit.
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

function registerWorkspaceIpc() {
  const watchOpened = async (contents: WebContents, opened: ReturnType<typeof openWorkspace>) => {
    if (!opened.success) return
    // Opening/replacing a workspace in an existing window must tear down DBs
    // from the old workspace even if the renderer did not explicitly close it.
    await dbManagers.get(contents.id)?.disconnectAll()
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
    const [folder] = result.filePaths
    if (result.canceled || !folder) return { success: false, canceled: true }
    if (focusExistingWorkspace(folder, event.sender.id)) return { success: false, canceled: true }

    const opened = openWorkspace(folder)
    if (opened.success) window.setTitle(`SqlKit — ${opened.name}`)
    await watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:open-path', async (event, wsPath: string) => {
    try {
      wsPath = stringValue(wsPath, 'Workspace path', 20_000)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
    if (!isAuthorizedRecentWorkspace(wsPath)) {
      return { success: false, error: 'This workspace has not been authorized through the folder picker.' }
    }
    if (focusExistingWorkspace(wsPath, event.sender.id)) return { success: false, canceled: true }
    const opened = openWorkspace(wsPath)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (opened.success && window) window.setTitle(`SqlKit — ${opened.name}`)
    await watchOpened(event.sender, opened)
    return opened
  })

  ipcMain.handle('workspace:close', async (event) => {
    workspacePaths.delete(event.sender.id)
    stopWorkspaceWatcher(event.sender.id)
    // Connections belong to the workspace they were opened from. The renderer
    // disconnects on workspace change too, but main owns the boundary: a
    // renderer that didn't (crash, failed IPC) must not leak pools or SSH
    // tunnels. disconnectAll is idempotent, so the double call is harmless.
    await dbManagers.get(event.sender.id)?.disconnectAll()
    BrowserWindow.fromWebContents(event.sender)?.setTitle('SqlKit')
  })

  ipcMain.handle('app:new-window', () => {
    createWindow()
  })

  ipcMain.handle('file:list', (event, folder: string) =>
    listWorkspaceFilesAsync(workspaceFor(event.sender), stringValue(folder, 'Folder', IPC_PATH_LIMIT)),
  )

  ipcMain.handle('file:read', (event, filePath: string) =>
    readWorkspaceFileAsync(workspaceFor(event.sender), stringValue(filePath, 'File path', IPC_PATH_LIMIT)),
  )

  ipcMain.handle('file:save', (event, filePath: string, content: string) =>
    saveWorkspaceFileAsync(
      workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
      stringValue(content, 'File content', IPC_SQL_FILE_LIMIT),
    ),
  )

  ipcMain.handle('file:create', (event, folder: string, relativePath: string) =>
    createWorkspaceFile(
      workspaceFor(event.sender),
      stringValue(folder, 'Folder', IPC_PATH_LIMIT),
      stringValue(relativePath, 'Relative path', IPC_PATH_LIMIT),
    ),
  )

  ipcMain.handle('file:rename', (event, filePath: string, newName: string) =>
    renameWorkspaceFile(
      workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
      stringValue(newName, 'File name', 1_000),
    ),
  )

  // Confirmation happens in the renderer (in-app modal); this just validates
  // and moves the target to the Trash.
  ipcMain.handle('file:delete', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(
      workspaceFor(event.sender),
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

  // Non-.sql files (spreadsheets, exports…) open with the system default app —
  // but only safe document/data types, never an executable or script a stray
  // workspace could use to run code on one click.
  ipcMain.handle('file:open-external', async (event, filePath: string) => {
    const resolved = resolveWorkspaceItem(
      workspaceFor(event.sender),
      stringValue(filePath, 'File path', IPC_PATH_LIMIT),
    )
    if ('error' in resolved) return { success: false, error: resolved.error }
    const action = externalOpenAction(resolved.path)
    if (action === 'reject') {
      return { success: false, error: "For safety, SqlKit won't open this file type in an external app. Open it from your file manager if you trust it." }
    }
    // Directories (incl. macOS .app packages) are revealed, never opened —
    // shell.openPath would launch a package; showItemInFolder only selects it.
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
    return saveWorkspaceFileAsync(workspace, filePath, content)
  })

  // Results export: anywhere on disk (not workspace-rooted like save-as).
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

  ipcMain.handle('workspace:get-recent', () => {
    return readGlobalConfig().recentWorkspaces.filter((workspace) => isDirectory(workspace.path))
  })

  ipcMain.handle('workspace:get-config', (event) => readWorkspaceConfigForRenderer(workspaceFor(event.sender)))

  ipcMain.handle('workspace:save-config', (event, config: WorkspaceConfig) => {
    try {
      return writeWorkspaceConfig(workspaceFor(event.sender), workspaceConfig(config))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
}

function registerDbIpc() {
  const manager = (event: IpcMainInvokeEvent) => dbManagerFor(event.sender)
  const existingManager = (event: IpcMainInvokeEvent) => dbManagers.get(event.sender.id)

  const hydratedProfile = (event: IpcMainInvokeEvent, profile: ConnectionProfile) =>
    hydrateConnectionProfile(workspaceFor(event.sender), profile)

  ipcMain.handle('db:test', (event, profile: ConnectionProfile) => {
    try {
      return testConnection(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message, tookMs: 0 }
    }
  })
  ipcMain.handle('db:test-ssh', (event, profile: ConnectionProfile) => {
    try {
      return testSshTunnel(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message, tookMs: 0 }
    }
  })
  ipcMain.handle('db:connect', (event, profile: ConnectionProfile) => {
    try {
      return manager(event).connect(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:disconnect', (event, profileId: string) =>
    existingManager(event)?.disconnect(stringValue(profileId, 'Profile id', 200)),
  )
  ipcMain.handle('db:disconnect-all', (event) => existingManager(event)?.disconnectAll())
  // Returned (not thrown) failures keep the renderer's invoke from rejecting:
  // the run path treats a rejected align as an app bug, not a query error.
  ipcMain.handle('db:set-active-child', (event, profileId: string, database: string) => {
    try {
      return manager(event).setActiveChild(
        stringValue(profileId, 'Profile id', 200),
        stringValue(database, 'Database name', 2_000),
      )
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:statuses', (event) => existingManager(event)?.statuses() ?? [])
  ipcMain.handle(
    'db:query',
    (event, profileId: string, childDb: string | null, sql: string, params?: unknown[], sort?: QuerySort | null, executionId?: string) => {
      try {
        const payload = queryPayload(sql, params, sort, executionId)
        const parsedProfileId = stringValue(profileId, 'Profile id', 200)
        const parsedChild = childDb === null ? null : stringValue(childDb, 'Database name', 2_000)
        return manager(event).query(parsedProfileId, parsedChild, payload.sql, payload.params, payload.sort, payload.executionId)
      } catch (error) {
        return { success: false as const, error: (error as Error).message }
      }
    },
  )
  ipcMain.handle(
    'db:run-batch',
    (event, profileId: string, childDb: string | null, statements: BatchStatement[]) => {
      try {
        return manager(event).runBatch(
          stringValue(profileId, 'Profile id', 200),
          childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
          batchStatements(statements),
        )
      } catch (error) {
        return { success: false as const, error: (error as Error).message }
      }
    },
  )
  ipcMain.handle(
    'db:run-ddl',
    (event, profileId: string, childDb: string | null, statements: string[]) => {
      try {
        return manager(event).runDdl(
          stringValue(profileId, 'Profile id', 200),
          childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
          ddlStatements(statements),
        )
      } catch (error) {
        return { success: false as const, error: (error as Error).message }
      }
    },
  )
  ipcMain.handle('db:fetch-rows', (event, sessionId: string, offset: number, limit: number) =>
    existingManager(event)?.fetchRows(
      stringValue(sessionId, 'Session id', 200),
      nonNegativeInteger(offset, 'Row offset', Number.MAX_SAFE_INTEGER),
      nonNegativeInteger(limit, 'Row limit', 200),
    ) ?? { success: false as const, error: 'No active session' },
  )
  ipcMain.handle('db:close-session', (event, sessionId: string) =>
    existingManager(event)?.closeSession(stringValue(sessionId, 'Session id', 200)),
  )
  ipcMain.handle('db:cancel', (event, profileId: string, executionId?: string) =>
    manager(event).cancelQuery(
      stringValue(profileId, 'Profile id', 200),
      executionId === undefined ? undefined : stringValue(executionId, 'Execution id', 200),
    ),
  )
  ipcMain.handle('db:create-database', (event, profileId: string, name: string) =>
    manager(event).createDatabase(
      stringValue(profileId, 'Profile id', 200),
      stringValue(name, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:drop-database', (event, profileId: string, name: string) =>
    manager(event).dropDatabase(
      stringValue(profileId, 'Profile id', 200),
      stringValue(name, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:list-tables', (event, profileId: string, childDb: string | null) =>
    manager(event).listTables(
      stringValue(profileId, 'Profile id', 200),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:list-columns', (event, profileId: string, childDb: string | null) =>
    manager(event).listColumns(
      stringValue(profileId, 'Profile id', 200),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:inspect-table', (event, profileId: string, childDb: string | null, table: TableRef) =>
    manager(event).inspectTable(
      stringValue(profileId, 'Profile id', 200),
      tableReference(table),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:list-objects', (event, profileId: string, childDb: string | null) =>
    manager(event).listObjects(
      stringValue(profileId, 'Profile id', 200),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:inspect-object', (event, profileId: string, childDb: string | null, object: DbObject, objectKind: DbObjectKind) =>
    manager(event).inspectObject(
      stringValue(profileId, 'Profile id', 200),
      databaseObject(object),
      databaseObjectKind(objectKind),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )
  ipcMain.handle('db:inspect-server', (event, profileId: string, childDb: string | null) =>
    manager(event).inspectServer(
      stringValue(profileId, 'Profile id', 200),
      nullableStringValue(childDb, 'Database name', 2_000),
    ),
  )

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

  app.on('before-quit', (event) => {
    // Window 'closed' cleanup normally handles this; this belt-and-suspenders
    // path covers quit races. Hold the quit until pools/tunnels actually close
    // (graceful Postgres Terminate, SSH teardown) so the remote backend isn't
    // orphaned — but cap the wait so a hung disconnect can't block quit forever.
    if (quitting) return
    quitting = true
    event.preventDefault()
    stopWorkspaceWatcher()
    const closed = Promise.all([...dbManagers.values()].map((active) => active.disconnectAll().catch(() => {})))
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 3000))
    void Promise.race([closed, deadline]).finally(() => app.quit())
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
    {
      // Hand-rolled View menu: the viewMenu role binds ⌘R to a full window
      // reload, which we repurpose to refresh the result grid. ⇧⌘R force-reload
      // stays as a dev escape hatch.
      label: 'View',
      submenu: [
        { label: 'Refresh Results', accelerator: 'CmdOrCtrl+R', click: menuAction('refresh-results') },
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

void app.whenReady().then(() => {
  installContentSecurityPolicy()
  buildAppMenu()
  registerWorkspaceIpc()
  registerDbIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}).catch((error: unknown) => {
  console.error('SqlKit failed to start:', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
