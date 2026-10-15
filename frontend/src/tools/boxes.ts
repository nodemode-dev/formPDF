import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { PageView } from '../pdf/viewer';
import { el, patchList, q, setDisabled, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { calc, PageLayers } from './overlay';

interface Rect { x: number; y: number; w: number; h: number; set: boolean }
interface PageBoxes { page: number; media: Rect; crop: Rect; bleed: Rect; trim: Rect; art: Rect }
type Shown = { key: 'trim' | 'bleed' | 'art'; r: Rect };

const SHOW_KEY = 'fs-boxes-show';
const MM = 72 / 25.4;
let hostRef: ToolHost | null = null;
let rootEl: HTMLElement | null = null;
let data: PageBoxes[] = [];
let dataFor = '';
let loading = '';
let show = ((): boolean => { try { return localStorage.getItem(SHOW_KEY) === '1'; } catch { return false; } })();

interface EdgeDrag { page: number; key: Shown['key']; edge: string; x0: number; y0: number; k: number; r0: Rect; r: Rect; id: number }
let edging: EdgeDrag | null = null;
const MIN_BOX = 18;

function shownBoxes(page: number): Shown[] {
  const b = data.find((x) => x.page === page);
  if (!b || !show) return [];
  const rel = (r: Rect): Rect => ({ ...r, x: r.x - b.crop.x, y: r.y - b.crop.y });
  const out: Shown[] = [];
  if (b.bleed.set) out.push({ key: 'bleed', r: rel(b.bleed) });
  out.push({ key: 'trim', r: rel(b.trim) });
  if (b.art.set) out.push({ key: 'art', r: rel(b.art) });
  const d = edging;
  return d && d.page === page ? out.map((s) => (s.key === d.key ? { ...s, r: d.r } : s)) : out;
}

const EDGES = ['n', 'e', 's', 'w'].map((e) => `<span class="fs-bx-h" data-e="${e}"></span>`).join('');

const layers = new PageLayers('boxes', (index, layer) => {
  if (!layer.dataset.bound) { layer.dataset.bound = '1'; bindEdges(layer, index + 1); }
  patchList(layer, shownBoxes(index + 1), {
    key: (s) => s.key,
    create: (s) => paint(el(`<div class="fs-bx fs-bx-${s.key}" data-bx="${s.key}"><span class="fs-bx-tag"></span>${EDGES}</div>`), s),
    update: (n, s) => { paint(n, s); },
  });
});

/** Dragging an edge of a box drawn on the page resizes that box; the change is written on release as one step. */
function bindEdges(layer: HTMLElement, page: number): void {
  layer.addEventListener('pointerdown', (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>('.fs-bx-h');
    const key = h?.closest<HTMLElement>('[data-bx]')?.dataset.bx as Shown['key'] | undefined;
    const s = key ? shownBoxes(page).find((x) => x.key === key) : undefined;
    if (!h || !key || !s || e.button !== 0 || !hostRef?.doc()) return;
    e.preventDefault();
    e.stopPropagation();
    const k = parseFloat(getComputedStyle(layer).getPropertyValue('--k')) || 1;
    edging = { page, key, edge: h.dataset.e ?? '', x0: e.clientX, y0: e.clientY, k, r0: { ...s.r }, r: { ...s.r }, id: e.pointerId };
    h.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    const d = edging;
    if (!d || d.page !== page || e.pointerId !== d.id) return;
    const b = data.find((x) => x.page === page);
    if (!b) return;
    const dx = (e.clientX - d.x0) / d.k, dy = (e.clientY - d.y0) / d.k;
    const mx0 = b.media.x - b.crop.x, my0 = b.media.y - b.crop.y, mx1 = mx0 + b.media.w, my1 = my0 + b.media.h;
    let { x, y, w, h } = d.r0;
    if (d.edge === 'w') { const nx = Math.min(Math.max(mx0, x + dx), x + w - MIN_BOX); w += x - nx; x = nx; }
    if (d.edge === 'e') w = Math.max(MIN_BOX, Math.min(mx1 - x, w + dx));
    if (d.edge === 'n') { const ny = Math.min(Math.max(my0, y + dy), y + h - MIN_BOX); h += y - ny; y = ny; }
    if (d.edge === 's') h = Math.max(MIN_BOX, Math.min(my1 - y, h + dy));
    d.r = { ...d.r, x, y, w, h };
    layers.repaint([page - 1]);
  });
  const end = (e: PointerEvent): void => {
    const d = edging;
    if (!d || d.page !== page || e.pointerId !== d.id) return;
    edging = null;
    const b = data.find((x) => x.page === page);
    const moved = Math.max(...(['x', 'y', 'w', 'h'] as const).map((k) => Math.abs(d.r[k] - d.r0[k])));
    if (!b || moved < 0.25 || e.type === 'pointercancel') { layers.repaint([page - 1]); return; }
    const r = { x: round(d.r.x + b.crop.x), y: round(d.r.y + b.crop.y), w: round(d.r.w), h: round(d.r.h) };
    void setBox(page, d.key, r);
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}

const round = (v: number): number => Math.round(v * 100) / 100;

async function setBox(page: number, key: Shown['key'], r: { x: number; y: number; w: number; h: number }): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d) return;
  await host.ctx.run('Setting page box', async () => {
    try {
      const res = await pdfApi.act<Derived>(d.id, 'edit_boxes', { pages: String(page), [key]: r });
      await host.ctx.commit(res, key === 'trim' ? 'Trim box' : key === 'bleed' ? 'Bleed box' : 'Art box');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  await load(host, true);
}

function paint(n: HTMLElement, s: Shown): HTMLElement {
  const style = `left:${calc(s.r.x)};top:${calc(s.r.y)};width:${calc(s.r.w)};height:${calc(s.r.h)}`;
  if (n.getAttribute('style') !== style) n.setAttribute('style', style);
  setText(q(n, '.fs-bx-tag'), s.key === 'trim' ? 'Trim' : s.key === 'bleed' ? 'Bleed' : 'Art');
  return n;
}

async function load(host: ToolHost, force = false): Promise<void> {
  const d = host.doc();
  if (!d) { data = []; dataFor = ''; return; }
  if (!force && (dataFor === d.id || loading === d.id)) return;
  loading = d.id;
  try {
    const got = await pdfApi.act<{ pages: PageBoxes[] }>(d.id, 'boxes', {});
    if (host.doc()?.id !== d.id) return;
    data = got.pages;
    dataFor = d.id;
    layers.repaint();
    sync();
  } catch (err) { toast((err as Error).message, 'error'); } finally { if (loading === d.id) loading = ''; }
}

function sync(): void {
  const root = rootEl, host = hostRef;
  if (!root || !host) return;
  const d = host.doc();
  const page = host.ctx.viewer.currentPage();
  const b = data.find((x) => x.page === page);
  const mm = (pt: number): string => (pt / MM).toFixed(1);
  if (!d || !b) setText(q(root, '[data-b="note"]'), d ? 'Reading the page boxes…' : 'Open a PDF to see its page boxes.');
  else {
    const bleed = b.bleed.set ? Math.max(0, Math.min(b.trim.x - b.bleed.x, b.trim.y - b.bleed.y)) : 0;
    setText(q(root, '[data-b="note"]'), `Page ${page}: trim ${mm(b.trim.w)} by ${mm(b.trim.h)} mm${b.trim.set ? '' : ' (no trim box: the visible page is used)'}, bleed ${bleed ? `${mm(bleed)} mm` : 'none'}${b.art.set ? ', art box set' : ''}.`);
  }
  const box = q<HTMLInputElement>(root, '[data-b="show"]');
  if (box.checked !== show) box.checked = show;
  for (const n of Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-b="add"], [data-b="clear"], [data-b="mm"]'))) setDisabled(n, !d);
}

async function addBleed(host: ToolHost, mm: number, pages = ''): Promise<unknown> {
  const d = host.doc();
  if (!d) throw new Error('Open a PDF first');
  if (!Number.isFinite(mm) || mm < 0 || mm > 50) throw new Error('Bleed is between 0 and 50 mm');
  let out: unknown = null;
  await host.ctx.run('Setting bleed', async () => {
    const res = await pdfApi.act<Derived & { changed: number }>(d.id, 'edit_boxes', { bleed_mm: mm, ...(pages ? { pages } : {}) });
    await host.ctx.commit(res, mm ? `Bleed ${mm} mm` : 'Bleed 0 mm');
    out = { bleed_mm: mm, changed: res.changed };
  });
  show = true;
  try { localStorage.setItem(SHOW_KEY, '1'); } catch { return out; }
  await load(host, true);
  return out;
}

async function clearBleed(host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.run('Removing bleed', async () => {
    try {
      const res = await pdfApi.act<Derived>(d.id, 'edit_boxes', { clear: ['bleed'] });
      await host.ctx.commit(res, 'Remove bleed boxes');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  await load(host, true);
}

function setShow(on: boolean): void {
  show = on;
  try { localStorage.setItem(SHOW_KEY, on ? '1' : '0'); } catch { show = on; }
  layers.repaint();
  sync();
}

registerTool({
  id: 'page-boxes',
  tab: 'print',
  title: 'Page boxes and bleed',
  words: ['bleed', 'trim', 'trim box', 'bleed box', 'art box', 'page boxes', 'crop marks', 'print production'],
  section: () => `<p class="fs-note fs-tool-note" data-b="note"></p>
<label class="fs-check"><input type="checkbox" data-b="show"><span>Show trim and bleed on the page</span></label>
<div class="fs-prop-row"><span class="fs-prop-label">Bleed</span><div class="fs-prop-ctl"><input class="fs-input" type="number" data-b="mm" min="0" max="50" step="0.5" value="3" aria-label="Bleed in millimetres"><span class="fs-unit">mm</span></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-b="add">${icon('maximize', 14)}Add bleed</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-b="clear">Remove bleed</button></div>
<p class="fs-note">Bleed grows the page around the trim so artwork can run past the edge; what you see on screen and everything placed on the page stay where they are. Drag an edge of a box on the page to change it.</p>`,
  mount: (root, host) => {
    rootEl = root;
    hostRef = host;
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-b]');
      if (!b || b.disabled) return;
      if (b.dataset.b === 'add') void addBleed(host, Number(q<HTMLInputElement>(root, '[data-b="mm"]').value)).catch((err) => toast((err as Error).message, 'error'));
      else if (b.dataset.b === 'clear') void clearBleed(host);
    });
    q<HTMLInputElement>(root, '[data-b="show"]').addEventListener('change', (e) => setShow((e.target as HTMLInputElement).checked));
    sync();
  },
  sync: (_root, host) => {
    hostRef = host;
    if (host.doc()?.id !== dataFor) void load(host);
    sync();
  },
  page: (pv: PageView) => layers.mount(pv),
  commands: (host) => [
    { id: 'tool-add-bleed', label: 'Add bleed…', words: ['bleed', 'print bleed', 'trim'], group: 'Print', when: 'Use when artwork must run past the trimmed edge of the printed page; give the bleed in millimetres.', params: { mm: { type: 'number', min: 0, max: 50, description: 'bleed in millimetres, default 3' }, pages: { type: 'string', description: 'pages such as 1-4; all pages when left out' } }, mutates: true, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: (p) => { host.setTab('print'); return addBleed(host, p?.mm === undefined ? 3 : Number(p.mm), typeof p?.pages === 'string' ? p.pages : ''); } },
    { id: 'tool-show-boxes', label: 'Show trim and bleed on the page', words: ['trim lines', 'bleed lines', 'page boxes'], group: 'View', checked: () => show, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: () => { setShow(!show); if (show) void load(host); return { show }; } },
  ],
});
