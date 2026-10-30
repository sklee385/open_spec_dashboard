import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { useReadRequests } from '../hooks/useReadRequests';
import { useExactMutation } from '../hooks/useExactMutation';
import { MutationStatus } from './WorkspaceFlowShared';
import type { ExactObservation } from '../lib/exactMutation';
type Space = { workId: string; candidateId: string | null; targetKind: string; changeName: string; phase: string; kind: string; rootId: string | null; path: string; spaceStatus: string; bytes?: number | null; capacityStatus?: string };
type Asset = { workId: string; captureId: string; id: string; createdAt: string; sha256: string | null; bytes: number | null; state: string; eligibleForCleanup: boolean };
type Maintenance = { totalBytes?: number | null; capacityStatus?: string; shared?: {bytes:number|null;status:string}; version: number; retentionDays: number; measuredAt: string; roots: { rootId: string; path: string; selected: boolean; capacity?: { bytes: number | null; freeBytes: number | null; status: string } }[]; spaces: Space[]; images: Asset[]; nextSpaceAfter: number | null; nextImageAfter: number | null };
type Preview = { canRemove: boolean; token?: string; version: string | null; blockers: { code: string; message: string }[]; target: { path: string; container: string; branch: string } | null };
type ImagePreview = { workId: string; captureId: string; id: string; expectedHash: string | null; state: string; eligibleForCleanup: boolean; policyVersion: number | null };
const identity = (space: Space) => JSON.stringify([space.workId, space.candidateId]);
const size = (bytes: number | null | undefined, unknown: string) => bytes == null ? unknown : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
function useJsonRead() {
  const read = useReadRequests();
  return useCallback((url: string) => read(async signal => { const response = await fetch(url, { signal }); const value = await response.json(); if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : 'Read failed'); return value; }), [read]);
}
export function WorkspaceMaintenance() {
  const { t } = useI18n(); const [open, setOpen] = useState(false);
  return <details className="border-t pt-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">{t('maintenance.title')}</summary>{open && <MaintenancePanel />}</details>;
}
function MaintenancePanel() {
  const { t } = useI18n(), read = useJsonRead(); const [data, setData] = useState<Maintenance | null>(null), [reading, setReading] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<string | null>(null);
  const mounted = useRef(true), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (more?: 'spaces' | 'images', after = 0) => {
    if (pending.current) return; pending.current = true; setReading(true);
    try {
      const next = await read(`/api/workspace-settings/maintenance?spaceAfter=${more === 'spaces' ? after : 0}&imageAfter=${more === 'images' ? after : 0}`) as Maintenance;
      if (!Array.isArray(next.spaces) || !Array.isArray(next.images) || !Array.isArray(next.roots)) throw new Error(t('maintenance.error'));
      if (mounted.current) { setData(previous => more && previous ? { ...next, spaces: more === 'spaces' ? [...new Map([...previous.spaces, ...next.spaces].map(row => [identity(row), row])).values()] : previous.spaces, images: more === 'images' ? [...new Map([...previous.images, ...next.images].map(row => [JSON.stringify([row.captureId,row.id]), row])).values()] : previous.images, nextSpaceAfter: more === 'spaces' ? next.nextSpaceAfter : previous.nextSpaceAfter, nextImageAfter: more === 'images' ? next.nextImageAfter : previous.nextImageAfter } : next); setError(''); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t('maintenance.error')); }
    finally { pending.current = false; if (mounted.current) setReading(false); }
  }, [read, t]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);
  return <div className="space-y-3 py-3 text-sm">
    <p>{t('maintenance.hint')}</p><button disabled={reading} onClick={() => void load()}>{t('maintenance.load')}</button>{error && <p role="alert">{error}</p>}
    {data && <>
      <p>{t('maintenance.total')}: {size(data.totalBytes,t('maintenance.unknown'))} · {t(data.capacityStatus === 'complete' ? 'maintenance.complete' : 'maintenance.partial')}</p><p>{t('maintenance.shared')}: {size(data.shared?.bytes,t('maintenance.unknown'))} · {t(data.shared?.status === 'complete' ? 'maintenance.complete' : 'maintenance.partial')}</p>
      <h4 className="font-medium">{t('maintenance.roots')}</h4><ul>{data.roots.map(root => <li key={root.rootId} className="border-b py-2"><p className="break-all">{root.path}{root.selected ? ` · ${t('maintenance.current')}` : ''}</p><p>{size(root.capacity?.bytes,t('maintenance.unknown'))} · {t('workspace.free')}: {size(root.capacity?.freeBytes,t('maintenance.unknown'))} · {t(root.capacity?.status === 'complete' ? 'maintenance.complete' : 'maintenance.partial')}</p></li>)}</ul><time>{data.measuredAt}</time>
      <h4 className="font-medium">{t('maintenance.spaces')}</h4>{!data.spaces.length && <p>{t('maintenance.empty')}</p>}
      <ul>{data.spaces.map(row => <li key={identity(row)} className="border-b py-2"><p>{row.changeName} · {t(row.candidateId ? 'browser.candidate' : 'browser.work')} · {row.spaceStatus === 'removed' ? t('maintenance.removed') : row.spaceStatus}</p><p className="break-all">{row.path}</p><p>{size(row.bytes,t('maintenance.unknown'))} · {t(row.capacityStatus === 'complete' ? 'maintenance.complete' : 'maintenance.partial')}</p>{row.kind !== 'git-worktree' ? <p>{t('maintenance.copy')}</p> : row.spaceStatus !== 'removed' && <button onClick={() => setSelected(identity(row))}>{t('maintenance.preview')}</button>}{selected === identity(row) && <CleanupPanel key={identity(row)} space={row} changed={() => void load()} />}</li>)}</ul>
      {data.nextSpaceAfter !== null && <button disabled={reading} onClick={() => void load('spaces',data.nextSpaceAfter!)}>{t('maintenance.moreSpaces')}</button>}
      <h4 className="font-medium">{t('maintenance.images')}</h4><p>{t('maintenance.imageScope')}</p>{!data.images.length && <p>{t('maintenance.empty')}</p>}
      <ul>{data.images.map(row => { const key = JSON.stringify(['image',row.workId,row.captureId,row.id]); return <li key={key} className="border-b py-2"><p>{row.workId} · {row.createdAt} · {size(row.bytes,t('maintenance.unknown'))} · {t(row.state === 'expired' ? 'maintenance.expired' : row.state === 'missing' ? 'maintenance.missing' : row.eligibleForCleanup ? 'maintenance.eligible' : 'maintenance.kept')}</p>{row.state === 'available' && row.eligibleForCleanup && <button onClick={() => setSelected(key)}>{t('maintenance.inspectImage')}</button>}{selected === key && <ImageCleanup key={key} asset={row} changed={() => void load()} />}</li>; })}</ul>
      {data.nextImageAfter !== null && <button disabled={reading} onClick={() => void load('images',data.nextImageAfter!)}>{t('maintenance.moreImages')}</button>}
    </>}
  </div>;
}
function CleanupPanel({ space, changed }: { space: Space; changed: () => void }) {
  const { t } = useI18n(), read = useJsonRead(), mutation = useExactMutation(JSON.stringify(['space-cleanup',space.workId,space.candidateId]));
  const { observe } = mutation, [preview, setPreview] = useState<Preview | null>(null), [confirmed, setConfirmed] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState(''), [stored, setStored] = useState<ExactObservation | null>(null);
  const endpoint = `/api/work/${encodeURIComponent(space.workId)}/workspace/cleanup${space.candidateId ? `?candidateId=${encodeURIComponent(space.candidateId)}` : ''}`;
  const previewEndpoint = `/api/work/${encodeURIComponent(space.workId)}/workspace/cleanup/preview${space.candidateId ? `?candidateId=${encodeURIComponent(space.candidateId)}` : ''}`;
  const refresh = useCallback(async () => { const result = await read(endpoint); setStored(result.receipt); if (result.receipt?.status === 'removed') { setPreview(null); setConfirmed(false); } if (result.receipt) await observe(result.receipt); }, [endpoint, read, observe]);
  const inspect = useCallback(async () => { setReading(true); setConfirmed(false); setError(''); try { const next = await read(previewEndpoint); setPreview(next); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : t('maintenance.error')); } finally { setReading(false); } }, [read, previewEndpoint, refresh, t]);
  useEffect(() => { const timer = setTimeout(() => { void inspect(); }, 0); return () => clearTimeout(timer); }, [inspect]);
  const remove = async () => { if (!confirmed || !preview?.canRemove || !preview.token || !preview.version) return; if (await mutation.run(endpoint,{ requestKey: crypto.randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true })) { setConfirmed(false); await refresh(); changed(); } };
  return <div className="space-y-2 rounded border p-3">
    {error && <p role="alert">{error}</p>}{preview?.blockers.map(row => <p key={row.code}>{row.message}</p>)}
    {preview?.target && <><p>{t('maintenance.scope')}</p><p className="break-all">{preview.target.path}</p><p className="break-all">{preview.target.container}/identity.json · disabled-hooks/</p><p>{preview.target.branch} · {t('maintenance.branch')}</p></>}
    {preview?.canRemove && <><label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={mutation.busy} onChange={event => setConfirmed(event.target.checked)} />{t('maintenance.confirm')}</label><button disabled={!confirmed || mutation.busy || mutation.receipt?.state === 'uncertain'} onClick={() => void remove()}>{t('maintenance.remove')}</button><button disabled={mutation.busy} onClick={() => { setPreview(null); setConfirmed(false); }}>{t('maintenance.cancel')}</button></>}
    <button disabled={reading} onClick={() => void inspect()}>{t('maintenance.checkAgain')}</button>
    {stored?.status && <p role="status">{stored.status === 'removed' ? t('maintenance.removed') : stored.status === 'failed' ? t('flow.failed') : t('maintenance.uncertain')}</p>}
    <MutationStatus {...mutation} retry={() => void mutation.run().then(ok => { if (ok) { void refresh(); changed(); } })} />
  </div>;
}
function ImageCleanup({ asset, changed }: { asset: Asset; changed: () => void }) {
  const { t } = useI18n(), read = useJsonRead(), mutation = useExactMutation(JSON.stringify(['image-expiry',asset.workId,asset.captureId,asset.id]));
  const { observe } = mutation, [preview, setPreview] = useState<ImagePreview | null>(null), [confirmed, setConfirmed] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('');
  const endpoint = `/api/work/${encodeURIComponent(asset.workId)}/completion/evidence/${encodeURIComponent(asset.id)}`;
  const inspect = useCallback(async () => { setReading(true); setConfirmed(false); try { const row = await read(`${endpoint}/cleanup?captureId=${encodeURIComponent(asset.captureId)}`) as ImagePreview; setPreview(row); setError(''); await observe({...row,status:row.state,expectedHash:row.expectedHash??undefined}); } catch (e) { setError(e instanceof Error ? e.message : t('maintenance.error')); } finally { setReading(false); } }, [read, endpoint, asset.captureId, observe, t]);
  useEffect(() => { const timer = setTimeout(() => { void inspect(); }, 0); return () => clearTimeout(timer); }, [inspect]);
  const expire = async () => { if (!confirmed || !preview?.eligibleForCleanup || !preview.expectedHash || preview.policyVersion === null) return; if (await mutation.run(`${endpoint}/expire`,{requestKey:crypto.randomUUID(),captureId:asset.captureId,expectedHash:preview.expectedHash,policyVersion:preview.policyVersion,confirmed:true})) { setConfirmed(false); await inspect(); changed(); } };
  return <div className="space-y-2 rounded border p-3"><p>{t('maintenance.imageScope')}</p><p>{asset.captureId} · {asset.id}</p>{error && <p role="alert">{error}</p>}{preview?.state === 'expired' && <p>{t('maintenance.expired')}</p>}{preview?.eligibleForCleanup && <><label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={mutation.busy} onChange={event => setConfirmed(event.target.checked)} />{t('maintenance.imageConfirm')}</label><button disabled={!confirmed || mutation.busy || mutation.receipt?.state === 'uncertain'} onClick={() => void expire()}>{t('maintenance.expire')}</button><button disabled={mutation.busy} onClick={() => { setPreview(null); setConfirmed(false); }}>{t('maintenance.cancel')}</button></>}
    <button disabled={reading} onClick={() => void inspect()}>{t('maintenance.checkAgain')}</button><MutationStatus {...mutation} retry={() => void mutation.run().then(ok => { if (ok) { void inspect(); changed(); } })} /></div>;
}
