import { vi } from 'vitest';
// Existing API tests must never register identities or emit real user notifications.
vi.mock('../src/notifications/adapter', () => ({ WindowsNotifications: class { supported = false; close() {} } }));
