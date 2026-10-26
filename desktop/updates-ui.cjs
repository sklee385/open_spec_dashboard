const labels = { idle:'업데이트 확인 대기', disabled:'자동 업데이트 사용 안 함', checking:'새 버전 확인 중', current:'최신 버전입니다', downloading:'다운로드 중', ready:'설치 준비 완료', waiting:'업무 종료 대기', installing:'정상 종료 및 업데이트 설치 중', error:'업데이트 실패' };
let acting = false;
function connectionError() {
  document.getElementById('message').textContent = '앱 연결을 확인할 수 없습니다. 다시 열어 주세요.';
  document.getElementById('install').disabled = true;
  document.getElementById('check').disabled = true;
}
async function render() {
  try {
    const s = await window.desktopUpdates.status();
    document.getElementById('version').textContent = `현재 ${s.currentVersion}${s.targetVersion ? ` → 새 버전 ${s.targetVersion}` : ''}`;
    document.getElementById('state').textContent = labels[s.state] || s.state;
    document.getElementById('message').textContent = s.message;
    document.getElementById('progress').value = s.percent;
    document.getElementById('install').disabled = acting || !['ready','waiting'].includes(s.state);
    document.getElementById('check').disabled = acting || ['disabled','checking','downloading','installing','ready','waiting'].includes(s.state);
  } catch { connectionError(); }
}
async function act(operation) {
  if (acting) return;
  acting = true;
  document.getElementById('install').disabled = true;
  document.getElementById('check').disabled = true;
  try { await operation(); acting = false; await render(); }
  catch { connectionError(); }
  finally { acting = false; }
}
document.getElementById('check').onclick = () => act(() => window.desktopUpdates.check());
document.getElementById('install').onclick = () => act(() => window.desktopUpdates.install());
setInterval(render, 1000); void render();
