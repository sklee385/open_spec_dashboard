import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { draftStorage } from '../lib/draftStorage';

/** Local-only recovery; never part of API requests or diagnostic records. */
export function useLocalDraft(key: string | null, value: unknown, enabled: boolean, onFailure: () => void) {
  const pending = useRef<{ key: string; json: string } | null>(null);
  const editedKey = useRef<string | null>(null);
  const failure = useRef(onFailure);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => { failure.current = onFailure; });
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!pending.current) return true;
    try { draftStorage.setItem(pending.current.key, pending.current.json); pending.current = null; return true; }
    catch { failure.current(); return false; }
  }, []);
  const cancel = useCallback(() => { clearTimeout(timer.current); pending.current = null; editedKey.current = null; }, []);
  const serialized = JSON.stringify(value);
  useLayoutEffect(() => {
    clearTimeout(timer.current);
    if (pending.current && pending.current.key !== key) flush();
    if (key && (enabled || editedKey.current === key)) { pending.current = { key, json: serialized }; timer.current = setTimeout(flush, 400); }
    else pending.current = null;
    editedKey.current = enabled ? key : null;
  }, [key, serialized, enabled, flush]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (!flush()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => { flush(); window.removeEventListener('beforeunload', before); };
  }, [flush]);
  return { flush, cancel };
}

export function readDocumentDraft(key: string): { content: string; version: string; baseContent?: string } | null {
  const saved = draftStorage.getItem(key);
  if (!saved) return null;
  const value = JSON.parse(saved);
  if (typeof value?.content !== 'string' || typeof value?.version !== 'string') throw new Error('Invalid draft');
  return { content: value.content, version: value.version, baseContent: typeof value.baseContent === 'string' ? value.baseContent : undefined };
}

export const projectDraftKey = (source: string, work: string | null | undefined, path: string) => `project-draft:${JSON.stringify([source, work ?? null, path])}`;
export const workDraftKey = (id: string, path: string) => `work-draft:${JSON.stringify([id, path])}`;
