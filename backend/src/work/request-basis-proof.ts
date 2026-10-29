import { ConflictException } from '@nestjs/common';

/** One HTTP request owns this proof. Never serialize it or reuse it for replay. */
export class RequestBasisProof<T> {
  private constructor(readonly basis: T, private readonly stamp: string) {}
  private static stale() { return new ConflictException('후보 편집 중 업무·계획·검증·소유 근거가 변경되었습니다. 새 요청으로 확인해 주세요'); }
  static async create<T>(full: () => Promise<T>, read: () => Promise<string>) {
    const before = await read(), basis = await full();
    if (await read() !== before) throw this.stale();
    return new RequestBasisProof(basis, before);
  }
  async check(read: () => Promise<string>, fresh?: () => Promise<void>): Promise<T> {
    if (await read() !== this.stamp) throw RequestBasisProof.stale();
    if (fresh) {
      await fresh();
      if (await read() !== this.stamp) throw RequestBasisProof.stale();
    }
    return this.basis;
  }
}
