export type RecentWorkspace = {
  name: string
  path: string
  lastOpened: string
}

export type WorkspaceResult =
  | { success: true; path: string; name: string }
  | { success: false; canceled?: boolean; error?: string }

export type SqlkitApi = {
  openWorkspace: () => Promise<WorkspaceResult>
  openWorkspacePath: (path: string) => Promise<WorkspaceResult>
  getRecentWorkspaces: () => Promise<RecentWorkspace[]>
}

declare global {
  interface Window {
    sqlkit: SqlkitApi
  }
}
