import { ConflictException, HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkStore } from './store';

// Only terminal receipts are durable. They never acquire a workspace/activity lock.
const active = new Map<string, number>();
interface AdmissionOptions { retry?: { context: string; basis: string; canRetry: () => boolean; pathFailure: (error: unknown) => boolean }; }
export class MutationAdmission {
  readonly id: string;
  private readonly activeKey: string;
  private generation: number;
  private retryToken?: string;
  constructor(private store: WorkStore, private workId: string, private operation: string, private requestKey: string, private fingerprint: string, private businessExists: () => boolean, private options: AdmissionOptions = {}) {
    this.id = `mutation-admission:${createHash('sha256').update(JSON.stringify([workId, operation, requestKey])).digest('hex')}`;
    const databases = store.db.prepare('PRAGMA database_list').all() as { file: string }[];
    this.activeKey = `${databases.find(row => row.file)?.file.toLowerCase()}:${this.id}`;
    this.generation = this.receipt()?.generation ?? 0;
  }
  private receipt() { return this.store.records(this.workId, 'mutation-admission').find(row => row.id === this.id); }
  /** Must be called inside the same transaction as the FIRST business reservation. */
  admit() {
    if (!this.store.db.isTransaction) throw new Error('mutation admission requires the business transaction');
    const previous = this.receipt();
    if (previous && !(this.retryToken && previous.status === 'rejected' && previous.generation === this.generation && previous.retryToken === this.retryToken && previous.fingerprint === this.fingerprint)) throw new ConflictException('같은 요청 키의 확정 기록이 있습니다. 새 기준과 명시 요청을 확인해 주세요.');
    this.store.record(this.id, this.workId, 'mutation-admission', { operation: this.operation, requestKey: this.requestKey, fingerprint: this.fingerprint, status: 'admitted', generation: this.generation });
    // The durable receipt, not this in-memory flag, decides commit/rollback ambiguity.
  }
  async run<T>(operation: (admission: MutationAdmission) => Promise<T>): Promise<T> {
    active.set(this.activeKey, (active.get(this.activeKey) ?? 0) + 1);
    try {
      const previous = this.receipt();
      if (previous) {
        const retry = this.options.retry;
        if (previous.status === 'rejected' && previous.fingerprint === this.fingerprint && previous.retryablePath === true && retry && previous.retryContext !== retry.context && previous.retryBasis === retry.basis && retry.canRetry() && !this.businessExists()) {
          this.store.transaction(() => {
            const current = this.receipt();
            if (JSON.stringify(current) !== JSON.stringify(previous) || this.businessExists() || !retry.canRetry()) throw new ConflictException('경로 재시도 확인 중 준비 상태가 변경되었습니다.');
            this.generation = previous.generation + 1; this.retryToken = randomUUID();
            this.store.record(this.id, this.workId, 'mutation-admission', { ...previous, generation: this.generation, retryToken: this.retryToken, retryContext: retry.context });
          });
        } else throw new ConflictException('같은 요청 키의 확정 기록이 있습니다. 새 기준과 명시 요청을 확인해 주세요.');
      }
      return await operation(this);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() < 400 || error.getStatus() >= 500 || (active.get(this.activeKey) ?? 0) > 1) throw error;
      let rejected = false;
      try {
        this.store.transaction(() => {
          const previous = this.receipt();
          if (this.businessExists() || previous && (previous.status !== 'rejected' || previous.fingerprint !== this.fingerprint || previous.generation !== this.generation)) return;
          const retry = this.options.retry, retryablePath = !!retry?.pathFailure(error);
          // Clearing retryToken fences a renewed handler before emitting another rejection.
          const retryEvidence = retry ? previous && !this.retryToken ? { retryablePath: previous.retryablePath === true, retryContext: previous.retryContext, retryBasis: previous.retryBasis } : { retryablePath, retryContext: retry.context, retryBasis: retry.basis } : {};
          this.store.record(this.id, this.workId, 'mutation-admission', { operation: this.operation, requestKey: this.requestKey, fingerprint: this.fingerprint, status: 'rejected', generation: this.generation, ...retryEvidence }); rejected = true;
        });
      } catch { /* A DB acknowledgement failure never proves a rejection. */ }
      if (!rejected) throw error;
      const response = error.getResponse();
      throw new HttpException({ ...(typeof response === 'string' ? { message: response } : response), mutationOutcome: 'rejected-before-intent', requestKey: this.requestKey }, error.getStatus());
    } finally {
      const count = (active.get(this.activeKey) ?? 1) - 1; if (count) active.set(this.activeKey, count); else active.delete(this.activeKey);
    }
  }
}
