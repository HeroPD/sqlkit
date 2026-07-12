import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionStatus, SqlkitApi } from '../src/electron'

const api: SqlkitApi = {
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openWorkspacePath: (path) => ipcRenderer.invoke('workspace:open-path', path),
  closeWorkspace: () => ipcRenderer.invoke('workspace:close'),
  newWindow: () => ipcRenderer.invoke('app:new-window'),
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
  runQuery: (profileId, childDb, sql, params, sort, executionId) =>
    ipcRenderer.invoke('db:query', profileId, childDb, sql, params, sort, executionId),
  runBatch: (profileId, childDb, statements) => ipcRenderer.invoke('db:run-batch', profileId, childDb, statements),
  runDdl: (profileId, childDb, statements) => ipcRenderer.invoke('db:run-ddl', profileId, childDb, statements),
  fetchRows: (sessionId, offset, limit) => ipcRenderer.invoke('db:fetch-rows', sessionId, offset, limit),
  exportQuery: (profileId, childDb, sql, sort, format, suggestedName) =>
    ipcRenderer.invoke('db:export-query', profileId, childDb, sql, sort, format, suggestedName),
  closeSession: (sessionId) => ipcRenderer.invoke('db:close-session', sessionId),
  cancelQuery: (profileId, executionId) => ipcRenderer.invoke('db:cancel', profileId, executionId),
  createDatabase: (profileId, name) => ipcRenderer.invoke('db:create-database', profileId, name),
  dropDatabase: (profileId, name) => ipcRenderer.invoke('db:drop-database', profileId, name),
  listTables: (profileId, childDb) => ipcRenderer.invoke('db:list-tables', profileId, childDb),
  listColumns: (profileId, childDb) => ipcRenderer.invoke('db:list-columns', profileId, childDb),
  inspectTable: (profileId, childDb, table) => ipcRenderer.invoke('db:inspect-table', profileId, childDb, table),
  listObjects: (profileId, childDb) => ipcRenderer.invoke('db:list-objects', profileId, childDb),
  inspectObject: (profileId, childDb, object, objectKind) =>
    ipcRenderer.invoke('db:inspect-object', profileId, childDb, object, objectKind),
  inspectServer: (profileId, childDb) => ipcRenderer.invoke('db:inspect-server', profileId, childDb),
  pickSqliteFile: () => ipcRenderer.invoke('db:pick-sqlite-file'),
  listFiles: (folder) => ipcRenderer.invoke('file:list', folder),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  saveFile: (path, content) => ipcRenderer.invoke('file:save', path, content),
  saveFileAs: (folder, suggestedName, content) => ipcRenderer.invoke('file:save-as', folder, suggestedName, content),
  exportFile: (suggestedName, content) => ipcRenderer.invoke('file:export', suggestedName, content),
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
