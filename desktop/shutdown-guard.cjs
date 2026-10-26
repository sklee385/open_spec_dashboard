class ShutdownGuard {
  #lease;
  get active() { return this.#lease !== undefined; }
  acquire() {
    if (this.#lease) throw new Error('앱 종료 또는 업데이트 설치를 준비 중입니다. 잠시 후 다시 요청해 주세요.');
    this.#lease = Symbol('desktop-shutdown');
    return this.#lease;
  }
  owns(lease) { return lease !== undefined && lease === this.#lease; }
  release(lease) { if (this.owns(lease)) this.#lease = undefined; }
  assertOwner(lease) { if (!this.owns(lease)) throw new Error('앱 종료·설치 요청의 소유를 확인할 수 없습니다'); }
  async prepare({ gate, probe, api }) {
    const lease = this.acquire();
    const wasLocked = gate.locked;
    let requested = false;
    try {
      await probe();
      if (gate.pending) throw new Error('처리 중인 업무 요청이 있습니다. 잠시 후 다시 요청해 주세요.');
      gate.locked = true;
      requested = true;
      await api('prepare', 'POST');
      return lease;
    } catch (error) {
      if (requested) await this.cancel(lease, { gate, api }).catch(() => {});
      else { gate.locked = wasLocked; this.release(lease); }
      throw error;
    }
  }
  async cancel(lease, { gate, api }) {
    if (!this.owns(lease)) return;
    try { await api('cancel', 'POST'); gate.locked = false; }
    finally { this.release(lease); }
  }
}
module.exports = { ShutdownGuard };
