import { useEffect, useState } from 'react';
import { isAiWorking } from '../components/AiActivity';

type WorkActivity = { sourceId: string; changeName: string; state: string };

export function useAiActivity() {
  const [work, setWork] = useState<WorkActivity[] | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const refresh = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/api/work', { signal: controller.signal });
        if (!response.ok) throw new Error('Activity unavailable');
        const data = await response.json();
        if (!Array.isArray(data.work)) throw new Error('Invalid activity');
        if (!stopped) setWork(data.work);
      } catch { if (!stopped) setWork(null); }
      finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  const count = work?.filter(item => isAiWorking(item.state)).length || 0;
  const state = work === null ? undefined : count ? 'running' : work.find(item => ['waiting-input', 'waiting-approval', 'recovery-required', 'failed'].includes(item.state))?.state || 'idle';
  const byChange = new Map(work?.map(item => [`${item.sourceId}/${item.changeName}`, item.state]));
  return { state, count, byChange };
}
