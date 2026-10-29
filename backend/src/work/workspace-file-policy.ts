import { resolve } from 'node:path';
import type { Work, WorkStore } from './store';
export const localSecretPath = (path: string) => /(^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|[^/]+\.(?:pem|key|pfx|p12))$/i.test(path);
export const managedPrivatePath = (path: string) => localSecretPath(path) || path.split('/').some(part => ['.git', '.data', '.logs', '.aws', '.codex', '.reference'].includes(part.toLowerCase()));
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
export function workspaceResourcePath(work: Work, path: string) {
  return managedPrivatePath(path) || (work.workspace?.localOnlyPaths ?? []).some(local => key(path) === key(local) || key(path).startsWith(`${key(local)}/`));
}
export type WorkspacePathPolicy = ((path: string) => boolean) & { strictOwnership?: boolean };
export type WorkspaceSourcePolicy = (root: string) => WorkspacePathPolicy;
/** Request-scoped snapshot of persisted local-only paths, never config file contents. */
export function workspaceSourcePolicy(store: WorkStore): WorkspaceSourcePolicy {
  return root => {
    const works = store.list().filter(work => work.workspace && key(resolve(work.workspace.executionPath)) === key(resolve(root)));
    return Object.assign((path: string) => works.some(work => workspaceResourcePath(work, path)), { strictOwnership: works.length > 0 });
  };
}
