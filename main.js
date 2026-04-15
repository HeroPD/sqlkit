const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

let mainWindow
let dbClient = null
let dbEngine = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#f2f2f7',
    show: false,
    title: 'SqlKit'
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

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
  if (dbClient) {
    try { await dbClient.end() } catch (_) {}
  }
})

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('db:connect', async (_event, profile) => {
  if (dbClient) {
    try { await dbClient.end() } catch (_) {}
    dbClient = null
    dbEngine = null
  }

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
  if (dbClient) {
    try { await dbClient.end() } catch (_) {}
    dbClient = null
    dbEngine = null
  }
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
