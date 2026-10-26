async function assertRendererClosable(window) {
  if (!window || window.isDestroyed()) return;
  let timer, allowed;
  try {
    // Fixed application-owned probe; honor the existing editor guard before stopping its API.
    allowed = await Promise.race([
      window.webContents.executeJavaScript("window.dispatchEvent(new Event('beforeunload', {cancelable: true}))"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); }),
    ]);
  } catch { throw new Error('화면의 닫기 상태를 확인하지 못했습니다. 앱 종료·설치를 보류합니다.'); }
  finally { clearTimeout(timer); }
  if (allowed !== true) throw new Error('미저장 문서가 있습니다. 문서를 저장한 뒤 앱 종료·설치를 다시 요청해 주세요.');
}
module.exports = { assertRendererClosable };
