const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sqlkit', {
  connect:      (profile) => ipcRenderer.invoke('db:connect', profile),
  disconnect:   ()        => ipcRenderer.invoke('db:disconnect'),
  getTables:    ()        => ipcRenderer.invoke('db:get-tables'),
  runQuery:     (sql)     => ipcRenderer.invoke('db:run-query', sql)
})
