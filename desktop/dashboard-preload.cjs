const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopAttention', {
  onRequest(callback) {
    const listener = (_event, value) => {
      if (value?.invalid === true) callback({ invalid: true });
      else if (typeof value?.workId === 'string' && typeof value?.questionId === 'string' && value.workId.length <= 512 && value.questionId.length <= 512) callback({ workId: value.workId, questionId: value.questionId });
    };
    ipcRenderer.on('desktop:attention', listener);
    return () => ipcRenderer.removeListener('desktop:attention', listener);
  },
  ready: () => ipcRenderer.invoke('desktop:attention-ready'),
});
