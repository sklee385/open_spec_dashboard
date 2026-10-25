import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Change } from '../types';
import './WorkRoom.css';

type Entry = { seq: number; type: string; data: Record<string, unknown> };
type Question = { id: string; kind: string; status: string; reflection?: string; recovered?: boolean; answer?: unknown; documents?: { path: string; version: string }[]; params: { questions?: { id: string; question: string; options?: { label: string; description: string }[] }[] }; method: string };
type Verification = { id: string; commandId: string; status: string; fresh: boolean; stdout: string; stderr: string; code: number | null };
type Command = { id: string; command: string; args: string[] };
type Room = { id: string; changeName: string; phase: string; state: string; threadId: string | null; turnId?: string; error?: string; updatedAt: string; reviewedVersion: string | null; reviewRequired?: boolean;
  documents: string[]; events: Entry[]; questions: Question[]; verifications: Verification[]; verificationCommands: Command[];
  queuedMessages?: { id: string; text: string; status: string; error?: string }[];
  changes: { path: string; before: string | null; after: string | null; status: string }[] };
type Doc = { path: string; content: string; version: string };
class RequestError extends Error { readonly latest?: Doc; constructor(message: string, latest?: Doc) { super(message); this.latest = latest; } }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new RequestError('서버 응답을 받지 못했습니다. 연결이 복구되면 다시 시도해 주세요.'); }
  if (!response.ok) throw new RequestError(typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다', data.latest);
  return data as T;
}
const phases: Record<string, string> = { planning: '아이디어·문서 작성', reviewed: '문서 검토 완료', implementation: '구현', verification: '검증·완료 검토', completed: '완료', archived: '보관' };
const states: Record<string, string> = { idle: '대화 가능', running: '실행 중', connecting: '연결 중', 'creating-thread': '세션 생성 중', 'waiting-input': '답변 대기', 'waiting-approval': '승인 대기', 'recovery-required': '복구 필요', failed: '실행 실패', interrupted: '중단됨' };
const operations: Record<string, string> = { status: '산출물·의존성', instructions: '다음 작성 지침', schemas: '워크플로', specs: '기준 명세 목록', spec: '기준 명세 내용', deltas: '변경 명세', diff: '요구사항 차이', validate: '문서 검증', doctor: '관계 진단', context: '프로젝트 관계' };
function conversation(events: Entry[]) {
  const messages = new Map<string, { seq: number; role: string; text: string }>();
  for (const entry of events) {
    if (entry.type === 'user-message') messages.set(`user:${entry.seq}`, { seq: entry.seq, role: '나', text: String(entry.data.text) });
    else if (entry.type === 'item/agentMessage/delta') {
      const key = `${entry.data.turnId}:${entry.data.itemId}`, old = messages.get(key);
      messages.set(key, { seq: old?.seq || entry.seq, role: 'Codex', text: (old?.text || '') + String(entry.data.delta) });
    } else if (entry.type === 'item/completed' && (entry.data.item as Record<string, unknown>)?.type === 'agentMessage') {
      const item = entry.data.item as Record<string, unknown>, key = `${entry.data.turnId}:${item.id}`, old = messages.get(key);
      messages.set(key, { seq: old?.seq || entry.seq, role: 'Codex', text: String(item.text) });
    }
  }
  return [...messages.values()].slice(-100);
}

export function WorkRoom({ change, onClose }: { change: Change; onClose: () => void }) {
  const [room, setRoom] = useState<Room | null>(null), [doc, setDoc] = useState<Doc | null>(null), [draft, setDraft] = useState('');
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [connection, setConnection] = useState('연결 중');
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('documents'), [preview, setPreview] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [pane, setPane] = useState('chat');
  const [answers, setAnswers] = useState<Record<string, string>>({}), [cli, setCli] = useState<{ ok: boolean; stdout: string; stderr: string; json?: unknown } | null>(null);
  const [operation, setOperation] = useState('status'), [artifact, setArtifact] = useState('proposal');
  const cliStatus = operation === 'status' ? cli?.json as { artifacts?: { id: string; status: string; requires?: string[] }[]; nextSteps?: string[] } | undefined : undefined;
  const [commandId, setCommandId] = useState(''), [command, setCommand] = useState(''), [args, setArgs] = useState('');
  const answerText = (q: Question, id: string) => answers[`${q.id}:${id}`] ?? (q.answer as Record<string, { answers?: string[] }> | undefined)?.[id]?.answers?.join('\n') ?? '';
  const dirty = !!doc && draft !== doc.content;
  const live = useRef({ doc, dirty }); live.current = { doc, dirty };
  const refresh = useCallback(async (id: string) => { const result = await api<Room>(`work/${id}`); setRoom(result); setLoadError(''); return result; }, []);
  const openDoc = useCallback(async (id: string, path: string) => {
    setConflict(null);
    const result = await api<Doc>(`work/${id}/document?path=${encodeURIComponent(path)}`);
    const saved = localStorage.getItem(`work-draft:${id}:${path}`);
    if (saved) {
      try { const value = JSON.parse(saved); setDoc({ ...result, version: value.version }); setDraft(value.content); return; } catch { /* restore server copy if draft is invalid */ }
    }
    setDoc(result); setDraft(result.content);
  }, []);
  useEffect(() => {
    if (!room?.id || typeof EventSource === 'undefined') return;
    let cursor = room.events.at(-1)?.seq || 0;
    let timer: ReturnType<typeof setTimeout> | undefined, refreshing = false, again = false, closed = false;
    const schedule = () => {
      if (closed) return;
      if (refreshing) { again = true; return; }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined; refreshing = true;
        void refresh(room.id).catch(e => setLoadError(e.message)).finally(() => { refreshing = false; if (again) { again = false; schedule(); } });
      }, 150);
    };
    const stream = new EventSource(`/api/work/${room.id}/events?after=${cursor}`);
    stream.onopen = () => setConnection('실시간 연결됨');
    stream.onerror = () => setConnection('재연결 중 · 저장된 업무 유지');
    stream.addEventListener('work-update', event => {
      const entry = JSON.parse((event as MessageEvent).data) as Entry;
      if (entry.seq <= cursor) return; cursor = entry.seq;
      schedule();
    });
    return () => { closed = true; clearTimeout(timer); stream.close(); };
  }, [room?.id, refresh]);
  useEffect(() => {
    let cancelled = false, currentId: string | null = null;
    const start = async () => {
      const result = await api<Room>('work', 'POST', { sourceId: change.sourceId, changeName: change.name, requestKey: `change:${change.id}` });
      if (cancelled) return; currentId = result.id;
      const detail = await refresh(result.id);
      if (!cancelled && detail.documents[0]) await openDoc(result.id, detail.documents[0]);
    };
    void start().catch(e => setLoadError(e.message));
    const timer = setInterval(() => {
      if (!currentId || cancelled) return;
      void refresh(currentId).then(async result => {
        if (!live.current.doc && result.documents[0]) { await openDoc(currentId!, result.documents[0]); return; }
        if (live.current.doc && !live.current.dirty) {
          const latest = await api<Doc>(`work/${currentId}/document?path=${encodeURIComponent(live.current.doc.path)}`);
          if (!live.current.dirty) { setDoc(latest); setDraft(latest.content); }
        }
      }).catch(() => setLoadError('서버 연결을 기다리는 중입니다. 저장된 업무와 초안은 유지됩니다.'));
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [change.id, change.name, change.sourceId, refresh, openDoc]);
  useEffect(() => {
    if (!room || !doc) return;
    const key = `work-draft:${room.id}:${doc.path}`;
    if (dirty) localStorage.setItem(key, JSON.stringify({ content: draft, version: doc.version })); else localStorage.removeItem(key);
  }, [room, doc, draft, dirty]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (live.current.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); if (room) await refresh(room.id); return true; } catch (e) { if (e instanceof RequestError && e.latest) setConflict(e.latest); setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const save = async (version = doc?.version) => {
    if (!room || !doc) return false;
    return run(async () => { const result = await api<Doc>(`work/${room.id}/document`, 'PUT', { path: doc.path, version, content: draft }); setConflict(null); setDoc(result); setDraft(result.content); localStorage.removeItem(`work-draft:${room.id}:${doc.path}`); });
  };
  const move = async (path: string) => { if (dirty) { setPending(path); return; } if (path === ':close') onClose(); else if (room) await run(() => openDoc(room.id, path)); };
  const action = (value: string) => {
    if (!room) return;
    if (dirty) { setError('문서 초안을 저장하거나 폐기한 뒤 진행해 주세요.'); return; }
    void run(() => api(`work/${room.id}/action`, 'POST', { action: value, confirmed: value === 'complete' }));
  };
  const send = () => {
    if (busy || !room || !message.trim()) return;
    if (dirty) { setError('편집 중인 문서를 먼저 저장해 주세요. 초안은 보존됩니다.'); return; }
    const text = doc ? `대상 문서: ${doc.path} (버전 ${doc.version})\n${message}` : message;
    void run(async () => { await api(`work/${room.id}/message`, 'POST', { text }); setMessage(''); });
  };
  const inspect = () => { if (room) void run(async () => setCli(await api(`work/${room.id}/openspec?operation=${operation}&artifact=${artifact}`))); };
  return <section className="work-room" aria-label="업무 공간">
    <header className="work-header">
      <button onClick={() => void move(':close')}>← 보드로 돌아가기</button>
      <div><h1>{change.title || change.name}</h1><span>{room ? `${phases[room.phase] || room.phase} · ${states[room.state] || room.state}` : '업무 불러오는 중'}</span></div>
      <details><summary>세션 정보 · {connection}</summary><small>{room?.threadId ? `Codex ${room.threadId}` : '첫 대화 시 같은 업무에 Codex 세션을 연결합니다.'}</small><p>권한 검토: Codex ‘나 대신 승인’ · 새 실행과 같은 대화 재개에 적용됩니다. Codex가 사용자에게 전달한 요청은 아래에서 직접 결정할 수 있습니다.</p></details>
    </header>
    {error && <div className="work-error" role="alert">{error}</div>}
    {loadError && <div className="work-error" role="status">{loadError}</div>}
    {room?.error && <div className="work-error">{/already has an active writer/.test(room.error) ? '다른 Codex 앱에서 이 업무 대화를 사용 중입니다. 해당 앱에서 이 대화를 닫은 뒤 다시 연결해 주세요. 문서와 대화 기록은 유지됩니다.' : room.error}</div>}
    {room?.state === 'recovery-required' && room.threadId && <button disabled={busy} onClick={() => void run(() => api(`work/${room.id}/reconnect`, 'POST', {}))}>같은 대화 다시 연결</button>}
    {room?.reviewRequired && <div className="work-notice">검토한 뒤 계획 문서가 변경되었습니다. 최신 문서를 다시 검토해 주세요. 문서 문답은 ‘AI와 계획 작성·수정’에서 이어갑니다.</div>}
    {pending && <div className="work-notice">저장하지 않은 문서가 있습니다.
      <button onClick={() => void save().then(ok => { if (ok) { const target = pending; setPending(null); if (target === ':close') onClose(); else if (room) void openDoc(room.id, target); } })}>저장 후 이동</button>
      <button onClick={() => { if (room && doc) localStorage.removeItem(`work-draft:${room.id}:${doc.path}`); const target = pending; setPending(null); if (target === ':close') onClose(); else if (room) void openDoc(room.id, target); }}>폐기 후 이동</button>
      <button onClick={() => setPending(null)}>취소</button></div>}
    <nav className="work-actions" aria-label="업무 동작">
      <button disabled={busy || !room} onClick={() => action('plan')}>AI와 계획 작성·수정</button>
      <button disabled={busy || !room} onClick={() => action('review')}>최신 문서 검토 완료</button>
      <button disabled={busy || !room?.reviewedVersion} onClick={() => action('implement')}>구현 시작</button>
      <button disabled={busy || !room?.turnId} onClick={() => room && void run(() => api(`work/${room.id}/interrupt`, 'POST', {}))}>현재 실행 중단</button>
      <button disabled={busy || room?.phase !== 'verification'} onClick={() => action('complete')}>결과 확인·완료</button>
      {room?.phase === 'completed' && <><button onClick={() => action('reopen')}>다시 문답·수정</button><button onClick={() => action('archive')}>OpenSpec 보관</button></>}
    </nav>
    <nav className="work-mobile-tabs" aria-label="작은 화면 영역"><button aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>대화·질문</button><button aria-pressed={pane === 'output'} onClick={() => setPane('output')}>문서·결과</button></nav>
    <div className={`work-layout pane-${pane}`}>
      <section className="work-chat"><h2>대화·확인 질문</h2><p className="work-hint">모든 단계에서 질문하고 수정할 수 있습니다.</p>
        <div className="work-messages" aria-live="polite">{!room?.events.length && <p>아이디어를 설명하거나 문서에서 바꾸고 싶은 점을 알려주세요.</p>}
          {conversation(room?.events || []).map(entry => <div key={entry.seq} className={entry.role === '나' ? 'work-message user' : 'work-message'}><small>{entry.role}</small><ReactMarkdown>{entry.text}</ReactMarkdown></div>)}
          <details className="work-event"><summary>실행 기록·명령 출력</summary>{room?.events.filter(entry => !['item/agentMessage/delta', 'user-message'].includes(entry.type)).slice(-100).map(entry => <details key={entry.seq}><summary>{({ 'item/autoApprovalReview/started': 'Codex 나 대신 승인 · 검토 시작', 'item/autoApprovalReview/completed': 'Codex 나 대신 승인 · 검토 결과', 'autoApprovalReview/strictReviewRequired': 'Codex 권한 검토 · 추가 검토 필요' } as Record<string, string>)[entry.type] || entry.type}</summary><pre>{JSON.stringify(entry.data, null, 2)}</pre></details>)}</details>
        </div>
        {room?.questions.filter(q => q.status === 'pending' || (q.status === 'expired' && q.kind === 'input')).map(q => <div className="work-question" key={q.id}>
          <h3>{q.kind === 'input' ? 'AI 확인 질문' : '실행 권한 승인'}</h3>
          {q.status === 'expired' && <p>연결 종료로 전달 요청이 만료되었습니다. 답변하면 같은 대화로 복구하고 문서를 다시 검토합니다.</p>}
          {q.kind === 'input' ? <>{q.params.questions?.map(question => <label key={question.id}>{question.question}
            {question.options?.map(option => <button key={option.label} onClick={() => setAnswers(old => ({ ...old, [`${q.id}:${question.id}`]: option.label }))}>{option.label} — {option.description}</button>)}
            <textarea aria-label={question.question} value={answerText(q, question.id)} onChange={event => setAnswers(old => ({ ...old, [`${q.id}:${question.id}`]: event.target.value }))} />
          </label>)}<button disabled={busy} onClick={() => void run(() => api(`work/${room.id}/answer`, 'POST', { questionId: q.id, recover: q.status === 'expired', answers: Object.fromEntries((q.params.questions || []).map(question => [question.id, { answers: [answerText(q, question.id)] }])) }))}>{q.status === 'expired' ? '같은 대화로 답변 복구' : '답변 전달'}</button></> : <><pre>{JSON.stringify(q.params, null, 2)}</pre><button onClick={() => void run(() => api(`work/${room.id}/approval`, 'POST', { questionId: q.id, decision: 'accept' }))}>이 요청 승인</button><button onClick={() => void run(() => api(`work/${room.id}/approval`, 'POST', { questionId: q.id, decision: 'decline' }))}>거절</button></>}
        </div>)}
        {!!room?.questions.some(q => q.status === 'answered') && <details className="work-event"><summary>답변·문서 반영 이력</summary>{room.questions.filter(q => q.status === 'answered').map(q => <div key={q.id}><p>{q.params.questions?.map(x => x.question).join(' · ') || '실행 승인'}</p><pre>{JSON.stringify(q.answer, null, 2)}</pre><p>{q.reflection === 'applied' ? '문서 변경 감지 · 내용 검토 필요' : q.reflection === 'pending' ? '반영 결과 대기' : '문서 반영 확인 필요'}</p>{q.documents?.map(d => <p key={d.path}>{d.path} · {d.version.slice(0, 12)}</p>)}</div>)}</details>}
        <label className="work-compose">AI와 문답<textarea aria-label="AI와 문답" aria-keyshortcuts="Control+Enter" placeholder="질문이나 수정할 내용을 입력하세요 (Ctrl+Enter로 보내기)" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.repeat) {
            event.preventDefault();
            send();
          }
        }} /></label>
        {room?.queuedMessages?.filter(q => q.status !== 'sent').map(q => <div className="work-notice" key={q.id}>{q.status === 'queued' ? '추가 지시 대기' : q.status === 'dispatching' ? '추가 지시 전달 중' : '추가 지시 확인 필요'}: {q.text}<p>{q.error}{['blocked', 'uncertain'].includes(q.status) && ' · 문서 검토와 실제 실행 기록을 확인한 뒤 필요한 내용만 다시 보내주세요.'}</p></div>)}
        <button disabled={busy || !room || !message.trim()} onClick={send}>보내기</button>
      </section>
      <section className="work-output"><nav className="work-tabs">{[['documents', '문서'], ['results', '코드·실행·검증'], ['openspec', 'OpenSpec']].map(([value, label]) => <button aria-pressed={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>
        {tab === 'documents' && <><div className="work-document-bar"><select aria-label="문서 선택" value={doc?.path || ''} onChange={event => void move(event.target.value)}>{!room?.documents.length && <option>AI와 문서를 작성해 주세요</option>}{room?.documents.map(path => <option key={path}>{path}</option>)}</select><button disabled={!dirty || busy} onClick={() => void save()}>문서 저장</button><button onClick={() => setPreview(!preview)}>{preview ? '편집' : '미리보기'}</button><span>{dirty ? '미저장 초안' : '저장됨'}</span></div>
          {conflict && <div className="work-notice" role="region" aria-label="문서 충돌 해결"><p>다른 변경이 저장되었습니다. 아래 최신 문서와 편집 중인 초안을 비교해 주세요.</p><h3>최신 문서</h3><pre>{conflict.content}</pre><button disabled={busy} onClick={() => void save(conflict.version)}>최신 버전에 내 초안 재적용</button><button disabled={busy} onClick={() => { setDoc(conflict); setDraft(conflict.content); setConflict(null); setError(''); }}>최신 문서 사용·초안 폐기</button></div>}
          {doc && (preview ? <article className="work-preview"><ReactMarkdown>{draft}</ReactMarkdown></article> : <textarea className="work-editor" aria-label="문서 내용" disabled={busy || room?.phase === 'archived' || room?.phase === 'completed'} value={draft} onChange={event => setDraft(event.target.value)} />)}
          {!room?.documents.length && <p className="work-hint">왼쪽에서 AI와 아이디어를 구체화하고 계획 작성을 요청하세요.</p>}
        </>}
        {tab === 'results' && <div className="work-result-list"><h2>검증</h2>{!room?.verificationCommands.length && <p>프로젝트에 맞는 검증 명령을 등록해 주세요.</p>}{room?.verificationCommands.map(value => <button key={value.id} disabled={busy || room.state === 'running'} onClick={() => void run(() => api(`work/${room.id}/verify`, 'POST', { commandId: value.id }))}>{value.id} 실행</button>)}
          <details><summary>검증 명령 추가</summary><input aria-label="검증 이름" placeholder="검증 이름" value={commandId} onChange={event => setCommandId(event.target.value)} /><input aria-label="실행 파일" placeholder="실행 파일 (예: npm)" value={command} onChange={event => setCommand(event.target.value)} /><textarea aria-label="명령 인자" placeholder={'인자를 한 줄씩 입력\nrun\ntest'} value={args} onChange={event => setArgs(event.target.value)} /><button disabled={busy} onClick={() => room && void run(() => api(`work/${room.id}/verification-plan`, 'PUT', { commands: [...room.verificationCommands.filter(x => x.id !== commandId), { id: commandId, command, args: args.split('\n').filter(Boolean) }] }))}>검증 명령 저장</button></details>
          {room?.verifications.map(result => <details key={result.id}><summary>{result.commandId} · {result.status} · {result.fresh ? '현재 버전' : '과거 결과·재검증 필요'}</summary><pre>{result.stdout}{'\n'}{result.stderr}{'\n'}종료 코드: {String(result.code)}</pre></details>)}
          <h2>변경 파일</h2>{room?.changes.map(file => <details key={file.path}><summary>{file.status} · {file.path}</summary><h3>변경 전</h3><pre>{file.before ?? '(없음 또는 바이너리)'}</pre><h3>변경 후</h3><pre>{file.after ?? '(없음 또는 바이너리)'}</pre></details>)}
        </div>}
        {tab === 'openspec' && <div className="work-result-list"><p>OpenSpec 문서 검증은 코드 실행 검증과 별도입니다.</p><select aria-label="OpenSpec 기능" value={operation} onChange={event => { setOperation(event.target.value); setCli(null); }}>{Object.entries(operations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{['instructions', 'spec'].includes(operation) && <input aria-label={operation === 'spec' ? '기준 명세 이름' : '작성할 산출물'} value={artifact} onChange={event => setArtifact(event.target.value)} />}<button disabled={busy || !room} onClick={inspect}>조회·검증</button>{cli && <><strong>{cli.ok ? '조회 완료' : '오류·미지원 또는 검증 실패'}</strong>{cliStatus?.artifacts && <><h2>산출물·의존성</h2><table><thead><tr><th>문서</th><th>상태</th><th>선행 문서</th></tr></thead><tbody>{cliStatus.artifacts.map(value => <tr key={value.id}><td>{value.id}</td><td>{{done: '작성됨', ready: '작성 가능', blocked: '선행 문서 필요'}[value.status] || value.status}</td><td>{value.requires?.join(', ') || '없음'}</td></tr>)}</tbody></table><h2>다음 단계</h2>{cliStatus.nextSteps?.map(step => <p key={step}>{step}</p>)}</>}<details open={!cliStatus?.artifacts}><summary>OpenSpec 원본 결과</summary><pre>{cli.json ? JSON.stringify(cli.json, null, 2) : cli.stdout}{'\n'}{cli.stderr}</pre></details><button onClick={() => setMessage(`OpenSpec ${operations[operation]} 결과를 확인하고 같은 업무에서 필요한 수정을 해 주세요.\n${cli.stdout}\n${cli.stderr}`)}>이 결과로 AI 수정 요청 준비</button></>}</div>}
      </section>
    </div>
  </section>;
}
