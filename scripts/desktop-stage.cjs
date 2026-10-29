const fs = require('node:fs');
const path = require('node:path');
const { validateRelease } = require('../desktop/release.cjs');
const { makeUpdatePolicy } = require('../desktop/update-policy.cjs');
const { prepareStageDirectory, validateStageName } = require('../desktop/stage-directory.cjs');
const { stageBrowserRuntime } = require('../desktop/browser-runtime.cjs');
const root = path.resolve(__dirname, '..');
const stageName = validateStageName(process.env.DESKTOP_STAGE_NAME ?? 'desktop-stage');
const stage = path.join(root, '.tools', stageName);
const service = path.join(stage, 'service');
const pkg = require('../package.json');
const release = process.argv.includes('--release');
const portable = process.argv.includes('--portable');
const personalUpdate = release || portable || process.argv.includes('--personal-update');
if (process.version !== 'v24.15.0') throw new Error('데스크톱 패키징에는 검증한 Node 24.15.0을 사용해 주세요');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64에서 준비해 주세요');
if (release) validateRelease({ platform: process.platform, arch: process.arch, version: pkg.version, tag: process.env.GITHUB_REF_NAME, env: process.env });
for (const required of ['backend/dist/desktop-main.js', 'frontend/dist/index.html', 'node_modules/electron-updater/package.json']) {
  if (!fs.existsSync(path.join(root, required))) throw new Error(`먼저 빌드·설치가 필요합니다: ${required}`);
}
prepareStageDirectory(root, stageName);
fs.mkdirSync(service, { recursive: true });
stageBrowserRuntime(root, path.join(service, 'browser-runtime'));
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, dereference: true }); };
for (const name of ['main.cjs','graphics.cjs','renderer-recovery.cjs','preload.cjs','dashboard-preload.cjs','attention-links.cjs','updates.cjs','update-policy.cjs','update-selection.cjs','portable-updater.cjs','portable-install.cjs','portable-swap.cjs','renderer-close.cjs','shutdown-guard.cjs','updates.html','updates-ui.cjs','api-client.cjs','recovery-state.cjs','health-window.cjs','health-preload.cjs','health-ui.cjs','health.html','health.css','emergency.cjs']) copy(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
  copy(path.join(root, 'desktop', 'drafts.cjs'), path.join(stage, 'desktop', 'drafts.cjs'));
  fs.writeFileSync(path.join(stage, 'desktop', 'release-policy.json'), JSON.stringify(makeUpdatePolicy(personalUpdate, { portable })));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'openspecboard', productName: 'OpenSpecBoard', version: pkg.version, description: 'OpenSpecBoard 데스크톱 업무 공간', main: 'desktop/main.cjs', author: 'OpenSpecBoard', license: 'MIT', private: true, dependencies: {} }, null, 2));
copy(path.join(root, 'backend', 'dist'), path.join(service, 'backend', 'dist'));
copy(path.join(root, 'backend', 'scripts'), path.join(service, 'backend', 'scripts'));
copy(path.join(root, 'frontend', 'dist'), path.join(service, 'frontend'));
for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'README.md']) copy(path.join(root, 'edge-extension', name), path.join(service, 'edge-extension', name));
for (const name of ['LICENSE.upstream','UPSTREAM.md']) copy(path.join(root, name), path.join(service, name));
// Use the existing lockfile's installed production graph; do not resolve new package versions during packaging.
const lock = require('../package-lock.json');
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!name.startsWith('node_modules/') || entry.dev || entry.link || !fs.existsSync(path.join(root, name))) continue;
  copy(path.join(root, name), path.join(service, name));
}
copy(path.join(root, 'package-lock.json'), path.join(service, 'dependency-lock.json'));
const runtime = path.join(service, 'runtime');
copy(process.execPath, path.join(runtime, 'node.exe'));
const nodeLicense = [path.join(path.dirname(process.execPath), 'LICENSE'), path.resolve(path.dirname(process.execPath), '../LICENSE'), path.resolve(path.dirname(process.execPath), '../share/doc/node/LICENSE')].find(file => fs.existsSync(file));
if (!nodeLicense) throw new Error('동봉할 Node 배포의 LICENSE를 찾을 수 없습니다');
copy(nodeLicense, path.join(runtime, 'LICENSE'));
const npmCandidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm')];
const npm = npmCandidates.find(dir => fs.existsSync(path.join(dir, 'bin', 'npm-cli.js')));
if (!npm) throw new Error('실행 중인 Node 배포의 npm을 찾을 수 없습니다');
copy(npm, path.join(runtime, 'node_modules', 'npm'));
const metadata = { node: process.version, platform: process.platform, arch: process.arch, electron: require('electron/package.json').version, version: pkg.version, signedRelease: false, updateMode: portable ? 'portable-github' : personalUpdate ? 'personal-github' : 'local', repository: 'sklee385/open_spec_dashboard' };
fs.writeFileSync(path.join(service, 'build-info.json'), JSON.stringify(metadata, null, 2));
console.log(`데스크톱 준비 완료: ${process.platform}/${process.arch}, Node ${process.version}, ${personalUpdate ? '개인용 GitHub 업데이트 활성 (미서명)' : '로컬 검사 빌드 (업데이트 비활성)'}`);
