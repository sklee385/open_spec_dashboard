const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
let createDomController;
try { ({ createDomController } = require('../content.js')); } catch {}
function setup() {
  assert.equal(typeof createDomController, 'function', 'DOM controller must exist');
  const dom = new JSDOM('<title>Example</title><body><button>Save</button><input aria-label="Name"><input type="password" value="secret"><input type="file"></body>', { url: 'https://example.test/page', pretendToBeVisual: true });
  const control = createDomController(dom.window);
  return { dom, control };
}
test('observe and fill use observation-scoped element IDs and invalidate actions', () => {
  const { dom, control } = setup();
  const observation = control.run('observe', {});
  assert.equal(observation.url, 'https://example.test/page');
  assert.equal(observation.title, 'Example');
  assert.equal(observation.elements.length, 2);
  const name = observation.elements.find(e => e.label === 'Name');
  let inputs = 0;
  dom.window.document.querySelector('input').addEventListener('input', () => inputs++);
  assert.deepEqual(control.run('fill', { observationId: observation.observationId, elementId: name.id, text: 'Alice' }), { url: observation.url });
  assert.equal(dom.window.document.querySelector('input').value, 'Alice');
  assert.equal(inputs, 1);
  assert.throws(() => control.run('click', { observationId: observation.observationId, elementId: observation.elements[0].id }), /observation/i);
});
test('rejects DOM mutation synchronously, URL changes, and unsupported operations', () => {
  const { dom, control } = setup();
  const observation = control.run('observe', {});
  dom.window.document.querySelector('button').textContent = 'Changed';
  assert.throws(() => control.run('click', { observationId: observation.observationId, elementId: observation.elements[0].id }), /observation/i);
  const fresh = control.run('observe', {});
  dom.window.history.pushState({}, '', '/other');
  assert.throws(() => control.run('click', { observationId: fresh.observationId, elementId: fresh.elements[0].id }), /observation/i);
  assert.throws(() => control.run('eval', { code: 'alert(1)' }), /operation/i);
});
test('never operates password/file fields even if field type changes after observation', () => {
  const { dom, control } = setup();
  for (const type of ['password', 'file']) {
    const observation = control.run('observe', {});
    const name = observation.elements.find(e => e.label === 'Name');
    dom.window.document.querySelector('input').type = type;
    assert.throws(() => control.run('fill', { observationId: observation.observationId, elementId: name.id, text: 'secret' }));
    dom.window.document.querySelector('input').type = 'text';
  }
});
test('click fires once, scroll validates bounds and invalidates observation', () => {
  const { dom, control } = setup();
  let clicks = 0;
  dom.window.document.querySelector('button').onclick = () => clicks++;
  const o = control.run('observe', {});
  control.run('click', { observationId: o.observationId, elementId: o.elements[0].id });
  assert.equal(clicks, 1);
  let scroll;
  dom.window.scrollBy = options => { scroll = options; };
  const fresh = control.run('observe', {});
  control.run('scroll', { observationId: fresh.observationId, direction: 'down', pixels: 300 });
  assert.equal(scroll.top, 300);
  assert.throws(() => control.run('click', { observationId: fresh.observationId, elementId: fresh.elements[0].id }), /observation/i);
  assert.throws(() => control.run('scroll', { direction: 'left', pixels: 300 }));
});
test('scroll requires a fresh observation and limits its travel to 2000 pixels', () => {
  const { control } = setup();
  assert.throws(() => control.run('scroll', { direction: 'down', pixels: 100 }), /observation/i);
  const o = control.run('observe', {});
  assert.throws(() => control.run('scroll', { observationId: o.observationId, direction: 'down', pixels: 2001 }), /scroll/i);
});
test('observation role metadata is bounded to the bridge contract', () => {
  const { dom, control } = setup();
  dom.window.document.querySelector('button').setAttribute('role', 'x'.repeat(300));
  assert.equal(control.run('observe').elements[0].role.length, 100);
});
