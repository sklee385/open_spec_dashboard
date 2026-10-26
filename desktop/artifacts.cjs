const { readdirSync, readFileSync, statSync } = require('node:fs');
const { basename, join } = require('node:path');
const { createHash } = require('node:crypto');
const { parse } = require('yaml');
function validateArtifacts(directory, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('정식 배포 버전이 잘못되었습니다');
  const names = readdirSync(directory);
  const win = `OpenSpecBoard-${version}-win-x64.exe`;
  const required = [win];
  if (required.some(name => !names.includes(name))) throw new Error('해당 버전·지원 플랫폼의 필수 설치 파일이 없습니다');
  if (names.some(name => /\.(exe|dmg|zip)$/i.test(name) && !required.includes(name))) throw new Error('다른 버전·OS·아키텍처의 설치 파일이 있습니다');
  for (const manifest of ['latest.yml']) {
    const data = parse(readFileSync(join(directory, manifest), 'utf8'));
    if (data.version !== version) throw new Error('업데이트 메타데이터 버전 불일치');
    if (!Array.isArray(data.files) || !data.files.length) throw new Error('업데이트 파일 목록이 없습니다');
    const expected = [win];
    if (expected.some(name => !data.files.some(file => file?.url === name))) throw new Error('OS·아키텍처에 맞는 업데이트 파일이 없습니다');
    const seen = new Set();
    for (const file of data.files) {
      if (!file || typeof file !== 'object') throw new Error('업데이트 파일 항목이 잘못되었습니다');
      if (typeof file.url !== 'string' || file.url !== basename(file.url) || /[/\\%]/.test(file.url)) throw new Error('허용되지 않은 업데이트 파일 경로');
      if (seen.has(file.url)) throw new Error('중복 업데이트 파일');
      seen.add(file.url);
      if (!expected.includes(file.url)) throw new Error('다른 버전·OS·아키텍처의 업데이트 파일');
      const full = join(directory, file.url);
      if (!statSync(full).isFile() || createHash('sha512').update(readFileSync(full)).digest('base64') !== file.sha512) throw new Error('업데이트 파일 무결성 불일치');
    }
  }
  return true;
}
module.exports = { validateArtifacts };
if (require.main === module) { validateArtifacts(process.argv[2], process.argv[3]); console.log('Windows x64 릴리스 파일·버전·무결성 검증 통과'); }
