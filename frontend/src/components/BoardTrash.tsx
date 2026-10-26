import { createContext, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, RotateCcw, X } from 'lucide-react';
import { useI18n } from '@/i18n/context';

type Entry = { id: string; kind: 'idea' | 'change'; title: string; deletedAt: string };
export function useBoardTrash() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch('/api/trash', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!stopped) { setEntries(data.entries); setReady(true); }
      } catch { if (!stopped) setReady(false); }
      finally { if (!stopped) timer = setTimeout(refresh, 2000); }
    };
    void refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  const update = async (entry: Pick<Entry, 'id' | 'kind'>, restore = false) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/trash${restore ? '/restore' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      const latest = await fetch('/api/trash');
      if (!latest.ok) throw new Error('상태를 다시 확인해 주세요.');
      setEntries((await latest.json()).entries);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };
  return { entries, ready, busy, error, update };
}
export const BoardTrashContext = createContext<ReturnType<typeof useBoardTrash> | null>(null);

export function DeleteBoardItem({ id, kind, state, onDeleted }: { id: string; kind: Entry['kind']; state?: string; onDeleted?: () => void }) {
  const trash = useContext(BoardTrashContext);
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (!trash) return null;
  const active = ['running','connecting','creating-thread','waiting-input','waiting-approval'].includes(state || '');
  return <><button type="button" disabled={!trash.ready || trash.busy || active} aria-label={t('trash.delete')} title={active ? t('trash.stopFirst') : t('trash.delete')} className="inline-flex items-center gap-1 rounded p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40" onClick={event => {
    event.stopPropagation();
    if (window.confirm(t('trash.confirm'))) void trash.update({ id, kind }).then(ok => { setFailed(!ok); if (ok) onDeleted?.(); });
  }}><Trash2 aria-hidden="true" className="h-4 w-4" /></button>{failed && trash.error && <span role="alert" className="text-sm text-destructive">{trash.error}</span>}</>;
}

export function TrashControls() {
  const trash = useContext(BoardTrashContext);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!trash) return null;
  return <>
    <button className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm" onClick={() => setOpen(true)}><Trash2 aria-hidden="true" className="h-4 w-4" />{t('trash.title')} · {trash.entries.length}</button>
    {trash.error && !open && <span role="alert" className="text-sm text-destructive">{trash.error}</span>}
    {open && createPortal(<section role="dialog" aria-modal="true" aria-label={t('trash.title')} className="fixed inset-0 z-[80] flex items-center justify-center bg-background/95 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-auto rounded-xl border border-border bg-background p-5 shadow-xl">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t('trash.title')}</h2><button aria-label={t('common.close')} onClick={() => setOpen(false)}><X className="h-5 w-5" /></button></div>
        <p className="my-3 text-sm text-muted-foreground">{t('trash.hint')}</p>
        {trash.error && <p role="alert" className="text-destructive">{trash.error}</p>}
        {!trash.ready && <p>{t('activity.connection')}</p>}
        {trash.ready && !trash.entries.length && <p>{t('trash.empty')}</p>}
        {trash.entries.map(entry => <div key={`${entry.kind}:${entry.id}`} className="flex items-center justify-between gap-3 border-t border-border py-3">
          <div className="min-w-0"><p className="break-words font-medium">{entry.title}</p><small className="break-all text-muted-foreground">{entry.id}</small></div>
          <button disabled={trash.busy || !trash.ready} className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-3 py-2 text-sm" onClick={() => void trash.update(entry, true)}><RotateCcw className="h-4 w-4" />{t('trash.restore')}</button>
        </div>)}
      </div>
    </section>, document.body)}
  </>;
}
