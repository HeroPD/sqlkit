import fs from 'node:fs'
import path from 'node:path'
import type { FileInfo, FileReadResult, FilesResult } from '../src/electron'

const isSqlFile = (name: string) => path.extname(name).toLowerCase() === '.sql'

const toRelative = (root: string, absPath: string) => path.relative(root, absPath).split(path.sep).join('/')

function collectSqlFiles(root: string, dir: string, files: FileInfo[]): FileInfo[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name !== '.sqlkit')

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Folders are listed too so empty ones still show in the tree.
      files.push({ type: 'folder', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
      collectSqlFiles(root, entryPath, files)
      continue
    }
    if (!entry.isFile() || !isSqlFile(entry.name)) continue
    files.push({ type: 'file', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
  }

  return files
}

// Lists one database context's folder, never the whole workspace — each
// connection keeps its .sql files in its own subfolder so contexts don't mix.
export function listSqlFiles(workspacePath: string | null, folder: string): FilesResult {
  if (!workspacePath) return { success: false, error: 'No workspace open' }
  if (!folder || folder.includes('/') || folder.includes('\\') || folder.startsWith('.')) {
    return { success: false, error: 'Invalid database folder' }
  }

  const root = path.join(workspacePath, folder)
  // The folder is created when the profile is saved; a missing one (e.g. a
  // hand-deleted directory) just lists as empty.
  if (!fs.existsSync(root)) return { success: true, files: [] }

  try {
    const files = collectSqlFiles(root, root, [])
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return { success: true, files }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// Reads a .sql file, refusing paths that escape the workspace root — the
// renderer only ever hands back paths it got from listSqlFiles, but IPC input
// is untrusted by construction.
export function readWorkspaceFile(workspacePath: string | null, filePath: string): FileReadResult {
  if (!workspacePath) return { success: false, error: 'No workspace open' }

  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(workspacePath + path.sep)) {
    return { success: false, error: 'Path is outside the workspace' }
  }
  if (!isSqlFile(resolved)) return { success: false, error: 'Only .sql files can be opened' }

  try {
    return { success: true, content: fs.readFileSync(resolved, 'utf8') }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// --- Change watcher --------------------------------------------------------

const DEBOUNCE_MS = 150

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null

export function stopWorkspaceWatcher() {
  watcher?.close()
  watcher = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
}

// Watches the workspace for .sql changes and fires `notify` (debounced) so
// the renderer can refresh its file list. Watch failures degrade to manual
// refresh rather than erroring the app.
export function startWorkspaceWatcher(workspacePath: string, notify: () => void) {
  stopWorkspaceWatcher()

  const schedule = () => {
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      notify()
    }, DEBOUNCE_MS)
  }

  try {
    watcher = fs.watch(workspacePath, { recursive: true, persistent: false }, (_event, filename) => {
      // Some platforms emit events with no filename; refresh defensively.
      if (filename) {
        const normalized = String(filename).split(path.sep).join('/')
        if (normalized.split('/').includes('.sqlkit')) return
        // Folder events carry no extension marker, so only filter clearly
        // unrelated files.
        if (path.extname(normalized) && !isSqlFile(normalized)) return
      }
      schedule()
    })
    watcher.on('error', stopWorkspaceWatcher)
  } catch {
    watcher = null
  }
}
