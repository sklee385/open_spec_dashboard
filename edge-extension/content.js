/* Runs in the extension's isolated world, never in the page's JavaScript world. */
(function () {
  function createDomController(win) {
    const doc = win.document;
    let observation = null;
    let elements = new Map();
    const invalidate = () => { observation = null; elements.clear(); };
    const mutations = new win.MutationObserver(invalidate);
    mutations.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const event of ['input', 'change', 'popstate', 'hashchange', 'pagehide']) win.addEventListener(event, invalidate, true);
    const safe = el => el.isConnected && !el.disabled && !el.closest('[hidden],[inert],[aria-hidden="true"]') && !['password', 'file', 'hidden'].includes(el.type) && win.getComputedStyle(el).display !== 'none' && win.getComputedStyle(el).visibility !== 'hidden';
    const label = el => (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent || el.getAttribute('title') || '').trim().slice(0, 200);
    function run(op, args = {}) {
      if (!['observe', 'click', 'fill', 'scroll', 'invalidate'].includes(op)) throw new Error('Unsupported operation');
      if (op === 'invalidate') { invalidate(); return { url: win.location.href }; }
      if (mutations.takeRecords().length) invalidate();
      if (op === 'observe') {
        invalidate();
        const observationId = win.crypto.randomUUID();
        const list = [...doc.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]')].filter(safe).slice(0, 500);
        const descriptors = list.map((el, i) => {
          const id = `${observationId}:${i}`;
          elements.set(id, el);
          return { id, role: (el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : 'textbox')).slice(0, 100), label: label(el) };
        });
        observation = { id: observationId, url: win.location.href };
        // Never serialize input values or password/file control attributes.
        return { observationId, url: win.location.href, title: doc.title.slice(0, 500), text: (doc.body?.innerText || doc.body?.textContent || '').slice(0, 40000), elements: descriptors };
      }
      if (!observation || args.observationId !== observation.id || observation.url !== win.location.href) throw new Error('Stale observation; observe again');
      if (op === 'scroll') {
        if (!['up', 'down'].includes(args.direction) || !Number.isInteger(args.pixels) || args.pixels < 1 || args.pixels > 2000) throw new Error('Invalid scroll arguments');
        invalidate();
        win.scrollBy({ top: args.pixels * (args.direction === 'up' ? -1 : 1), behavior: 'instant' });
        return { url: win.location.href };
      }
      const el = elements.get(args.elementId);
      if (!el || !safe(el)) throw new Error('Invalid element; observe again');
      if (op === 'fill' && (typeof args.text !== 'string' || args.text.length > 20000 || !['INPUT', 'TEXTAREA'].includes(el.tagName) || el.readOnly || (el.tagName === 'INPUT' && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type)))) throw new Error('Unsupported input field or text');
      invalidate();
      if (op === 'click') el.click();
      else {
        const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, args.text);
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      return { url: win.location.href };
    }
    return { run };
  }
  if (typeof module !== 'undefined') module.exports = { createDomController };
  else if (!globalThis.__openSpecEdgeDom) globalThis.__openSpecEdgeDom = createDomController(globalThis);
})();
