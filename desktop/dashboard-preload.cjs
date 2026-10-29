const { contextBridge, ipcRenderer } = require('electron');
function draftRequest(operation, key, value) {
  const result = ipcRenderer.sendSync('desktop:draft', operation, key, value);
  if (!result?.ok) throw Error(result?.error || '초안 저장소 응답을 확인하지 못했습니다');
  return result.value;
}
contextBridge.exposeInMainWorld('desktopDrafts', {
  getItem: key => draftRequest('get', key),
  setItem: (key, value) => { draftRequest('set', key, value); },
  removeItem: key => { draftRequest('remove', key); },
});
contextBridge.exposeInMainWorld('desktopRecovery', {
  onOpenWork(callback) {
    const listener = (_event, workId) => { if (typeof workId === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(workId)) callback(workId); };
    ipcRenderer.on('desktop:open-work', listener);
    return () => ipcRenderer.removeListener('desktop:open-work', listener);
  },
});
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
