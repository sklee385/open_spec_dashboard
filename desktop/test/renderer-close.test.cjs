const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertRendererClosable } = require('../renderer-close.cjs');
test('미저장 문서로 화면 닫기를 거절하면 종료 준비 전에 중단한다', async () => {
  await assert.rejects(assertRendererClosable({ isDestroyed: () => false, webContents: { executeJavaScript: async () => false } }), /미저장/);
});
test('닫기 상태를 확인할 수 없으면 보류하고 허용된 화면만 통과한다', async () => {
  await assert.rejects(assertRendererClosable({ isDestroyed: () => false, webContents: { executeJavaScript: async () => { throw Error('crashed'); } } }), /확인/);
  await assert.doesNotReject(assertRendererClosable({ isDestroyed: () => false, webContents: { executeJavaScript: async () => true } }));
});
