import type { Change, ChangeDetail } from '../types';

export interface AttentionTarget { workId: string; questionId: string; token: number }
export interface WorkRoomNavigation { preserveDrafts(): boolean }
export interface AttentionLink { workId: string; questionId: string; title?: string }
export function parseAttentionLink(href: string): AttentionLink | null {
  const url = new URL(href), names = ['workId', 'questionId'];
  if (!names.some(key => url.searchParams.has(key))) return null;
  if (names.some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim() || url.searchParams.get(key)!.length > 512 || /[\x00-\x1f\x7f]/.test(url.searchParams.get(key)!))) throw new Error('Invalid notification link');
  return { workId: url.searchParams.get('workId')!, questionId: url.searchParams.get('questionId')! };
}
export function consumeAttentionLink() {
  const url = new URL(window.location.href); url.searchParams.delete('workId'); url.searchParams.delete('questionId');
  window.history.replaceState(window.history.state, '', url.href);
}

/** Validate through current server state; a notification's stored metadata can be stale. */
export async function loadAttentionDestination(item: AttentionLink): Promise<Change> {
  const workResponse = await fetch(`/api/work/${encodeURIComponent(item.workId)}`);
  if (!workResponse.ok) throw new Error('Work unavailable');
  const work = await workResponse.json();
  if (work.id !== item.workId || typeof work.sourceId !== 'string' || typeof work.changeName !== 'string') throw new Error('Invalid work');
  if (!Array.isArray(work.questions) || !work.questions.some((question: { id?: unknown }) => question.id === item.questionId)) throw new Error('Request unavailable');
  const response = await fetch(`/api/changes/${encodeURIComponent(`${work.sourceId}/${work.changeName}`)}`);
  if (!response.ok) throw new Error('Change unavailable');
  const change: ChangeDetail = await response.json();
  if (change.sourceId !== work.sourceId || change.id !== `${work.sourceId}/${work.changeName}`) throw new Error('Invalid destination');
  return { id: change.id, sourceId: change.sourceId, name: work.changeName, title: change.title || item.title, status: change.status,
    hasProposal: change.proposal !== null, hasDesign: change.design !== null, hasSpecs: !!change.specs?.length, hasTasks: !!change.tasks,
    taskStats: change.tasks?.stats || null, schema: change.schema, artifacts: change.artifacts };
}
