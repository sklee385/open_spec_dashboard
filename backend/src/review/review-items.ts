import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';

export type ReviewItem = { id: string; path: string; startLine: number; endLine: number; kind: string; text: string; version: string };
export const documentVersion = (content: string) => createHash('sha256').update(content).digest('hex');

export async function extractReviewItems(path: string, content: string): Promise<ReviewItem[]> {
  const tree = fromMarkdown(content), version = documentVersion(content), items: ReviewItem[] = [];
  const plain = (node: RootContent): string => {
    if (node.type === 'html') return '';
    if ('value' in node) return node.value;
    if ('children' in node) return node.children.map(child => plain(child as RootContent)).join(['list', 'listItem'].includes(node.type) ? '\n' : '');
    return '';
  };
  const visit = (node: RootContent) => {
    if (node.type === 'listItem') {
      const first = node.children[0];
      const text = first?.type === 'paragraph' && first.children[0]?.type === 'text' ? first.children[0].value : '';
      const marker = /^\[review:(confirm|assumption|decision|choice)\](?:\s+|$)/.exec(text);
      if (marker && node.position) {
        const { start, end } = node.position;
        items.push({ id: documentVersion(`${path}:${version}:${start.line}:${end.line}`), path, version,
          startLine: start.line, endLine: end.line, kind: marker[1], text: plain(node).replace(marker[0], '').trim() });
      }
    }
    if ('children' in node) node.children.forEach(child => visit(child as RootContent));
  };
  tree.children.forEach(visit);
  return items;
}
