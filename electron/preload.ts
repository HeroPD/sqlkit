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
  setActiveChildDb: (profileId, database) => ipcRenderer.invoke('db:set-active-child', profileId, database),
  getConnectionStatuses: () => ipcRenderer.invoke('db:statuses'),
  onConnectionStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, statuses: ConnectionStatus[]) => listener(statuses)
    ipcRenderer.on('db:status', handler)
    return () => ipcRenderer.off('db:status', handler)
  },
  runQuery: (profileId, sql, params) => ipcRenderer.invoke('db:query', profileId, sql, params),
  cancelQuery: (profileId) => ipcRenderer.invoke('db:cancel', profileId),
  createDatabase: (profileId, name) => ipcRenderer.invoke('db:create-database', profileId, name),
  dropDatabase: (profileId, name) => ipcRenderer.invoke('db:drop-database', profileId, name),
  listTables: (profileId) => ipcRenderer.invoke('db:list-tables', profileId),
  listColumns: (profileId) => ipcRenderer.invoke('db:list-columns', profileId),
  inspectTable: (profileId, table) => ipcRenderer.invoke('db:inspect-table', profileId, table),
  pickSqliteFile: () => ipcRenderer.invoke('db:pick-sqlite-file'),
  listFiles: (folder) => ipcRenderer.invoke('file:list', folder),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  saveFile: (path, content) => ipcRenderer.invoke('file:save', path, content),
  saveFileAs: (folder, suggestedName, content) => ipcRenderer.invoke('file:save-as', folder, suggestedName, content),
  createFile: (folder, relativePath) => ipcRenderer.invoke('file:create', folder, relativePath),
  renameFile: (path, newName) => ipcRenderer.invoke('file:rename', path, newName),
  deleteFile: (path) => ipcRenderer.invoke('file:delete', path),
  openExternal: (path) => ipcRenderer.invoke('file:open-external', path),
  onFilesChanged: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('workspace:files-changed', handler)
    return () => ipcRenderer.off('workspace:files-changed', handler)
  },
  onMenuAction: (listener) => {
    const handler = (_event: IpcRendererEvent, action: Parameters<typeof listener>[0]) => listener(action)
    ipcRenderer.on('app:menu', handler)
    return () => ipcRenderer.off('app:menu', handler)
  },
}

contextBridge.exposeInMainWorld('sqlkit', api)
