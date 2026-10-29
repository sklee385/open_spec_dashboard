const { trustedAttentionSender } = require('./attention-links.cjs');
function registerWorkspacePicker({ ipcMain, dialog, window, origin, locked }) {
  let busy = false;
  ipcMain.handle('desktop:workspace-folder', async event => {
    const owner = window();
    if (!trustedAttentionSender(event, owner, origin()) || locked() || busy) throw new Error('폴더 선택을 요청할 수 없는 상태입니다.');
    busy = true;
    try {
      const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths?.length) return { cancelled: true };
      if (result.filePaths.length !== 1 || typeof result.filePaths[0] !== 'string') throw new Error('선택한 폴더를 확인하지 못했습니다.');
      return { cancelled: false, path: result.filePaths[0] };
    } finally { busy = false; }
  });
}
module.exports = { registerWorkspacePicker };
