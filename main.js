const { app, BrowserWindow, ipcMain, nativeTheme, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

nativeTheme.themeSource = 'dark'

let mainWindow
let dbClient = null
let dbEngine = null
let currentWorkspace = null
let allowWindowClose = false

// ── Global Config ─────────────────────────────────────────────────────────────
const GLOBAL_CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

function readGlobalConfig() {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8'))
  } catch {
    return { recentWorkspaces: [], lastWorkspace: null }
  }
}

function writeGlobalConfig(config) {
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ── Workspace Config ──────────────────────────────────────────────────────────
function readWorkspaceConfig(wsPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(wsPath, '.sqlkit', 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

function writeWorkspaceConfig(wsPath, config) {
  const dir = path.join(wsPath, '.sqlkit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
}

async function closeDbClient() {
  if (!dbClient) return
  try { await dbClient.end() } catch (_) {}
  dbClient = null
  dbEngine = null
}

function isDirectoryPath(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

function isPathInside(parentPath, targetPath) {
  const rel = path.relative(path.resolve(parentPath), path.resolve(targetPath))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function validateWorkspaceFilePath(filePath) {
  if (!currentWorkspace) return { success: false, error: 'No workspace open' }
  if (!filePath) return { success: false, error: 'File path is required' }

  const resolvedPath = path.resolve(filePath)
  const workspacePath = path.resolve(currentWorkspace)

  if (!isPathInside(workspacePath, resolvedPath)) {
    return { success: false, error: 'File must be inside the current workspace' }
  }

  if (path.dirname(resolvedPath) !== workspacePath) {
    return { success: false, error: 'Only SQL files in the workspace root are supported' }
  }

  if (path.extname(resolvedPath).toLowerCase() !== '.sql') {
    return { success: false, error: 'Only .sql files are supported' }
  }

  return { success: true, path: resolvedPath }
}

function validateNewFileName(name) {
  if (!currentWorkspace) return { success: false, error: 'No workspace open' }

  const trimmedName = String(name || '').trim()
  if (!trimmedName) return { success: false, error: 'File name cannot be empty' }
  if (trimmedName !== path.basename(trimmedName) || trimmedName.includes('/') || trimmedName.includes('\\')) {
    return { success: false, error: 'File name must not include folders' }
  }

  const fileName = trimmedName.toLowerCase().endsWith('.sql') ? trimmedName : trimmedName + '.sql'
  const pathValidation = validateWorkspaceFilePath(path.join(currentWorkspace, fileName))
  if (!pathValidation.success) return pathValidation

  return { success: true, name: fileName, path: pathValidation.path }
}

async function openWorkspace(wsPath) {
  if (!isDirectoryPath(wsPath)) throw new Error('Directory not found')

  const resolvedWorkspacePath = path.resolve(wsPath)
  const isSwitchingWorkspace = !currentWorkspace || path.resolve(currentWorkspace) !== resolvedWorkspacePath

  if (isSwitchingWorkspace) await closeDbClient()
  fs.mkdirSync(path.join(resolvedWorkspacePath, '.sqlkit'), { recursive: true })
  currentWorkspace = resolvedWorkspacePath

  const config = readGlobalConfig()
  config.recentWorkspaces = (config.recentWorkspaces || []).filter(w => path.resolve(w.path) !== resolvedWorkspacePath)
  config.recentWorkspaces.unshift({
    path: resolvedWorkspacePath,
    name: path.basename(resolvedWorkspacePath),
    lastOpened: new Date().toISOString()
  })
  config.recentWorkspaces = config.recentWorkspaces.slice(0, 10)
  config.lastWorkspace = resolvedWorkspacePath
  writeGlobalConfig(config)

  if (mainWindow) mainWindow.setTitle(`SqlKit — ${path.basename(resolvedWorkspacePath)}`)

  return {
    success: true,
    path: resolvedWorkspacePath,
    name: path.basename(resolvedWorkspacePath),
    config: readWorkspaceConfig(resolvedWorkspacePath)
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  allowWindowClose = false
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1e1e1e',
    show: false,
    title: 'SqlKit'
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

  mainWindow.on('close', (event) => {
    if (allowWindowClose) return
    event.preventDefault()
    mainWindow.webContents.send('app:request-close')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    allowWindowClose = false
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await closeDbClient()
})

ipcMain.on('app:confirm-close-response', (_event, shouldClose) => {
  if (!shouldClose || !mainWindow || mainWindow.isDestroyed()) return
  allowWindowClose = true
  mainWindow.close()
})

// ── Workspace IPC ─────────────────────────────────────────────────────────────

ipcMain.handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Workspace Folder',
    buttonLabel: 'Open'
  })
  if (result.canceled) return { success: false, canceled: true }
  try {
    return await openWorkspace(result.filePaths[0])
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('workspace:open-path', async (_event, wsPath) => {
  if (!isDirectoryPath(wsPath)) return { success: false, error: 'Directory not found' }
  try {
    return await openWorkspace(wsPath)
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('workspace:get-recent', async () => {
  const config = readGlobalConfig()
  const workspaces = (config.recentWorkspaces || []).filter(w => isDirectoryPath(w.path))
  return { success: true, workspaces }
})

ipcMain.handle('workspace:get-last', async () => {
  const config = readGlobalConfig()
  if (config.lastWorkspace && isDirectoryPath(config.lastWorkspace)) {
    return { success: true, path: config.lastWorkspace }
  }
  return { success: false }
})

ipcMain.handle('workspace:get-current', async () => {
  if (!currentWorkspace) return { success: false }
  return { success: true, path: currentWorkspace, name: path.basename(currentWorkspace) }
})

ipcMain.handle('workspace:save-config', async (_event, config) => {
  if (!currentWorkspace) return { success: false, error: 'No workspace open' }
  try {
    writeWorkspaceConfig(currentWorkspace, config)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('workspace:get-config', async () => {
  if (!currentWorkspace) return { success: false }
  return { success: true, config: readWorkspaceConfig(currentWorkspace) }
})

// ── File IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('file:list', async () => {
  if (!currentWorkspace) return { success: false, error: 'No workspace' }
  try {
    const files = fs.readdirSync(currentWorkspace)
      .filter(f => path.extname(f).toLowerCase() === '.sql')
      .map(f => ({
        name: f,
        path: path.join(currentWorkspace, f),
        modified: fs.statSync(path.join(currentWorkspace, f)).mtime.toISOString()
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { success: true, files }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:read', async (_event, filePath) => {
  const validation = validateWorkspaceFilePath(filePath)
  if (!validation.success) return validation

  try {
    const content = fs.readFileSync(validation.path, 'utf8')
    return { success: true, content, name: path.basename(validation.path), path: validation.path }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:save', async (_event, filePath, content) => {
  const validation = validateWorkspaceFilePath(filePath)
  if (!validation.success) return validation

  try {
    fs.writeFileSync(validation.path, content, 'utf8')
    return { success: true, path: validation.path, name: path.basename(validation.path) }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:save-new', async (_event, name, content) => {
  const validation = validateNewFileName(name)
  if (!validation.success) return validation
  if (fs.existsSync(validation.path)) return { success: false, error: `File "${validation.name}" already exists` }

  try {
    fs.writeFileSync(validation.path, content, 'utf8')
    return { success: true, path: validation.path, name: validation.name }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:delete', async (_event, filePath) => {
  const validation = validateWorkspaceFilePath(filePath)
  if (!validation.success) return validation

  try {
    fs.unlinkSync(validation.path)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ── Database IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('db:connect', async (_event, profile) => {
  await closeDbClient()

  if (profile.engine !== 'postgresql') {
    const name = profile.engine === 'mysql' ? 'MySQL' : 'SQL Server'
    return { success: false, error: `${name} support is coming soon` }
  }

  let pg
  try {
    pg = require('pg')
  } catch (_) {
    return { success: false, error: 'pg driver not found — run: npm install' }
  }

  const client = new pg.Client({
    host: profile.host || 'localhost',
    port: parseInt(profile.port, 10) || 5432,
    database: profile.database || 'postgres',
    user: profile.username || 'postgres',
    password: profile.password || undefined,
    connectionTimeoutMillis: 10000
  })

  try {
    await client.connect()
    dbClient = client
    dbEngine = 'postgresql'

    const ver = await client.query('SELECT version()')
    const version = ver.rows[0]?.version?.split(' ').slice(0, 2).join(' ') || 'PostgreSQL'
    return { success: true, serverVersion: version }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('db:disconnect', async () => {
  await closeDbClient()
  return { success: true }
})

ipcMain.handle('db:get-tables', async () => {
  if (!dbClient) return { success: false, error: 'Not connected' }

  try {
    const result = await dbClient.query(`
      SELECT
        table_schema AS schema,
        table_name   AS name,
        CASE table_type
          WHEN 'BASE TABLE' THEN 'table'
          WHEN 'VIEW'       THEN 'view'
          ELSE lower(table_type)
        END AS type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY table_schema, table_name
    `)
    return { success: true, tables: result.rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('db:get-columns', async (_event, schema, table) => {
  if (!dbClient) return { success: false, error: 'Not connected' }

  try {
    const result = await dbClient.query(`
      SELECT
        column_name   AS name,
        data_type     AS type,
        is_nullable   AS nullable,
        column_default AS default_value
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table])
    return { success: true, columns: result.rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('db:run-query', async (_event, sql) => {
  if (!dbClient) return { success: false, error: 'Not connected' }
  if (!sql?.trim()) return { success: false, error: 'Query is empty' }

  const start = Date.now()
  try {
    const result = await dbClient.query(sql)
    const elapsed = Date.now() - start

    if (result.fields?.length > 0) {
      return {
        success: true,
        columns: result.fields.map(f => f.name),
        rows: result.rows.map(row =>
          result.fields.map(f => {
            const v = row[f.name]
            if (v === null || v === undefined) return null
            if (v instanceof Date) return v.toISOString()
            if (Buffer.isBuffer(v)) return `<binary: ${v.length} bytes>`
            if (typeof v === 'object') return JSON.stringify(v)
            return String(v)
          })
        ),
        executionTime: elapsed,
        rowCount: result.rowCount
      }
    }

    return {
      success: true,
      columns: [],
      rows: [],
      executionTime: elapsed,
      rowCount: result.rowCount,
      command: result.command
    }
  } catch (err) {
    return { success: false, error: err.message, executionTime: Date.now() - start }
  }
})
