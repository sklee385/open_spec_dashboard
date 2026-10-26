const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { validateArtifacts } = require('../artifacts.cjs');
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'release-artifacts-'));
  const url = 'OpenSpecBoard-0.1.0-win-x64.exe';
  fs.writeFileSync(join(dir, url), url);
  const entry = { url, sha512: createHash('sha512').update(url).digest('base64') };
  const save = files => fs.writeFileSync(join(dir, 'latest.yml'), JSON.stringify({ version: '0.1.0', files }));
  save([entry]); return { dir, entry, save };
}

test('무설치 ZIP과 전용 메타데이터를 함께 검증하고 누락·변조를 차단한다', () => {
  const { dir } = fixture();
  const file = 'OpenSpecBoard-0.1.0-win-x64-portable.zip';
  const bytes = Buffer.from('portable fixture'); fs.writeFileSync(join(dir,file),bytes);
  const manifest={version:'0.1.0',file,size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64')};
  fs.writeFileSync(join(dir,'portable.json'),JSON.stringify(manifest));
  assert.equal(validateArtifacts(dir,'0.1.0'),true);
  fs.writeFileSync(join(dir,file),'changed'); assert.throws(()=>validateArtifacts(dir,'0.1.0'));
  fs.writeFileSync(join(dir,file),bytes); fs.unlinkSync(join(dir,'portable.json')); assert.throws(()=>validateArtifacts(dir,'0.1.0'));
});
test('Windows 설치 파일과 메타데이터만으로 버전·해시 검사를 통과한다', () => {
  const { dir, entry } = fixture();
  assert.equal(validateArtifacts(dir, '0.1.0'), true);
  assert.throws(() => validateArtifacts(dir, '0.2.0'), /버전/);
  fs.writeFileSync(join(dir, entry.url), 'tampered');
  assert.throws(() => validateArtifacts(dir, '0.1.0'), /무결성/);
});
test('구버전·다른 플랫폼·아키텍처 파일을 정상 해시여도 배포하지 않는다', () => {
  for (const name of ['OpenSpecBoard-0.0.9-win-x64.exe', 'OpenSpecBoard-0.1.0-win-arm64.exe', 'OpenSpecBoard-0.1.0-mac-arm64.zip']) {
    const { dir, entry, save } = fixture(); fs.writeFileSync(join(dir, name), name);
    save([entry, { url: name, sha512: createHash('sha512').update(name).digest('base64') }]);
    assert.throws(() => validateArtifacts(dir, '0.1.0'), /파일|버전/);
  }
});
test('설치 파일 누락과 빈 메타데이터를 차단한다', () => {
  const { dir, entry, save } = fixture();
  save([]); assert.throws(() => validateArtifacts(dir, '0.1.0'), /파일/);
  save([entry]); fs.unlinkSync(join(dir, entry.url));
  assert.throws(() => validateArtifacts(dir, '0.1.0'), /파일/);
});
test('경로 탈출·외부 URL·중복 파일의 게시를 차단한다', () => {
  for (const url of ['../outside.exe', 'https://example.com/app.exe', '%2e%2e%2foutside.exe', '..\\outside.exe']) {
    const { dir, entry, save } = fixture(); save([entry, { ...entry, url }]);
    assert.throws(() => validateArtifacts(dir, '0.1.0'));
  }
  const { dir, entry, save } = fixture(); save([entry, entry]);
  assert.throws(() => validateArtifacts(dir, '0.1.0'), /중복/);
});
