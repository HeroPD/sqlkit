import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ConnectionProfile, RecentWorkspace, SaveResult, WorkspaceConfig, WorkspaceResult } from '../src/electron'

type GlobalConfig = {
  recentWorkspaces: RecentWorkspace[]
  lastWorkspace: string | null
}

// The workspace the renderer currently has open; set by openWorkspace and
// used by the per-workspace config read/write.
let currentWorkspace: string | null = null

export const currentWorkspacePath = () => currentWorkspace

const defaultWorkspaceConfig = (): WorkspaceConfig => ({ version: 1, connections: [] })

const workspaceConfigPathFor = (wsPath: string) => path.join(wsPath, '.sqlkit', 'config.json')

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 60) || 'database'

// A folder must stay a single path segment inside the workspace; anything
// else (separators, dot-segments) came from a hand-edited config and is
// re-derived from the name instead.
const isSafeFolder = (folder: string) => /^[\w][\w .-]*$/.test(folder) && folder !== '.sqlkit'

// Fills in missing per-profile fields from before they existed: `file`
// (sqlite) and `folder` — each connection owns a workspace subfolder for its
// .sql files, slugged from its name and deduped, then never re-derived so
// later renames don't move files.
function normalizeConnections(connections: ConnectionProfile[]): ConnectionProfile[] {
  const taken = new Set(connections.map((connection) => connection.folder).filter(Boolean))
  return connections.map((connection) => {
    if (connection.folder && isSafeFolder(connection.folder)) return { ...connection, file: connection.file ?? '' }
    const base = slugify(connection.name)
    let folder = base
    for (let suffix = 2; taken.has(folder); suffix += 1) folder = `${base}-${suffix}`
    taken.add(folder)
    return { ...connection, file: connection.file ?? '', folder }
  })
}

// Secrets at rest: encrypted through the OS keychain (Electron safeStorage)
// and marked with a prefix so legacy plaintext configs still read — they
// migrate to encrypted on the next save (openWorkspace re-saves, so on first
// open). Keychain-bound by design: a config copied to another machine
// decrypts to '' and the password must be re-entered there. Falls back to
// plaintext only where the OS offers no key store.
const SECRET_PREFIX = 'enc:v1:'

const encryptSecret = (value: string): string => {
  if (!value || value.startsWith(SECRET_PREFIX) || !safeStorage.isEncryptionAvailable()) return value
  return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
}

const decryptSecret = (value: string): string => {
  if (!value.startsWith(SECRET_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

const mapSecrets = (connection: ConnectionProfile, map: (value: string) => string): ConnectionProfile => ({
  ...connection,
  password: map(connection.password ?? ''),
  ...(connection.ssh
    ? { ssh: { ...connection.ssh, password: map(connection.ssh.password ?? ''), passphrase: map(connection.ssh.passphrase ?? '') } }
    : {}),
})

export function readWorkspaceConfig(): WorkspaceConfig {
  if (!currentWorkspace) return defaultWorkspaceConfig()
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceConfigPathFor(currentWorkspace), 'utf8')) as Partial<WorkspaceConfig>
    return {
      ...defaultWorkspaceConfig(),
      ...raw,
      connections: normalizeConnections(raw.connections ?? []).map((connection) => mapSecrets(connection, decryptSecret)),
    }
  } catch {
    return defaultWorkspaceConfig()
  }
}

export function writeWorkspaceConfig(config: WorkspaceConfig): SaveResult {
  if (!currentWorkspace) return { success: false, error: 'No workspace open' }
  try {
    const normalized = { ...config, connections: normalizeConnections(config.connections) }
    fs.mkdirSync(path.join(currentWorkspace, '.sqlkit'), { recursive: true })
    // Every connection's files folder exists from the moment it's saved.
    for (const connection of normalized.connections) {
      fs.mkdirSync(path.join(currentWorkspace, connection.folder), { recursive: true })
    }
    const stored = {
      ...normalized,
      connections: normalized.connections.map((connection) => mapSecrets(connection, encryptSecret)),
    }
    fs.writeFileSync(workspaceConfigPathFor(currentWorkspace), JSON.stringify(stored, null, 2))
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

const globalConfigPath = () => path.join(app.getPath('userData'), 'config.json')

export function readGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8')) as GlobalConfig
  } catch {
    return { recentWorkspaces: [], lastWorkspace: null }
  }
}

function writeGlobalConfig(config: GlobalConfig) {
  fs.writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2))
}

export function isDirectory(checkPath: string) {
  try {
    return fs.statSync(checkPath).isDirectory()
  } catch {
    return false
  }
}

// Opens (and initializes) a workspace folder: ensures the .sqlkit marker
// directory with a seeded config.json, and records the folder at the top of
// the global recent list.
export function openWorkspace(wsPath: string): WorkspaceResult {
  if (!isDirectory(wsPath)) {
    return { success: false, error: 'Directory not found' }
  }

  const workspacePath = path.resolve(wsPath)
  currentWorkspace = workspacePath
  // Seeds the config when missing, and brings older configs up to date:
  // assigns per-connection folders and creates them on disk.
  writeWorkspaceConfig(readWorkspaceConfig())

  const name = path.basename(workspacePath)
  const config = readGlobalConfig()
  config.recentWorkspaces = (config.recentWorkspaces ?? []).filter(
    (workspace) => path.resolve(workspace.path) !== workspacePath,
  )
  config.recentWorkspaces.unshift({ path: workspacePath, name, lastOpened: new Date().toISOString() })
  config.recentWorkspaces = config.recentWorkspaces.slice(0, 10)
  config.lastWorkspace = workspacePath
  writeGlobalConfig(config)

  return { success: true, path: workspacePath, name }
}
