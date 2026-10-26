import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type Target = { role: 'button' | 'textbox' | 'link' | 'heading' | 'checkbox' | 'combobox' | 'option' | 'status' | 'alert'; name: string; testId?: never } | { testId: string; role?: never; name?: never };
export type Step = { op: 'goto' | 'expectURL'; path: string } | { op: 'reload' } | { op: 'click' | 'expectVisible'; target: Target } | { op: 'fill'; target: Target; value: string } | { op: 'expectText' | 'expectValue'; target: Target; value: string };
export interface Scenario { name: string; server: { command: 'node' | 'npm'; args: string[]; url: string; cwd?: string }; steps: Step[]; }
const reject = (): never => { throw new Error('시나리오 형식 또는 허용 범위를 확인해 주세요'); };
function object(value: any, keys: string[]) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) reject(); }
function string(value: unknown, max = 500): asserts value is string { if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) reject(); }
export function localOrigin(value: string) {
  string(value); const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !url.port || Number(url.port) < 1024 || [13001, 13002, 13003].includes(Number(url.port)) || url.pathname !== '/' || url.search || url.hash) reject();
  return url.origin;
}
export function allowedRequest(value: string, origin: string) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.origin === origin && !url.username && !url.password; } catch { return false; }
}
export function localPath(value: unknown): asserts value is string {
  string(value, 2000);
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) reject();
}
export function parseScenario(value: any): Scenario {
  object(value, ['name', 'server', 'steps']); string(value.name, 100);
  const server = value.server; object(server, ['command', 'args', 'url', 'cwd']);
  if (!['node', 'npm'].includes(server.command) || !Array.isArray(server.args) || !server.args.length || server.args.length > 40) reject();
  server.args.forEach((arg: unknown) => string(arg, 2000));
  if (server.command === 'node' && (!/\.[cm]?js$/.test(server.args[0]) || server.args[0].startsWith('-') || isAbsolute(server.args[0]) || server.args[0].split(/[\\/]/).includes('..'))) reject();
  if (server.command === 'npm' && (server.args[0] !== 'run' || !/^[\w:-]+$/.test(server.args[1] || ''))) reject();
  if (server.cwd !== undefined) { string(server.cwd); if (isAbsolute(server.cwd) || server.cwd.split(/[\\/]/).includes('..')) reject(); }
  const url = localOrigin(server.url);
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 50) reject();
  let assertions = 0;
  for (const step of value.steps) {
    object(step, ['op', 'target', 'path', 'value']);
    if (!['goto', 'reload', 'click', 'fill', 'expectText', 'expectValue', 'expectURL', 'expectVisible'].includes(step.op)) reject();
    const fields = step.op === 'reload' ? ['op'] : ['goto', 'expectURL'].includes(step.op) ? ['op', 'path'] : ['fill', 'expectText', 'expectValue'].includes(step.op) ? ['op', 'target', 'value'] : ['op', 'target'];
    object(step, fields);
    if (fields.includes('path')) { localPath(step.path); if (!allowedRequest(new URL(step.path, url).href, url)) reject(); }
    if (fields.includes('value') && (typeof step.value !== 'string' || step.value.length > 5000 || step.value.includes('\0'))) reject();
    if (fields.includes('target')) {
      const target = step.target; object(target, ['testId', 'role', 'name']);
      if (target.testId !== undefined) { object(target, ['testId']); string(target.testId, 200); }
      else { object(target, ['role', 'name']); if (!['button', 'textbox', 'link', 'heading', 'checkbox', 'combobox', 'option', 'status', 'alert'].includes(target.role)) reject(); string(target.name, 200); }
    }
    if (step.op.startsWith('expect')) assertions++;
  }
  if (!assertions) reject();
  return JSON.parse(JSON.stringify({ ...value, server: { ...server, url } }));
}
export function serverCwd(root: string, cwd = '.') {
  const canonical = realpathSync(root), path = realpathSync(resolve(canonical, cwd)), rel = relative(canonical, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(path).isDirectory()) reject();
  return path;
}
