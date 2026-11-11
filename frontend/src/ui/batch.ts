import { api } from '../io/api';
import { deliver } from '../pdf/api';
import { promptName } from './dialogs';
import { enhanceSelect } from './dropdown';
import { el, escapeHtml, patchList, q, setClass, setDisabled, setHidden, setText } from './dom';
import { icon } from './icons';
import { toast } from './toast';

export interface ActionField { name: string; label: string; type: string; default: unknown; options: string[]; hint: string }
export interface ActionInfo { name: string; kind: string; label: string; words: string[]; ext: string; batch: boolean; fields: ActionField[] }
interface Item { key: string; name: string; path: string; bytes: number; state: 'uploading' | 'ready' | 'waiting' | 'running' | 'done' | 'failed'; text: string; outputs: string[]; note?: string }
interface JobRow { key: string; name: string; state: Item['state']; text: string; outputs: string[]; note?: string }
interface Job { id: string; state: string; done: number; total: number; out: string; rows: JobRow[] }

const STATE_LABEL: Record<Item['state'], string> = { uploading: 'Adding…', ready: 'Ready', waiting: 'Waiting', running: 'Working…', done: 'Done', failed: 'Failed' };
const size = (n: number): string => (n <= 0 ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
let seq = 0;

function fieldHtml(action: string, f: ActionField): string {
  const id = `bf-${action}-${f.name.replace(/\W/g, '-')}`;
  const hint = f.hint ? `<span class="fs-note">${escapeHtml(f.hint)}</span>` : '';
  const def = f.default;
  if (f.type === 'bool') return `<label class="fs-check"><input type="checkbox" data-f="${escapeHtml(f.name)}" data-t="bool"${def ? ' checked' : ''}>${escapeHtml(f.label)}</label>`;
  if (f.type === 'multi') {
    const on = Array.isArray(def) ? (def as string[]) : [];
    return `<div class="fs-field is-stack" data-f="${escapeHtml(f.name)}" data-t="multi"><span>${escapeHtml(f.label)}</span><div class="fs-batch-checks">${f.options.map((o) => `<label class="fs-check"><input type="checkbox" value="${escapeHtml(o)}"${on.includes(o) ? ' checked' : ''}>${escapeHtml(o.replace(/_/g, ' '))}</label>`).join('')}</div>${hint}</div>`;
  }
  if (f.type === 'select') return `<label class="fs-field is-stack"><span>${escapeHtml(f.label)}</span><select class="fs-batch-select" id="${id}" data-f="${escapeHtml(f.name)}" data-t="select" aria-label="${escapeHtml(f.label)}">${f.options.map((o) => `<option value="${escapeHtml(o)}"${o === def ? ' selected' : ''}>${escapeHtml(o.replace(/[-_]/g, ' '))}</option>`).join('')}</select>${hint}</label>`;
  const type = f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : f.type === 'color' ? 'color' : 'text';
  const value = Array.isArray(def) ? def.join(', ') : def === null || def === undefined ? '' : String(def);
  return `<label class="fs-field is-stack"><span>${escapeHtml(f.label)}</span><input class="fs-input" type="${type}" data-f="${escapeHtml(f.name)}" data-t="${escapeHtml(f.type)}" value="${escapeHtml(value)}" spellcheck="false"${type === 'number' ? ' step="any"' : ''}>${hint}</label>`;
}

export class Batch {
  readonly root: HTMLElement;
  private items: Item[] = [];
  private actions: ActionInfo[] = [];
  private job: Job | null = null;
  private timer = 0;
  private readonly list: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly groups: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly zipBtn: HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root = el(`<div class="fs-batch">
<div class="fs-home-head"><div><h1 class="fs-home-title">Batch</h1><p class="fs-home-sub">Run one action on many PDFs. The PDFs you add are not changed; every result goes into a new folder in Formpdf/Exports.</p></div></div>
<div class="fs-batch-grid">
<section class="fs-batch-card fs-batch-files" aria-label="Files">
<div class="fs-batch-card-head"><h2 class="fs-home-section-title">Files <span class="fs-badge is-count fs-batch-count">0</span></h2><div class="fs-batch-head-btns"><button class="fs-btn fs-btn-sm" type="button" data-b="add">${icon('folderOpen', 14)}Add PDFs…</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-b="path">Add by path…</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-b="clear">Clear</button></div></div>
<div class="fs-batch-list" role="list"></div>
<div class="fs-empty fs-batch-empty"><span class="fs-empty-icon">${icon('upload', 18)}</span><span class="fs-empty-title">Drop PDFs here</span><span class="fs-empty-note">Or add them with the buttons above. They run in the order listed.</span></div>
</section>
<section class="fs-batch-card fs-batch-action" aria-label="Action">
<label class="fs-field is-stack"><span>Action</span><select class="fs-batch-action-select" aria-label="Action"></select></label>
<div class="fs-batch-groups"></div>
<div class="fs-batch-run"><button class="fs-btn fs-btn-primary" type="button" data-b="run">${icon('play', 14)}Run on all files</button><span class="fs-batch-progress" aria-live="polite"></span></div>
<div class="fs-batch-result"><span class="fs-note fs-batch-out">Results appear in a new folder.</span><button class="fs-btn fs-btn-sm" type="button" data-b="zip" disabled>${icon('download', 14)}Download all</button></div>
</section></div></div>`);
    host.appendChild(this.root);
    this.list = q(this.root, '.fs-batch-list');
    this.select = q<HTMLSelectElement>(this.root, '.fs-batch-action-select');
    enhanceSelect(this.select, { search: 'Find an action' });
    this.groups = q(this.root, '.fs-batch-groups');
    this.runBtn = q<HTMLButtonElement>(this.root, '[data-b="run"]');
    this.zipBtn = q<HTMLButtonElement>(this.root, '[data-b="zip"]');
    this.wire();
    this.sync();
    void this.load();
  }

  private wire(): void {
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = (t.closest('[data-b]') as HTMLElement | null)?.dataset.b;
      if (b === 'add') this.pick();
      else if (b === 'path') void promptName('Add a PDF by path', '', 'Add').then((p) => { if (p) this.addPath(p); });
      else if (b === 'clear') { if (!this.busy) { this.items = []; this.sync(); } }
      else if (b === 'run') void this.run();
      else if (b === 'zip' && this.job) void this.download();
      else if (b === 'remove') { const k = t.closest<HTMLElement>('[data-key]')?.dataset.key; if (k && !this.busy) { this.items = this.items.filter((i) => i.key !== k); this.sync(); } }
    });
    this.select.addEventListener('change', () => this.showGroup());
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setClass(this.root, 'is-drag-over', true); } });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget as Node | null)) setClass(this.root, 'is-drag-over', false); });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setClass(this.root, 'is-drag-over', false);
      this.addFiles(Array.from(e.dataTransfer?.files ?? []));
    });
  }

  private get busy(): boolean { return this.job?.state === 'running'; }

  private async load(): Promise<void> {
    try { this.actions = (await api.get<{ actions: ActionInfo[] }>('/api/pdf/actions')).actions.filter((a) => a.batch); } catch { this.actions = []; }
    for (const a of this.actions) {
      const opt = document.createElement('option');
      opt.value = a.name;
      opt.textContent = a.label;
      this.select.appendChild(opt);
      const g = el(`<div class="fs-batch-group" data-g="${escapeHtml(a.name)}" hidden>${a.fields.map((f) => fieldHtml(a.name, f)).join('') || '<p class="fs-note">This action has nothing to set.</p>'}</div>`);
      this.groups.appendChild(g);
      for (const s of Array.from(g.querySelectorAll<HTMLSelectElement>('select'))) enhanceSelect(s);
    }
    const first = this.actions.find((a) => a.name === 'page_numbers') ?? this.actions[0];
    if (first) this.select.value = first.name;
    this.showGroup();
  }

  private showGroup(): void {
    for (const g of Array.from(this.groups.children) as HTMLElement[]) setHidden(g, g.dataset.g !== this.select.value);
    this.sync();
  }

  private pick(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.multiple = true;
    input.onchange = () => this.addFiles(Array.from(input.files ?? []));
    input.click();
  }

  private addFiles(files: File[]): void {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (files.length && !pdfs.length) { toast('Batch takes PDF files'); return; }
    if (this.busy) return;
    if (this.job) this.reset();
    for (const f of pdfs) {
      const it: Item = { key: `b${++seq}`, name: f.name, path: '', bytes: f.size, state: 'uploading', text: '', outputs: [] };
      this.items.push(it);
      const fd = new FormData();
      fd.append('file', f, f.name);
      void fetch('/api/batch/upload', { method: 'POST', body: fd }).then(async (r) => {
        const body = await r.json() as { path?: string; detail?: string };
        if (!r.ok || !body.path) throw new Error(body.detail ?? r.statusText);
        it.path = body.path;
        it.state = 'ready';
      }).catch((err: Error) => { it.state = 'failed'; it.text = err.message; }).finally(() => this.sync());
    }
    this.sync();
  }

  private addPath(p: string): void {
    if (this.busy) return;
    if (this.job) this.reset();
    const name = p.split(/[\\/]/).pop() ?? p;
    this.items.push({ key: `b${++seq}`, name, path: p, bytes: 0, state: 'ready', text: p, outputs: [] });
    this.sync();
  }

  private reset(): void {
    this.job = null;
    for (const it of this.items) if (it.path) { it.state = 'ready'; it.text = it.bytes ? '' : it.path; it.outputs = []; }
  }

  private args(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const g = this.groups.querySelector<HTMLElement>(`[data-g="${CSS.escape(this.select.value)}"]`);
    if (!g) return out;
    for (const n of Array.from(g.querySelectorAll<HTMLElement>('[data-f]'))) {
      const name = n.dataset.f as string, t = n.dataset.t;
      if (t === 'multi') out[name] = Array.from(n.querySelectorAll<HTMLInputElement>('input:checked')).map((i) => i.value);
      else if (t === 'bool') out[name] = (n as HTMLInputElement).checked;
      else if (t === 'number') { const v = (n as HTMLInputElement).value.trim(); if (v) out[name] = Number(v); }
      else if (t === 'list') out[name] = (n as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
      else out[name] = (n as HTMLInputElement | HTMLSelectElement).value;
    }
    return out;
  }

  private async run(): Promise<void> {
    const ready = this.items.filter((i) => i.path && i.state !== 'uploading');
    if (!ready.length || this.busy) return;
    try {
      const res = await api.post<{ id: string; out: string; total: number }>('/api/batch/run', { action: this.select.value, args: this.args(), paths: ready.map((i) => i.path) });
      this.job = { id: res.id, state: 'running', done: 0, total: res.total, out: res.out, rows: [] };
      for (const it of ready) { it.state = 'waiting'; it.text = ''; it.outputs = []; it.note = undefined; }
      this.sync();
      this.poll(ready);
    } catch (err) { toast((err as Error).message, 'error'); }
  }

  private poll(ready: Item[]): void {
    window.clearTimeout(this.timer);
    const job = this.job;
    if (!job) return;
    void api.get<Job>(`/api/batch/${job.id}`).then((j) => {
      if (this.job?.id !== j.id) return;
      this.job = j;
      j.rows.forEach((r, i) => { const it = ready[i]; if (it) { it.state = r.state; it.text = r.text; it.outputs = r.outputs; it.note = r.note; } });
      this.sync();
      if (j.state === 'running') this.timer = window.setTimeout(() => this.poll(ready), 500);
      else toast(`Batch finished: ${j.rows.filter((r) => r.state === 'done').length} of ${j.total} done`);
    }).catch(() => { this.timer = window.setTimeout(() => this.poll(ready), 1500); });
  }

  private async download(): Promise<void> {
    if (!this.job) return;
    const r = await fetch(`/api/batch/${this.job.id}/zip`);
    if (!r.ok) { toast('The batch wrote no files', 'error'); return; }
    await deliver(await r.blob(), `${this.select.selectedOptions[0]?.textContent ?? 'Batch'} batch.zip`);
  }

  private sync(): void {
    setText(q(this.root, '.fs-batch-count'), String(this.items.length));
    setHidden(q(this.root, '.fs-batch-empty'), this.items.length > 0);
    const fill = (n: HTMLElement, it: Item): void => {
      setText(q(n, '.fs-batch-name'), it.name);
      setText(q(n, '.fs-batch-state'), STATE_LABEL[it.state]);
      setText(q(n, '.fs-batch-text'), it.state === 'done' && it.note ? it.note : it.state === 'done' && it.outputs[0] ? (it.outputs.length > 1 ? `${it.outputs.length} files` : it.outputs[0].split(/[\\/]/).pop() ?? '') : it.text || size(it.bytes));
      n.title = it.outputs[0] ?? it.text ?? it.name;
      for (const s of ['done', 'failed', 'running']) setClass(n, `is-${s}`, it.state === s);
    };
    patchList(this.list, this.items, {
      key: (it) => it.key,
      create: (it) => { const n = el(`<div class="fs-batch-row" role="listitem"><span class="fs-batch-name"></span><span class="fs-batch-state"></span><span class="fs-batch-text"></span><button class="fs-icon-btn is-sm" type="button" data-b="remove" title="Remove" aria-label="Remove from the batch">${icon('close', 12)}</button></div>`); fill(n, it); return n; },
      update: fill,
    });
    const ready = this.items.filter((i) => i.path && i.state !== 'uploading').length;
    const uploading = this.items.some((i) => i.state === 'uploading');
    setDisabled(this.runBtn, !ready || uploading || this.busy || !this.select.value);
    const j = this.job;
    setText(q(this.root, '.fs-batch-progress'), j ? (j.state === 'running' ? `${j.done} of ${j.total} done` : `Finished: ${j.rows.filter((r) => r.state === 'done').length} of ${j.total} done`) : uploading ? 'Adding files…' : ready ? `${ready} PDF${ready === 1 ? '' : 's'} ready` : '');
    setText(q(this.root, '.fs-batch-out'), j ? j.out : 'Results appear in a new folder.');
    setDisabled(this.zipBtn, !j || j.state === 'running' || !j.rows.some((r) => r.outputs.length));
  }
}
