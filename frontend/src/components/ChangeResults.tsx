import { useI18n } from '@/i18n/context';
import { FileChange, type FileDiffProps } from './FileDiff';

export type ChangeReport = { source: string; isolated?: boolean; startedAt?: string | null; endedAt?: string | null; application?: string; error?: string; excluded?: string[]; conflicts?: string[] };
export function ChangeResults({ workId, files, report, busy, applyDisabled, onApply, onIsolate }: { workId: string; files: (FileDiffProps & { status: string })[]; report?: ChangeReport; busy?: boolean; applyDisabled?: boolean; onApply?: () => void; onIsolate?: () => void }) {
  const { t } = useI18n();
  const source = report?.source || 'unavailable';
  const status = (value: string) => value === 'added' ? t('workRoom.added') : value === 'removed' ? t('workRoom.removed') : t('workRoom.modified');
  return <section>
    <h2>{t('workRoom.files')}</h2>
    <p>{t('changeResults.work')} · {workId}</p>
    {source === 'unavailable' ? <><p>{t('changeResults.unavailable')}</p>{onIsolate && <><p>{t('changeResults.transitionHint')}</p><button disabled={busy} onClick={onIsolate}>{t('changeResults.transition')}</button></>}</> : <>
      <p>{source === 'completed' ? t('changeResults.completed') : t('changeResults.current')}</p>
      <p>{t('changeResults.started')} · {report?.startedAt || t('changeResults.noTime')} · {t('changeResults.ended')} · {report?.endedAt || t('changeResults.noTime')}</p>
      <p>{t('changeResults.isolated')}</p>
      {!files.length && <p>{t('changeResults.empty')}</p>}
      {files.map(file => <FileChange key={file.path} file={file} status={status(file.status)} />)}
      <p>{report?.application === 'applied' ? t('changeResults.applied') : report?.application === 'conflict' ? t('changeResults.conflict') : report?.application === 'applying' ? t('changeResults.recovery') : t('changeResults.notApplied')}</p>
      {report?.conflicts?.map(path => <p key={path}>{path}</p>)}
      {source === 'current' && onApply && <button disabled={busy || applyDisabled} onClick={onApply}>{t('changeResults.apply')}</button>}
    </>}
    {report?.error && <p role="alert">{report.error}</p>}
    <details><summary>{t('changeResults.policy')}</summary><p>{t('changeResults.policyHint')}</p><p>{report?.excluded?.join(', ')}</p></details>
  </section>;
}
