import { contextBridge, ipcRenderer } from 'electron'
import type { SqlkitApi } from '../src/electron'

const api: SqlkitApi = {
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openWorkspacePath: (path) => ipcRenderer.invoke('workspace:open-path', path),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace:get-recent'),
}

contextBridge.exposeInMainWorld('sqlkit', api)
