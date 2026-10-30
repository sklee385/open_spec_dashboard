import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { managedPrivatePath } from '../work/workspace-file-policy';
import { inspectWorkspacePath, pathsOverlap } from '../work/workspace-paths';
import { localOrigin, localPath, parseScenario } from './browser-policy';
import type { VerificationSnapshot, VerificationOutput } from './verification-snapshot';

type Endpoint = { path: string; urlPath: string };
export interface BrowserBuildContract { version: 1; build: { command: 'node' | 'npm'; args: string[]; cwd?: string }; artifacts: Endpoint[]; identity: Endpoint; freshness?: { tasksCheckboxes: 'independent-plan-metadata-v1' }; }
type BuildContext = { environmentId: string; sourceRevision: string; workId?: string; dataPath?: string; evidencePath?: string };
export interface PreparedBrowserBuild { snapshot: VerificationSnapshot; context: BuildContext; contract: BrowserBuildContract; contractVersion: string; expectedRoot: string; }
export interface BrowserBuildAttestation {
  version: 1; environmentId: string; sourceRevision: string; buildId: string; contractVersion: string;
  snapshot: VerificationSnapshot; expectedRoot: string; artifacts: (Endpoint & { sha256: string; bytes: number; mode: number })[];
  identity: Endpoint & { sha256: string; bytes: number; mode: number }; outputs: VerificationOutput[];
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(message); };
const keys = (value: any, allowed: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('빌드 출처 계약 형식을 확인해 주세요'); };
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
function outputPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 500 || !/^(?:dist|build)\//.test(value) || value.split('/').length > 16 || value.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0\r\n:*?"<>|]|[. ]$/.test(part)) || managedPrivatePath(value) || value.split('/').some(part => ['.tools', 'node_modules', 'openspec'].includes(part.toLowerCase()))) fail('빌드 산출물은 dist/build 아래의 제한된 상대 일반파일이어야 합니다');
}
function endpoint(value: any): Endpoint {
  keys(value, ['path', 'urlPath']); outputPath(value.path); localPath(value.urlPath);
  const url = new URL(value.urlPath, 'http://127.0.0.1:19000');
  if (url.origin !== 'http://127.0.0.1:19000' || url.pathname !== value.urlPath || url.search || url.hash) fail('빌드 산출물 URL 경계를 확인해 주세요');
  return { path: value.path, urlPath: value.urlPath };
}
function parse(value: any): BrowserBuildContract {
  keys(value, ['version', 'build', 'artifacts', 'identity', 'freshness']); if (value.version !== 1 || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 32) fail('빌드 출처 계약 버전·산출물을 확인해 주세요');
  if (value.freshness !== undefined) { keys(value.freshness, ['tasksCheckboxes']); if (value.freshness.tasksCheckboxes !== 'independent-plan-metadata-v1') fail('계획 metadata 독립성 선언을 확인해 주세요'); }
  keys(value.build, ['command', 'args', 'cwd']);
  const command = parseScenario({ name: 'build', server: { ...value.build, url: 'http://127.0.0.1:19000' }, steps: [{ op: 'expectURL', path: '/' }] }).server;
  if (command.command === 'npm' && command.args.length !== 2) fail('빌드 npm 명령은 등록된 run 스크립트만 허용합니다');
  const artifacts = value.artifacts.map(endpoint), identity = endpoint(value.identity), all = [...artifacts, identity];
  if (new Set(all.map(item => key(item.path))).size !== all.length || new Set(all.map(item => item.urlPath)).size !== all.length) fail('identity와 산출물 경로·URL이 충돌합니다');
  return { version: 1, build: { command: command.command, args: command.args, ...(command.cwd === undefined ? {} : { cwd: command.cwd }) }, artifacts, identity, ...(value.freshness ? { freshness: { tasksCheckboxes: 'independent-plan-metadata-v1' as const } } : {}) };
}
export async function readBrowserBuildContract(root: string) { const file = await readOwned(root, 'openspec/browser-build.json', 65536); return { contract: parse(JSON.parse(file.bytes.toString('utf8'))), version: file.sha256 }; }

/** Historical evidence is structural, not a new build or a running-server probe. */
export function validBrowserBuild(attestation: any, environment: any): attestation is BrowserBuildAttestation {
  try {
    if (!attestation || attestation.version !== 1 || attestation.environmentId !== environment?.environmentId || attestation.sourceRevision !== environment.sourceRevision || attestation.snapshot?.revision !== environment.sourceRevision || !/^[a-f0-9]{64}$/.test(attestation.contractVersion) || !Array.isArray(attestation.artifacts) || !attestation.artifacts.length || attestation.artifacts.length > 32) return false;
    const files = [...attestation.artifacts, attestation.identity];
    for (const file of files) { endpoint({ path: file.path, urlPath: file.urlPath }); if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 8 * 1024 ** 2 || !Number.isSafeInteger(file.mode)) return false; }
    if (new Set(files.map(file => key(file.path))).size !== files.length || new Set(files.map(file => file.urlPath)).size !== files.length) return false;
    if (attestation.buildId !== hash(JSON.stringify([attestation.environmentId, attestation.sourceRevision, attestation.contractVersion, attestation.artifacts]))) return false;
    const identity = Buffer.from(JSON.stringify({ version: 1, environmentId: attestation.environmentId, buildId: attestation.buildId, sourceRevision: attestation.sourceRevision, contractVersion: attestation.contractVersion, artifacts: attestation.artifacts.map(({ urlPath, sha256, bytes }: any) => ({ urlPath, sha256, bytes })) }));
    return hash(identity) === attestation.identity.sha256 && identity.length === attestation.identity.bytes && JSON.stringify(attestation.outputs) === JSON.stringify(files.map(file => ({ path: file.path, hash: file.sha256, size: file.bytes, mode: file.mode })));
  } catch { return false; }
}
async function owned(snapshot: VerificationSnapshot, expectedRoot: string) {
  const data = resolve(process.env.OPENSPEC_VERIFICATION_DATA_ROOT || process.env.DATA_DIR || '../.data');
  const container = join(data, 'verification-snapshots', snapshot.id), root = join(container, 'project');
  if (!/^[a-f0-9-]{36}$/.test(snapshot.id) || key(resolve(expectedRoot)) !== key(root) || key(resolve(snapshot.root)) !== key(root) || pathsOverlap(snapshot.root, snapshot.sourceRoot)) fail('확인된 호스트 독립 사본에서만 빌드할 수 있습니다');
  inspectWorkspacePath(root, [snapshot.sourceRoot]);
  const owner = JSON.parse((await readOwned(container, 'owner.json', 65536)).bytes.toString('utf8'));
  if (owner.id !== snapshot.id) fail('검증 사본 소유 표시가 변경되었습니다');
}
async function readOwned(root: string, path: string, max = 8 * 1024 ** 2) {
  const full = join(root, path); inspectWorkspacePath(dirname(full), []);
  const before = await lstat(full); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max) fail('빌드 파일의 소유·크기 경계를 확인할 수 없습니다');
  const fd = await open(full, 'r');
  try {
    const opened = await fd.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) fail('빌드 파일을 여는 동안 소유가 변경되었습니다');
    const chunks: Buffer[] = []; let size = 0;
    while (true) { const chunk = Buffer.allocUnsafe(Math.min(1024 ** 2, max + 1 - size)); const read = await fd.read(chunk, 0, chunk.length, null); if (!read.bytesRead) break; size += read.bytesRead; if (size > max) fail('빌드 파일 크기 한도를 초과했습니다'); chunks.push(chunk.subarray(0, read.bytesRead)); }
    const bytes = Buffer.concat(chunks, size), after = await lstat(full);
    if (bytes.length !== before.size || bytes.length > max || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || key(await realpath(full)) !== key(resolve(full))) fail('빌드 파일을 읽는 동안 변경되었습니다');
    return { bytes, sha256: hash(bytes), mode: before.mode & 0o777 };
  } finally { await fd.close(); }
}
async function existing(root: string, path: string) {
  try { return await readOwned(root, path); } catch (error: any) { if (error.code === 'ENOENT') { inspectWorkspacePath(dirname(join(root, path)), []); return undefined; } throw error; }
}
export async function prepareBrowserBuild(snapshot: VerificationSnapshot, context: BuildContext, expectedRoot: string): Promise<PreparedBrowserBuild> {
  await owned(snapshot, expectedRoot);
  if (!/^[a-f0-9-]{36}$/.test(context.environmentId) || context.sourceRevision !== snapshot.revision) fail('검증 환경과 사본 소스 출처가 다릅니다');
  if (context.dataPath !== undefined || context.evidencePath !== undefined) {
    const dataPath = context.dataPath, evidencePath = context.evidencePath;
    if (typeof dataPath !== 'string' || typeof evidencePath !== 'string') throw new Error('호스트 환경의 데이터·증거 경로가 필요합니다');
    const data = resolve(process.env.OPENSPEC_VERIFICATION_DATA_ROOT || process.env.DATA_DIR || '../.data'), container = join(data, 'verification-environments', context.environmentId);
    if (dataPath !== join(container, 'data') || evidencePath !== join(container, 'evidence')) fail('호스트 환경의 데이터·증거 경로가 다릅니다');
    inspectWorkspacePath(container, [snapshot.sourceRoot, snapshot.root]);
    const owner = JSON.parse((await readOwned(container, 'owner.json', 65536)).bytes.toString('utf8'));
    if (owner.environmentId !== context.environmentId || owner.snapshotId !== snapshot.id || owner.workId !== context.workId) fail('호스트 환경의 데이터 소유 표시가 다릅니다');
    inspectWorkspacePath(dataPath, [snapshot.sourceRoot, snapshot.root]); inspectWorkspacePath(evidencePath, [snapshot.sourceRoot, snapshot.root]);
  }
  let raw: Buffer; try { raw = (await readOwned(snapshot.root, 'openspec/browser-build.json', 65536)).bytes; } catch { fail('새 빌드 출처 계약 openspec/browser-build.json이 필요합니다'); }
  const contract = parse(JSON.parse(raw!.toString('utf8'))), files = [...contract.artifacts, contract.identity];
  const states = await Promise.all(files.map(file => existing(snapshot.root, file.path)));
  // Validate every output before removing any one file; no recursive cleanup.
  await owned(snapshot, expectedRoot);
  for (let index = 0; index < files.length; index++) if (states[index]) { const current = await readOwned(snapshot.root, files[index].path); if (current.sha256 !== states[index]!.sha256 || current.mode !== states[index]!.mode) fail('빌드 준비 중 산출물이 변경되었습니다'); await unlink(join(snapshot.root, files[index].path)); }
  return { snapshot, context: { environmentId: context.environmentId, sourceRevision: context.sourceRevision, ...(context.workId ? { workId: context.workId } : {}) }, expectedRoot, contract, contractVersion: hash(raw!) };
}
export async function completeBrowserBuild(prepared: PreparedBrowserBuild): Promise<BrowserBuildAttestation> {
  const { snapshot, expectedRoot, contract, context, contractVersion } = prepared; await owned(snapshot, expectedRoot);
  if ((await readOwned(snapshot.root, 'openspec/browser-build.json', 65536)).sha256 !== contractVersion) fail('빌드 중 출처 계약이 변경되었습니다');
  let total = 0;
  const artifacts: BrowserBuildAttestation['artifacts'] = [];
  for (const file of contract.artifacts) { const value = await readOwned(snapshot.root, file.path); total += value.bytes.length; if (total > 32 * 1024 ** 2) fail('빌드 산출물 전체 크기 한도를 초과했습니다'); artifacts.push({ ...file, sha256: value.sha256, bytes: value.bytes.length, mode: value.mode }); }
  const buildId = hash(JSON.stringify([context.environmentId, context.sourceRevision, contractVersion, artifacts]));
  const identityBytes = Buffer.from(JSON.stringify({ version: 1, environmentId: context.environmentId, buildId, sourceRevision: context.sourceRevision, contractVersion, artifacts: artifacts.map(({ urlPath, sha256, bytes }) => ({ urlPath, sha256, bytes })) }));
  const parent = dirname(join(snapshot.root, contract.identity.path)); let current = snapshot.root;
  for (const part of relative(snapshot.root, parent).split(sep).filter(Boolean)) { current = join(current, part); inspectWorkspacePath(current, []); try { await mkdir(current); } catch (error: any) { if (error.code !== 'EEXIST') throw error; } inspectWorkspacePath(current, []); }
  const identityFile = await open(join(snapshot.root, contract.identity.path), 'wx'); try { await identityFile.writeFile(identityBytes); } finally { await identityFile.close(); }
  const identityValue = await readOwned(snapshot.root, contract.identity.path, 65536), identity = { ...contract.identity, sha256: identityValue.sha256, bytes: identityValue.bytes.length, mode: identityValue.mode };
  return { version: 1, ...context, buildId, contractVersion, snapshot, expectedRoot, artifacts, identity, outputs: [...artifacts, identity].map(file => ({ path: file.path, hash: file.sha256, size: file.bytes, mode: file.mode })) };
}
export async function verifyBrowserBuild(attestation: BrowserBuildAttestation, inputOrigin: string, signal: AbortSignal) {
  const origin = localOrigin(inputOrigin); await owned(attestation.snapshot, attestation.expectedRoot);
  for (const file of [attestation.identity, ...attestation.artifacts]) {
    signal.throwIfAborted(); const local = await readOwned(attestation.snapshot.root, file.path);
    if (local.sha256 !== file.sha256 || local.bytes.length !== file.bytes || local.mode !== file.mode) fail('준비된 빌드 산출물이 변경되었습니다');
    const response = await fetch(origin + file.urlPath, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); fail('같은 origin의 빌드 identity·산출물을 확인할 수 없습니다'); }
    const reader = response.body!.getReader(), digest = createHash('sha256'); let bytes = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > file.bytes) fail('서버가 다른 빌드 산출물을 제공합니다'); digest.update(item.value); } }
    finally { await reader.cancel(); }
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) fail('서버의 실제 응답과 새 빌드 출처가 일치하지 않습니다');
  }
}
