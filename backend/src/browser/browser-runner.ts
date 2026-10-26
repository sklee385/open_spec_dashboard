import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, Page, Locator } from '@playwright/test';
import { browserRuntime } from './browser-runtime';
import { allowedRequest, parseScenario, serverCwd, type Scenario, type Target } from './browser-policy';
import { localRuntimeDirectory, runtimeCommand, runtimeEnvironment } from '../runtime';
import { stopOwnedProcess } from './browser-process';
import { debuglog } from 'node:util';
import { browserNetwork } from './browser-network';
const debug = debuglog('openspec-browser');
async function bounded<T>(operation: Promise<T>, signal: AbortSignal, ms = 10000): Promise<T> {
  signal.throwIfAborted(); let timer: NodeJS.Timeout;
  let abort: () => void;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('브라우저 응답 시간이 초과됐습니다')), ms);
    abort = () => reject(new Error('검증이 중단됐습니다')); signal.addEventListener('abort', abort, { once: true });
  })]); } finally { clearTimeout(timer!); signal.removeEventListener('abort', abort!); }
}

export interface BrowserOutcome {
  status: 'passed' | 'failed' | 'blocked' | 'interrupted'; error?: string;
  startupAttempts?: number; startupRecovery?: 'windows-native-startup-crash';
  steps: { index: number; op: string; status: 'passed' | 'failed'; durationMs: number }[];
  image?: string; browser?: string; viewport: { width: number; height: number }; consoleErrors: number;
}
async function assertPortFree(port: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', () => reject(new Error('지정 포트가 사용 중입니다. 기존 서버는 유지합니다'))); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve())); });
}
function target(page: Page, value: Target): Locator {
  return value.testId !== undefined ? page.getByTestId(value.testId) : page.getByRole(value.role!, { name: value.name, exact: true });
}
export async function runScenario(input: Scenario, root: string, signal: AbortSignal, progress: (step: BrowserOutcome['steps'][number]) => void = () => {}): Promise<BrowserOutcome> {
  const outcome: BrowserOutcome = { status: 'blocked', steps: [], viewport: { width: 1280, height: 800 }, consoleErrors: 0 };
  let browser: Browser | undefined, server: ChildProcess | undefined, page: Page | undefined, data: string | undefined, blocked = false, serverError = false;
  let context: BrowserContext | undefined;
  let network: Awaited<ReturnType<typeof browserNetwork>> | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', abort);
  try {
    signal.throwIfAborted();
    const scenario = parseScenario(input), cwd = serverCwd(root, scenario.server.cwd), origin = scenario.server.url;
    const api = browserRuntime();
    debug('runtime ready');
    if (scenario.server.command === 'node' && !existsSync(join(cwd, scenario.server.args[0]))) throw new Error('테스트 서버 실행 파일이 없습니다');
    await assertPortFree(Number(new URL(origin).port)); signal.throwIfAborted();
    debug('port free');
    data = mkdtempSync(join(tmpdir(), 'openspec-browser-')); writeFileSync(join(data, 'config.json'), JSON.stringify({ sources: [] }));
    const base: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) base[key] = process.env[key];
    Object.assign(base, { NODE_ENV: 'test', OPENSPEC_VERIFICATION: '1', DATA_DIR: data, CONFIG_PATH: join(data, 'config.json'), HOME: data, USERPROFILE: data, PORT: new URL(origin).port, HOST: '127.0.0.1' });
    const command = runtimeCommand(scenario.server.command, scenario.server.args, localRuntimeDirectory());
    server = spawn(command.command, command.args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore', env: runtimeEnvironment(base) });
    server.on('error', () => { serverError = true; });
    debug('server spawned %s', server.pid);
    const deadline = Date.now() + 20000;
    while (true) {
      signal.throwIfAborted();
      if (serverError || server.exitCode !== null || server.signalCode !== null) throw new Error('테스트 서버가 준비 전에 종료됐습니다');
      try { const response = await fetch(origin, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) }); await response.body?.cancel(); if (response.status >= 200 && response.status < 400) break; } catch { signal.throwIfAborted(); }
      if (Date.now() > deadline) throw new Error('테스트 서버 준비 시간이 초과됐습니다');
      await delay(100, undefined, { signal });
    }
    // Chromium's own background services may also hit the proxy. Deny those
    // without attributing them to the page's scenario. Page/WS events below
    // mark actual scenario violations, while the proxy blocks their traffic.
    network = await browserNetwork(origin, () => {});
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal.throwIfAborted(); outcome.startupAttempts = attempt;
      try {
        browser = await api.chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true, timeout: 30000, proxy: network.proxy, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const retry = attempt === 1 && process.platform === 'win32' && !signal.aborted &&
          !(error instanceof Error && error.name === 'TimeoutError') && !/timeout|timed out|EACCES|EPERM|access denied|permission denied/i.test(message) &&
          /process did exit: exitCode=3221225477/.test(message);
        if (!retry) throw error;
        // Playwright confirmed exit before rejecting; no context, page or input exists yet.
        outcome.startupRecovery = 'windows-native-startup-crash';
      }
    }
    signal.throwIfAborted();
    if (!browser) throw new Error('브라우저를 시작하지 못했습니다');
    debug('browser launched');
    outcome.browser = `Chromium ${browser.version()}`;
    context = await bounded(browser.newContext({ viewport: outcome.viewport, serviceWorkers: 'block', acceptDownloads: false, permissions: [] }), signal);
    debug('context created');
    context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
    context.on('request', request => { if (!allowedRequest(request.url(), origin)) blocked = true; });
    await context.route('**/*', async route => {
      if (allowedRequest(route.request().url(), origin)) await route.continue();
      else { blocked = true; await route.abort('blockedbyclient'); }
    });
    debug('routes registered');
    page = await bounded(context.newPage(), signal);
    debug('page created');
    context.on('page', opened => { if (opened !== page) { blocked = true; void opened.close().catch(() => {}); } });
    page.on('download', download => { blocked = true; void download.cancel().catch(() => {}); });
    page.on('dialog', dialog => { blocked = true; void dialog.dismiss().catch(() => {}); });
    page.on('pageerror', () => outcome.consoleErrors++);
    page.on('websocket', socket => { if (!allowedRequest(socket.url().replace(/^ws:/, 'http:'), origin)) blocked = true; });
    page.on('console', message => { if (message.type() === 'error') outcome.consoleErrors++; });
    outcome.status = 'failed';
    for (const [index, step] of scenario.steps.entries()) {
      signal.throwIfAborted();
      const started = Date.now(), row: BrowserOutcome['steps'][number] = { index, op: step.op, status: 'failed', durationMs: 0 };
      try {
        debug('step %s', step.op);
        if (serverError || server.exitCode !== null || server.signalCode !== null) throw new Error();
        if (step.op === 'goto') { const response = await page.goto(origin + step.path); if (!response?.ok()) throw new Error(); }
        else if (step.op === 'reload') { const response = await page.reload(); if (!response?.ok()) throw new Error(); }
        else if (step.op === 'expectURL') await api.expect(page).toHaveURL(origin + step.path, { timeout: 5000 });
        else if ('target' in step) {
          const element = target(page, step.target);
          await api.expect(element).toHaveCount(1, { timeout: 5000 });
          if (step.op === 'click') await element.click();
          else if (step.op === 'fill') {
            const kind = await element.getAttribute('type');
            if (['password', 'file', 'hidden'].includes(kind || '')) { blocked = true; throw new Error(); }
            await element.fill(step.value);
          } else if (step.op === 'expectText') await api.expect(element).toHaveText(step.value, { timeout: 5000 });
          else if (step.op === 'expectValue') await api.expect(element).toHaveValue(step.value, { timeout: 5000 });
          else await api.expect(element).toBeVisible({ timeout: 5000 });
        }
        if (blocked) throw new Error();
        row.status = 'passed';
      } finally { row.durationMs = Date.now() - started; outcome.steps.push(row); progress(row); }
    }
    outcome.status = blocked ? 'blocked' : 'passed';
  } catch (error) {
    outcome.status = signal.aborted ? 'interrupted' : blocked ? 'blocked' : outcome.status === 'blocked' ? 'blocked' : 'failed';
    outcome.error = signal.aborted ? '사용자가 검증을 중단했습니다. 입력을 자동 반복하지 않습니다' : blocked ? '허용 범위를 벗어난 통신·팝업·입력을 차단했습니다' : outcome.steps.length ? '시나리오 단계가 실패했습니다. 단계와 화면을 확인해 주세요' : error instanceof Error ? error.message : '브라우저 준비에 실패했습니다';
  } finally {
    debug('cleanup %s', outcome.status);
    signal.removeEventListener('abort', abort);
    if (page && !signal.aborted) try { const bytes = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000 }); if (bytes.length < 1000000) outcome.image = `data:image/jpeg;base64,${bytes.toString('base64')}`; } catch { /* A missing capture is not a successful assertion. */ }
    try { if (context) await bounded(context.close(), new AbortController().signal, 5000); } catch { /* Browser/job cleanup below is authoritative. */ }
    // Playwright allows 30 seconds before killing its own process tree. Windows
    // tree termination and profile cleanup can take additional time (42s observed).
    // Keep the egress boundary alive until the entire bounded cleanup finishes.
    try { if (browser) await bounded(browser.close(), new AbortController().signal, 60000); } catch (error) { debug('browser cleanup: %s', error instanceof Error ? error.message.slice(0, 200) : 'unknown'); outcome.status = 'blocked'; outcome.error = '브라우저 종료를 확인하지 못했습니다'; }
    await network?.close();
    if (server) try { await stopOwnedProcess(server); } catch { outcome.status = 'blocked'; outcome.error = '검증 서버 종료를 확인하지 못했습니다'; }
    if (data) try { rmSync(data, { recursive: true, force: true }); } catch { /* Test-only data retained if a process still owns it. */ }
  }
  if (blocked && outcome.status === 'passed') { outcome.status = 'blocked'; outcome.error = '허용하지 않은 통신이 감지됐습니다'; }
  return outcome;
}
