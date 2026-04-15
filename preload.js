const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sqlkit', {
  // Database
  connect:      (profile)        => ipcRenderer.invoke('db:connect', profile),
  disconnect:   ()               => ipcRenderer.invoke('db:disconnect'),
  getTables:    ()               => ipcRenderer.invoke('db:get-tables'),
  getColumns:   (schema, table)  => ipcRenderer.invoke('db:get-columns', schema, table),
  runQuery:     (sql)            => ipcRenderer.invoke('db:run-query', sql),

  // Workspace
  openWorkspace:      ()          => ipcRenderer.invoke('workspace:open'),
  openWorkspacePath:  (p)         => ipcRenderer.invoke('workspace:open-path', p),
  getRecentWorkspaces:()          => ipcRenderer.invoke('workspace:get-recent'),
  getLastWorkspace:   ()          => ipcRenderer.invoke('workspace:get-last'),
  getCurrentWorkspace:()          => ipcRenderer.invoke('workspace:get-current'),
  saveWorkspaceConfig:(c)         => ipcRenderer.invoke('workspace:save-config', c),
  getWorkspaceConfig: ()          => ipcRenderer.invoke('workspace:get-config'),

  // Files
  listFiles:    ()               => ipcRenderer.invoke('file:list'),
  readFile:     (p)              => ipcRenderer.invoke('file:read', p),
  saveFile:     (p, content)     => ipcRenderer.invoke('file:save', p, content),
  saveNewFile:  (name, content)  => ipcRenderer.invoke('file:save-new', name, content),
  deleteFile:   (p)              => ipcRenderer.invoke('file:delete', p),
})
