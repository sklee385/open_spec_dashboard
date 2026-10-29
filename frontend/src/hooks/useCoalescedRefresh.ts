import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One read cycle plus at most one pending reload, using the latest callback. */
export function useCoalescedRefresh<Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) {
  const latest = useRef(run);
  useLayoutEffect(() => { latest.current = run; }, [run]);
  const [queue] = useState(() => {
    let pending: { args: Args; generation: number } | null = null, running = false, generation = 0;
    let waiters: { generation: number; resolve: (value: Result) => void; reject: (error: unknown) => void }[] = [];
    const drain = async () => {
      running = true;
      while (pending) {
        const next = pending; pending = null;
        let result!: Result, failure: unknown, failed = false;
        try { result = await latest.current(...next.args); }
        catch (error) { failed = true; failure = error; }
        const due = waiters.filter(waiter => !pending || waiter.generation <= next.generation);
        waiters = waiters.filter(waiter => !due.includes(waiter));
        for (const waiter of due) { if (failed) waiter.reject(failure); else waiter.resolve(result); }
      }
      running = false;
    };
    const request = (...args: Args): Promise<Result> => {
      const current = ++generation; pending = { args, generation: current };
      const promise = new Promise<Result>((resolve, reject) => { waiters.push({ generation: current, resolve, reject }); });
      if (!running) void drain();
      return promise;
    };
    return { request, cancelPending: () => { pending = null; } };
  });
  useEffect(() => () => queue.cancelPending(), [queue]);
  return queue.request;
}
