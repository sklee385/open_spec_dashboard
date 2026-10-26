import { useCallback, useEffect, useRef, useState } from 'react';
import { projectApi as unscopedProjectApi, ProjectApiError, projectQuery } from '../lib/projectApi';
import type { GitStatus, GitOperation, GitDetail, GitDiff, OperationKind, ProjectEntry, ProjectFile, ProjectPage, GitCommit, GitReconciliation } from '../types/project';

function persistOperation(resourceKey: string, value: GitOperation) {
  localStorage.setItem(`project-operation:${resourceKey}`, value.id);
  localStorage.setItem(`project-operation-record:${resourceKey}`, JSON.stringify(value));
}

export function useProjectWorkspace(sourceId: string | null, active = true, workId?: string | null) {
  const resourceKey = workId ? JSON.stringify([sourceId, workId]) : sourceId ?? '';
  const projectApi = useCallback(<T>(id: string, endpoint: string, body?: unknown, method = 'POST') => unscopedProjectApi<T>(id, endpoint, body, method, workId), [workId]);
  const generation = useRef(0), source = useRef(sourceId), busyRef = useRef(false), fileRequest = useRef(0), treeRequest = useRef(0), statusInFlight = useRef<string | null>(null);
  const treeRequests = useRef(new Map<string, number>());
  const treeOptions = useRef(0);
  const [entries, setEntries] = useState<ProjectEntry[]>([]), [directory, setDirectory] = useState(''), [cursor, setCursor] = useState<string | null>(null);
  const [treePages, setTreePages] = useState<Record<string, ProjectPage>>({});
  const [query, setQuery] = useState(''), [hidden, setHidden] = useState(false), [ignoredUnavailable, setIgnoredUnavailable] = useState(false);
  const [file, setFile] = useState<ProjectFile | null>(null), [draft, setDraft] = useState(''), [editing, setEditing] = useState(false), [latest, setLatest] = useState<ProjectFile | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null), [branches, setBranches] = useState<{ name: string; current: boolean }[]>([]);
  const [history, setHistory] = useState<GitCommit[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitDetail | null>(null), [diff, setDiff] = useState<GitDiff | null>(null), [historical, setHistorical] = useState<{ path: string; content: string | null; base?: string; reason?: string } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [operation, setOperation] = useState<GitOperation | null>(null);
  const dirty = file !== null && draft !== (file.content ?? '').replace(/\r\n?/g, '\n');
  const fileView = useRef({ file, dirty, sourceId });
  useEffect(() => { fileView.current = { file, dirty, sourceId }; }, [file, dirty, sourceId]);
  const valid = useCallback((id: string, gen: number) => source.current === id && generation.current === gen, []);
  const report = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const loadTree = useCallback(async (path = directory, next?: string, select = true) => {
    if (!sourceId) return;
    const gen = generation.current, request = ++treeRequest.current, options = treeOptions.current;
    const resource = `${query}:${hidden}:${path}`; treeRequests.current.set(resource, request);
    try {
      const page = await projectApi<ProjectPage>(sourceId, `${query ? '/search' : '/tree'}${projectQuery({ path, q: query || undefined, cursor: next, showHidden: String(hidden) })}`);
      if (!valid(sourceId, gen) || options !== treeOptions.current || request !== treeRequests.current.get(resource)) return;
      setEntries(old => next ? [...old, ...page.entries] : page.entries); setCursor(page.nextCursor); if (select) setDirectory(path); setIgnoredUnavailable(!!page.ignoredUnavailable);
      if (!query) setTreePages(old => ({ ...old, [path]: { ...page, entries: next ? [...(old[path]?.entries ?? []), ...page.entries] : page.entries } }));
    } catch (err) { if (valid(sourceId, gen)) report(err); }
  }, [sourceId, query, hidden, directory, valid, projectApi]);
  const refresh = useCallback(async () => {
    if (!sourceId || statusInFlight.current === resourceKey) return;
    statusInFlight.current = resourceKey;
    const gen = generation.current;
    try {
      const value = await projectApi<GitStatus>(sourceId, '/git/status');
      if (valid(sourceId, gen)) setStatus(value);
      if (value.available) {
        const list = await projectApi<{ branches: { name: string; current: boolean }[] }>(sourceId, '/git/branches');
        if (valid(sourceId, gen)) setBranches(list.branches);
      }
      const opened = fileView.current;
      if (valid(sourceId, gen) && opened.sourceId === sourceId && opened.file && !busyRef.current) {
        const current = await projectApi<ProjectFile>(sourceId, `/file${projectQuery({ path: opened.file.path })}`);
        const view = fileView.current;
        if (valid(sourceId, gen) && view.file?.path === opened.file.path && view.file.version === opened.file.version && current.version !== opened.file.version) {
          if (view.dirty) setLatest(current);
          else { setFile(current); setDraft((current.content ?? '').replace(/\r\n?/g, '\n')); setLatest(null); }
        }
      }
    } catch (err) { if (valid(sourceId, gen)) report(err); }
    finally { if (statusInFlight.current === resourceKey) statusInFlight.current = null; }
  }, [sourceId, valid, projectApi, resourceKey]);
  const loadHistory = useCallback(async (next?: string) => {
    if (!sourceId) return; const gen = generation.current;
    try { const value = await projectApi<{ commits: GitCommit[]; nextCursor: string | null }>(sourceId, `/git/log${projectQuery({ cursor: next })}`); if (valid(sourceId, gen)) { setHistory(old => next ? [...old, ...value.commits] : value.commits); setHistoryCursor(value.nextCursor); } } catch (err) { if (valid(sourceId, gen)) report(err); }
  }, [sourceId, valid, projectApi]);
  const openDetail = useCallback(async (hash: string) => {
    if (!sourceId) return; const gen = generation.current;
    try { const value = await projectApi<GitDetail>(sourceId, `/git/commits/${encodeURIComponent(hash)}`); if (valid(sourceId, gen)) { setDetail(value); setHistorical(null); setDiff(null); } } catch (err) { if (valid(sourceId, gen)) report(err); }
  }, [sourceId, valid, projectApi]);
  useEffect(() => {
    source.current = sourceId;
    // Reset the remote-resource snapshot when its source identity changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generation.current++; fileRequest.current++; setEntries([]); setTreePages({}); setDirectory(''); setFile(null); setDraft(''); setEditing(false); setLatest(null); setStatus(null); setError(''); setDetail(null); setDiff(null); setHistorical(null); setHistory([]); setBranches([]); setOperation(null); busyRef.current = false; setBusy(false);
    if (!sourceId) return;
    const gen = generation.current;
    const saved = localStorage.getItem(`project-operation:${resourceKey}`);
    try { const record = JSON.parse(localStorage.getItem(`project-operation-record:${resourceKey}`) ?? 'null') as GitOperation | null; if (record?.id && record.status) setOperation(record); } catch { /* A malformed local cache cannot cause a mutation. */ }
    if (saved) void projectApi<GitOperation>(sourceId, `/git/operations/${encodeURIComponent(saved)}`).then(value => { if (valid(sourceId, gen) && value.id && value.status) { setOperation(value); persistOperation(resourceKey, value); } }).catch(() => {});
    void loadHistory();
    // Source identity owns this reset; other requests independently track their generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, workId]);
  // Tree options synchronize the external directory resource from its root.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { treeOptions.current++; setTreePages({}); void loadTree(''); }, [sourceId, workId, query, hidden]);
  useEffect(() => {
    if (!active || !sourceId) return; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) await loadTree(directory, undefined, false); if (!stopped) timer = setTimeout(poll, 5000); };
    void poll(); const focus = () => { if (!stopped) { void refresh(); void loadTree(directory, undefined, false); } }; window.addEventListener('focus', focus);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [active, sourceId, refresh, loadTree, directory]);
  useEffect(() => {
    if (!active || !sourceId || operation?.status !== 'running') return;
    const gen = generation.current; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await projectApi<GitOperation>(sourceId, `/git/operations/${encodeURIComponent(operation.id)}`); if (stopped || !valid(sourceId, gen)) return; setOperation(next); persistOperation(resourceKey, next); if (next.status === 'running') timer = setTimeout(poll, 1000); else { void refresh(); void loadTree(); void loadHistory(); if (next.kind === 'commit' && next.status === 'succeeded' && (next.result?.hash || next.head)) void openDetail(next.result?.hash || next.head!); } } catch (err) { if (!stopped && valid(sourceId, gen)) { report(err); timer = setTimeout(poll, 5000); } } };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [active, sourceId, operation?.id, operation?.status, refresh, loadTree, loadHistory, openDetail, valid, projectApi, resourceKey]);
  const openFile = async (path: string) => {
    if (!sourceId) return; const gen = generation.current, request = ++fileRequest.current; setError('');
    try { const value = await projectApi<ProjectFile>(sourceId, `/file${projectQuery({ path })}`); if (valid(sourceId, gen) && request === fileRequest.current) { setFile(value); setDraft((value.content ?? '').replace(/\r\n?/g, '\n')); setEditing(false); setLatest(null); setDiff(null); setHistorical(null); } } catch (err) { if (valid(sourceId, gen)) report(err); }
  };
  const save = async () => {
    if (!sourceId || !file || busyRef.current) return false;
    const gen = generation.current; busyRef.current = true; setBusy(true); setError('');
    const newline = file.newline?.toLowerCase();
    const separators = file.content?.match(/\r\n|\r|\n/g) ?? [];
    let line = 0;
    const content = newline === 'crlf' || file.newline === '\r\n' ? draft.replace(/\r?\n/g, '\r\n') : newline === 'mixed' ? draft.replace(/\n/g, () => separators[line++] ?? '\n') : draft;
    try { const result = await projectApi<ProjectFile>(sourceId, '/file', { path: file.path, content, version: file.version }, 'PUT'); if (!valid(sourceId, gen)) return false; setFile({ ...file, ...result, content }); setLatest(null); void refresh(); void loadTree(); return true; }
    catch (err) { if (valid(sourceId, gen)) { report(err); if (err instanceof ProjectApiError && err.status === 409) { const current = err.data.latest ?? err.data.current; if (current && typeof current === 'object') setLatest(current as ProjectFile); } } return false; }
    finally { if (valid(sourceId, gen)) { busyRef.current = false; setBusy(false); } }
  };
  const discard = () => { setDraft((file?.content ?? '').replace(/\r\n?/g, '\n')); setEditing(false); setLatest(null); };
  const mutate = async (endpoint: string, body: unknown, method = 'POST') => {
    if (!sourceId || busyRef.current) return false; const gen = generation.current; busyRef.current = true; setBusy(true); setError('');
    try { await projectApi(sourceId, endpoint, body, method); if (!valid(sourceId, gen)) return false; if (endpoint === '/entries/move') { setTreePages({}); void loadTree(''); } else void loadTree(); void refresh(); return true; } catch (err) { if (valid(sourceId, gen)) report(err); return false; } finally { if (valid(sourceId, gen)) { busyRef.current = false; setBusy(false); } }
  };
  const run = async (kind: OperationKind, args: Record<string, unknown> = {}) => {
    if (!sourceId || !status || busyRef.current || operation?.status === 'running' || (operation?.status === 'uncertain' && !operation.reviewedAt)) return;
    const gen = generation.current; busyRef.current = true; setBusy(true); setError(''); const requestKey = crypto.randomUUID();
    try { persistOperation(resourceKey, { id: requestKey, kind, status: 'uncertain' }); const value = await projectApi<GitOperation>(sourceId, '/git/operations', { kind, ...args, token: status.token, requestKey }); if (!valid(sourceId, gen)) return; setOperation(value); persistOperation(resourceKey, value); void refresh(); void loadTree(); void loadHistory(); if (kind === 'commit' && value.status === 'succeeded' && (value.result?.hash || value.head)) void openDetail(value.result?.hash || value.head!); }
    catch (err) { if (valid(sourceId, gen)) { report(err); if (!(err instanceof ProjectApiError) || err.status >= 500 || err.status === 408) { const uncertain: GitOperation = { id: requestKey, kind, status: 'uncertain' }; setOperation(uncertain); persistOperation(resourceKey, uncertain); } else { localStorage.removeItem(`project-operation:${resourceKey}`); localStorage.removeItem(`project-operation-record:${resourceKey}`); } void refresh(); } }
    finally { if (valid(sourceId, gen)) { busyRef.current = false; setBusy(false); } }
  };
  const showDiff = async (path: string, side: string, commit?: string) => { if (!sourceId) return; const gen = generation.current; try { const value = await projectApi<GitDiff>(sourceId, `/git/diff${projectQuery({ path, side, commit })}`); if (valid(sourceId, gen)) { setDiff(value); setHistorical(null); } } catch (err) { if (valid(sourceId, gen)) report(err); } };
  const showHistorical = async (hash: string, path: string) => { if (!sourceId) return; const gen = generation.current; try { const value = await projectApi<{ path: string; content: string | null; base?: string; reason?: string }>(sourceId, `/git/commits/${encodeURIComponent(hash)}/file${projectQuery({ path })}`); if (valid(sourceId, gen)) { setHistorical(value); setDiff(null); } } catch (err) { if (valid(sourceId, gen)) report(err); } };
  const clearFile = () => { setFile(null); setDraft(''); setEditing(false); };
  const moveEntry = async (entry: ProjectEntry, target: string) => {
    if (!sourceId || busyRef.current) return false; const gen = generation.current;
    try {
      const identity = entry.version ? entry : await projectApi<ProjectEntry>(sourceId, `/entry${projectQuery({ path: entry.path })}`);
      if (!valid(sourceId, gen)) return false;
      return await mutate('/entries/move', { path: entry.path, target, version: identity.version });
    } catch (err) { if (valid(sourceId, gen)) report(err); return false; }
  };
  const reconcile = async () => { if (!sourceId || !operation || busyRef.current) return; const gen = generation.current; busyRef.current = true; setBusy(true); try { const response = await projectApi<GitReconciliation>(sourceId, `/git/operations/${encodeURIComponent(operation.id)}/reconcile`, { confirmed: true }); if (valid(sourceId, gen)) { const value = { ...response.operation, evidence: response.evidence }; setOperation(value); setStatus(response.status); persistOperation(resourceKey, value); } } catch (err) { if (valid(sourceId, gen)) report(err); } finally { if (valid(sourceId, gen)) { busyRef.current = false; setBusy(false); } } };
  return { entries, treePages, directory, cursor, query, setQuery, hidden, setHidden, ignoredUnavailable, loadTree, file, draft, setDraft, editing, setEditing, latest, dirty, error, setError, busy, status, branches, history, historyCursor, loadHistory, detail, openDetail, diff, historical, showDiff, showHistorical, operation, run, refresh, openFile, save, discard, mutate, clearFile, reconcile, moveEntry };
}
