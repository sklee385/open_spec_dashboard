export class ProjectApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) { super(String(data.error ?? data.message ?? status)); this.status = status; this.data = data; }
}
export async function projectApi<T>(sourceId: string, endpoint: string, body?: unknown, method = 'POST', workId?: string | null): Promise<T> {
  const scope = workId ? `${endpoint.includes('?') ? '&' : '?'}${new URLSearchParams({ workId })}` : '';
  const response = await fetch(`/api/projects/${encodeURIComponent(sourceId)}${endpoint}${scope}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new ProjectApiError(response.status, data);
  return data as T;
}
export const projectQuery = (values: Record<string, string | undefined>) => { const query = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value !== undefined) query.set(key, value); }); return `?${query}`; };
