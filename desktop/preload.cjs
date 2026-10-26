const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopUpdates', {
  status: () => ipcRenderer.invoke('desktop:status'),
  check: () => ipcRenderer.invoke('desktop:check'),
  install: () => ipcRenderer.invoke('desktop:install'),
});
