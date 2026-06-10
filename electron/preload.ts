import { contextBridge, ipcRenderer } from 'electron'
import type { SqlkitApi } from '../src/electron'

const api: SqlkitApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  ping: () => ipcRenderer.invoke('ping'),
}

contextBridge.exposeInMainWorld('sqlkit', api)
