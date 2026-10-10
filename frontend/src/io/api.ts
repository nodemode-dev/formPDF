async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    const body = await res.json().catch(() => ({})) as { detail?: string };
    if (body.detail) detail = body.detail;
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const post = <T>(url: string, body: unknown = {}): Promise<T> => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r));
const get = <T>(url: string): Promise<T> => fetch(url).then((r) => json<T>(r));

export const api = {
  health: () => get<{ ok: boolean; version: string }>('/api/health'),
  capabilities: () => get<Record<string, unknown>>('/api/capabilities'),
  settings: () => get<Record<string, unknown>>('/api/settings'),
  setSettings: (patch: Record<string, unknown>) => post<Record<string, unknown>>('/api/settings', patch),
  post,
  get,
};
