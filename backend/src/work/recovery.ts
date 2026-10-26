import { ConflictException } from '@nestjs/common';
import { statSync } from 'node:fs';
import { FileResults } from './file-results';
import { Work, WorkStore } from './store';

export type RecoveryCode = 'legacy-workspace' | 'isolated-workspace' | 'workspace-unavailable' | 'project-unavailable' | 'thread-in-use' | 'session-restarted' | 'thread-unknown' | 'connection-failed' | 'busy' | 'completed';
export interface RecoveryStatus { required: boolean; canReconnect: boolean; code: RecoveryCode; mode: 'shared' | 'isolated'; }
const availableStates = ['recovery-required', 'idle', 'interrupted', 'failed'];

export class WorkRecovery {
  constructor(private store: WorkStore) {}
  private isolated(work: Work) { return !!work.executionPath || this.store.records(work.id, 'isolated-baseline').length > 0; }
  path(work: Work) {
    if (this.isolated(work)) return new FileResults(this.store).path(work);
    if (!statSync(work.projectPath).isDirectory()) throw new Error('프로젝트 폴더를 확인해 주세요');
    return work.projectPath;
  }
  status(work: Work): RecoveryStatus {
    const mode = this.isolated(work) ? 'isolated' : 'shared';
    const result = (code: RecoveryCode, canReconnect: boolean, required = work.state === 'recovery-required'): RecoveryStatus => ({ code, canReconnect, required, mode });
    if (['completed', 'archived'].includes(work.phase)) return result('completed', false, false);
    try { this.path(work); }
    catch { return result(mode === 'isolated' ? 'workspace-unavailable' : 'project-unavailable', false, true); }
    if (!availableStates.includes(work.state) || this.store.records(work.id, 'question').some(question => ['pending', 'sending', 'recovering', 'uncertain'].includes(question.status))) return result('busy', false);
    if (!work.threadId) return result('thread-unknown', false);
    if (work.errorCode === 'thread-in-use' || work.errorCode === 'session-restarted') return result(work.errorCode, true);
    return result(mode === 'isolated' ? 'isolated-workspace' : this.store.records(work.id, 'baseline').length || ['implementation', 'verification'].includes(work.phase) ? 'legacy-workspace' : 'connection-failed', true);
  }
  assertReconnect(work: Work) {
    const status = this.status(work);
    if (!status.canReconnect) throw new ConflictException({ message: recoveryMessages[status.code], errorCode: status.code });
    return status;
  }
}

const recoveryMessages: Record<RecoveryCode, string> = {
  'legacy-workspace': '기존 프로젝트에서 같은 대화를 복구할 수 있습니다',
  'isolated-workspace': '업무 전용 공간에서 같은 대화를 복구할 수 있습니다',
  'workspace-unavailable': '업무 전용 공간의 폴더와 식별 정보를 복원한 뒤 다시 시도해 주세요. 원본 프로젝트로 대체하지 않습니다.',
  'project-unavailable': '등록된 프로젝트 폴더를 복원한 뒤 다시 시도해 주세요.',
  'thread-unknown': '복구할 기존 대화가 없습니다. 새 대화를 자동 생성하지 않습니다.',
  'thread-in-use': '다른 Codex에서 해당 대화를 닫은 뒤 다시 시도해 주세요.',
  'session-restarted': '서버 재시작 후 같은 대화로 복구할 수 있습니다.',
  'connection-failed': '기존 대화 연결을 다시 시도해 주세요.',
  busy: '실행·연결 또는 질문·승인 응답을 마친 뒤 업무를 복구해 주세요.',
  completed: '완료·보관된 업무는 복구 대상으로 변경하지 않습니다.',
};
