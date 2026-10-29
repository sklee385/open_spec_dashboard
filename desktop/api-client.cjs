function failure(code, message, status, blockers = []) { return Object.assign(new Error(message), { code, status, blockers }); }
function createDesktopApi({ child, token, fetchImpl = globalThis.fetch, timeout = 10000 }) {
  return async (path, method = 'GET', body) => {
    const owner = child();
    if (!owner?.sessionPort || owner.exitCode !== null || owner.signalCode != null) throw failure('connection', '대화 서버 연결을 확인할 수 없습니다. 상태 점검 또는 강제 종료를 선택할 수 있습니다.');
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${owner.sessionPort}/api/desktop/${path}`, {
        method, headers: { 'x-desktop-token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const timedOut = ['TimeoutError', 'AbortError'].includes(error?.name);
      throw failure(timedOut ? 'timeout' : 'connection', timedOut ? '대화 서버 응답 시간이 초과됐습니다. 실행 여부는 확인되지 않았습니다.' : '대화 서버에 연결하지 못했습니다. 실행 여부는 확인되지 않았습니다.');
    }
    let data;
    try { data = await response.json(); } catch { throw failure('invalid-response', '대화 서버의 응답을 읽지 못했습니다.', response.status); }
    if (response.ok) return data;
    if (response.status === 401 || response.status === 403) throw failure('authentication', '앱과 대화 서버의 인증을 확인하지 못했습니다.', response.status);
    if (response.status === 409) {
      const blockers = Array.isArray(data?.blockers) ? data.blockers.slice(0, 100).map(row => ({ workId: String(row.workId).slice(0, 100), reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 12).map(reason => String(reason).slice(0, 200)) : [] })) : [];
      throw failure('busy', '종료 또는 복구를 막는 항목이 있습니다. 전체 상태 점검에서 업무와 사유를 확인해 주세요.', 409, blockers);
    }
    if (response.status === 404) throw failure('unavailable', '이 버전의 대화 서버에서는 요청한 점검 기능을 사용할 수 없습니다.', 404);
    throw failure('service-error', '대화 서버에서 요청을 처리하지 못했습니다. 실행 중 여부와 별도로 점검이 필요합니다.', response.status);
  };
}
module.exports = { createDesktopApi };
