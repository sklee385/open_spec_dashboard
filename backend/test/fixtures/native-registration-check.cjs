// Real Windows user-scope registration smoke check. No toast is emitted.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { WindowsNotifications } = require('../../dist/notifications/adapter');
const key = 'HKCU\\Software\\Classes\\AppUserModelId\\OpenSpecBoard.Notifications';
const reg = join(process.env.SystemRoot, 'System32/reg.exe');
const shortcut = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/OpenSpecBoard Notifications.lnk');
const marker = value => execFileSync(reg, ['add', key, '/v', 'Owner', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, stdio: 'ignore' });
(async () => {
  const adapter = new WindowsNotifications();
  await adapter.register('microsoft-edge:http://127.0.0.1:13001/'); assert.ok(existsSync(shortcut));
  // Only the identity this check just registered is altered. Never borrow another app ID.
  marker('OpenSpecBoard.TestConflict');
  try { await assert.rejects(adapter.unregister()); assert.ok(existsSync(shortcut)); }
  finally { marker('OpenSpecBoard.NativeNotifications.v1'); }
  await adapter.unregister(); assert.ok(!existsSync(shortcut));
  let removed = false; try { execFileSync(reg, ['query', key], { windowsHide: true, stdio: 'ignore' }); } catch { removed = true; } assert.ok(removed);
  await adapter.register('microsoft-edge:http://127.0.0.1:13001/'); assert.ok(existsSync(shortcut));
  console.log('Native registration, foreign ownership rejection, owned unregister, re-register: passed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
