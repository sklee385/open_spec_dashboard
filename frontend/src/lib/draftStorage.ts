export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

declare global {
  interface Window { desktopDrafts?: DraftStorage }
}

/** Desktop profile storage survives the gateway's changing origin. Browser use stays local. */
export const draftStorage: DraftStorage = {
  getItem(key) {
    const desktop = window.desktopDrafts;
    if (!desktop) return localStorage.getItem(key);
    const saved = desktop.getItem(key);
    if (saved !== null) return saved;
    const legacy = localStorage.getItem(key);
    if (legacy !== null) {
      desktop.setItem(key, legacy);
      localStorage.removeItem(key);
    }
    return legacy;
  },
  setItem(key, value) {
    if (window.desktopDrafts) window.desktopDrafts.setItem(key, value);
    else localStorage.setItem(key, value);
  },
  removeItem(key) {
    window.desktopDrafts?.removeItem(key);
    localStorage.removeItem(key);
  },
};
