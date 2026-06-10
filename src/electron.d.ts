export type RecentWorkspace = {
  name: string
  path: string
  lastOpened: string
}

export type WorkspaceResult =
  | { success: true; path: string; name: string }
  | { success: false; canceled?: boolean; error?: string }

export type Engine = 'postgresql' | 'mysql' | 'sqlserver'

export type ConnectionProfile = {
  id: string
  name: string
  engine: Engine
  host: string
  port: string
  username: string
  password: string
  database: string
}

export type WorkspaceConfig = {
  version: number
  connections: ConnectionProfile[]
}

export type SaveResult = { success: true } | { success: false; error: string }

export type SqlkitApi = {
  openWorkspace: () => Promise<WorkspaceResult>
  openWorkspacePath: (path: string) => Promise<WorkspaceResult>
  getRecentWorkspaces: () => Promise<RecentWorkspace[]>
  getWorkspaceConfig: () => Promise<WorkspaceConfig>
  saveWorkspaceConfig: (config: WorkspaceConfig) => Promise<SaveResult>
}

declare global {
  interface Window {
    sqlkit: SqlkitApi
  }
}
