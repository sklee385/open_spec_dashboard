import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareBrowserBuild, completeBrowserBuild, verifyBrowserBuild } from '../src/browser/browser-build';
import { VerificationSnapshots, type VerificationSnapshot } from '../src/browser/verification-snapshot';
import { WorkStore, type Work } from '../src/work/store';

let store: WorkStore, snapshots: VerificationSnapshots, snapshot: VerificationSnapshot, source: string, server: Server | undefined;
const oldData = process.env.DATA_DIR;
const contract = { version: 1, build: { command: 'node', args: ['build.cjs'] }, artifacts: [{ path: 'dist/app.js', urlPath: '/app.js' }], identity: { path: 'dist/identity.json', urlPath: '/identity.json' } };
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vbuild-')); source = join(dir, 'source'); mkdirSync(join(source, 'openspec'), { recursive: true }); mkdirSync(join(source, 'dist'));
  writeFileSync(join(source, 'input.txt'), 'fresh input'); writeFileSync(join(source, 'dist/app.js'), 'stale artifact');
  writeFileSync(join(source, 'openspec/browser-build.json'), JSON.stringify(contract));
  writeFileSync(join(source, 'build.cjs'), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/app.js',fs.readFileSync('input.txt'));\n");
  process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore(); const work: Work = { id: 'build-fixture', sourceId: 'demo', projectPath: source, executionPath: source, changeName: 'a', requestKey: randomUUID(), ideaIds: [], phase: 'verification', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' }; store.save(work);
  snapshots = new VerificationSnapshots(store); snapshot = await snapshots.prepare(work, source);
});
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } await snapshots?.cleanup(snapshot); store?.onApplicationShutdown(); if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData; });
const context = () => ({ environmentId: randomUUID(), sourceRevision: snapshot.revision });
async function build() {
  const prepared = await prepareBrowserBuild(snapshot, context(), snapshot.root);
  execFileSync(process.execPath, prepared.contract.build.args, { cwd: snapshot.root, windowsHide: true });
  return completeBrowserBuild(prepared);
}
async function serve(mode = 'files') {
  server = createServer((request, response) => {
    if (mode === 'health') { response.end('healthy'); return; }
    const name = request.url === '/identity.json' ? 'identity.json' : request.url === '/app.js' ? 'app.js' : undefined;
    if (name === 'identity.json' && mode === 'foreign') { response.end(JSON.stringify({ environmentId: 'other', buildId: 'other' })); return; }
    if (!name) { response.statusCode = 404; response.end(); return; }
    response.end(readFileSync(join(snapshot.root, 'dist', name)));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as any).port}`;
}
it('새 빌드 실제bytes와 같은 origin의 identity·artifact를 대조하고 원본은 보존한다', async () => {
  const attestation = await build(), origin = await serve(); await verifyBrowserBuild(attestation, origin, new AbortController().signal);
  expect(attestation).toMatchObject({ version: 1, sourceRevision: snapshot.revision, artifacts: [{ path: 'dist/app.js', bytes: 11 }] }); expect(attestation.buildId).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(source, 'dist/app.js'), 'utf8')).toBe('stale artifact'); expect(existsSync(join(source, 'dist/identity.json'))).toBe(false);
});
it('성공 종료만 하고 오래된 artifact를 다시 만들지 않는 build는 차단한다', async () => {
  writeFileSync(join(snapshot.root, 'build.cjs'), 'process.exit(0)'); const prepared = await prepareBrowserBuild(snapshot, context(), snapshot.root);
  expect(existsSync(join(snapshot.root, 'dist/app.js'))).toBe(false); execFileSync(process.execPath, prepared.contract.build.args, { cwd: snapshot.root, windowsHide: true }); await expect(completeBrowserBuild(prepared)).rejects.toThrow();
});
it.each(['health', 'foreign'])('%s 응답은 health200이나 다른 identity로 준비를 증명하지 못한다', async mode => {
  const attestation = await build(), origin = await serve(mode); await expect(verifyBrowserBuild(attestation, origin, new AbortController().signal)).rejects.toThrow();
});
it('최초 준비 뒤 산출물 변경도 통과 직전 재대조에서 차단한다', async () => {
  const attestation = await build(), origin = await serve(); await verifyBrowserBuild(attestation, origin, new AbortController().signal);
  writeFileSync(join(snapshot.root, 'dist/app.js'), 'changed after readiness'); await expect(verifyBrowserBuild(attestation, origin, new AbortController().signal)).rejects.toThrow();
});
it('호스트 소유 사본이 아닌 원본 직접경로와 임의 expectedRoot는 파일 변경 전에 거부한다', async () => {
  await expect(prepareBrowserBuild({ ...snapshot, root: source }, context(), snapshot.root)).rejects.toThrow();
  await expect(prepareBrowserBuild(snapshot, context(), source)).rejects.toThrow(); expect(readFileSync(join(source, 'dist/app.js'), 'utf8')).toBe('stale artifact');
  await expect(prepareBrowserBuild({ ...snapshot, root: source }, context(), source)).rejects.toThrow(); expect(readFileSync(join(source, 'dist/app.js'), 'utf8')).toBe('stale artifact');
});
it.each(['missing', 'private', 'collision', 'command', 'shared'])('%s companion 경계는 artifact를 지우기 전에 거부한다', async mode => {
  const path = join(snapshot.root, 'openspec/browser-build.json');
  if (mode === 'missing') writeFileSync(path, '{}');
  if (mode === 'private') writeFileSync(path, JSON.stringify({ ...contract, artifacts: [{ path: '.env', urlPath: '/app.js' }] }));
  if (mode === 'collision') writeFileSync(path, JSON.stringify({ ...contract, identity: contract.artifacts[0] }));
  if (mode === 'command') writeFileSync(path, JSON.stringify({ ...contract, build: { command: 'cmd', args: ['/c', 'echo'] } }));
  if (mode === 'shared') linkSync(join(snapshot.root, 'dist/app.js'), join(snapshot.root, 'shared.js'));
  await expect(prepareBrowserBuild(snapshot, context(), snapshot.root)).rejects.toThrow(); expect(readFileSync(join(snapshot.root, 'dist/app.js'), 'utf8')).toBe('stale artifact');
});
