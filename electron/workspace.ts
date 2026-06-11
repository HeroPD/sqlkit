import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { RecentWorkspace, SaveResult, WorkspaceConfig, WorkspaceResult } from '../src/electron'

type GlobalConfig = {
  recentWorkspaces: RecentWorkspace[]
  lastWorkspace: string | null
}

// The workspace the renderer currently has open; set by openWorkspace and
// used by the per-workspace config read/write.
let currentWorkspace: string | null = null

const defaultWorkspaceConfig = (): WorkspaceConfig => ({ version: 1, connections: [] })

const workspaceConfigPathFor = (wsPath: string) => path.join(wsPath, '.sqlkit', 'config.json')

export function readWorkspaceConfig(): WorkspaceConfig {
  if (!currentWorkspace) return defaultWorkspaceConfig()
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceConfigPathFor(currentWorkspace), 'utf8')) as Partial<WorkspaceConfig>
    return {
      ...defaultWorkspaceConfig(),
      ...raw,
      // Profiles saved before the sqlite engine existed have no file field.
      connections: (raw.connections ?? []).map((connection) => ({ ...connection, file: connection.file ?? '' })),
    }
  } catch {
    return defaultWorkspaceConfig()
  }
}

export function writeWorkspaceConfig(config: WorkspaceConfig): SaveResult {
  if (!currentWorkspace) return { success: false, error: 'No workspace open' }
  try {
    fs.mkdirSync(path.join(currentWorkspace, '.sqlkit'), { recursive: true })
    fs.writeFileSync(workspaceConfigPathFor(currentWorkspace), JSON.stringify(config, null, 2))
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
  const sqlkitDir = path.join(workspacePath, '.sqlkit')
  fs.mkdirSync(sqlkitDir, { recursive: true })

  const workspaceConfigPath = workspaceConfigPathFor(workspacePath)
  if (!fs.existsSync(workspaceConfigPath)) {
    fs.writeFileSync(workspaceConfigPath, JSON.stringify(defaultWorkspaceConfig(), null, 2))
  }
  currentWorkspace = workspacePath

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
