import { vi } from 'vitest';
// API tests create independent servers and choose their own runtime fixtures.
// A desktop-launched test runner must not impose its authentication or runtime path.
delete process.env.DESKTOP_TOKEN;
delete process.env.OPENSPEC_NODE_DIRECTORY;
// Existing API tests must never register identities or emit real user notifications.
vi.mock('../src/notifications/adapter', () => ({ WindowsNotifications: class { supported = false; close() {} } }));
