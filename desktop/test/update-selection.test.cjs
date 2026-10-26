const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AppUpdater } = require('electron-updater/out/AppUpdater');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { configureUpdateSelection } = require('../update-selection.cjs');

function setup(platform = 'win32', arch = 'x64') {
  const updater = new AppUpdater(null, { version: '0.2.0' });
  updater.allowDowngrade = false; updater.allowPrerelease = false;
  updater.isUserWithinRollout = () => true;
  updater.isUpdateSupported = () => true;
  configureUpdateSelection(updater, { platform, arch });
  return updater;
}
function info(version, platform = 'win', arch = 'x64') {
  return { version, tag: `v${version}`, files: [{ url: `OpenSpecBoard-${version}-${platform}-${arch}.${platform === 'win' ? 'exe' : 'zip'}`, sha512: Buffer.alloc(64).toString('base64') }] };
}

test('실제 updater에서 높은 정식 버전만 선택하고 같은·낮은·사전 버전을 제외한다', async () => {
  const updater = setup();
  for (const version of ['0.1.0', '0.2.0', '0.3.0-beta.1']) assert.equal(await updater.isUpdateAvailable(info(version)), false);
  assert.equal(await updater.isUpdateAvailable(info('0.3.0')), true);
  await assert.rejects(updater.isUpdateAvailable(info('invalid')));
});

test('호환 파일 부재·다른 OS/아키텍처 혼입·태그 버전 불일치는 다운로드 전에 차단한다', async () => {
  const win = setup();
  for (const candidate of [info('0.3.0', 'mac', 'arm64'), info('0.3.0', 'win', 'arm64'), { ...info('0.3.0'), tag: 'v0.4.0' }, { ...info('0.3.0'), files: [] }]) {
    await assert.rejects(win.isUpdateAvailable(candidate), /업데이트/);
  }
  const mixed = info('0.3.0'); mixed.files.push(...info('0.3.0', 'win', 'arm64').files);
  await assert.rejects(win.isUpdateAvailable(mixed), /업데이트/);
  assert.throws(() => setup('darwin', 'arm64'), /지원/);
  assert.throws(() => setup('darwin', 'x64'), /지원/);
});

test('기존 updater의 최소 OS 지원 판정을 유지한다', async () => {
  const updater = new AppUpdater(null, { version: '0.2.0' });
  let checked = 0;
  updater.isUpdateSupported = () => { checked++; return false; };
  configureUpdateSelection(updater, { platform: 'win32', arch: 'x64' });
  assert.equal(await updater.isUpdateAvailable(info('0.3.0')), false);
  assert.equal(checked, 1);
});

test('공개 latest에 정식 릴리스가 없으면 초안·사전 버전 태그로 우회하지 않는다', async () => {
  let downloads = 0;
  const provider = new GitHubProvider({ owner: 'sklee385', repo: 'open_spec_dashboard' }, setup(), {
    platform: 'win32',
    executor: { request: async request => {
      if (request.path.endsWith('.atom')) return '<feed><entry><link href="https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.4.0-beta.1"/></entry></feed>';
      if (request.path.endsWith('/latest')) return null;
      downloads++; throw new Error('정식 릴리스 없이 다운로드 요청');
    } },
  });
  await assert.rejects(provider.getLatestVersion(), /No published versions/);
  assert.equal(downloads, 0);
});

test('실제 GitHub provider는 공개 latest 정식 피드와 Windows 메타데이터만 조회한다', async () => {
  {
    const platform = 'win32', arch = 'x64', suffix = '', os = 'win';
    const updater = setup(platform, arch), requests = [];
    const provider = new GitHubProvider({ owner: 'sklee385', repo: 'open_spec_dashboard' }, updater, {
      platform,
      executor: { request: async request => {
        requests.push(`${request.hostname}${request.path}`);
        if (request.path.endsWith('.atom')) return '<feed><entry><title>beta</title><link href="https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.4.0-beta.1"/></entry><entry><title>stable</title><link href="https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.3.0"/></entry></feed>';
        if (request.path.endsWith('/latest')) return JSON.stringify({ tag_name: 'v0.3.0' });
        assert.equal(request.path, `/sklee385/open_spec_dashboard/releases/download/v0.3.0/latest${suffix}.yml`);
        return `version: 0.3.0\nfiles:\n  - url: OpenSpecBoard-0.3.0-${os}-${arch}.${os === 'win' ? 'exe' : 'zip'}\n    sha512: ${Buffer.alloc(64).toString('base64')}\n`;
      } },
    });
    const release = await provider.getLatestVersion();
    assert.equal(release.tag, 'v0.3.0');
    assert.equal(await updater.isUpdateAvailable(release), true);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(url => url.startsWith('github.com/sklee385/open_spec_dashboard/releases')));
    assert.ok(requests.every(url => !url.includes('beta') && !url.includes('draft')));
  }
});

test('개인용 미서명 업데이트도 올바른 SHA-512가 없으면 다운로드 전에 차단한다', async () => {
  const updater = setup();
  for (const hash of [undefined, '', 'fixture', '0'.repeat(128), Buffer.alloc(32).toString('base64')]) {
    const candidate = info('0.3.0'); candidate.files[0].sha512 = hash;
    await assert.rejects(updater.isUpdateAvailable(candidate), /업데이트/);
  }
});
