import { afterEach, expect, it } from 'vitest';
import { EdgeBridge } from '../src/browser/edge-bridge';

const bridges: EdgeBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });
async function setup(options: { commandTimeoutMs?: number; codeTtlMs?: number; connectionTtlMs?: number } = {}) {
  const bridge = new EdgeBridge(options); bridges.push(bridge);
  const pair = await bridge.createPair('work-a');
  const request = async (path: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST', origin?: string) => {
    const response = await fetch(pair.endpoint + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const connect = () => request('/pair', { code: pair.code, tabId: 7, url: 'http://localhost:13001/page', title: 'Test' });
  return { bridge, pair, request, connect };
}
it('일회성 코드로 업무에 탭을 연결하고 코드·토큰을 상태에 노출하지 않는다', async () => {
  const { bridge, connect } = await setup();
  const first = await connect(); expect(first.status).toBe(200);
  expect(first.data).toMatchObject({ workId: 'work-a' }); expect(first.data.token.length).toBeGreaterThan(30);
  expect((await connect()).status).toBe(401);
  expect(bridge.status('work-a')).toMatchObject({ connected: true, tabId: 7, title: 'Test' });
  expect(JSON.stringify(bridge.status('work-a'))).not.toContain(first.data.token);
  expect(bridge.status('work-b').connected).toBe(false);
});
it('웹 페이지 Origin·인증 없는 명령·브라우저 내부 URL을 거부한다', async () => {
  const { pair, request } = await setup();
  expect((await request('/pair', { code: pair.code, tabId: 7, url: 'http://localhost/', title: 'X' }, undefined, 'POST', 'https://attacker.example')).status).toBe(403);
  expect((await request('/commands')).status).toBe(401);
  expect((await request('/pair', { code: pair.code, tabId: 7, url: 'edge://settings', title: 'X' })).status).toBe(400);
});
it('만료 코드와 연결을 거부한다', async () => {
  const { bridge, connect } = await setup({ codeTtlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 5)); expect((await connect()).status).toBe(401);
  const fresh = await setup({ connectionTtlMs: 1 }); await fresh.connect();
  await new Promise(resolve => setTimeout(resolve, 5)); expect(fresh.bridge.status('work-a').connected).toBe(false);
  expect(bridge.status('work-a').connected).toBe(false);
});
it('선택한 업무에만 명령을 전달하고 관찰·동작·중복 결과를 관리한다', async () => {
  const { bridge, connect, request } = await setup(); const { token } = (await connect()).data;
  await expect(bridge.execute('work-b', { op: 'observe' })).rejects.toThrow();
  const result = bridge.execute('work-a', { op: 'observe' });
  const { command } = (await request('/commands', undefined, token)).data;
  expect(command).toMatchObject({ op: 'observe', tabId: 7, expectedUrl: 'http://localhost:13001/page' });
  expect(command.expiresAt).toBeGreaterThan(Date.now());
  expect((await request(`/commands/${command.id}`, undefined, token)).data).toEqual({ valid: true });
  const observation = { observationId: 'o1', url: command.expectedUrl, title: 'Test', text: 'Button', elements: [{ id: 'e1', role: 'button', label: 'Go' }] };
  expect((await request('/results', { id: command.id, ok: true, result: observation }, token)).status).toBe(200);
  expect(await result).toEqual(observation);
  expect((await request('/results', { id: command.id, ok: true, result: observation }, token)).status).toBe(409);
  expect((await request(`/commands/${command.id}`, undefined, token)).status).toBe(409);
  await expect(bridge.execute('work-a', { op: 'click', observationId: 'stale', elementId: 'e1' })).rejects.toThrow();
  const action = bridge.execute('work-a', { op: 'click', observationId: 'o1', elementId: 'e1' });
  await expect(bridge.execute('work-a', { op: 'observe' })).rejects.toThrow();
  const next = (await request('/commands', undefined, token)).data.command;
  await request('/results', { id: next.id, ok: true, result: { url: command.expectedUrl } }, token); await action;
  await expect(bridge.execute('work-a', { op: 'click', observationId: 'o1', elementId: 'e1' })).rejects.toThrow();
});
it('취소·시간 초과 후 늦은 결과를 적용하지 않고 조작을 재전송하지 않는다', async () => {
  const { bridge, connect, request } = await setup({ commandTimeoutMs: 30 }); const { token } = (await connect()).data;
  const result = bridge.execute('work-a', { op: 'observe' }); const assertion = expect(result).rejects.toThrow(/시간/);
  const command = (await request('/commands', undefined, token)).data.command;
  await assertion;
  expect((await request('/results', { id: command.id, ok: true, result: {} }, token)).status).toBe(409);
  const pending = bridge.execute('work-a', { op: 'observe' }); const canceled = expect(pending).rejects.toThrow(/연결/);
  bridge.disconnect('work-a'); await canceled;
  expect((await request('/commands', undefined, token)).status).toBe(401);
});
it('전달 후 취소된 입력의 실행 권한을 회수하고 새 연결을 보존한다', async () => {
  const { bridge, connect, request, pair } = await setup(); const { token } = (await connect()).data;
  const pending = bridge.execute('work-a', { op: 'observe' }); const canceled = expect(pending).rejects.toThrow(/취소/);
  const command = (await request('/commands', undefined, token)).data.command;
  bridge.cancel('work-a'); await canceled;
  expect((await request(`/commands/${command.id}`, undefined, token)).status).toBe(409);
  const next = await bridge.createPair('work-a');
  const renewed = await fetch(pair.endpoint + '/pair', { method: 'POST', body: JSON.stringify({ code: next.code, tabId: 7, url: 'http://localhost:13001/new', title: 'New' }) });
  expect(renewed.status).toBe(200);
  expect((await request('/results', { id: command.id, ok: true, result: {} }, token)).status).toBe(401);
  expect(bridge.status('work-a')).toMatchObject({ connected: true, title: 'New' });
});
it('다른 사이트로 이동한 결과는 연결을 해제하고 수집하지 않는다', async () => {
  const { bridge, connect, request } = await setup(); const { token } = (await connect()).data;
  const result = bridge.execute('work-a', { op: 'observe' }); const assertion = expect(result).rejects.toThrow();
  const command = (await request('/commands', undefined, token)).data.command;
  await request('/results', { id: command.id, ok: true, result: { url: 'https://other.example/', observationId: 'o1', text: '', title: '', elements: [] } }, token);
  await assertion; expect(bridge.status('work-a').connected).toBe(false);
});
