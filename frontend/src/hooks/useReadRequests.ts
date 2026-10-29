import { useCallback, useEffect, useRef } from 'react';

/** Only for read requests. Cancellation does not stop or classify server work. */
export function useReadRequests() {
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => { const active = controllers.current; return () => { for (const controller of active) controller.abort(); active.clear(); }; }, []);
  return useCallback(async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try { return await run(controller.signal); }
    finally { clearTimeout(timer); controllers.current.delete(controller); }
  }, []);
}
