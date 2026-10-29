const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopHealth', {
  inspect: () => ipcRenderer.invoke('desktop:health-inspect'),
  recover: id => ipcRenderer.invoke('desktop:health-recover', id),
  interrupt: id => ipcRenderer.invoke('desktop:health-interrupt', id),
  openWork: id => ipcRenderer.invoke('desktop:health-open-work', id),
  safeMode: enabled => ipcRenderer.invoke('desktop:health-safe-mode', enabled),
  forceQuit: () => ipcRenderer.invoke('desktop:health-force'),
});
