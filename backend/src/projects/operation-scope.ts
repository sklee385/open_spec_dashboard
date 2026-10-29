import type { OperationRequest } from './operation-locks';
import type { OperationBody } from './git-operations';
import { gitHeadRef } from './git-metadata';
import { readGitSync } from './git-runner';

export function fileOperation(root: string, paths: unknown[]): OperationRequest {
  const names = paths.map(path => typeof path === 'string' && !path.includes('\\') && !path.split('/').some(part => part === '.' || part === '..') ? /^openspec\/changes\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/.exec(path)?.[1] : undefined);
  return names.length && names.every(name => name && name === names[0]) ? { kind: 'documents', root, changeName: names[0] } : { kind: 'workspace', root };
}
export function gitOperation(root: string, body: OperationBody): OperationRequest {
  if (['stage', 'unstage', 'commit'].includes(body.kind)) return { kind: 'index', root };
  if (body.kind === 'switch-branch') return { kind: 'integration', root, ...(body.name ? { refs: [`refs/heads/${body.name}`] } : {}) };
  const head = gitHeadRef(root), refs = head ? [head] : [];
  if (body.kind === 'create-branch' && body.name) refs.push(`refs/heads/${body.name}`);
  // Fetch refspecs can update arbitrary local refs; freeze every existing target.
  if (['fetch', 'pull'].includes(body.kind)) refs.push(...readGitSync(root, ['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/).filter(Boolean));
  return { kind: 'management', root, spaces: [root], refs };
}
