import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { useReadRequests } from '../hooks/useReadRequests';
import { FileDiff, type FileAvailability } from './FileDiff';

export type RetainedCapture = { captureId: string; workId: string; fileCount: number; verificationCount: number; integration?: { candidateId?: string; targetBranch?: string; appliedCommit?: string; resultCommit?: string } };
type RetainedFile = { ordinal: number; path: string; status: string; beforeAvailability: string; afterAvailability: string; beforeHash?: string; afterHash?: string };
type RetainedFileBody = RetainedFile & { before: string | null; after: string | null };
type RetainedVerification = { ordinal: number; id: string; targetKind: string; status: string; commandId?: string; candidateId?: string; commit?: string; evidence?: { id: string; state: 'available' | 'expired' | 'missing'; url?: string; eligibleForCleanup?: boolean } };
type Page = { workId: string; captureId: string; nextCursor: number | null };
type FilesPage = Page & { files: RetainedFile[] };
type VerificationsPage = Page & { results: RetainedVerification[] };

function evidenceLink(url: string | undefined) {
  if (!url) return null;
  try { const parsed = new URL(url, window.location.origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/') && !parsed.username && !parsed.password ? url : null; }
  catch { return null; }
}
const availability = (value: string): FileAvailability => ['text', 'absent', 'binary', 'size-limit', 'unknown'].includes(value) ? value as FileAvailability : 'unknown';

export function RetainedResults({ workId, capture }: { workId: string; capture: RetainedCapture }) {
  const { t } = useI18n();
  if (workId !== capture.workId) return <p role="alert">{t('retained.identity')}</p>;
  return <RetainedContent key={JSON.stringify([workId, capture.captureId])} workId={workId} capture={capture} />;
}
function RetainedContent({ workId, capture }: { workId: string; capture: RetainedCapture }) {
  const { t } = useI18n(), read = useReadRequests();
  const [files, setFiles] = useState<RetainedFile[]>([]), [results, setResults] = useState<RetainedVerification[]>([]);
  const [fileCursor, setFileCursor] = useState<number | null>(null), [verificationCursor, setVerificationCursor] = useState<number | null>(null);
  const [filesBusy, setFilesBusy] = useState(false), [verificationsBusy, setVerificationsBusy] = useState(false), [bodyBusy, setBodyBusy] = useState(false);
  const [fileError, setFileError] = useState(''), [verificationError, setVerificationError] = useState(''), [bodyError, setBodyError] = useState('');
  const [selected, setSelected] = useState<RetainedFile | null>(null), [body, setBody] = useState<RetainedFileBody | null>(null);
  const alive = useRef(true), filePending = useRef(false), verificationPending = useRef(false), bodySequence = useRef(0), fileAttempt = useRef(0), verificationAttempt = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const base = `/api/work/${encodeURIComponent(workId)}/completion`;
  const request = useCallback(<T,>(endpoint: string) => read(async signal => {
    const response = await fetch(endpoint, { signal }); const value = await response.json();
    if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : t('retained.failed'));
    return value as T;
  }), [read, t]);
  const validatePage = useCallback((page: Page, after: number) => {
    if (page.workId !== workId || page.captureId !== capture.captureId) throw new Error(t('retained.identity'));
    if (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after)) throw new Error(t('retained.invalid'));
  }, [workId, capture.captureId, t]);
  const loadFiles = useCallback(async (after = 0) => {
    if (filePending.current) return; filePending.current = true; fileAttempt.current = after; setFilesBusy(true); setFileError('');
    try {
      const page = await request<FilesPage>(`${base}/files?${new URLSearchParams({ captureId: capture.captureId, after: String(after), limit: '25' })}`);
      if (!alive.current) return; validatePage(page, after);
      if (!Array.isArray(page.files) || page.files.some(file => !Number.isSafeInteger(file.ordinal) || file.ordinal < after || typeof file.path !== 'string')) throw new Error(t('retained.invalid'));
      setFiles(previous => after === 0 ? page.files : [...previous, ...page.files]); setFileCursor(page.nextCursor);
    } catch (error) { if (alive.current) setFileError(error instanceof Error ? error.message : t('retained.failed')); }
    finally { filePending.current = false; if (alive.current) setFilesBusy(false); }
  }, [base, capture.captureId, request, validatePage, t]);
  const loadVerifications = useCallback(async (after = 0) => {
    if (verificationPending.current) return; verificationPending.current = true; verificationAttempt.current = after; setVerificationsBusy(true); setVerificationError('');
    try {
      const page = await request<VerificationsPage>(`${base}/verifications?${new URLSearchParams({ captureId: capture.captureId, after: String(after), limit: '25' })}`);
      if (!alive.current) return; validatePage(page, after);
      if (!Array.isArray(page.results) || page.results.some(result => !Number.isSafeInteger(result.ordinal) || result.ordinal < after || typeof result.id !== 'string' || result.evidence && !['available', 'expired', 'missing'].includes(result.evidence.state))) throw new Error(t('retained.invalid'));
      setResults(previous => after === 0 ? page.results : [...previous, ...page.results]); setVerificationCursor(page.nextCursor);
    } catch (error) { if (alive.current) setVerificationError(error instanceof Error ? error.message : t('retained.failed')); }
    finally { verificationPending.current = false; if (alive.current) setVerificationsBusy(false); }
  }, [base, capture.captureId, request, validatePage, t]);
  // Read the first metadata pages only. Bodies and evidence are never prefetched.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (capture.fileCount > 0) void loadFiles(); if (capture.verificationCount > 0) void loadVerifications(); }, [capture.fileCount, capture.verificationCount, loadFiles, loadVerifications]);
  const openFile = async (file: RetainedFile) => {
    const sequence = ++bodySequence.current; setSelected(file); setBody(null); setBodyError(''); setBodyBusy(true);
    try {
      const next = await request<RetainedFileBody>(`${base}/file?${new URLSearchParams({ captureId: capture.captureId, ordinal: String(file.ordinal) })}`);
      if (!alive.current || sequence !== bodySequence.current) return;
      if (next.ordinal !== file.ordinal || next.path !== file.path) throw new Error(t('retained.identity'));
      if (!(typeof next.before === 'string' || next.before === null) || !(typeof next.after === 'string' || next.after === null)) throw new Error(t('retained.invalid'));
      setBody(next);
    } catch (error) { if (alive.current && sequence === bodySequence.current) setBodyError(error instanceof Error ? error.message : t('retained.failed')); }
    finally { if (alive.current && sequence === bodySequence.current) setBodyBusy(false); }
  };
  const integration = capture.integration;
  return <section aria-label={t('retained.title')}>
    <h3>{t('retained.title')}</h3>
    {integration && <dl>{integration.targetBranch && <><dt>{t('retained.target')}</dt><dd>{integration.targetBranch}</dd></>}{integration.candidateId && <><dt>{t('retained.candidate')}</dt><dd>{integration.candidateId}</dd></>}{integration.appliedCommit && <><dt>{t('retained.appliedCommit')}</dt><dd>{integration.appliedCommit}</dd></>}{integration.resultCommit && <><dt>{t('retained.resultCommit')}</dt><dd>{integration.resultCommit}</dd></>}</dl>}
    <h4>{t('retained.files')} ({capture.fileCount})</h4>
    {filesBusy && <p role="status">{t('retained.loading')}</p>}{fileError && <><p role="alert">{fileError}</p><button disabled={filesBusy} onClick={() => void loadFiles(fileAttempt.current)}>{t('retained.retryFiles')}</button></>}
    {!filesBusy && !fileError && !files.length && <p>{t('retained.noFiles')}</p>}
    <ul>{files.map(file => <li key={file.ordinal}><span>{file.status}</span> <button onClick={() => void openFile(file)}>{t('retained.openFile')} {file.path}</button></li>)}</ul>
    {fileCursor !== null && <button disabled={filesBusy} onClick={() => void loadFiles(fileCursor)}>{t('retained.moreFiles')}</button>}
    {selected && <section aria-label={selected.path}><h4>{selected.path}</h4>{bodyBusy && <p role="status">{t('retained.loading')}</p>}{bodyError && <><p role="alert">{bodyError}</p><button disabled={bodyBusy} onClick={() => void openFile(selected)}>{t('retained.retryBody')}</button></>}{body && <FileDiff path={body.path} before={body.before} after={body.after} beforeAvailability={availability(body.beforeAvailability)} afterAvailability={availability(body.afterAvailability)} />}</section>}
    <h4>{t('retained.verifications')} ({capture.verificationCount})</h4>
    {verificationsBusy && <p role="status">{t('retained.loading')}</p>}{verificationError && <><p role="alert">{verificationError}</p><button disabled={verificationsBusy} onClick={() => void loadVerifications(verificationAttempt.current)}>{t('retained.retryVerifications')}</button></>}
    {!verificationsBusy && !verificationError && !results.length && <p>{t('retained.noVerifications')}</p>}
    <ul>{results.map(result => {
      const evidence = result.evidence, href = evidence?.state === 'available' ? evidenceLink(evidence.url) : null;
      return <li key={result.ordinal}><p>{result.commandId ?? result.id} · {result.targetKind} · {result.status} {result.candidateId} {result.commit}</p>{evidence && <><p>{t(evidence.state === 'expired' ? 'retained.expired' : evidence.state === 'missing' ? 'retained.missing' : 'retained.available')}</p>{evidence.eligibleForCleanup && <p>{t('retained.eligible')}</p>}{href ? <a href={href} target="_blank" rel="noopener noreferrer">{t('retained.evidence')}</a> : evidence.state === 'available' && evidence.url ? <p>{t('retained.blockedUrl')}</p> : null}</>}</li>;
    })}</ul>
    {verificationCursor !== null && <button disabled={verificationsBusy} onClick={() => void loadVerifications(verificationCursor)}>{t('retained.moreVerifications')}</button>}
  </section>;
}
