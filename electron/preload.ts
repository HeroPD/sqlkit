import { contextBridge, ipcRenderer } from 'electron'
import type { SqlkitApi } from '../src/electron'

const api: SqlkitApi = {
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openWorkspacePath: (path) => ipcRenderer.invoke('workspace:open-path', path),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace:get-recent'),
  getWorkspaceConfig: () => ipcRenderer.invoke('workspace:get-config'),
  saveWorkspaceConfig: (config) => ipcRenderer.invoke('workspace:save-config', config),
}

contextBridge.exposeInMainWorld('sqlkit', api)
