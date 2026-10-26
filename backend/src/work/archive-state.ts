import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { changeAt, directories, markdownFiles } from '../legacy/parser';
import { textFile, within } from '../files';
import { createHash } from 'node:crypto';
import { unresolvedQuestion } from '../codex/questions';
import type { Work, WorkStore } from './store';

/** Repair a completed filesystem move, without claiming tests or application passed. */
export function reconcileArchive(store: WorkStore, work: Work, sourceRoot: string): Work {
  if (work.phase === 'archived' || !['idle', 'failed', 'interrupted'].includes(work.state) || work.errorCode === 'termination-unconfirmed') return work;
  if (existsSync(within(sourceRoot, `changes/${work.changeName}`))) return work;
  if (store.records(work.id, 'question').some(unresolvedQuestion)) return work;
  if (['verification', 'browser-verification'].some(kind => store.records(work.id, kind).some(row => row.status === 'running'))) return work;
  if (store.records(work.id, 'queued-message').some(row => ['queued', 'dispatching', 'uncertain'].includes(row.status))) return work;
  const names = directories(join(sourceRoot, 'changes/archive')).filter(name => name === work.changeName || /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === work.changeName);
  if (names.length !== 1) return work;
  if (!changeAt(sourceRoot, work.sourceId, names[0], true)) return work;
  const root = within(sourceRoot, `changes/archive/${names[0]}`);
  const documents = Object.fromEntries(['proposal.md', 'design.md', 'tasks.md', 'verification.md', ...markdownFiles(join(root, 'specs')).map(file => `specs/${file}`)].flatMap(path => {
    const content = textFile(within(root, path));
    return content === null ? [] : [[path, { path, content, version: createHash('sha256').update(content).digest('hex') }]];
  }));
  const restored: Work = { ...work, phase: 'archived', state: 'idle', archiveName: names[0], completedDocuments: work.completedDocuments ?? documents };
  delete restored.error; delete restored.errorCode;
  store.transaction(() => {
    store.save(restored);
    store.event(work.id, 'archive-reconciled', { archiveName: names[0], verificationHistoryPreserved: true });
  });
  return restored;
}
