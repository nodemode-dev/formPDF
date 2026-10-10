import { api } from '../io/api';
import { el, escapeHtml } from './dom';

export interface SessionDoc { id: string; key: string; name: string; page: number; tab: string; dirty: boolean; pages?: number }
export interface Restore { page: number; tab: string; dirty: boolean }

export async function offerResume(sub: HTMLElement, reopen: (id: string, restore: Restore) => void): Promise<void> {
  let s: { doc: SessionDoc | null; recover?: boolean };
  try { s = await api.get('/api/session'); } catch { return; }
  const d = s.doc;
  if (!d) return;
  const original = Array.from(sub.childNodes);
  const name = escapeHtml(d.name || 'your PDF');
  const line = el(`<span class="fs-home-resume">${s.recover
    ? `formpdf closed with unsaved changes in <b>${name}</b>. <button type="button" data-r="open">Reopen them</button> · <button type="button" data-r="drop">Discard</button>`
    : `Pick up where you left off: <b>${name}</b>. <button type="button" data-r="open">Reopen</button> · <button type="button" data-r="drop">Dismiss</button>`}</span>`);
  sub.replaceChildren(line);
  const restoreText = (): void => { sub.replaceChildren(...original); };
  line.addEventListener('click', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')?.dataset.r;
    if (r === 'open') { restoreText(); reopen(d.id, { page: d.page || 1, tab: d.tab || 'view', dirty: !!s.recover }); }
    else if (r === 'drop') { restoreText(); void api.post('/api/session/dismiss').catch(() => undefined); }
  });
}
