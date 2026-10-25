import { useCallback, useEffect, useRef, useState } from 'react';
import { claimAttention } from '../lib/attentionStore';

export interface AttentionItem {
  workId: string; sourceId: string; changeName: string; title: string;
  questionId: string; kind: 'input' | 'approval'; status: 'pending'; createdAt: string;
}
export const attentionKey = (item: AttentionItem) => JSON.stringify([item.workId, item.questionId]);
export interface NativeNotificationStatus { enabled: boolean | null; effectiveEnabled: boolean; dashboardUrl: string | null; registrationStatus: string; lastError: string | null }
function isItem(value: unknown): value is AttentionItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['workId', 'sourceId', 'changeName', 'title', 'questionId', 'createdAt'].every(key => typeof item[key] === 'string')
    && ['input', 'approval'].includes(String(item.kind)) && item.status === 'pending';
}

export function useAttention(onOpen: (item: AttentionItem) => Promise<void>) {
  const [items, setItems] = useState<AttentionItem[]>([]), [notices, setNotices] = useState<AttentionItem[]>([]);
  const [connectionError, setConnectionError] = useState(false), [storageError, setStorageError] = useState(false);
  const [windowsError, setWindowsError] = useState(false), [nativeSettings, setNativeSettings] = useState<NativeNotificationStatus | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [navigationError, setNavigationError] = useState(false), [navigating, setNavigating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const opening = useRef(false), latest = useRef({ onOpen }); latest.current = { onOpen };
  const reportNavigationError = useCallback(() => { setNavigationError(true); setExpanded(true); }, []);
  const open = useCallback(async (item: AttentionItem) => {
    if (opening.current) return;
    opening.current = true; setNavigating(true); setNavigationError(false);
    try { await latest.current.onOpen(item); setExpanded(false); setNotices(old => old.filter(value => attentionKey(value) !== attentionKey(item))); }
    catch { setNavigationError(true); setExpanded(true); }
    finally { opening.current = false; setNavigating(false); }
  }, []);
  useEffect(() => {
    let stopped = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (stopped || inFlight) return;
      clearTimeout(timer); inFlight = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch('/api/work/attention', { signal: controller.signal });
        if (!response.ok) throw new Error('Attention unavailable');
        const data: { items?: unknown } = await response.json();
        if (!Array.isArray(data.items) || !data.items.every(isItem)) throw new Error('Invalid attention response');
        if (stopped) return;
        const current = data.items as AttentionItem[];
        setItems(current); setConnectionError(false);
        const keys = new Set(current.map(attentionKey));
        setNotices(old => {
          const remaining = old.filter(item => keys.has(attentionKey(item)));
          return remaining.length === old.length ? old : remaining;
        });
        for (const item of current) {
          try {
            const claimed = await claimAttention(item.workId, item.questionId);
            if (stopped) return;
            setStorageError(false);
            if (!claimed) continue;
            setNotices(old => [...old, item]);
          } catch { if (!stopped) setStorageError(true); }
        }
      } catch { if (!stopped) setConnectionError(true); }
      finally {
        if (!stopped) {
          try {
            const response = await fetch('/api/notifications/settings', { signal: controller.signal });
            if (!response.ok) throw new Error(); const value = await response.json();
            if (typeof value.effectiveEnabled !== 'boolean' || ![true, false, null].includes(value.enabled)) throw new Error();
            if (!stopped) { setNativeSettings(value); setWindowsError(!!value.lastError); }
          } catch { if (!stopped) setWindowsError(true); }
        }
        clearTimeout(timeout); inFlight = false; if (!stopped) timer = setTimeout(refresh, 5000);
      }
    };
    const wake = () => { void refresh(); };
    window.addEventListener('focus', wake); window.addEventListener('online', wake);
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); };
  }, []);
  const updateWindows = async (input: { enabled?: boolean; dashboardUrl?: string; unregister?: true }) => {
    if (savingSettings) return; setSavingSettings(true);
    try {
      const response = await fetch('/api/notifications/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(); const value = await response.json();
      if (typeof value.effectiveEnabled !== 'boolean') throw new Error();
      setNativeSettings(value); setWindowsError(!!value.lastError);
    } catch { setWindowsError(true); }
    finally { setSavingSettings(false); }
  };
  const dismissNotices = useCallback(() => setNotices([]), []);
  useEffect(() => {
    if (!notices.length) return;
    const timer = setTimeout(dismissNotices, 8000);
    return () => clearTimeout(timer);
  }, [notices, dismissNotices]);
  return { items, notices, connectionError, storageError, windowsError, nativeSettings, savingSettings, updateWindows, navigationError, reportNavigationError, navigating, expanded, setExpanded, open, dismissNotices };
}
export type AttentionState = ReturnType<typeof useAttention>;
