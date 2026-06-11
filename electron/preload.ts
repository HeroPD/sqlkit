import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionStatus, SqlkitApi } from '../src/electron'

const api: SqlkitApi = {
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openWorkspacePath: (path) => ipcRenderer.invoke('workspace:open-path', path),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace:get-recent'),
  getWorkspaceConfig: () => ipcRenderer.invoke('workspace:get-config'),
  saveWorkspaceConfig: (config) => ipcRenderer.invoke('workspace:save-config', config),
  testConnection: (profile) => ipcRenderer.invoke('db:test', profile),
  testSshTunnel: (profile) => ipcRenderer.invoke('db:test-ssh', profile),
  connectDatabase: (profile) => ipcRenderer.invoke('db:connect', profile),
  disconnectDatabase: (profileId) => ipcRenderer.invoke('db:disconnect', profileId),
  disconnectAllDatabases: () => ipcRenderer.invoke('db:disconnect-all'),
  getConnectionStatuses: () => ipcRenderer.invoke('db:statuses'),
  onConnectionStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, statuses: ConnectionStatus[]) => listener(statuses)
    ipcRenderer.on('db:status', handler)
    return () => ipcRenderer.off('db:status', handler)
  },
  runQuery: (profileId, sql, params) => ipcRenderer.invoke('db:query', profileId, sql, params),
  listTables: (profileId) => ipcRenderer.invoke('db:list-tables', profileId),
  pickSqliteFile: () => ipcRenderer.invoke('db:pick-sqlite-file'),
}

contextBridge.exposeInMainWorld('sqlkit', api)
