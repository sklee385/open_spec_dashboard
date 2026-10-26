const { spawnSync } = require('node:child_process');
const { lstatSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { validateArtifacts } = require('./artifacts.cjs');
const repository = 'sklee385/open_spec_dashboard';
function runGh(args, env) {
  return spawnSync('gh', args, { env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
}
function publishRelease({ directory, version, tag, env = process.env, run = runGh }) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF_TYPE !== 'tag' || !env.GH_TOKEN) throw new Error('지정 저장소의 태그 배포 환경과 게시 자격 증명이 필요합니다');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `v${version}`) throw new Error('정식 버전과 태그가 일치해야 합니다');
  directory = resolve(directory);
  validateArtifacts(directory, version);
  const names = [`OpenSpecBoard-${version}-win-x64.exe`, `OpenSpecBoard-${version}-win-x64.exe.blockmap`, 'latest.yml'];
  const assets = names.map(name => {
    const file = join(directory, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('필수 배포 파일이 없거나 잘못되었습니다');
    return { name, file, size: stat.size, digest: createHash('sha256').update(readFileSync(file)).digest('hex') };
  });
  const command = (args, phase) => {
    const result = run(args, env);
    if (result?.status !== 0) throw new Error(`${phase} 실패로 게시를 중단했습니다. 기존 파일과 초안은 자동 삭제하지 않습니다.`);
    return result.stdout || '';
  };
  // A failed authenticated listing is never evidence that the tag is unused.
  const tags = command(['api', '--hostname', 'github.com', '--paginate', `repos/${repository}/releases`, '--jq', '.[].tag_name'], '기존 릴리스 조회');
  if (tags.split(/\r?\n/).some(value => value.trim() === tag)) throw new Error('기존 릴리스를 덮어쓰지 않습니다. 초안과 배포 이력을 확인해 주세요.');
  const repo = ['--repo', `github.com/${repository}`];
  command(['release', 'create', tag, ...repo, '--verify-tag', '--draft', '--title', `OpenSpecBoard ${tag}`, '--generate-notes'], '초안 생성');
  command(['release', 'upload', tag, ...assets.map(asset => asset.file), ...repo], '산출물 업로드');
  let remote;
  try {
    // The tag endpoint only returns published releases; authenticated listings include drafts.
    const pages = JSON.parse(command(['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${repository}/releases`], '업로드 결과 조회'));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Invalid release pages');
    const matching = pages.flat().filter(release => release?.tag_name === tag);
    if (matching.length !== 1) throw new Error('Ambiguous release');
    remote = matching[0];
  }
  catch { throw new Error('업로드 결과를 확인하지 못해 게시를 중단했습니다. 초안을 확인해 주세요.'); }
  if (remote.tag_name !== tag || remote.draft !== true || remote.prerelease !== false) throw new Error('원격 릴리스가 같은 버전의 정식 배포 초안이 아닙니다');
  if (!Array.isArray(remote.assets) || remote.assets.length !== assets.length || assets.some(asset => remote.assets.filter(value => value?.name === asset.name && value.size === asset.size && value.state === 'uploaded' && value.digest === `sha256:${asset.digest}`).length !== 1)) throw new Error('원격 산출물 파일 목록·크기·해시·업로드 상태가 일치하지 않습니다');
  if (assets.some(asset => createHash('sha256').update(readFileSync(asset.file)).digest('hex') !== asset.digest)) throw new Error('검증 후 로컬 배포 파일이 변경되어 게시를 중단했습니다');
  command(['release', 'edit', tag, ...repo, '--draft=false'], '정식 게시');
}
module.exports = { publishRelease };
if (require.main === module) {
  try {
    publishRelease({ directory: process.argv[2], version: require('../package.json').version, tag: process.env.GITHUB_REF_NAME });
    console.log('Windows x64 릴리스 게시 완료');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
