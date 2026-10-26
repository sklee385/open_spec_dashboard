import { vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
// GitHub Windows exposes TEMP as RUNNER~1 while Git/fs return runneradmin.
// Fixtures must start from the same canonical path as the production boundary checks.
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = realpathSync.native(tmpdir());
// API tests create independent servers and choose their own runtime fixtures.
// A desktop-launched test runner must not impose its authentication or runtime path.
delete process.env.DESKTOP_TOKEN;
delete process.env.OPENSPEC_NODE_DIRECTORY;
// Existing API tests must never register identities or emit real user notifications.
vi.mock('../src/notifications/adapter', () => ({ WindowsNotifications: class { supported = false; close() {} } }));
