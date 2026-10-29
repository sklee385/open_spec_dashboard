import { useEffect, useState } from 'react';
import { draftStorage } from '../lib/draftStorage';

export type SessionRecoveryStatus = { requestId: string; status: string; previousThreadId?: string; newThreadId?: string | null; reason?: string; createdAt?: string; contextRecordId?: string };
const reasons: Record<string, string> = { 'thread-in-use': '다른 Codex에서 사용 중인 대화의 복구 기록입니다.', 'previous-execution-unconfirmed': '이전 실행의 종료를 확인하지 못했습니다. 상태 재확인 또는 같은 대화 재연결이 필요합니다.', 'explicit-recovery': '사용자가 요청한 새 세션 복구입니다.' };
const statuses: Record<string, string> = { prepared: '자료 준비', creating: '세션 생성 중', completed: '새 세션 준비 완료', uncertain: '생성 결과 확인 필요', blocked: '실행 확인 대기', failed: '세션 생성 거절', abandoned: '미확인 복구 취소 완료' };
type Props = { workId: string; threadId: string | null; recovery?: SessionRecoveryStatus; conflicted?: boolean; busy?: boolean; onPreserve: () => boolean; onRefresh: () => Promise<unknown> };

export function SessionRecovery({ workId, threadId, recovery, conflicted, busy, onPreserve, onRefresh }: Props) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const [observed, setObserved] = useState<SessionRecoveryStatus>();
  const [retry, setRetry] = useState(false);
  const effective = recovery?.status === 'completed' && recovery.newThreadId === threadId && conflicted ? undefined : recovery;
  useEffect(() => { setObserved(undefined); }, [effective?.requestId, effective?.status, effective?.reason]);
  const current = observed || effective;
  const recover = async () => {
    if (working || busy) return;
    if (!onPreserve()) { setError('초안을 저장하지 못했습니다. 내용을 보존한 뒤 다시 시도해 주세요.'); return; }
    setWorking(true); setError('');
    try {
      const key = `work-session-recovery:${workId}:${current?.previousThreadId || threadId}`;
      let requestId = draftStorage.getItem(key);
      const fresh = ['failed', 'abandoned'].includes(current?.status || '');
      if (fresh && requestId === current?.requestId) requestId = null;
      if (!requestId) { requestId = fresh ? crypto.randomUUID() : current?.requestId || crypto.randomUUID(); draftStorage.setItem(key, requestId); }
      const response = await fetch(`/api/work/${encodeURIComponent(workId)}/recover-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(100000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : '복구 상태를 확인하지 못했습니다.');
      if (result.sessionRecovery) setObserved(result.sessionRecovery);
      setRetry(true);
      await onRefresh();
    } catch (failure) {
      setRetry(true);
      setError(`${failure instanceof Error ? failure.message : '연결 오류'} · 같은 복구 요청으로 다시 확인할 수 있습니다. 지시는 자동 재전송하지 않습니다.`);
      await onRefresh().catch(() => {});
    } finally { setWorking(false); }
  };
  const cancel = async () => {
    if (!current || working || busy) return;
    setWorking(true); setError('');
    try {
      const response = await fetch(`/api/work/${encodeURIComponent(workId)}/recover-session/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: current.requestId }), signal: AbortSignal.timeout(100000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : '기존 실행 상태를 확인하지 못했습니다.');
      if (result.sessionRecovery) setObserved(result.sessionRecovery);
      await onRefresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '복구 취소 상태를 확인하지 못했습니다.'); await onRefresh().catch(() => {}); }
    finally { setWorking(false); }
  };
  const completed = current?.status === 'completed';
  return <section className="work-notice work-session-recovery" aria-label="새 세션 복구">
    <strong>잠금이 계속되면 새 세션으로 이어하기</strong>
    <p>기존 대화와 현재 파일을 참고해 별도 대화를 준비합니다. 이전 실행의 종료를 확인하기 전에는 파일을 변경하지 않습니다.</p>
    {current?.reason && <p role="status">{reasons[current.reason] || current.reason}</p>}
    {completed && <p role="status">새 세션을 준비했습니다. 다음 지시를 보내면 이어갑니다. 기존 작업은 자동으로 실행하지 않았습니다.</p>}
    {current && <details><summary>복구 세션 정보</summary><p>상태: {statuses[current.status] || current.status}</p><p>이전 대화: {current.previousThreadId || threadId}</p>{current.newThreadId && <p>새 대화: {current.newThreadId}</p>}<p>복구 요청: {current.requestId}</p></details>}
    {error && <p role="alert">{error}</p>}
    {!completed && <button disabled={busy || working || !threadId || ['creating', 'uncertain'].includes(current?.status || '')} onClick={() => void recover()}>
      {working ? '복구 상태 확인 중…' : ['failed', 'abandoned'].includes(current?.status || '') ? '새 복구 요청으로 재시도' : retry || current ? '복구 요청 다시 확인' : '복구용 새 세션으로 이어하기'}
    </button>}
    {['creating', 'uncertain'].includes(current?.status || '') && <><p>세션 생성 결과를 확인해야 합니다. 중복 세션을 만들지 않도록 새 복구 요청을 보류합니다. 미확인 복구를 취소하면 기존 실행의 종료를 확인한 뒤 다시 시도할 수 있습니다.</p><button disabled={working || busy} onClick={() => void cancel()}>미확인 복구 취소·상태 재확인</button></>}
  </section>;
}
