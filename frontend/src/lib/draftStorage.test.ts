import { afterEach, expect, it } from 'vitest';
import { draftStorage } from './draftStorage';

afterEach(() => { delete window.desktopDrafts; });
const key = 'work-chat-draft:demo/feature';

it('keeps browser-only draft storage in localStorage', () => {
  draftStorage.setItem(key, 'browser'); expect(draftStorage.getItem(key)).toBe('browser');
  draftStorage.removeItem(key); expect(localStorage.getItem(key)).toBeNull();
});

it('migrates an existing origin draft once without resurrecting it after explicit removal', () => {
  const data = new Map<string, string>();
  window.desktopDrafts = { getItem: name => data.get(name) ?? null, setItem: (name, value) => { data.set(name, value); }, removeItem: name => { data.delete(name); } };
  localStorage.setItem(key, 'legacy browser draft');
  expect(draftStorage.getItem(key)).toBe('legacy browser draft');
  expect(data.get(key)).toBe('legacy browser draft'); expect(localStorage.getItem(key)).toBeNull();
  localStorage.setItem(key, 'older origin copy');
  draftStorage.removeItem(key);
  expect(draftStorage.getItem(key)).toBeNull();
});

it('prefers the profile copy and propagates bridge failures instead of silently writing an origin-only draft', () => {
  localStorage.setItem(key, 'old copy');
  window.desktopDrafts = { getItem: () => 'profile copy', setItem: () => { throw new Error('disk full'); }, removeItem: () => { throw new Error('denied'); } };
  expect(draftStorage.getItem(key)).toBe('profile copy');
  expect(() => draftStorage.setItem(key, 'new copy')).toThrow('disk full');
  expect(localStorage.getItem(key)).toBe('old copy');
  expect(() => draftStorage.removeItem(key)).toThrow('denied');
  window.desktopDrafts.getItem = () => { throw new Error('read denied'); };
  expect(() => draftStorage.getItem(key)).toThrow('read denied');
});
