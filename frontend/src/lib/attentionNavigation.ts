import type { Change, ChangeDetail } from '../types';

export interface AttentionTarget { workId: string; questionId: string; token: number }
export interface WorkRoomNavigation { preserveDrafts(): boolean }
export interface AttentionLink { workId: string; questionId: string; title?: string }
export type DesktopAttentionRequest = AttentionLink | { invalid: true };
const hasControlCharacters = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
declare global {
  interface Window {
    desktopAttention?: { onRequest(listener: (target: DesktopAttentionRequest) => void): () => void; ready(): Promise<unknown> };
    desktopRecovery?: { onOpenWork(listener: (workId: string) => void): () => void };
  }
}
export function parseAttentionLink(href: string): AttentionLink | null {
  const url = new URL(href), names = ['workId', 'questionId'];
  if (!names.some(key => url.searchParams.has(key))) return null;
  if (names.some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim() || url.searchParams.get(key)!.length > 512 || hasControlCharacters(url.searchParams.get(key)!))) throw new Error('Invalid notification link');
  return { workId: url.searchParams.get('workId')!, questionId: url.searchParams.get('questionId')! };
}
export function consumeAttentionLink() {
  const url = new URL(window.location.href); url.searchParams.delete('workId'); url.searchParams.delete('questionId');
  window.history.replaceState(window.history.state, '', url.href);
}

/** Validate through current server state; a notification's stored metadata can be stale. */
export async function loadAttentionDestination(item: AttentionLink): Promise<Change> {
  return loadWorkDestination(item.workId, item);
}

export async function loadWorkDestination(workId: string, item?: AttentionLink): Promise<Change> {
  if (typeof workId !== 'string' || !workId.trim() || workId.length > 512 || hasControlCharacters(workId)) throw new Error('Invalid work id');
  const workResponse = await fetch(`/api/work/${encodeURIComponent(workId)}`);
  if (!workResponse.ok) throw new Error('Work unavailable');
  const work = await workResponse.json();
  if (work.id !== workId || typeof work.sourceId !== 'string' || !work.sourceId.trim() || typeof work.changeName !== 'string' || !work.changeName.trim()) throw new Error('Invalid work');
  if (item && (!Array.isArray(work.questions) || !work.questions.some((question: { id?: unknown }) => question.id === item.questionId))) throw new Error('Request unavailable');
  const response = await fetch(`/api/changes/${encodeURIComponent(`${work.sourceId}/${work.changeName}`)}`);
  if (!response.ok) throw new Error('Change unavailable');
  const change: ChangeDetail = await response.json();
  if (change.sourceId !== work.sourceId || change.id !== `${work.sourceId}/${work.changeName}`) throw new Error('Invalid destination');
  return { id: change.id, sourceId: change.sourceId, name: work.changeName, title: change.title || item?.title, status: change.status,
    hasProposal: change.proposal !== null, hasDesign: change.design !== null, hasSpecs: !!change.specs?.length, hasTasks: !!change.tasks,
    taskStats: change.tasks?.stats || null, schema: change.schema, artifacts: change.artifacts };
}
