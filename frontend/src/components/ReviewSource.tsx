import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ReviewItem } from '../hooks/useReviewItems';

export function ReviewSource({ content, path, selection }: { content: string; path: string; selection: ReviewItem | null }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selection || selection.path !== path) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-source-line="${selection.startLine}"]`);
    target?.focus(); target?.scrollIntoView?.({ block: 'center' });
  }, [selection, content, path]);
  return <div ref={root} className="review-source"><ReactMarkdown components={{ li: ({ node, ...props }) => <li {...props}
    tabIndex={-1} data-source-line={node?.position?.start.line}
    data-review-selected={selection?.path === path && selection.startLine === node?.position?.start.line ? 'true' : undefined} /> }}>{content}</ReactMarkdown></div>;
}
