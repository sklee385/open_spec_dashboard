(() => {
  const el = id => document.getElementById(id), bridge = window.desktopHealth;
  let snapshot;
  const labels = { normal: '정상', running: '실행 중', mismatch: '불일치', unknown: '확인 불가', ready: '응답 확인', loading: '불러오는 중', unresponsive: '응답 없음', crashed: '화면 종료', inactive: '실행 없음', active: '실행 확인' };
  const historyNames = { 'app-started': '앱 시작', 'app-stopped': '정상 종료', 'screen-error': '화면 장애', 'server-exited': '서버 연결 종료', 'inspection-failed': '점검 실패', 'inspection-completed': '전체 점검', 'force-exit-requested': '강제 종료 요청', 'safe-mode-changed': '안전 모드 변경', 'work-recover-requested': '업무 상태 복구 요청', 'work-interrupt-requested': '업무 중단 요청', 'work-recovered': '업무 상태 복구', 'safe-mode': '안전 모드 변경' };
  Object.assign(historyNames, { 'safe-mode-enabled': '안전 모드 켜기', 'safe-mode-disabled': '안전 모드 해제', 'codex-disconnected': 'Codex 연결 끊김', 'execution-failed': '실행 실패', 'interrupt-requested': '중단 요청', 'history-storage-failed': '진단 기록 저장 실패', 'force-exit-unconfirmed': '강제 종료 확인 불가', 'owner-unavailable': '종료 소유권 확인 불가', 'quit-blocked': '정상 종료 보류' });
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '—';
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = String(text); if (className) value.className = className; return value; };
  function error(value) { el('error').textContent = value || ''; el('error').hidden = !value; }
  async function action(operation) {
    try { error(''); const result = await operation(); if (!result?.cancelled) await inspect(); }
    catch (reason) { error(reason?.message || '요청을 완료하지 못했습니다. 다시 점검해 주세요.'); }
  }
  function button(text, operation) { const value = node('button', text); value.addEventListener('click', () => action(operation)); return value; }
  function rows() {
    const body = el('works'); body.replaceChildren();
    const works = snapshot?.server?.works;
    if (!works) { const row = node('tr'); const cell = node('td', '서버 상태를 확인하지 못해 업무의 실행 여부도 확인할 수 없습니다.', 'empty'); cell.colSpan = 4; row.append(cell); body.append(row); return; }
    const visible = el('problems-only').checked ? works.filter(work => work.status !== 'normal' || work.reasons.length) : works;
    if (!visible.length) { const row = node('tr'); const cell = node('td', works.length ? '확인이 필요한 업무가 없습니다.' : '등록된 업무가 없습니다.', 'empty'); cell.colSpan = 4; row.append(cell); body.append(row); }
    for (const work of visible) {
      const row = node('tr'), name = node('td', work.name), state = node('td', labels[work.status] || '확인 불가', `status-${work.status}`), details = node('td'), actions = node('td');
      details.append(node('small', date(work.updatedAt)), node('div', work.reasons.length ? work.reasons.join(' · ') : '종료를 막는 항목 없음'));
      actions.append(button('업무 열기', () => bridge.openWork(work.id)));
      if (work.canInterrupt) actions.append(button('중단 요청', () => bridge.interrupt(work.id)));
      if (work.canRecover) actions.append(button('상태 복구', () => bridge.recover(work.id)));
      row.append(name, state, details, actions); body.append(row);
    }
  }
  function render(value) {
    snapshot = value; const server = value.server;
    el('version').textContent = value.desktop?.version ? `v${value.desktop.version}` : '';
    el('checked-at').textContent = `점검 ${date(value.checkedAt)}`;
    el('summary').textContent = !server ? '서버 연결을 확인하지 못했습니다. 실제 실행 여부도 확인이 필요합니다.' : server.idle ? '현재 종료를 막는 업무나 요청이 없습니다.' : '종료를 막는 항목이 있습니다. 아래 업무와 요청을 확인해 주세요.';
    const overview = el('overview'); overview.replaceChildren();
    for (const [label, text] of [['화면', labels[value.desktop?.screen] || '확인 불가'], ['대화 서버', server ? '응답 확인' : '연결 확인 불가'], ['처리 중 요청', server ? `${server.requests}개` : '—'], ['종료 준비', server ? server.locked ? '잠금 상태' : '잠금 없음' : '—']]) { const group = node('div'); group.append(node('dt', label), node('dd', text)); overview.append(group); }
    el('safe-notice').hidden = !(server?.safeMode ?? value.desktop?.safeMode); el('safe-mode').hidden = !server; el('safe-mode').textContent = server?.safeMode ? '안전 모드 해제…' : '안전 모드 켜기';
    rows();
    const requests = el('requests'); requests.replaceChildren();
    for (const request of server?.requestDetails || []) requests.append(node('li', `${request.kind || request.method || '변경 요청'} · ${request.workId || '앱 요청'} · ${date(request.startedAt || request.at)}`));
    if (!requests.childElementCount) requests.append(node('li', server ? '처리 중인 변경 요청이 없습니다.' : '요청 상태를 확인할 수 없습니다.', 'empty'));
    const history = el('history'); history.replaceChildren();
    const events = [...(value.events || []), ...(server?.history || [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12);
    for (const event of events) { const row = node('li'); const code = event.errorCode || event.code; row.append(node('time', date(event.at)), node('span', `${historyNames[event.type] || '상태 변경'}${event.workId ? ` · ${event.workId}` : ''}${code ? ` · ${code}` : ''}`)); history.append(row); }
    if (!events.length) history.append(node('li', '보관된 장애·복구 기록이 없습니다.', 'empty'));
    error(value.error?.message || (value.desktop?.storageWarning ? '일부 진단 기록을 저장하지 못했습니다. 저장 공간과 프로필 폴더 접근 권한을 확인해 주세요.' : ''));
  }
  async function inspect() {
    if (!bridge) { error('앱 메뉴의 전체 상태 점검에서 열어 주세요.'); return; }
    el('inspect').disabled = true;
    try { render(await bridge.inspect()); } catch (reason) { error(reason?.message || '점검 결과를 읽지 못했습니다.'); }
    finally { el('inspect').disabled = false; }
  }
  el('inspect').addEventListener('click', inspect); el('problems-only').addEventListener('change', rows);
  el('safe-mode').addEventListener('click', () => action(() => bridge.safeMode(!snapshot.server.safeMode)));
  el('force').addEventListener('click', async () => { try { await bridge.forceQuit(); } catch (reason) { error(reason?.message || '강제 종료를 요청하지 못했습니다.'); } });
  void inspect();
})();
