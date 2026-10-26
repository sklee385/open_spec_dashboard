(function () {
  function createBridge(chrome, fetcher) {
    let connection = null;
    let polling = false;
    let generation = 0;
    let pairing = false;
    async function save() {
      const saved = connection;
      await chrome.storage.session.set({ connection: saved });
      // A delayed write from revoked ownership must not replace the new session.
      if (connection !== saved) {
        if (connection) await save();
        else await chrome.storage.session.remove('connection');
      }
    }
    const context = (c = connection, expiresAt) => ({ c, generation, expiresAt });
    function valid(ctx) {
      if (!ctx.c || connection !== ctx.c || generation !== ctx.generation) throw new Error('Connection ownership changed');
      if (ctx.expiresAt !== undefined && (!Number.isFinite(ctx.expiresAt) || Date.now() >= ctx.expiresAt)) throw new Error('Command expired; observe again');
    }
    async function preflight(ctx) {
      valid(ctx);
      const response = await request(ctx.c, `/commands/${encodeURIComponent(ctx.commandId)}`);
      valid(ctx);
      const result = await response.json();
      valid(ctx);
      if (result.valid !== true) throw new Error('Command canceled or revoked by the server');
    }
    function endpoint(value) {
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an http://127.0.0.1:<port> loopback endpoint');
      return url.origin;
    }
    async function request(c, path, method = 'GET', body) {
      const response = await fetcher(`${c.endpoint}${path}`, { method, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000) });
      if (!response.ok) {
        if ([401, 403, 410].includes(response.status) && connection === c) { connection = null; generation++; await chrome.storage.session.remove('connection'); }
        const error = new Error(`Bridge request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response;
    }
    async function pair({ endpoint: address, code }) {
      const base = endpoint(address);
      if (connection || pairing) throw new Error('Disconnect the current tab first');
      if (typeof code !== 'string' || !code.trim() || code.length > 200) throw new Error('Enter a pairing code');
      pairing = true;
      const pairingGeneration = generation;
      const checkPair = () => { if (generation !== pairingGeneration || connection) throw new Error('Connection ownership changed during pairing'); };
      try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      checkPair();
      if (!tab || !/^https?:\/\//.test(tab.url)) throw new Error('Select an HTTP/HTTPS tab');
      const response = await fetcher(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim(), tabId: tab.id, url: tab.url, title: tab.title || '' }), redirect: 'error', signal: AbortSignal.timeout(10000) });
      checkPair();
      if (!response.ok) throw new Error(`Pairing failed (${response.status})`);
      const result = await response.json();
      checkPair();
      if (typeof result.token !== 'string' || typeof result.workId !== 'string') throw new Error('Invalid pairing response');
      connection = { endpoint: base, token: result.token, workId: result.workId, tabId: tab.id, origin: new URL(tab.url).origin, url: tab.url, title: tab.title || '', owner: crypto.randomUUID(), inFlight: null, lastId: null };
      generation++;
      const ctx = context();
      try { await dom(ctx.c, 'bind', {}, tab.url, ctx); }
      catch (error) { if (connection === ctx.c) await disconnect(); throw error; }
      valid(ctx);
      await save();
      valid(ctx);
      return status();
      } finally { pairing = false; }
    }
    async function restore() {
      connection = (await chrome.storage.session.get('connection')).connection || null;
      generation++;
      if (connection) {
        const c = connection;
        c.owner = crypto.randomUUID();
        const ctx = context(c);
        try {
          const tab = await chrome.tabs.get(c.tabId);
          valid(ctx);
          if (!tab.url || new URL(tab.url).origin !== c.origin) { await disconnect(); return; }
          await dom(c, 'bind', {}, tab.url, ctx);
        } catch { /* Content may be unloading; the next command still checks the URL. */ }
      }
      if (connection?.inFlight) {
        const c = connection;
        try { await request(c, '/results', 'POST', { id: c.inFlight, ok: false, error: 'Extension worker restart: operation outcome uncertain; observe again' }); }
        catch (error) { if (error.status !== 409) throw error; }
        c.lastId = c.inFlight;
        c.inFlight = null;
        if (connection === c) await save();
      }
    }
    async function dom(c, op, args, expectedUrl, ctx) {
      if (ctx) valid(ctx);
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: c.tabId }, files: ['content.js'] });
      if (ctx) valid(ctx);
      if (!injected?.documentId) throw new Error('Document identity unavailable; reconnect the tab');
      if (ctx?.commandId) await preflight(ctx);
      const [result] = await chrome.scripting.executeScript({ target: { tabId: c.tabId, documentIds: [injected.documentId] }, func: (operation, data, origin, url, owner, expiresAt) => {
        if (location.origin !== origin || location.href !== url) throw new Error('URL changed; observe again');
        if (operation === 'bind') { globalThis.__openSpecEdgeOwner = owner; return globalThis.__openSpecEdgeDom.run('invalidate'); }
        if (operation === 'revoke') {
          if (globalThis.__openSpecEdgeOwner === owner) { globalThis.__openSpecEdgeOwner = null; globalThis.__openSpecEdgeDom.run('invalidate'); }
          return { url: location.href };
        }
        if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error('Command expired; observe again');
        // Only a fresh document has no owner. Never replace a different or revoked owner.
        if (operation === 'observe' && globalThis.__openSpecEdgeOwner === undefined) {
          globalThis.__openSpecEdgeDom.run('invalidate');
          globalThis.__openSpecEdgeOwner = owner;
        }
        if (globalThis.__openSpecEdgeOwner !== owner) throw new Error('Connection ownership changed');
        return globalThis.__openSpecEdgeDom.run(operation, data);
      }, args: [op, args, c.origin, expectedUrl, c.owner, ctx?.expiresAt ?? null] });
      if (ctx) valid(ctx);
      if (!result || result.error || !result.result) throw new Error('Page unavailable; reconnect the tab');
      return result.result;
    }
    async function execute(command, ctx = context(connection, command?.expiresAt)) {
      const c = ctx.c;
      if (!c) throw new Error('No connected tab');
      if (!Number.isFinite(command?.expiresAt)) throw new Error('Command expiry is required');
      ctx.commandId = command.id;
      valid(ctx);
      if (!command || command.tabId !== c.tabId) throw new Error('Wrong bound tab');
      if (!['observe', 'click', 'fill', 'scroll', 'capture'].includes(command.op)) throw new Error('Unsupported operation');
      let tab;
      try { tab = await chrome.tabs.get(c.tabId); }
      catch (error) {
        valid(ctx);
        try { await disconnect(); } catch {}
        throw error;
      }
      valid(ctx);
      if (!tab.url || new URL(tab.url).origin !== c.origin) {
        try { await disconnect(); } catch {}
        throw new Error('Connected site or tab access changed; reconnect the tab');
      }
      if (command.op !== 'observe' && tab.url !== command.expectedUrl) throw new Error('URL changed; request a fresh observation');
      if (command.op === 'capture') {
        const window = await chrome.windows.get(tab.windowId);
        valid(ctx);
        const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        valid(ctx);
        if (!tab.active || active?.id !== c.tabId) throw new Error('Select the connected tab as the active tab');
        if (!window.focused) throw new Error('Connected window must be focused');
        await preflight(ctx);
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        valid(ctx);
        if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length >= 3 * 1024 * 1024) throw new Error('Capture image is too large for the bridge (3 MiB limit)');
        const after = await chrome.tabs.get(c.tabId);
        valid(ctx);
        const [activeAfter] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        valid(ctx);
        const windowAfter = await chrome.windows.get(tab.windowId);
        valid(ctx);
        if (!after.active || activeAfter?.id !== c.tabId || after.url !== tab.url || !windowAfter.focused) throw new Error('Active tab changed during capture');
        return { image, url: tab.url };
      }
      return dom(c, command.op, command.args || {}, command.op === 'observe' ? tab.url : command.expectedUrl, ctx);
    }
    async function pollOnce() {
      const c = connection;
      const ownership = generation;
      if (!c) return;
      const { command } = await (await request(c, '/commands')).json();
      if (!command || connection !== c || generation !== ownership || command.id === c.lastId) return;
      if (typeof command.id !== 'string' || !command.id) throw new Error('Invalid command ID');
      c.inFlight = command.id;
      await save(); // Persist BEFORE execution: restarting cannot replay an uncertain action.
      let result;
      try { result = { id: command.id, ok: true, result: await execute(command, { c, generation: ownership, expiresAt: command.expiresAt }) }; }
      catch (error) { result = { id: command.id, ok: false, error: error.message || 'Operation failed' }; }
      if (connection !== c || generation !== ownership) return;
      c.lastId = command.id;
      await save();
      if (connection !== c || generation !== ownership) return;
      await request(c, '/results', 'POST', result);
      c.inFlight = null;
      if (connection === c) await save();
    }
    async function disconnect() {
      const c = connection;
      connection = null;
      generation++;
      await chrome.storage.session.remove('connection');
      if (c) {
        try {
          const tab = await chrome.tabs.get(c.tabId);
          if (tab.url && new URL(tab.url).origin === c.origin) await dom(c, 'revoke', {}, tab.url);
        } catch { /* Closed or inaccessible document cannot retain a usable grant. */ }
      }
      if (c) await request(c, '/connection', 'DELETE');
    }
    async function tabChanged(tabId, change) {
      if (!connection || tabId !== connection.tabId) return;
      if (change.removed || (change.url && new URL(change.url).origin !== connection.origin)) { await disconnect(); return; }
      if (change.status || change.url) {
        const c = connection;
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch {}
        if (connection === c && (!tab?.url || new URL(tab.url).origin !== c.origin)) await disconnect();
      }
    }
    function status() { return connection ? { connected: true, tabId: connection.tabId, title: connection.title, url: connection.url, workId: connection.workId } : { connected: false }; }
    async function start() {
      if (polling) return;
      polling = true;
      try {
        while (connection) {
          const current = generation;
          try { await pollOnce(); } catch { /* Reconnect with no action replay. */ }
          if (current !== generation || !connection) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } finally { polling = false; }
    }
    return { pair, restore, execute, pollOnce, disconnect, tabChanged, status, start };
  }
  if (typeof module !== 'undefined') module.exports = { createBridge };
  else {
    const bridge = createBridge(chrome, fetch);
    let ready = bridge.restore();
    ready.then(() => bridge.start()).catch(() => {});
    chrome.alarms.create('edge-poll', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(() => { ready = ready.catch(() => bridge.restore()); ready.then(() => bridge.start()).catch(() => {}); });
    chrome.tabs.onRemoved.addListener(tabId => { ready.then(() => bridge.tabChanged(tabId, { removed: true })).catch(() => {}); });
    chrome.tabs.onUpdated.addListener((tabId, change) => { ready.then(() => bridge.tabChanged(tabId, change)).catch(() => {}); });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      // Only the extension popup may pair/disconnect; content pages cannot issue control messages.
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
      ready.then(async () => {
        if (message.type === 'pair') { const result = await bridge.pair(message); bridge.start(); return result; }
        if (message.type === 'disconnect') { await bridge.disconnect(); return bridge.status(); }
        if (message.type === 'status') return bridge.status();
        throw new Error('Unknown popup request');
      }).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
      return true;
    });
  }
})();
