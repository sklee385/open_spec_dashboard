import { runScenario } from './browser-runner';
import { type Scenario } from './browser-policy';

const controller = new AbortController();
process.once('disconnect', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let started = false;
function reply(result: unknown, code = 0) {
  if (!process.connected) { process.exit(code); return; }
  process.send?.({ result }, () => { if (process.connected) process.disconnect(); process.exit(code); });
}
process.on('message', async (message: any) => {
  if (message?.cancel === true) { controller.abort(); return; }
  if (started || !message?.scenario || typeof message.root !== 'string') return;
  started = true;
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const result = await runScenario(message.scenario as Scenario, message.root, controller.signal, step => { if (process.connected) process.send?.({ step }); });
    // Playwright's driver may retain handles after closing the browser. This
    // worker has finished cleanup; exiting makes the independent Job guard
    // close every remaining owned handle before the host releases its lock.
    reply(result);
  } catch { reply({ status: 'blocked', steps: [], error: '검증 실행기가 종료됐습니다' }, 1); }
  finally { clearTimeout(timer); }
});
