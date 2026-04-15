const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sqlkit', {
  connect:      (profile)        => ipcRenderer.invoke('db:connect', profile),
  disconnect:   ()               => ipcRenderer.invoke('db:disconnect'),
  getTables:    ()               => ipcRenderer.invoke('db:get-tables'),
  getColumns:   (schema, table)  => ipcRenderer.invoke('db:get-columns', schema, table),
  runQuery:     (sql)            => ipcRenderer.invoke('db:run-query', sql)
})
