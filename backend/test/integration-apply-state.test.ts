import { expect, it } from 'vitest';
import { applyProtocol, terminatedApply } from '../src/work/integration-apply-state';

function tuple() {
  const proof = { protocol: applyProtocol, state: 'job-quiescent', workerPid: 123, guardPid: 456, owner: 'owner', runGeneration: 'generation', attemptId: 'attempt', intentId: 'intent', at: '2026-10-30T00:00:00.000Z' };
  const row: any = { id: 'attempt', intentId: 'intent', owner: 'owner', runGeneration: 'generation', executionProtocol: applyProtocol, processTerminated: true, processId: 123, terminationProof: proof };
  const intent: any = { id: 'intent', owner: 'owner', runGeneration: 'generation', executionProtocol: applyProtocol, processTerminated: true, processId: 123, terminationProof: { ...proof } };
  return { row, intent };
}
it('일치한 quiescent tuple만 종료 근거로 인정한다', () => { const { row, intent } = tuple(); expect(terminatedApply(row, intent)).toBe(true); });
it('intent PID가 row와 다르면 종료 capability를 거부한다', () => { const { row, intent } = tuple(); intent.processId = 999; expect(terminatedApply(row, intent)).toBe(false); });
it('job-quiescent라도 worker PID가 없으면 종료 capability를 거부한다', () => {
  const { row, intent } = tuple(); delete row.processId; delete intent.processId; row.terminationProof.workerPid = null; intent.terminationProof.workerPid = null;
  expect(terminatedApply(row, intent)).toBe(false);
});
