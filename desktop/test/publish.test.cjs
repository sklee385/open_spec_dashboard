const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { publishRelease } = require('../publish.cjs');

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'desktop-publish-'));
  const installer = 'OpenSpecBoard-0.1.0-win-x64.exe';
  fs.writeFileSync(join(directory, installer), 'fixture installer');
  fs.writeFileSync(join(directory, installer + '.blockmap'), 'fixture blockmap');
  fs.writeFileSync(join(directory, 'latest.yml'), JSON.stringify({ version: '0.1.0', files: [{ url: installer, sha512: createHash('sha512').update('fixture installer').digest('base64') }] }));
  const env = { GH_TOKEN: 'fixture-secret', GITHUB_REPOSITORY: 'sklee385/open_spec_dashboard', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag' };
  const calls = [];
  const remote = { tag_name: 'v0.1.0', draft: true, prerelease: false, assets: fs.readdirSync(directory).map(name => ({ name, size: fs.statSync(join(directory, name)).size, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(fs.readFileSync(join(directory, name))).digest('hex') })) };
  const execute = args => {
    calls.push(args);
    if (args[0] === 'api') {
      if (args.some(arg => arg.includes('/releases/tags/'))) return { status: 1, stderr: 'draft is not a published release' };
      return { status: 0, stdout: args.includes('--slurp') ? JSON.stringify([[remote]]) : '' };
    }
    return { status: 0, stdout: '' };
  };
  return { directory, installer, env, calls, remote, execute, options: { directory, version: '0.1.0', tag: 'v0.1.0', env, run: execute } };
}
const was = (calls, action) => calls.some(args => args[0] === 'release' && args[1] === action);

test('무설치 ZIP·메타데이터가 있으면 다섯 파일을 빠짐없이 검증해 게시한다', () => {
  const f=fixture();const name='OpenSpecBoard-0.1.0-win-x64-portable.zip';const data=Buffer.from('portable');
  fs.writeFileSync(join(f.directory,name),data);fs.writeFileSync(join(f.directory,'portable.json'),JSON.stringify({version:'0.1.0',file:name,size:data.length,sha512:createHash('sha512').update(data).digest('base64')}));
  for(const file of [name,'portable.json'])f.remote.assets.push({name:file,size:fs.statSync(join(f.directory,file)).size,state:'uploaded',digest:'sha256:'+createHash('sha256').update(fs.readFileSync(join(f.directory,file))).digest('hex')});
  publishRelease(f.options);
  const upload=f.calls.find(args=>args[1]==='upload');assert.equal(upload.filter(arg=>arg.startsWith(f.directory)).length,5);
  assert.ok(was(f.calls,'edit'));
});

test('검증한 세 파일을 초안에 올리고 원격 전체 확인 뒤 게시한다', () => {
  const f = fixture(); publishRelease(f.options);
  assert.deepEqual(f.calls.map(args => args.slice(0, 2).join(' ')), ['api --hostname', 'release create', 'release upload', 'api --hostname', 'release edit']);
  const upload = f.calls.find(args => args[1] === 'upload');
  const files = upload.filter(arg => arg.startsWith(f.directory)).map(file => basename(file)).sort();
  assert.deepEqual(files, f.remote.assets.map(asset => asset.name).sort());
  assert.ok(f.calls.flat().every(arg => !arg.includes('fixture-secret')));
  assert.ok(f.calls.flat().every(arg => arg !== '--clobber'));
});

test('누락 산출물과 버전·저장소·토큰·실행 종류 불일치는 외부 호출 전에 차단한다', () => {
  for (const file of ['latest.yml', 'OpenSpecBoard-0.1.0-win-x64.exe', 'OpenSpecBoard-0.1.0-win-x64.exe.blockmap']) {
    const f = fixture(); fs.unlinkSync(join(f.directory, file));
    assert.throws(() => publishRelease(f.options)); assert.equal(f.calls.length, 0);
  }
  for (const override of [{ tag: 'v0.2.0' }, { env: { GH_TOKEN: 'x', GITHUB_REPOSITORY: 'other/repo' } }, { env: {} }, { env: { ...fixture().env, GITHUB_EVENT_NAME: 'workflow_dispatch' } }]) {
    const f = fixture(); assert.throws(() => publishRelease({ ...f.options, ...override })); assert.equal(f.calls.length, 0);
  }
});

test('같은 태그의 초안·게시된 릴리스가 있으면 덮어쓰지 않는다', () => {
  const f = fixture();
  const run = args => args.includes('--paginate') ? (f.calls.push(args), { status: 0, stdout: 'v0.0.9\nv0.1.0\n' }) : f.execute(args);
  assert.throws(() => publishRelease({ ...f.options, run }), /기존|덮어/);
  assert.equal(was(f.calls, 'create'), false); assert.equal(was(f.calls, 'upload'), false); assert.equal(was(f.calls, 'edit'), false);
});

test('릴리스 조회 실패를 미존재로 간주하지 않고 비밀 오류 출력을 노출하지 않는다', () => {
  const f = fixture();
  const run = args => { f.calls.push(args); return { status: 1, stderr: 'fixture-secret unauthorized' }; };
  assert.throws(() => publishRelease({ ...f.options, run }), error => !error.message.includes('fixture-secret') && /조회/.test(error.message));
  assert.equal(was(f.calls, 'create'), false);
});

test('업로드 실패와 초안 생성 경합은 게시로 이어지지 않는다', () => {
  for (const action of ['create', 'upload']) {
    const f = fixture();
    const run = args => { if (args[1] === action) { f.calls.push(args); return { status: 1 }; } return f.execute(args); };
    assert.throws(() => publishRelease({ ...f.options, run })); assert.equal(was(f.calls, 'edit'), false);
    if (action === 'create') assert.equal(was(f.calls, 'upload'), false);
  }
});

test('원격 파일 누락·크기·해시 불일치·중복·업로드 미완료는 게시하지 않는다', () => {
  for (const mutate of [r => r.assets.pop(), r => r.assets[0].size++, r => r.assets.push(r.assets[0]), r => r.assets[0].state = 'starter', r => r.assets[0].digest = 'sha256:wrong', r => r.assets[0].digest = null]) {
    const f = fixture(); mutate(f.remote);
    assert.throws(() => publishRelease(f.options), /산출물|파일/); assert.equal(was(f.calls, 'edit'), false);
  }
});

test('잘못된 원격 태그·사전 버전·이미 게시된 릴리스를 수정하지 않는다', () => {
  for (const fields of [{ tag_name: 'v0.2.0' }, { prerelease: true }, { draft: false }]) {
    const f = fixture(); Object.assign(f.remote, fields);
    assert.throws(() => publishRelease(f.options)); assert.equal(was(f.calls, 'edit'), false);
  }
});

test('업로드 중 로컬 파일 변경과 원격 응답 오류는 게시를 차단한다', () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    const run = args => {
      if (args[1] === 'upload' && corrupt) fs.writeFileSync(join(f.directory, f.installer + '.blockmap'), 'changed blockmap');
      if (args[0] === 'api' && args.includes('--slurp') && !corrupt) { f.calls.push(args); return { status: 0, stdout: '{bad json' }; }
      return f.execute(args);
    };
    assert.throws(() => publishRelease({ ...f.options, run })); assert.equal(was(f.calls, 'edit'), false);
  }
});

test('여러 페이지에서 유일한 초안을 찾고 누락·중복 태그는 차단한다', () => {
  for (const count of [0, 1, 2]) {
    const f = fixture();
    const run = args => {
      if (args.includes('--slurp')) { f.calls.push(args); return { status: 0, stdout: JSON.stringify([[], ...Array.from({ length: count }, () => [f.remote])]) }; }
      return f.execute(args);
    };
    if (count === 1) { publishRelease({ ...f.options, run }); assert.equal(was(f.calls, 'edit'), true); }
    else { assert.throws(() => publishRelease({ ...f.options, run })); assert.equal(was(f.calls, 'edit'), false); }
  }
});
