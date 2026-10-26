function configureUpdateSelection(updater, { platform, arch }) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('지원하지 않는 업데이트 플랫폼입니다');
  }
  const previous = updater.isUpdateSupported.bind(updater);
  updater.isUpdateSupported = info => {
    // Release CI only publishes strict vMAJOR.MINOR.PATCH tags. Never let a
    // malformed stable channel opt clients into a prerelease or another ABI.
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version)) return false;
    if (info.tag !== `v${info.version}`) throw new Error('업데이트 태그와 버전이 일치하지 않습니다');
    const required = `OpenSpecBoard-${info.version}-win-x64.exe`;
    if (!Array.isArray(info.files) || info.files.length !== 1 || info.files[0]?.url !== required) {
      throw new Error('현재 OS·아키텍처에 맞는 업데이트 파일이 없습니다');
    }
    const hash = info.files[0].sha512;
    if (typeof hash !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(hash) || Buffer.from(hash, 'base64').toString('base64') !== hash) {
      throw new Error('업데이트 파일의 SHA-512 메타데이터가 없거나 잘못되었습니다');
    }
    return previous(info);
  };
}
module.exports = { configureUpdateSelection };
