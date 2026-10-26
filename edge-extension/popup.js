const form = document.getElementById('pair-form');
const disconnectButton = document.getElementById('disconnect');
const statusOutput = document.getElementById('status');
const pairButton = document.getElementById('pair');

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '확장 응답을 받지 못했습니다.');
  return response.result;
}
function show(connection) {
  form.hidden = connection.connected;
  disconnectButton.hidden = !connection.connected;
  statusOutput.textContent = connection.connected
    ? `연결됨: ${connection.title}\n${connection.url}\n업무: ${connection.workId}`
    : '연결되지 않았습니다.';
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pairButton.disabled) return;
  pairButton.disabled = true;
  try {
    const connection = await request({ type: 'pair', endpoint: document.getElementById('endpoint').value.trim(), code: document.getElementById('code').value.trim() });
    document.getElementById('code').value = '';
    show(connection);
  } catch (error) { statusOutput.textContent = error.message; }
  finally { pairButton.disabled = false; }
});
disconnectButton.addEventListener('click', async () => {
  try { show(await request({ type: 'disconnect' })); }
  catch (error) {
    show({ connected: false });
    statusOutput.textContent = `확장 연결은 해제되었습니다. 서버 확인: ${error.message}`;
  }
});
request({ type: 'status' }).then(show).catch(error => { statusOutput.textContent = error.message; });
