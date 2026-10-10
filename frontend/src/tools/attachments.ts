import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { el, patchList, q, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

interface FileItem { name: string; bytes: number | null; description: string }
interface PinItem extends FileItem { page: number; index: number; x: number; y: number; w: number; h: number }
interface Row { key: string; title: string; sub: string; pin?: PinItem; file?: FileItem }

const MAX = 200 * 1024 * 1024;
let rows: Row[] = [];
let loadedFor = '';
let loading = '';
let order: string[] = [];
let orderFor = '';

const size = (n: number | null): string => (n === null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function pick(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

function encode(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`${f.name} could not be read`));
    r.readAsDataURL(f);
  });
}

function render(root: HTMLElement): void {
  const fill = (n: HTMLElement, r: Row): void => { setText(q(n, '.fs-row-title'), r.title); setText(q(n, '.fs-row-sub'), r.sub); n.title = r.title; };
  patchList(q(root, '[data-t="list"]'), rows, {
    key: (r) => r.key,
    create: (r) => {
      const n = el(`<div class="fs-row fs-tool-row" data-t="pick"><span class="fs-row-icon">${icon(r.pin ? 'sticky' : 'fileText', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-tool-acts"><button class="fs-icon-btn is-sm" type="button" data-t="save" title="Save a copy" aria-label="Save a copy">${icon('download', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-t="remove" title="Remove from the PDF" aria-label="Remove from the PDF">${icon('delete', 14)}</button></span></div>`);
      fill(n, r);
      return n;
    },
    update: fill,
  });
  setText(q(root, '[data-t="count"]'), String(rows.length));
  setHidden(q(root, '[data-t="empty"]'), rows.length > 0 || loading !== '');
}

async function load(root: HTMLElement, host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) { rows = []; loadedFor = ''; render(root); return; }
  if (loadedFor === d.id || loading === d.id) return;
  loading = d.id;
  try {
    const got = await pdfApi.act<{ files: FileItem[]; pins: PinItem[] }>(d.id, 'attachments');
    if (host.doc()?.id !== d.id) return;
    const next: Row[] = [
      ...got.files.map((f) => ({ key: `f|${f.name}`, title: f.name, sub: [size(f.bytes), f.description].filter(Boolean).join(' · ') || 'Attached to the document', file: f })),
      ...got.pins.map((p) => ({ key: `p|${p.page}|${p.index}|${p.name}`, title: p.name, sub: `Pinned on page ${p.page}${p.bytes !== null ? ` · ${size(p.bytes)}` : ''}`, pin: p })),
    ];
    if (orderFor !== d.key) { order = []; orderFor = d.key; }
    const rank = new Map(order.map((k, i) => [k, i]));
    rows = next.map((r, i) => ({ r, k: rank.get(r.key) ?? order.length + i })).sort((a, b) => a.k - b.k).map((v) => v.r);
    order = rows.map((r) => r.key);
    loadedFor = d.id;
  } catch { rows = []; } finally { if (loading === d.id) loading = ''; }
  render(root);
}

async function change(host: ToolHost, body: Record<string, unknown>, label: string, busy: string): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.run(busy, async () => {
    try { await host.ctx.commit(await pdfApi.act<Derived>(d.id, 'edit_attachments', body), label); } catch (err) { toast((err as Error).message, 'error'); }
  });
}

async function payload(files: File[]): Promise<Array<{ name: string; data: string }> | null> {
  const big = files.find((f) => f.size > MAX);
  if (big) { toast(`${big.name} is larger than 200 MB`, 'error'); return null; }
  return Promise.all(files.map(async (f) => ({ name: f.name, data: await encode(f) })));
}

async function attachFiles(host: ToolHost): Promise<void> {
  const files = await pick(true);
  if (!files.length) return;
  const add = await payload(files);
  if (add) await change(host, { add }, files.length === 1 ? `Attach ${files[0].name}` : `Attach ${files.length} files`, 'Attaching');
}

async function pinFile(host: ToolHost): Promise<void> {
  const files = await pick(false);
  if (!files.length) return;
  const add = await payload(files);
  if (!add) return;
  host.setTab('edit');
  host.useTool({
    hint: `Click where the pin for ${files[0].name} goes. Esc cancels.`,
    down: (pv, p) => {
      host.useTool(null);
      const at = { page: pv.index + 1, x: Math.max(0, Math.min(pv.size.w - 20, p.x - 10)), y: Math.max(0, Math.min(pv.size.h - 20, p.y - 10)) };
      void change(host, { add: [{ ...add[0], ...at }] }, `Pin ${files[0].name}`, 'Pinning the file');
    },
  });
}

registerTool({
  id: 'attachments',
  tab: 'edit',
  title: 'Attached files',
  words: ['attach', 'attachment', 'embed file', 'paperclip', 'portfolio'],
  section: () => `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="attach">${icon('upload', 14)}Attach files…</button><button class="fs-btn fs-btn-sm" type="button" data-t="pin">${icon('sticky', 14)}Pin a file to the page…</button></div>
<p class="fs-note">Attached files travel inside the PDF. Remove hidden information can take them out again.</p>
<div class="fs-pdfwb-subhead">In this PDF <span class="fs-badge is-count" data-t="count">0</span></div>
<div class="fs-list fs-tool-list" data-t="list"></div>
<p class="fs-note" data-t="empty">No attached files.</p>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
      const d = host.doc();
      if (!t || !d) return;
      const r = rows.find((x) => x.key === t.closest<HTMLElement>('[data-key]')?.dataset.key);
      switch (t.dataset.t) {
        case 'attach': void attachFiles(host); break;
        case 'pin': void pinFile(host); break;
        case 'save': {
          if (!r) break;
          const qs = r.pin ? `page=${r.pin.page}&index=${r.pin.index}` : `name=${encodeURIComponent(r.title)}`;
          void fetch(`/api/pdf/${encodeURIComponent(d.id)}/attachment?${qs}`).then(async (res) => {
            if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? res.statusText);
            await host.ctx.deliver(await res.blob(), r.title);
          }).catch((err: Error) => toast(err.message, 'error'));
          break;
        }
        case 'remove':
          if (r) void change(host, r.pin ? { unpin: [{ page: r.pin.page, index: r.pin.index }] } : { remove: [r.title] }, `Remove ${r.title}`, 'Removing the file');
          break;
        case 'pick':
          if (r?.pin) { host.ctx.viewer.scrollToPoint(r.pin.page - 1, r.pin.x + 10, r.pin.y); host.ctx.annot.pulse(r.pin.page, [{ x: r.pin.x, y: r.pin.y, w: r.pin.w, h: r.pin.h }]); }
          break;
      }
    });
  },
  sync: (root, host) => { void load(root, host); },
  commands: (host) => [
    { id: 'tool-attach', label: 'Attach files…', words: ['attachment', 'embed'], enabled: () => !!host.doc(), run: () => void attachFiles(host) },
    { id: 'tool-attach-pin', label: 'Pin a file to the page…', words: ['file attachment comment', 'paperclip'], enabled: () => !!host.doc(), run: () => void pinFile(host) },
  ],
});
