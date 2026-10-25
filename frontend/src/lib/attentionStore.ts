/** The unique insertion is shared by every tab on this origin. Never use a read-then-write claim. */
export function claimAttention(workId: string, questionId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let settled = false;
    let db: IDBDatabase | undefined;
    const finish = (value: boolean | Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); db?.close();
      if (value instanceof Error) reject(value); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('Notification storage timeout')), 2000);
    const request = indexedDB.open('openspec-attention', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('issued'); };
    request.onerror = () => finish(new Error('Notification storage unavailable'));
    request.onsuccess = () => {
      db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => db?.close();
      try {
        const transaction = db.transaction('issued', 'readwrite');
        const insertion = transaction.objectStore('issued').add(Date.now(), JSON.stringify([workId, questionId]));
        let duplicate = false;
        insertion.onerror = event => {
          if (insertion.error?.name === 'ConstraintError') { duplicate = true; event.preventDefault(); event.stopPropagation(); }
        };
        transaction.oncomplete = () => finish(!duplicate);
        transaction.onabort = () => finish(new Error('Notification storage write failed'));
        transaction.onerror = () => finish(new Error('Notification storage write failed'));
      } catch { finish(new Error('Notification storage unavailable')); }
    };
  });
}
