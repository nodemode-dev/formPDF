import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { el, patchList, q, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { PageLayers, place } from './overlay';

interface LinkItem { page: number; index: number; x: number; y: number; w: number; h: number; kind: string; target: string }
interface Box { page: number; x: number; y: number; w: number; h: number }

let pending: Box | null = null;
let draft: Box | null = null;
let loadedFor = '';
let loading = '';
let items: LinkItem[] = [];
let order: string[] = [];
let orderFor = '';
let rootEl: HTMLElement | null = null;

const layers = new PageLayers('links', (index, layer) => {
  const box = draft ?? pending;
  let node = layer.querySelector<HTMLElement>('.fs-pdf-linkbox');
  if (!box || box.page !== index + 1) { if (node) node.hidden = true; return; }
  if (!node) { node = el('<div class="fs-pdf-linkbox"></div>'); layer.appendChild(node); }
  node.hidden = false;
  place(node, box.x, box.y, box.w, box.h);
});

function paintBox(): void { layers.repaint(); }

function syncForm(root: HTMLElement): void {
  const to = q<HTMLInputElement>(root, '[data-t="to"]');
  setDisabled(q<HTMLButtonElement>(root, '[data-t="add"]'), !pending || !to.value.trim());
  setDisabled(q<HTMLButtonElement>(root, '[data-t="clear"]'), !pending);
  setText(q(root, '[data-t="note"]'), pending ? `Box on page ${pending.page}. Type where it goes, then Add link.` : 'Draw a box over the words, then type a web address, an email address or a page number.');
}

function renderList(root: HTMLElement): void {
  const list = q(root, '[data-t="list"]');
  const fill = (n: HTMLElement, it: LinkItem): void => {
    setText(q(n, '.fs-row-title'), it.kind === 'page' ? `Page ${it.target}` : it.kind === 'uri' ? it.target.replace(/^mailto:/, '') : 'Other action');
    setText(q(n, '.fs-row-sub'), `On page ${it.page}`);
    n.title = it.target;
  };
  patchList(list, items, {
    key: (it) => `${it.page}|${it.index}|${it.target}`,
    create: (it) => {
      const n = el(`<div class="fs-row fs-tool-row" data-t="pick"><span class="fs-row-icon">${icon('link', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><button class="fs-icon-btn is-sm" type="button" data-t="remove" title="Remove link" aria-label="Remove link">${icon('delete', 14)}</button></div>`);
      fill(n, it);
      return n;
    },
    update: fill,
  });
  setText(q(root, '[data-t="count"]'), String(items.length));
  setHidden(q(root, '[data-t="empty"]'), items.length > 0 || loading !== '');
}

async function load(root: HTMLElement, host: ToolHost, force = false): Promise<void> {
  const d = host.doc();
  if (!d) { items = []; loadedFor = ''; renderList(root); return; }
  if (!force && (loadedFor === d.id || loading === d.id)) return;
  loading = d.id;
  try {
    const got = await pdfApi.act<{ links: LinkItem[] }>(d.id, 'links');
    if (host.doc()?.id !== d.id) return;
    if (orderFor !== d.key) { order = []; orderFor = d.key; }
    const key = (x: LinkItem): string => `${x.page}|${x.index}|${x.target}`;
    const rank = new Map(order.map((k, i) => [k, i]));
    items = got.links.map((x, i) => ({ x, r: rank.get(key(x)) ?? order.length + i })).sort((a, b) => a.r - b.r).map((v) => v.x);
    order = items.map(key);
    loadedFor = d.id;
  } catch { items = []; } finally { if (loading === d.id) loading = ''; }
  renderList(root);
}

function startDraw(host: ToolHost): void {
  host.setTab('edit');
  let p0: { x: number; y: number } | null = null;
  host.useTool({
    hint: 'Drag a box over the words the link covers. Esc ends.',
    down: (pv, p) => { p0 = p; draft = { page: pv.index + 1, x: p.x, y: p.y, w: 0, h: 0 }; paintBox(); },
    move: (pv, p) => {
      if (!p0 || !draft || draft.page !== pv.index + 1) return;
      draft = { page: draft.page, x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      paintBox();
    },
    up: () => {
      const b = draft;
      draft = null;
      p0 = null;
      if (b && b.w >= 4 && b.h >= 4) pending = b;
      paintBox();
      host.useTool(null);
      if (rootEl) { syncForm(rootEl); q<HTMLInputElement>(rootEl, '[data-t="to"]').focus(); }
    },
    cancel: () => { draft = null; p0 = null; paintBox(); },
  });
}

async function change(host: ToolHost, body: Record<string, unknown>, label: string, busy: string): Promise<boolean> {
  const d = host.doc();
  if (!d) return false;
  let ok = false;
  await host.ctx.run(busy, async () => {
    try {
      const res = await pdfApi.act<Derived & { added?: number; deleted?: number }>(d.id, 'edit_links', body);
      await host.ctx.commit(res, label);
      ok = true;
      if (label === 'Link web addresses') toast(`Linked ${res.added ?? 0} address${res.added === 1 ? '' : 'es'}`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  return ok;
}

registerTool({
  id: 'links',
  tab: 'edit',
  title: 'Links',
  words: ['link', 'hyperlink', 'url', 'web address', 'mailto', 'go to page'],
  section: () => `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="draw">${icon('link', 14)}Draw a link</button><button class="fs-btn fs-btn-sm" type="button" data-t="auto">Link web addresses</button></div>
<label class="fs-field is-stack fs-tool-field"><span>Goes to</span><input class="fs-input" type="text" data-t="to" placeholder="https://example.com, name@example.com or 12" spellcheck="false" aria-label="Where the link goes"></label>
<label class="fs-check"><input type="checkbox" data-t="border">Show a thin blue border</label>
<p class="fs-note fs-tool-note" data-t="note"></p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-t="add" disabled>Add link</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-t="clear" disabled>Clear box</button></div>
<div class="fs-pdfwb-subhead">In this PDF <span class="fs-badge is-count" data-t="count">0</span></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-t="list"></div><p class="fs-note fs-tool-empty" data-t="empty">No links yet.</p></div>`,
  mount: (root, host) => {
    rootEl = root;
    syncForm(root);
    const to = q<HTMLInputElement>(root, '[data-t="to"]');
    to.addEventListener('input', () => syncForm(root));
    to.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q<HTMLButtonElement>(root, '[data-t="add"]').click(); } });
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
      const border = q<HTMLInputElement>(root, '[data-t="border"]').checked;
      switch (t?.dataset.t) {
        case 'draw': startDraw(host); break;
        case 'auto': void change(host, { auto: true, border }, 'Link web addresses', 'Finding web addresses'); break;
        case 'clear': pending = null; paintBox(); syncForm(root); break;
        case 'add': {
          const box = pending;
          if (!box || !to.value.trim()) break;
          void change(host, { add: [{ ...box, to: to.value.trim() }], border }, 'Add link', 'Adding the link').then((ok) => { if (ok) { pending = null; to.value = ''; paintBox(); syncForm(root); } });
          break;
        }
        case 'remove': {
          const row = t.closest<HTMLElement>('[data-key]');
          const it = items.find((x) => `${x.page}|${x.index}|${x.target}` === row?.dataset.key);
          if (it) void change(host, { remove: [{ page: it.page, index: it.index }] }, 'Remove link', 'Removing the link');
          break;
        }
        case 'pick': {
          const row = t.closest<HTMLElement>('[data-key]');
          const it = items.find((x) => `${x.page}|${x.index}|${x.target}` === row?.dataset.key);
          if (it) { host.ctx.viewer.scrollToPoint(it.page - 1, it.x + it.w / 2, it.y); host.ctx.annot.pulse(it.page, [{ x: it.x, y: it.y, w: it.w, h: it.h }]); }
          break;
        }
      }
    });
  },
  sync: (root, host) => {
    const d = host.doc();
    if (!d && pending) { pending = null; paintBox(); }
    syncForm(root);
    void load(root, host);
  },
  page: (pv) => layers.mount(pv),
  commands: (host) => [
    { id: 'tool-link-draw', label: 'Draw a link…', words: ['add link', 'hyperlink'], enabled: () => !!host.doc(), run: () => startDraw(host) },
    { id: 'tool-link-auto', label: 'Link web and email addresses', words: ['auto link', 'urls', 'linkify'], enabled: () => !!host.doc(), run: () => { const b = rootEl ? q<HTMLInputElement>(rootEl, '[data-t="border"]').checked : false; void change(host, { auto: true, border: b }, 'Link web addresses', 'Finding web addresses'); } },
  ],
});
