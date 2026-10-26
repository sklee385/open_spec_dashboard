import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeChangeEvents } from './changeEvents';

export type ReviewItem = { id: string; path: string; startLine: number; endLine: number; kind: 'confirm' | 'assumption' | 'decision' | 'choice'; text: string; version: string };
export type ReviewResponse = { items: ReviewItem[]; documentVersions: Record<string, string>; errors: { path: string; code: string; message: string }[] };
export function matchReviewItem(item: ReviewItem, data: ReviewResponse): ReviewItem | undefined {
  const exact = data.items.find(candidate => candidate.id === item.id);
  if (exact) return exact;
  const matches = data.items.filter(candidate => candidate.path === item.path && candidate.kind === item.kind && candidate.text === item.text);
  return matches.length === 1 ? matches[0] : undefined;
}
export function useReviewItems(endpoint: string | null, revision: number | string = 0) {
  const [data, setData] = useState<ReviewResponse | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!endpoint) return null;
    const current = ++sequence.current;
    setLoading(true); setError(false);
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error('review request failed');
      const result = await response.json() as ReviewResponse;
      if (!Array.isArray(result.items) || !Array.isArray(result.errors) || !result.documentVersions) throw new Error('invalid review response');
      if (current === sequence.current) setData(result);
      return result;
    } catch {
      if (current === sequence.current) setError(true);
      return null;
    } finally { if (current === sequence.current) setLoading(false); }
  }, [endpoint]);
  useEffect(() => {
    setData(null); void refresh();
    return () => { ++sequence.current; };
  }, [refresh]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) { previousRevision.current = revision; void refresh(); }
  }, [revision, refresh]);
  useEffect(() => {
    if (!endpoint) return;
    return subscribeChangeEvents(() => { void refresh(); });
  }, [endpoint, refresh]);
  return { data, loading, error, refresh };
}
