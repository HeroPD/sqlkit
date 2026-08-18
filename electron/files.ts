import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { FileInfo, FileReadResult, FileSaveResult, FilesResult } from '../src/electron'
import { t } from '../src/i18n'

const isSqlFile = (name: string) => path.extname(name).toLowerCase() === '.sql'
const MAX_SQL_FILE_BYTES = 10 * 1024 * 1024
const MAX_TREE_ITEMS = 20_000
const MAX_TREE_DEPTH = 64

const toRelative = (root: string, absPath: string) => path.relative(root, absPath).split(path.sep).join('/')

// realpath of the deepest existing ancestor with the not-yet-created tail
// re-appended, so a path whose final segments don't exist yet (save/create)
// still resolves through any symlinked parent.
function realpathDeep(target: string): string | null {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      try {
        // realpathSync also fails for a broken symlink. That must not be
        // treated like a missing future path, because writeFileSync would
        // follow the symlink and create/write its outside target.
        if (fs.lstatSync(current).isSymbolicLink()) return null
      } catch { /* lstat failed — nothing to resolve here; fall through */ }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = path.dirname(current)
      if (parent === current) return null
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

// True when `target` stays inside the workspace even after symlinks are
// followed. Lexical resolve + startsWith is bypassable: a symlink inside the
// workspace can point out of it, so both sides are compared by real path.
// (The caller still operates on the lexical path — reading/writing it follows
// the same symlinks we just proved resolve inside the root.)
function isInsideWorkspace(workspacePath: string, target: string): boolean {
  const root = realpathDeep(path.resolve(workspacePath))
  const real = realpathDeep(path.resolve(target))
  if (!root || !real) return false
  return real === root || real.startsWith(root + path.sep)
}

function isWorkspaceRoot(workspacePath: string, target: string): boolean {
  const root = realpathDeep(path.resolve(workspacePath))
  const real = realpathDeep(path.resolve(target))
  return root !== null && real !== null && real === root
}

function isInternalWorkspacePath(workspacePath: string, target: string): boolean {
  const resolved = path.resolve(target)
  if (resolved.split(path.sep).includes('.sqlkit')) return true
  const internal = realpathDeep(path.join(workspacePath, '.sqlkit'))
  const real = realpathDeep(resolved)
  return internal !== null && real !== null && (real === internal || real.startsWith(internal + path.sep))
}

// A context folder is one or two plain path segments inside the workspace:
// the connection's folder, optionally followed by a child-database folder
// (all-databases mode) — connection/child/file.sql.
const isSafeSegment = (segment: string) => /^[\w][\w .-]*$/.test(segment) && segment !== '.sqlkit'

export function resolveContextRoot(workspacePath: string, folder: string): string | null {
  const segments = folder.split('/').filter(Boolean)
  if (!segments.length || segments.length > 2 || !segments.every(isSafeSegment)) return null
  return path.join(workspacePath, ...segments)
}

function collectFiles(root: string, dir: string, files: FileInfo[], depth = 0): FileInfo[] {
  if (depth > MAX_TREE_DEPTH) throw new Error(`Workspace folders may not be nested more than ${MAX_TREE_DEPTH} levels.`)
  // Dotfiles (.sqlkit, .DS_Store, .git…) stay out of the tree.
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'))

  for (const entry of entries) {
    if (files.length >= MAX_TREE_ITEMS) throw new Error(`This database folder contains more than ${MAX_TREE_ITEMS.toLocaleString()} items. Narrow the folder before opening it.`)
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Folders are listed too so empty ones still show in the tree.
      files.push({ type: 'folder', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
      collectFiles(root, entryPath, files, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    // Every file type is listed (.sql opens in the editor; the rest open
    // with the system's default app).
    files.push({ type: 'file', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
  }

  return files
}

async function collectFilesAsync(root: string, dir: string, files: FileInfo[], depth = 0): Promise<FileInfo[]> {
  if (depth > MAX_TREE_DEPTH) throw new Error(`Workspace folders may not be nested more than ${MAX_TREE_DEPTH} levels.`)
  const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.'))
  for (const entry of entries) {
    if (files.length >= MAX_TREE_ITEMS) throw new Error(`This database folder contains more than ${MAX_TREE_ITEMS.toLocaleString()} items. Narrow the folder before opening it.`)
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push({ type: 'folder', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
      await collectFilesAsync(root, entryPath, files, depth + 1)
    } else if (entry.isFile()) {
      files.push({ type: 'file', name: entry.name, path: entryPath, relativePath: toRelative(root, entryPath) })
    }
  }
  return files
}

// Lists one database context's folder, never the whole workspace — each
// connection (and each child database) keeps its files in its own subfolder
// so contexts don't mix.
export function listWorkspaceFiles(workspacePath: string | null, folder: string): FilesResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const root = resolveContextRoot(workspacePath, folder)
  if (!root) return { success: false, error: t('file.invalidDatabaseFolder') }

  // Context folders are created on first save; a missing one (or a child
  // folder that doesn't exist yet) just lists as empty.
  if (!fs.existsSync(root)) return { success: true, files: [] }
  if (!isInsideWorkspace(workspacePath, root)) return { success: false, error: t('file.databaseFolderOutsideWorkspace') }
  if (isInternalWorkspacePath(workspacePath, root)) return { success: false, error: t('file.internalFolder') }

  try {
    const files = collectFiles(root, root, [])
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return { success: true, files }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

export async function listWorkspaceFilesAsync(workspacePath: string | null, folder: string): Promise<FilesResult> {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const root = resolveContextRoot(workspacePath, folder)
  if (!root) return { success: false, error: t('file.invalidDatabaseFolder') }
  try {
    await fsp.access(root)
  } catch {
    return { success: true, files: [] }
  }
  if (!isInsideWorkspace(workspacePath, root)) return { success: false, error: t('file.databaseFolderOutsideWorkspace') }
  if (isInternalWorkspacePath(workspacePath, root)) return { success: false, error: t('file.internalFolder') }
  try {
    const files = await collectFilesAsync(root, root, [])
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
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }

  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) {
    return { success: false, error: t('file.pathOutsideWorkspace') }
  }
  if (!isSqlFile(resolved)) return { success: false, error: t('file.openSqlOnly') }

  try {
    if (fs.statSync(resolved).size > MAX_SQL_FILE_BYTES) return { success: false, error: t('file.tooLargeToOpen') }
    return { success: true, content: fs.readFileSync(resolved, 'utf8') }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

export async function readWorkspaceFileAsync(workspacePath: string | null, filePath: string): Promise<FileReadResult> {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) return { success: false, error: t('file.pathOutsideWorkspace') }
  if (!isSqlFile(resolved)) return { success: false, error: t('file.openSqlOnly') }
  try {
    if ((await fsp.stat(resolved)).size > MAX_SQL_FILE_BYTES) return { success: false, error: t('file.tooLargeToOpen') }
    return { success: true, content: await fsp.readFile(resolved, 'utf8') }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// Saves go through a sibling temp file and a rename, so a crash mid-write can't
// truncate work the user already had. The name leads with a dot — dotfiles are
// filtered from the Explorer, so it never flickers into the tree — and carries a
// random suffix: two saves racing on one path (⌘S held down, or ⌘S while a
// save-as is in flight) would otherwise share a temp, and the first rename would
// leave the second failing on a file that is no longer there.
const tempSavePath = (target: string) =>
  path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)

// Writes a .sql file under the workspace root, with the same hardening as
// readWorkspaceFile. Used by both save (existing path) and save-as (path
// picked in a native dialog — still validated, dialogs can navigate anywhere).
export function saveWorkspaceFile(workspacePath: string | null, filePath: string, content: string): FileSaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }

  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) {
    return { success: false, error: t('file.filesInsideWorkspace') }
  }
  if (isInternalWorkspacePath(workspacePath, resolved)) return { success: false, error: t('file.internalFolder') }
  if (!isSqlFile(resolved)) return { success: false, error: t('file.saveSqlOnly') }
  if (Buffer.byteLength(content, 'utf8') > MAX_SQL_FILE_BYTES) return { success: false, error: t('file.tooLargeToSave') }

  const temp = tempSavePath(resolved)
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(temp, content, 'utf8')
    fs.renameSync(temp, resolved)
    return { success: true, path: resolved, name: path.basename(resolved) }
  } catch (error) {
    // A name of its own means a failed save leaves an orphan of its own, hidden
    // from the tree but real on disk (and in the user's git).
    try {
      fs.unlinkSync(temp)
    } catch {
      // Never created, or already renamed into place.
    }
    return { success: false, error: (error as Error).message }
  }
}

export async function saveWorkspaceFileAsync(workspacePath: string | null, filePath: string, content: string): Promise<FileSaveResult> {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) return { success: false, error: t('file.filesInsideWorkspace') }
  if (isInternalWorkspacePath(workspacePath, resolved)) return { success: false, error: t('file.internalFolder') }
  if (!isSqlFile(resolved)) return { success: false, error: t('file.saveSqlOnly') }
  if (Buffer.byteLength(content, 'utf8') > MAX_SQL_FILE_BYTES) return { success: false, error: t('file.tooLargeToSave') }
  const temp = tempSavePath(resolved)
  try {
    await fsp.mkdir(path.dirname(resolved), { recursive: true })
    await fsp.writeFile(temp, content, 'utf8')
    await fsp.rename(temp, resolved)
    return { success: true, path: resolved, name: path.basename(resolved) }
  } catch (error) {
    await fsp.unlink(temp).catch(() => {})
    return { success: false, error: (error as Error).message }
  }
}

// Creates an empty .sql file inside a database context's folder. Refuses to
// overwrite — creation comes from the Explorer's inline "new file" input.
export function createWorkspaceFile(workspacePath: string | null, folder: string, relativePath: string): FileSaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const root = resolveContextRoot(workspacePath, folder)
  if (!root) return { success: false, error: t('file.invalidDatabaseFolder') }

  const resolved = path.resolve(root, relativePath)
  // Lexical check keeps relativePath inside this context folder; the realpath
  // check below additionally blocks escapes through a symlinked folder.
  if (!resolved.startsWith(root + path.sep)) return { success: false, error: t('file.mustStayInDatabaseFolder') }
  if (isInternalWorkspacePath(workspacePath, resolved)) return { success: false, error: t('file.internalFolder') }

  const target = isSqlFile(resolved) ? resolved : `${resolved}.sql`
  if (!isInsideWorkspace(workspacePath, target)) return { success: false, error: t('file.mustStayInDatabaseFolder') }
  if (fs.existsSync(target)) return { success: false, error: `${path.basename(target)} already exists` }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '', 'utf8')
    return { success: true, path: target, name: path.basename(target) }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// Renames a file within its directory; the new name is a bare filename,
// never a path. A new name without an extension keeps the old one's, so
// renaming "report.sql" to "monthly" yields "monthly.sql" — same for .xlsx.
export function renameWorkspaceFile(workspacePath: string | null, filePath: string, newName: string): FileSaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }

  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) return { success: false, error: t('file.fileOutsideWorkspace') }
  if (isInternalWorkspacePath(workspacePath, resolved)) return { success: false, error: t('file.internalFolder') }

  const trimmed = newName.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
    return { success: false, error: t('file.invalidName') }
  }
  const name = path.extname(trimmed) ? trimmed : `${trimmed}${path.extname(resolved)}`
  const target = path.join(path.dirname(resolved), name)
  if (target === resolved) return { success: true, path: resolved, name }
  if (fs.existsSync(target)) return { success: false, error: `${name} already exists` }

  try {
    fs.renameSync(resolved, target)
    return { success: true, path: target, name }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// open-external hands the file to the OS default app, so restrict it to
// documents/data/images. Executables, scripts and HTML are refused: a workspace
// opened from an untrusted source must not run code on a single click.
const OPENABLE_EXTERNALLY = new Set([
  '.csv', '.tsv', '.txt', '.json', '.jsonl', '.ndjson', '.md', '.markdown', '.log', '.xml', '.yaml', '.yml',
  '.pdf', '.xlsx', '.xls', '.ods', '.docx', '.doc', '.rtf', '.odt', '.parquet',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
])

// open: hand the file to the OS default app. reveal: show it in the file
// manager (never open). reject: refuse. Directories are only ever revealed —
// shell.openPath would LAUNCH a macOS package like malicious.app, so a
// directory must not reach openPath.
export type ExternalOpenAction = 'open' | 'reveal' | 'reject'

export function externalOpenAction(resolvedPath: string): ExternalOpenAction {
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return 'reject'
  }
  if (stat.isDirectory()) return 'reveal'
  return OPENABLE_EXTERNALLY.has(path.extname(resolvedPath).toLowerCase()) ? 'open' : 'reject'
}

/** Validates a workspace file/folder path for delete or open-external. */
export function resolveWorkspaceItem(
  workspacePath: string | null,
  filePath: string,
  options: { allowRoot?: boolean } = {},
): { path: string } | { error: string } {
  if (!workspacePath) return { error: t('file.noWorkspace') }
  const resolved = path.resolve(filePath)
  if (!isInsideWorkspace(workspacePath, resolved)) return { error: t('file.pathOutsideWorkspace') }
  if (options.allowRoot === false && isWorkspaceRoot(workspacePath, resolved)) return { error: t('file.cannotDeleteWorkspace') }
  if (isInternalWorkspacePath(workspacePath, resolved)) return { error: t('file.internalFolder') }
  try {
    fs.statSync(resolved)
    return { path: resolved }
  } catch {
    return { error: t('file.notFound') }
  }
}

// --- Change watcher --------------------------------------------------------

const DEBOUNCE_MS = 150

type WatchState = {
  watcher: fs.FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
}

const watchers = new Map<number, WatchState>()

export function stopWorkspaceWatcher(id?: number) {
  if (id === undefined) {
    for (const key of watchers.keys()) stopWorkspaceWatcher(key)
    return
  }

  const state = watchers.get(id)
  if (!state) return
  state.watcher?.close()
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  watchers.delete(id)
}

// Watches the workspace for .sql changes and fires `notify` (debounced) so
// the renderer can refresh its file list. Watch failures degrade to manual
// refresh rather than erroring the app.
export function startWorkspaceWatcher(id: number, workspacePath: string, notify: () => void) {
  stopWorkspaceWatcher(id)

  const state: WatchState = { watcher: null, debounceTimer: null }
  watchers.set(id, state)

  const schedule = () => {
    if (state.debounceTimer) return
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null
      notify()
    }, DEBOUNCE_MS)
  }

  try {
    state.watcher = fs.watch(workspacePath, { recursive: true, persistent: false }, (_event, filename) => {
      // Some platforms emit events with no filename; refresh defensively.
      // All file types are listed in the Explorer, so only internal churn
      // (.sqlkit) is filtered.
      if (filename) {
        const normalized = String(filename).split(path.sep).join('/')
        if (normalized.split('/').includes('.sqlkit')) return
      }
      schedule()
    })
    state.watcher.on('error', () => stopWorkspaceWatcher(id))
  } catch {
    stopWorkspaceWatcher(id)
  }
}
