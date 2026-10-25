import { ProductError, errorMessage } from '@/i18n/errors';
import { useI18n } from '@/i18n/context';
import { useCallback, useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import { AttentionBell } from './AttentionCenter';
import type { AttentionTarget, WorkRoomNavigation } from '../lib/attentionNavigation';
import ReactMarkdown from 'react-markdown';
import { ReviewItems } from './ReviewItems';
import { DetailModal } from './DetailModal';
import { matchReviewItem, useReviewItems, type ReviewItem } from '../hooks/useReviewItems';
import type { Change } from '../types';
import './WorkRoom.css';

type Entry = { seq: number; type: string; data: Record<string, unknown> };
type Question = { id: string; kind: string; status: string; reflection?: string; recovered?: boolean; answer?: unknown; documents?: { path: string; version: string }[]; params: { questions?: { id: string; question: string; options?: { label: string; description: string }[] }[] }; method: string };
type Verification = { id: string; commandId: string; status: string; fresh: boolean; stdout: string; stderr: string; code: number | null };
type Command = { id: string; command: string; args: string[] };
type Room = { id: string; changeName: string; phase: string; state: string; threadId: string | null; turnId?: string; error?: string; updatedAt: string; reviewedVersion: string | null; reviewRequired?: boolean;
  toolId?: string; toolConfigSnapshot?: { name: string; kind: string }; toolCapabilities?: { conversation: boolean; questions: boolean; approval: boolean; interrupt: boolean; nativeResume: boolean }; toolReadiness?: { ready: boolean; message: string };
  documents: string[]; events: Entry[]; questions: Question[]; verifications: Verification[]; verificationCommands: Command[];
  queuedMessages?: { id: string; text: string; status: string; error?: string }[];
  changes: { path: string; before: string | null; after: string | null; status: string }[] };
type Doc = { path: string; content: string; version: string };
function readChatDraft(changeId: string): { message: string; answers: Record<string, string> } {
  try {
    const value = JSON.parse(localStorage.getItem(`work-chat-draft:${changeId}`) || 'null');
    return { message: typeof value?.message === 'string' ? value.message : '', answers: Object.fromEntries(Object.entries(value?.answers || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
  } catch { return { message: '', answers: {} }; }
}
function readWorkView(changeId: string) {
  try {
    const value = JSON.parse(localStorage.getItem(`work-view:${changeId}`) || 'null');
    return {
      pane: value?.pane === 'output' ? 'output' : 'chat',
      tab: ['documents', 'review', 'results', 'openspec'].includes(value?.tab) ? value.tab as string : 'documents',
      path: typeof value?.path === 'string' ? value.path as string : null,
    };
  } catch { return { pane: 'chat', tab: 'documents', path: null }; }
}
class RequestError extends Error { readonly latest?: Doc; constructor(message: string, latest?: Doc) { super(message); this.latest = latest; } }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new ProductError('workRoom.noResponse'); }
  if (!response.ok) {
    const message = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : undefined;
    if (message === undefined) throw new ProductError('workRoom.requestError');
    throw new RequestError(message, data.latest);
  }
  return data as T;
}


const operationRequestLabels: Record<string, string> = { status: '산출물·의존성', instructions: '다음 작성 지침', schemas: '워크플로', specs: '기준 명세 목록', spec: '기준 명세 내용', deltas: '변경 명세', diff: '요구사항 차이', validate: '문서 검증', doctor: '관계 진단', context: '프로젝트 관계' };
function conversation(events: Entry[], toolName: string) {
  const messages = new Map<string, { seq: number; role: string; text: string }>();
  for (const entry of events) {
    if (entry.type === 'user-message') messages.set(`user:${entry.seq}`, { seq: entry.seq, role: 'user', text: String(entry.data.text) });
    else if (entry.type === 'item/agentMessage/delta') {
      const key = `${entry.data.turnId}:${entry.data.itemId}`, old = messages.get(key);
      messages.set(key, { seq: old?.seq || entry.seq, role: toolName, text: (old?.text || '') + String(entry.data.delta) });
    } else if (entry.type === 'item/completed' && (entry.data.item as Record<string, unknown>)?.type === 'agentMessage') {
      const item = entry.data.item as Record<string, unknown>, key = `${entry.data.turnId}:${item.id}`, old = messages.get(key);
      messages.set(key, { seq: old?.seq || entry.seq, role: toolName, text: String(item.text) });
    }
  }
  return [...messages.values()].slice(-100);
}

export function WorkRoom({ change, onClose, attentionTarget, navigationRef }: { change: Change; onClose: () => void; attentionTarget?: AttentionTarget; navigationRef?: Ref<WorkRoomNavigation> }) {
  const { t } = useI18n();
  const resultStates: Record<string, string> = { passed: t('workRoom.passed'), failed: t('workRoom.failed'), running: t('workRoom.running'), interrupted: t('workRoom.interrupted'), queued: t('workRoom.queuedStatus') };
  const fileStates: Record<string, string> = { added: t('workRoom.added'), modified: t('workRoom.modified'), removed: t('workRoom.removed') };
  const phases: Record<string, string> = { planning: t('workRoom.planning'), reviewed: t('workRoom.reviewed'), implementation: t('workRoom.implementation'), verification: t('workRoom.verificationPhase'), completed: t('workRoom.completed'), archived: t('workRoom.archived') };
  const states: Record<string, string> = { idle: t('workRoom.idle'), running: t('workRoom.running'), connecting: t('workRoom.connecting'), 'creating-thread': t('workRoom.creating'), 'waiting-input': t('workRoom.waitingInput'), 'waiting-approval': t('workRoom.waitingApproval'), 'recovery-required': t('workRoom.recovery'), failed: t('workRoom.failed'), interrupted: t('workRoom.interrupted') };
  const operations: Record<string, string> = { status: t('workRoom.dependencies'), instructions: t('workRoom.instructions'), schemas: t('workRoom.schemas'), specs: t('workRoom.specs'), spec: t('workRoom.spec'), deltas: t('workRoom.deltas'), diff: t('workRoom.diff'), validate: t('workRoom.validate'), doctor: t('workRoom.doctor'), context: t('workRoom.context') };
  const [room, setRoom] = useState<Room | null>(null), [doc, setDoc] = useState<Doc | null>(null), [draft, setDraft] = useState('');
  const toolName = room?.toolConfigSnapshot?.name || 'Codex';
  const nativeResume = room?.toolCapabilities?.nativeResume ?? true;
  const [initialWorkId] = useState(attentionTarget?.workId);
  const questionNodes = useRef(new Map<string, HTMLDivElement>());
  const attentionNotice = useRef<HTMLParagraphElement>(null);
  const focusedTarget = useRef<number | null>(null);
  const [readyTarget, setReadyTarget] = useState<number | null>(null);
  const [initialChat] = useState(() => readChatDraft(change.id));
  const [message, setMessage] = useState(initialChat.message), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [connection, setConnection] = useState(t('workRoom.connecting'));
  const [loadError, setLoadError] = useState('');
  const [initialView] = useState(() => readWorkView(change.id));
  const [tab, setTab] = useState(initialView.tab), [preview, setPreview] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [pane, setPane] = useState(initialView.pane);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const review = useReviewItems(room ? `/api/work/${room.id}/review-items` : null, reviewRevision);
  const reviewDestination = useRef<ReviewItem | null>(null);
  const [sourceSelection, setSourceSelection] = useState<ReviewItem | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (busy || !sourceSelection || !doc || sourceSelection.path !== doc.path || sourceSelection.version !== doc.version || draft !== doc.content || tab !== 'documents' || preview || !editor.current) return;
    const lines = draft.split('\n');
    const start = lines.slice(0, sourceSelection.startLine - 1).reduce((sum, line) => sum + line.length + 1, 0);
    const end = start + lines.slice(sourceSelection.startLine - 1, sourceSelection.endLine).join('\n').length;
    editor.current.focus(); editor.current.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(editor.current).lineHeight) || 24;
    editor.current.scrollTop = Math.max(0, (sourceSelection.startLine - 3) * lineHeight);
    setSourceSelection(null);
  }, [sourceSelection, doc, draft, tab, preview, busy]);
  const messageList = useRef<HTMLDivElement>(null);
  const messages = conversation(room?.events || [], toolName);
  const conversationVersion = JSON.stringify(messages);
  useEffect(() => {
    if (!attentionTarget && messageList.current && pane === 'chat') messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [conversationVersion, pane, attentionTarget]);
  useEffect(() => {
    if (!attentionTarget || readyTarget !== attentionTarget.token || room?.id !== attentionTarget.workId || focusedTarget.current === attentionTarget.token) return;
    if (pane !== 'chat') { setPane('chat'); return; }
    const node = questionNodes.current.get(attentionTarget.questionId) || attentionNotice.current;
    if (!node) return;
    node.scrollIntoView?.({ block: 'center' }); node.focus({ preventScroll: true });
    focusedTarget.current = attentionTarget.token;
  }, [attentionTarget, readyTarget, room, pane]);
  const [answers, setAnswers] = useState<Record<string, string>>(initialChat.answers), [cli, setCli] = useState<{ ok: boolean; stdout: string; stderr: string; json?: unknown } | null>(null);
  useEffect(() => {
    try { localStorage.setItem(`work-chat-draft:${change.id}`, JSON.stringify({ message, answers })); } catch { /* Keep the current input usable if browser storage is unavailable. */ }
  }, [change.id, message, answers]);
  const [operation, setOperation] = useState('status'), [artifact, setArtifact] = useState('proposal');
  const cliStatus = operation === 'status' ? cli?.json as { artifacts?: { id: string; status: string; requires?: string[] }[]; nextSteps?: string[] } | undefined : undefined;
  const [commandId, setCommandId] = useState(''), [command, setCommand] = useState(''), [args, setArgs] = useState('');
  const answerText = (q: Question, id: string) => answers[`${q.id}:${id}`] ?? (q.answer as Record<string, { answers?: string[] }> | undefined)?.[id]?.answers?.join('\n') ?? '';
  const dirty = !!doc && draft !== doc.content;
  const live = useRef({ doc, dirty }); live.current = { doc, dirty };
  const documentRequest = useRef(0);
  const activeOperations = useRef(0);
  const refresh = useCallback(async (id: string) => { const result = await api<Room>(`work/${id}`); setRoom(result); setLoadError(''); return result; }, []);
  useEffect(() => {
    if (!attentionTarget || room?.id !== attentionTarget.workId) return;
    let cancelled = false;
    void api<Room>(`work/${encodeURIComponent(attentionTarget.workId)}`).then(result => {
      if (cancelled) return;
      setRoom(result); setReadyTarget(attentionTarget.token);
    }).catch(error => { if (!cancelled) setLoadError(errorMessage(error, t)); });
    return () => { cancelled = true; };
  }, [attentionTarget, room?.id, t]);
  const openDoc = useCallback(async (id: string, path: string, expectedVersion?: string) => {
    const request = ++documentRequest.current;
    setConflict(null);
    const result = await api<Doc>(`work/${id}/document?path=${encodeURIComponent(path)}`);
    if (request !== documentRequest.current) return false;
    if (expectedVersion && result.version !== expectedVersion) throw new ProductError('review.changed');
    const saved = localStorage.getItem(`work-draft:${id}:${path}`);
    if (saved) {
      try { const value = JSON.parse(saved); setDoc({ ...result, version: value.version }); setDraft(value.content); return true; } catch { /* restore server copy if draft is invalid */ }
    }
    setDoc(result); setDraft(result.content);
    return true;
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
        void refresh(room.id).catch(e => setLoadError(errorMessage(e, t))).finally(() => { refreshing = false; if (again) { again = false; schedule(); } });
      }, 150);
    };
    const stream = new EventSource(`/api/work/${room.id}/events?after=${cursor}`);
    stream.onopen = () => { setConnection(t('workRoom.connected')); schedule(); };
    stream.onerror = () => setConnection(t('workRoom.reconnecting'));
    stream.addEventListener('work-update', event => {
      const entry = JSON.parse((event as MessageEvent).data) as Entry;
      if (entry.seq <= cursor) return; cursor = entry.seq;
      schedule();
    });
    return () => { closed = true; clearTimeout(timer); stream.close(); };
  }, [room?.id, refresh, t]);
  useEffect(() => {
    let cancelled = false, currentId: string | null = null;
    const start = async () => {
      const result = initialWorkId
        ? await api<Room>(`work/${encodeURIComponent(initialWorkId)}`)
        : await api<Room>('work', 'POST', { sourceId: change.sourceId, changeName: change.name, requestKey: `change:${change.id}` });
      if (cancelled) return; currentId = result.id;
      const detail = await refresh(result.id);
      const path = initialView.path && detail.documents.includes(initialView.path) ? initialView.path : detail.documents[0];
      if (!cancelled && path) await openDoc(result.id, path);
    };
    void start().catch(e => setLoadError(errorMessage(e, t)));
    const timer = setInterval(() => {
      if (!currentId || cancelled) return;
      void refresh(currentId).then(async result => {
        if (!live.current.doc && result.documents[0]) { await openDoc(currentId!, result.documents[0]); return; }
        if (live.current.doc && !live.current.dirty) {
          const path = live.current.doc.path, request = documentRequest.current;
          const latest = await api<Doc>(`work/${currentId}/document?path=${encodeURIComponent(path)}`);
          if (!cancelled && request === documentRequest.current && live.current.doc?.path === path && !live.current.dirty) { setDoc(latest); setDraft(latest.content); }
        }
      }).catch(() => setLoadError(t('workRoom.waitingServer')));
    }, 2000);
    return () => { cancelled = true; ++documentRequest.current; clearInterval(timer); };
  }, [change.id, change.name, change.sourceId, initialWorkId, refresh, openDoc, initialView.path, t]);
  useEffect(() => {
    if (!doc) return;
    try { localStorage.setItem(`work-view:${change.id}`, JSON.stringify({ pane, tab, path: doc.path })); } catch { /* Keep the view and preserve drafts before notification navigation. */ }
  }, [change.id, doc, pane, tab]);
  useEffect(() => {
    if (!room || !doc) return;
    const key = `work-draft:${room.id}:${doc.path}`;
    try { if (dirty) localStorage.setItem(key, JSON.stringify({ content: draft, version: doc.version })); else localStorage.removeItem(key); } catch { /* Explicit navigation checks draft storage. */ }
  }, [room, doc, draft, dirty]);
  useImperativeHandle(navigationRef, () => ({ preserveDrafts() {
    if (activeOperations.current > 0) return false;
    try {
      localStorage.setItem(`work-chat-draft:${change.id}`, JSON.stringify({ message, answers }));
      localStorage.setItem(`work-view:${change.id}`, JSON.stringify({ pane, tab, path: doc?.path || null }));
      if (room && doc && dirty) localStorage.setItem(`work-draft:${room.id}:${doc.path}`, JSON.stringify({ content: draft, version: doc.version }));
      return true;
    } catch { setError(t('attention.navigationError')); return false; }
  } }), [change.id, message, answers, room, doc, dirty, draft, pane, tab, t]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (live.current.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    ++activeOperations.current;
    setBusy(true); setError('');
    try { await action(); if (room) await refresh(room.id); return true; } catch (e) { if (e instanceof RequestError && e.latest) setConflict(e.latest); setError(errorMessage(e, t)); return false; } finally { setBusy(--activeOperations.current > 0); }
  };
  const save = async (version = doc?.version) => {
    if (!room || !doc) return false;
    return run(async () => { const result = await api<Doc>(`work/${room.id}/document`, 'PUT', { path: doc.path, version, content: draft }); setConflict(null); setDoc(result); setDraft(result.content); setReviewRevision(value => value + 1); localStorage.removeItem(`work-draft:${room.id}:${doc.path}`); });
  };
  const navigate = async (path: string) => {
    if (path === ':close') { onClose(); return; }
    if (!room) return;
    const selected = reviewDestination.current;
    reviewDestination.current = null;
    if (selected?.path === path) {
      await run(async () => {
        const latest = await review.refresh();
        const target = latest && matchReviewItem(selected, latest);
        if (!target) throw new Error(t('review.changed'));
        try { if (!await openDoc(room.id, path, target.version)) return; }
        catch (error) { await review.refresh(); throw error; }
        setSourceSelection(target); setPreview(false); setTab('documents'); setPane('output');
      });
    } else await run(() => openDoc(room.id, path));
  };
  const move = async (path: string) => { if (activeOperations.current > 0) return; if (dirty) { setPending(path); return; } await navigate(path); };
  const action = (value: string) => {
    if (!room) return;
    if (dirty) { setError(t('workRoom.saveOrDiscard')); return; }
    void run(() => api(`work/${room.id}/action`, 'POST', { action: value, confirmed: value === 'complete' }));
  };
  const send = () => {
    if (busy || !room || !message.trim()) return;
    if (dirty) { setError(t('workRoom.saveFirst')); return; }
    const text = doc ? `대상 문서: ${doc.path} (버전 ${doc.version})\n${message}` : message;
    void run(async () => { await api(`work/${room.id}/message`, 'POST', { text }); setMessage(''); });
  };
  const inspect = () => { if (room) void run(async () => setCli(await api(`work/${room.id}/openspec?operation=${operation}&artifact=${artifact}`))); };
  return <section className="work-room" aria-label={t('workRoom.space')}>
    <header className="work-header">
      <AttentionBell />
      <button onClick={() => setDetailOpen(true)}>{t('review.documents')}</button>
      <button onClick={() => void move(':close')}>{t('workRoom.back')}</button>
      <div><h1>{change.title || change.name}</h1><span>{room ? `${phases[room.phase] || room.phase} · ${states[room.state] || room.state}` : t('workRoom.loading')}</span></div>
      <details><summary><span>{toolName}</span> · <span>{t('workRoom.sessionInfo')} {connection}</span></summary><small>{nativeResume ? room?.threadId ? `${toolName} ${room.threadId}` : t('workRoom.sessionHint') : t('aiTools.logicalSession')}</small><p>{nativeResume ? t('workRoom.approvalHint') : t('aiTools.limitations')}</p></details>
    </header>
    {error && <div className="work-error" role="alert">{error}</div>}
    {loadError && <div className="work-error" role="status">{loadError}</div>}
    {room?.error && <div className="work-error">{room.error}</div>}
    {room && <p className="work-hint">{nativeResume ? t('aiTools.supported') : t('aiTools.external')}</p>}
    {room?.toolReadiness && !room.toolReadiness.ready && <p className="work-error">{room.toolReadiness.message}</p>}
    {nativeResume && room?.state === 'recovery-required' && room.threadId && <button disabled={busy} onClick={() => void run(() => api(`work/${room.id}/reconnect`, 'POST', {}))}>{t('workRoom.reconnect')}</button>}
    {room?.reviewRequired && <div className="work-notice">{t('workRoom.reviewAgain')}</div>}
    {pending && <div className="work-notice">{t('workRoom.unsaved')}
      <button onClick={() => void save().then(ok => { if (ok) { const target = pending; setPending(null); void navigate(target); } })}>{t('workRoom.saveMove')}</button>
      <button onClick={() => { if (room && doc) localStorage.removeItem(`work-draft:${room.id}:${doc.path}`); const target = pending; setPending(null); void navigate(target); }}>{t('workRoom.discardMove')}</button>
      <button onClick={() => { setPending(null); reviewDestination.current = null; }}>{t('common.cancel')}</button></div>}
    <nav className="work-actions" aria-label={t('workRoom.actions')}>
      <button disabled={busy || !room} onClick={() => action('plan')}>{t('workRoom.plan')}</button>
      <button disabled={busy || !room} onClick={() => action('review')}>{t('workRoom.review')}</button>
      <button disabled={busy || !room?.reviewedVersion} onClick={() => action('implement')}>{t('workRoom.implement')}</button>
      <button disabled={busy || !room?.turnId || room?.toolCapabilities?.interrupt === false} onClick={() => room && void run(() => api(`work/${room.id}/interrupt`, 'POST', {}))}>{t('workRoom.interrupt')}</button>
      <button disabled={busy || room?.phase !== 'verification'} onClick={() => action('complete')}>{t('workRoom.complete')}</button>
      {room?.phase === 'completed' && <><button onClick={() => action('reopen')}>{t('workRoom.reopen')}</button><button onClick={() => action('archive')}>{t('workRoom.archive')}</button></>}
    </nav>
    <nav className="work-mobile-tabs" aria-label={t('workRoom.mobile')}><button aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>{t('workRoom.chatTab')}</button><button aria-pressed={pane === 'output'} onClick={() => setPane('output')}>{t('workRoom.outputTab')}</button></nav>
    <div className={`work-layout pane-${pane}`}>
      <section className="work-chat"><h2>{t('workRoom.questions')}</h2><p className="work-hint">{t('workRoom.questionsHint')}</p>
                {attentionTarget && readyTarget === attentionTarget.token && room?.id === attentionTarget.workId && room.questions.find(q => q.id === attentionTarget.questionId)?.status !== 'pending' && <p ref={attentionNotice} tabIndex={-1} className="work-notice" role="status">{t('attention.stale')}</p>}
<div className="work-messages" ref={messageList} aria-live="polite">{!room?.events.length && <p>{t('workRoom.emptyChat')}</p>}
          {conversation(room?.events || [], toolName).map(entry => <div key={entry.seq} className={entry.role === 'user' ? 'work-message user' : 'work-message'}><small>{entry.role === 'user' ? t('workRoom.me') : entry.role}</small><ReactMarkdown>{entry.text}</ReactMarkdown></div>)}
          <details className="work-event"><summary>{t('workRoom.events')}</summary>{room?.events.filter(entry => !['item/agentMessage/delta', 'user-message'].includes(entry.type)).slice(-100).map(entry => <details key={entry.seq}><summary>{({ 'item/autoApprovalReview/started': t('workRoom.autoReviewStarted'), 'item/autoApprovalReview/completed': t('workRoom.autoReviewCompleted'), 'autoApprovalReview/strictReviewRequired': t('workRoom.strictReview') } as Record<string, string>)[entry.type] || entry.type}</summary><pre>{JSON.stringify(entry.data, null, 2)}</pre></details>)}</details>
        </div>
        {room?.questions.filter(q => (q.kind === 'input' ? room.toolCapabilities?.questions !== false : room.toolCapabilities?.approval !== false) && (q.status === 'pending' || (q.status === 'expired' && q.kind === 'input'))).map(q => <div className="work-question" key={q.id} tabIndex={-1} ref={node => { if (node) questionNodes.current.set(q.id, node); else questionNodes.current.delete(q.id); }}>
          <h3>{q.kind === 'input' ? t('workRoom.aiQuestion') : t('workRoom.permission')}</h3>
          {q.status === 'expired' && <p>{t('workRoom.expired')}</p>}
          {q.kind === 'input' ? <>{q.params.questions?.map(question => <label key={question.id}>{question.question}
            {question.options?.map(option => <button key={option.label} aria-label={`${option.label} — ${option.description}`} onClick={() => setAnswers(old => ({ ...old, [`${q.id}:${question.id}`]: option.label }))}>{option.label} — {option.description}</button>)}
            <textarea aria-label={question.question} value={answerText(q, question.id)} onChange={event => setAnswers(old => ({ ...old, [`${q.id}:${question.id}`]: event.target.value }))} />
          </label>)}<button disabled={busy} onClick={() => void run(() => api(`work/${room.id}/answer`, 'POST', { questionId: q.id, recover: q.status === 'expired', answers: Object.fromEntries((q.params.questions || []).map(question => [question.id, { answers: [answerText(q, question.id)] }])) }))}>{q.status === 'expired' ? t('workRoom.restoreAnswer') : t('workRoom.answer')}</button></> : <><pre>{JSON.stringify(q.params, null, 2)}</pre><button onClick={() => void run(() => api(`work/${room.id}/approval`, 'POST', { questionId: q.id, decision: 'accept' }))}>{t('workRoom.approve')}</button><button onClick={() => void run(() => api(`work/${room.id}/approval`, 'POST', { questionId: q.id, decision: 'decline' }))}>{t('workRoom.decline')}</button></>}
        </div>)}
        {!!room?.questions.some(q => q.status === 'answered') && <details className="work-event"><summary>{t('workRoom.answerHistory')}</summary>{room.questions.filter(q => q.status === 'answered').map(q => <div key={q.id}><p>{q.params.questions?.map(x => x.question).join(' · ') || t('workRoom.executionApproval')}</p><pre>{JSON.stringify(q.answer, null, 2)}</pre><p>{q.reflection === 'applied' ? t('workRoom.reflected') : q.reflection === 'pending' ? t('workRoom.reflectionPending') : t('workRoom.reflectionCheck')}</p>{q.documents?.map(d => <p key={d.path}>{d.path} · {d.version.slice(0, 12)}</p>)}</div>)}</details>}
        <label className="work-compose">{t('workRoom.chat')}<textarea aria-label={t('workRoom.chat')} aria-keyshortcuts="Control+Enter" placeholder={t('workRoom.chatPlaceholder')} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !event.repeat) {
            event.preventDefault();
            send();
          }
        }} /></label>
        {room?.queuedMessages?.filter(q => q.status !== 'sent').map(q => <div className="work-notice" key={q.id}>{q.status === 'queued' ? t('workRoom.queued') : q.status === 'dispatching' ? t('workRoom.dispatching') : t('workRoom.queueCheck')}: {q.text}<p>{q.error}{['blocked', 'uncertain'].includes(q.status) && t('workRoom.queueHint')}</p></div>)}
        <button disabled={busy || !room || !message.trim()} onClick={send}>{t('workRoom.send')}</button>
      </section>
      <section className="work-output"><nav className="work-tabs">{[['documents', t('workRoom.documents')], ['review', t('review.title')], ['results', t('workRoom.results')], ['openspec', 'OpenSpec']].map(([value, label]) => <button aria-pressed={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>
        {tab === 'review' && <ReviewItems {...review} busy={busy} onSelect={item => { if (busy) return; reviewDestination.current = item; void move(item.path); }} />}
        {tab === 'documents' && <><div className="work-document-bar"><select disabled={busy} aria-label={t('workRoom.selectDoc')} value={doc?.path || ''} onChange={event => void move(event.target.value)}>{!room?.documents.length && <option>{t('workRoom.createDoc')}</option>}{room?.documents.map(path => <option key={path}>{path}</option>)}</select><button disabled={!dirty || busy} onClick={() => void save()}>{t('workRoom.saveDoc')}</button><button onClick={() => setPreview(!preview)}>{preview ? t('common.edit') : t('workRoom.preview')}</button><span>{dirty ? t('workRoom.unsavedDraft') : t('workRoom.saved')}</span></div>
          {conflict && <div className="work-notice" role="region" aria-label={t('workRoom.conflict')}><p>{t('workRoom.conflictHint')}</p><h3>{t('workRoom.latest')}</h3><pre>{conflict.content}</pre><button disabled={busy} onClick={() => void save(conflict.version)}>{t('workRoom.reapply')}</button><button disabled={busy} onClick={() => { setDoc(conflict); setDraft(conflict.content); setConflict(null); setError(''); }}>{t('workRoom.useLatest')}</button></div>}
          {doc && (preview ? <article className="work-preview"><ReactMarkdown>{draft}</ReactMarkdown></article> : <textarea ref={editor} className="work-editor" aria-label={t('workRoom.content')} disabled={busy || room?.phase === 'archived' || room?.phase === 'completed'} value={draft} onChange={event => setDraft(event.target.value)} />)}
          {!room?.documents.length && <p className="work-hint">{t('workRoom.createHint')}</p>}
        </>}
        {tab === 'results' && <div className="work-result-list"><h2>{t('workRoom.verification')}</h2>{!room?.verificationCommands.length && <p>{t('workRoom.addVerifyHint')}</p>}{room?.verificationCommands.map(value => <button key={value.id} disabled={busy || room.state === 'running'} onClick={() => void run(() => api(`work/${room.id}/verify`, 'POST', { commandId: value.id }))}>{t('workRoom.runCommand', { name: value.id })}</button>)}
          <details><summary>{t('workRoom.addCommand')}</summary><input aria-label={t('workRoom.commandName')} placeholder={t('workRoom.commandName')} value={commandId} onChange={event => setCommandId(event.target.value)} /><input aria-label={t('workRoom.executable')} placeholder={t('workRoom.executableHint')} value={command} onChange={event => setCommand(event.target.value)} /><textarea aria-label={t('workRoom.args')} placeholder={t('workRoom.argsHint')} value={args} onChange={event => setArgs(event.target.value)} /><button disabled={busy} onClick={() => room && void run(() => api(`work/${room.id}/verification-plan`, 'PUT', { commands: [...room.verificationCommands.filter(x => x.id !== commandId), { id: commandId, command, args: args.split('\n').filter(Boolean) }] }))}>{t('workRoom.saveCommand')}</button></details>
          {room?.verifications.map(result => <details key={result.id}><summary>{result.commandId} · {resultStates[result.status] || result.status} · {result.fresh ? t('workRoom.currentVersion') : t('workRoom.oldResult')}</summary><pre>{result.stdout}{'\n'}{result.stderr}{'\n'}{t('workRoom.exitCode')} {String(result.code)}</pre></details>)}
          <h2>{t('workRoom.files')}</h2>{room?.changes.map(file => <details key={file.path}><summary>{fileStates[file.status] || file.status} · {file.path}</summary><h3>{t('workRoom.before')}</h3><pre>{file.before ?? t('workRoom.noFile')}</pre><h3>{t('workRoom.after')}</h3><pre>{file.after ?? t('workRoom.noFile')}</pre></details>)}
        </div>}
        {tab === 'openspec' && <div className="work-result-list"><p>{t('workRoom.specHint')}</p><select aria-label={t('workRoom.specFunction')} value={operation} onChange={event => { setOperation(event.target.value); setCli(null); }}>{Object.entries(operations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{['instructions', 'spec'].includes(operation) && <input aria-label={operation === 'spec' ? t('workRoom.specName') : t('workRoom.artifact')} value={artifact} onChange={event => setArtifact(event.target.value)} />}<button disabled={busy || !room} onClick={inspect}>{t('workRoom.inspect')}</button>{cli && <><strong>{cli.ok ? t('workRoom.inspected') : t('workRoom.inspectError')}</strong>{cliStatus?.artifacts && <><h2>{t('workRoom.dependencies')}</h2><table><thead><tr><th>{t('workRoom.documents')}</th><th>{t('workRoom.status')}</th><th>{t('workRoom.requires')}</th></tr></thead><tbody>{cliStatus.artifacts.map(value => <tr key={value.id}><td>{value.id}</td><td>{{done: t('common.written'), ready: t('workRoom.ready'), blocked: t('workRoom.blocked')}[value.status] || value.status}</td><td>{value.requires?.join(', ') || t('common.none')}</td></tr>)}</tbody></table><h2>{t('workRoom.nextSteps')}</h2>{cliStatus.nextSteps?.map(step => <p key={step}>{step}</p>)}</>}<details open={!cliStatus?.artifacts}><summary>{t('workRoom.raw')}</summary><pre>{cli.json ? JSON.stringify(cli.json, null, 2) : cli.stdout}{'\n'}{cli.stderr}</pre></details><button onClick={() => setMessage(`OpenSpec ${operationRequestLabels[operation]} 결과를 확인하고 같은 업무에서 필요한 수정을 해 주세요.\n${cli.stdout}\n${cli.stderr}`)}>{t('workRoom.prepareRequest')}</button></>}</div>}
      </section>
    </div>
    {detailOpen && <DetailModal change={change} onClose={() => setDetailOpen(false)} />}
  </section>;
}
