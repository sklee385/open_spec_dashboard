import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInContext } from 'node:vm';
import { EdgeBridge } from '../src/browser/edge-bridge';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { createBridge } = require('../../edge-extension/background.js');
it('실제 HTTP 브리지와 확장 코드로 연결·관찰·입력·해제까지 처리한다', async () => {
  const bridge = new EdgeBridge();
  const page = new JSDOM('<body><h1>Fixture</h1><label>Name<input type="text"></label><button>Save</button></body>', { url: 'http://localhost:13001/', runScripts: 'outside-only' });
  const tab = { id: 4, url: page.window.location.href, title: 'Fixture', active: true, windowId: 1 };
  let saved: Record<string, unknown> = {};
  const chrome = {
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { executeScript: async (input: any) => {
      if (input.files) { runInContext(readFileSync(resolve('../edge-extension/content.js'), 'utf8'), page.getInternalVMContext()); return [{ documentId: 'fixture-document' }]; }
      expect(input.target.documentIds).toEqual(['fixture-document']);
      return [{ result: runInContext(`(${input.func.toString()})(...${JSON.stringify(input.args)})`, page.getInternalVMContext()) }];
    } },
    storage: { session: { get: async () => saved, set: async (value: any) => { saved = structuredClone(value); }, remove: async () => { saved = {}; } } },
  };
  const extension = createBridge(chrome, fetch);
  try {
    const pair = await bridge.createPair('work'); await extension.pair(pair);
    expect(bridge.status('work')).toMatchObject({ connected: true, tabId: 4 });
    const pending = bridge.execute('work', { op: 'observe' }); await extension.pollOnce();
    const observation = await pending; expect(observation.text).toContain('Fixture');
    const input = observation.elements.find((element: any) => element.role === 'textbox'); expect(input).toBeDefined();
    const fill = bridge.execute('work', { op: 'fill', observationId: observation.observationId, elementId: input.id, text: 'Changed' });
    await extension.pollOnce(); await fill;
    expect(page.window.document.querySelector('input').value).toBe('Changed');
    await expect(bridge.execute('work', { op: 'fill', observationId: observation.observationId, elementId: input.id, text: 'Repeat' })).rejects.toThrow();
    await extension.disconnect(); expect(bridge.status('work').connected).toBe(false);
  } finally { await bridge.close(); page.window.close(); }
});
