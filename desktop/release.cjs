function validateRelease({ platform, arch, version, tag, env }) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('지원하지 않는 OS·아키텍처입니다');
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error('정식 버전과 태그가 일치해야 합니다');
  if (!env.GH_TOKEN) throw new Error('GitHub 게시 토큰이 필요합니다. 비밀값을 로그에 출력하지 마세요.');
  if (env.GITHUB_REPOSITORY !== 'sklee385/open_spec_dashboard') throw new Error('지정한 GitHub 저장소에서만 배포할 수 있습니다');
}
module.exports = { validateRelease };
