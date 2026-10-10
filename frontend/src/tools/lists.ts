import { api } from '../io/api';
import { pdfApi, type Derived } from '../pdf/api';
import { isRecording, onRecording, recorded, startRecording, stopRecording, type Step } from '../pdf/recorder';
import { registerTool, type ToolHost } from '../pdf/tools';
import { confirmAction, Dialog, promptName } from '../ui/dialogs';
import { el, patchList, q, setClass, setDisabled, setText } from '../ui/dom';
import { toast } from '../ui/toast';

interface ActionList { id: string; name: string; description: string; steps: Step[]; builtin: boolean }
interface ActionInfo { name: string; label: string; kind: string }

let labels: Record<string, string> = {};

async function catalogue(): Promise<void> {
  if (Object.keys(labels).length) return;
  try {
    const got = await api.get<{ actions: ActionInfo[] }>('/api/pdf/actions');
    labels = Object.fromEntries(got.actions.map((a) => [a.name, a.label]));
  } catch { labels = {}; }
}

function summary(args: Record<string, unknown>): string {
  const bits = Object.entries(args).filter(([, v]) => v !== '' && v !== null && v !== undefined).slice(0, 4)
    .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 40)}`);
  return bits.join(', ');
}

class ListsDialog extends Dialog {
  private lists: ActionList[] = [];
  private chosen = '';
  private host: ToolHost | null = null;
  private readonly names: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly delBtn: HTMLButtonElement;

  constructor() {
    super('Action lists', 640);
    const box = el(`<div class="fs-lists"><div class="fs-list fs-lists-names" role="listbox" aria-label="Action lists" tabindex="0"></div>
<div class="fs-lists-main"><div class="fs-lists-title"></div><p class="fs-note fs-lists-desc"></p><ol class="fs-lists-steps"></ol>
<p class="fs-note fs-lists-help">Run a list on this PDF here, or on many files from Home > Batch with Run an action list. Record a new list by using the tools as usual.</p></div></div>`);
    this.body.appendChild(box);
    this.names = q(box, '.fs-lists-names');
    this.steps = q(box, '.fs-lists-steps');
    this.button('Record new…', 'ghost', () => { this.close(); if (this.host) record(this.host); }).classList.add('fs-btn-apart');
    this.delBtn = this.button('Delete', 'ghost', () => void this.remove());
    this.runBtn = this.button('Run on this PDF', 'primary', () => void this.run());
    this.names.addEventListener('click', (e) => {
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
      if (k) { this.chosen = k; this.sync(); }
    });
    this.names.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const at = this.lists.findIndex((l) => l.id === this.chosen);
      const next = this.lists[Math.max(0, Math.min(this.lists.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { this.chosen = next.id; this.sync(); }
    });
  }

  async show(host: ToolHost): Promise<void> {
    this.host = host;
    this.open(this.names);
    await this.load();
  }

  private async load(): Promise<void> {
    await catalogue();
    try { this.lists = (await api.get<{ lists: ActionList[] }>('/api/lists')).lists; } catch (err) { toast((err as Error).message, 'error'); this.lists = []; }
    if (!this.lists.some((l) => l.id === this.chosen)) this.chosen = this.lists[0]?.id ?? '';
    this.sync();
  }

  private sync(): void {
    const fill = (n: HTMLElement, l: ActionList): void => {
      setText(q(n, '.fs-row-title'), l.name);
      setText(q(n, '.fs-row-sub'), `${l.builtin ? 'Built in' : 'Yours'} · ${l.steps.length} step${l.steps.length === 1 ? '' : 's'}`);
      setClass(n, 'is-selected', l.id === this.chosen);
      n.setAttribute('aria-selected', String(l.id === this.chosen));
    };
    patchList(this.names, this.lists, {
      key: (l) => l.id,
      create: (l) => { const n = el('<div class="fs-row fs-tool-row" role="option"><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>'); fill(n, l); return n; },
      update: fill,
    });
    const l = this.lists.find((x) => x.id === this.chosen);
    setText(q(this.body, '.fs-lists-title'), l?.name ?? 'No list');
    setText(q(this.body, '.fs-lists-desc'), l?.description || (l ? 'Recorded in formpdf.' : ''));
    const steps = (l?.steps ?? []).map((s, i) => ({ s, i }));
    patchList(this.steps, steps, {
      key: (x) => `${this.chosen}|${x.i}`,
      create: (x) => el(`<li><span class="fs-lists-step"></span><span class="fs-note fs-lists-args"></span></li>`),
      update: () => undefined,
    });
    Array.from(this.steps.children).forEach((n, i) => {
      const st = steps[i]?.s;
      if (!st) return;
      setText(q(n as HTMLElement, '.fs-lists-step'), labels[st.action] ?? st.action);
      setText(q(n as HTMLElement, '.fs-lists-args'), summary(st.args));
    });
    setDisabled(this.runBtn, !l || !this.host?.doc());
    setDisabled(this.delBtn, !l || l.builtin);
  }

  private async run(): Promise<void> {
    const l = this.lists.find((x) => x.id === this.chosen), host = this.host, d = host?.doc();
    if (!l || !host || !d) return;
    this.close();
    await host.ctx.run(`Running ${l.name}`, async () => {
      try {
        const id = await host.ctx.flush() ?? d.id;
        const res = await pdfApi.act<Derived & { steps?: Array<{ label: string; ok: boolean; ms: number }> }>(id, 'run_list', { list: l.id });
        await host.ctx.commit(res, l.name);
        toast(`${l.name}: ${(res.steps ?? []).map((s) => s.label).join(', ')} done.`);
      } catch (err) { toast((err as Error).message, 'error'); }
    });
  }

  private async remove(): Promise<void> {
    const l = this.lists.find((x) => x.id === this.chosen);
    if (!l || l.builtin) return;
    if (!(await confirmAction('Delete action list', `Delete ${l.name}? This cannot be undone.`, 'Delete', true))) { this.open(this.names); return; }
    try { await fetch(`/api/lists/${encodeURIComponent(l.id)}`, { method: 'DELETE' }); } catch { toast('Could not delete the list', 'error'); }
    this.open(this.names);
    await this.load();
  }
}

let dlg: ListsDialog | null = null;
let stopWatch: (() => void) | null = null;

function barFor(host: ToolHost): void {
  const n = recorded().length;
  host.bar(`Recording an action list: ${n} step${n === 1 ? '' : 's'} so far. Use the tools as usual; each change you apply becomes a step.`, [
    { label: 'Stop and save…', kind: 'primary', run: () => void finish(host, true) },
    { label: 'Cancel', kind: 'ghost', run: () => void finish(host, false) },
  ]);
}

function record(host: ToolHost): void {
  if (isRecording()) return;
  startRecording();
  stopWatch = onRecording(() => { if (isRecording()) barFor(host); });
  barFor(host);
}

async function finish(host: ToolHost, keep: boolean): Promise<void> {
  const steps = stopRecording();
  stopWatch?.();
  stopWatch = null;
  host.hideBar();
  if (!keep) return;
  if (!steps.length) { toast('Nothing was recorded; apply a change while recording.', 'error'); return; }
  const name = await promptName('Save action list', '', 'Save');
  if (!name) return;
  try {
    await api.post('/api/lists', { name, steps });
    toast(`Saved ${name} with ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
  } catch (err) { toast((err as Error).message, 'error'); }
}

registerTool({
  id: 'action-lists',
  tab: 'view',
  words: ['action wizard', 'action list', 'workflow', 'macro', 'automate'],
  commands: (host) => [
    { id: 'tool-lists', label: 'Action lists…', words: ['action wizard', 'automate', 'workflow'], run: () => void (dlg ??= new ListsDialog()).show(host) },
    { id: 'tool-lists-record', label: 'Record an action list', words: ['record', 'macro'], enabled: () => !!host.doc() && !isRecording(), run: () => record(host) },
  ],
});
