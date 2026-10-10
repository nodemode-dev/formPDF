import { alignMoves, type AlignHow } from '../pdf/align';
import { bounds, shifted, type PageTool } from '../pdf/annotate';
import { pdfApi, type Annot, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { PageView } from '../pdf/viewer';
import { el, patchList, q, setClass, setDisabled, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { calc, PageLayers } from './overlay';
import { plain, TextEditor, type Font, type Geo, type Para } from './richtext';

type Crop = { l: number; t: number; r: number; b: number };
interface Item { id: string; kind: 'text' | 'picture'; page: number; x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean; z: number; font?: Font; paras?: Para[]; crop?: Crop; iw?: number; ih?: number; merged?: boolean }
interface Pic { page: number; op: number; x: number; y: number; w: number; h: number; rot: number; flipV: boolean; iw: number; ih: number }
type Kind = 'text' | 'picture' | 'pic' | 'comment';
interface Obj { key: string; kind: Kind; page: number; g: Geo; item?: Item; pic?: Pic; annot?: Annot }
type Pt = { x: number; y: number };
interface Drag { kind: 'move' | 'resize' | 'rotate' | 'crop' | 'width'; page: number; p0: Pt; handle: string; base: Map<string, Geo>; crop0: Crop; moved: boolean }
type Mode = 'idle' | 'select' | 'text' | 'picture';

const NO_CROP: Crop = { l: 0, t: 0, r: 0, b: 0 };
const ALIGN_CMD = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' } as const;
const RUN_CMD: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough', sup: 'sup', sub: 'sub' };
const STATE_CMD: Record<string, string> = { b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough', sup: 'superscript', sub: 'subscript' };

let items: Item[] = [];
let pics: Pic[] = [];
let loadedFor = '';
const loaded = new Set<number>();
const queued = new Set<number>();
let flushing = false;
let sel: string[] = [];
let mode: Mode = 'idle';
let drag: Drag | null = null;
const preview = new Map<string, Geo>();
let cropping: string | null = null;
let cropDraft: Crop | null = null;
let font: Font = { family: 'sans', size: 12, color: '#111111', lineHeight: 1.25 };
let picture: { data: string; w: number; h: number; name: string } | null = null;
let lastDown = { t: 0, x: 0, y: 0, key: '' };
let rootEl: HTMLElement | null = null;
let hostRef: ToolHost | null = null;
const editor = new TextEditor();
let editing: { key: string | null; page: number; geo: Geo; font0: string; busy: boolean } | null = null;
const waiters = new Map<number, Array<() => void>>();

const rad = (d: number): number => (d * Math.PI) / 180;
const rot = (v: Pt, deg: number): Pt => { const r = rad(deg), c = Math.cos(r), s = Math.sin(r); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const geoOfItem = (it: Item): Geo => ({ x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot ?? 0 });

function bbox(g: Geo): { x: number; y: number; w: number; h: number } {
  const r = rad(g.rot), bw = g.w * Math.abs(Math.cos(r)) + g.h * Math.abs(Math.sin(r)), bh = g.w * Math.abs(Math.sin(r)) + g.h * Math.abs(Math.cos(r));
  return { x: g.x + g.w / 2 - bw / 2, y: g.y + g.h / 2 - bh / 2, w: bw, h: bh };
}

function inside(g: Geo, p: Pt, pad = 2): boolean {
  const l = rot({ x: p.x - (g.x + g.w / 2), y: p.y - (g.y + g.h / 2) }, -g.rot);
  return Math.abs(l.x) <= g.w / 2 + pad && Math.abs(l.y) <= g.h / 2 + pad;
}

export function recrop(g: Geo, flipH: boolean, flipV: boolean, old: Crop, c: Crop): Geo {
  const W = g.w / Math.max(0.01, 1 - old.l - old.r), H = g.h / Math.max(0.01, 1 - old.t - old.b);
  const nw = W * (1 - c.l - c.r), nh = H * (1 - c.t - c.b);
  let dx = (c.l - old.l) * W + nw / 2 - g.w / 2, dy = (c.t - old.t) * H + nh / 2 - g.h / 2;
  if (flipH) dx = -dx;
  if (flipV) dy = -dy;
  const d = rot({ x: dx, y: dy }, g.rot);
  const cx = g.x + g.w / 2 + d.x, cy = g.y + g.h / 2 + d.y;
  return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh, rot: g.rot };
}

function objects(page: number, host: ToolHost): Obj[] {
  const out: Obj[] = [];
  for (const p of pics) if (p.page === page) out.push({ key: `p:${p.page}:${p.op}`, kind: 'pic', page, g: { x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot }, pic: p });
  for (const it of items.filter((x) => x.page === page).sort((a, b) => a.z - b.z)) out.push({ key: `i:${it.id}`, kind: it.kind, page, g: geoOfItem(it), item: it });
  if (mode === 'select') {
    for (const a of host.ctx.annot.items) if (a.page === page && a.kind !== 'reply') out.push({ key: `c:${a.id}`, kind: 'comment', page, g: { ...bounds(a), rot: 0 }, annot: a });
  }
  return out;
}

function allSelected(host: ToolHost): Obj[] {
  const pages = new Set<number>();
  for (const k of sel) {
    const it = k.startsWith('i:') ? items.find((x) => x.id === k.slice(2)) : null;
    const pic = k.startsWith('p:') ? pics.find((x) => `p:${x.page}:${x.op}` === k) : null;
    const a = k.startsWith('c:') ? host.ctx.annot.items.find((x) => x.id === k.slice(2)) : null;
    const page = it?.page ?? pic?.page ?? a?.page;
    if (page) pages.add(page);
  }
  const out: Obj[] = [];
  for (const p of pages) for (const o of objects(p, host)) if (sel.includes(o.key)) out.push(o);
  return out;
}

const geo = (o: Obj): Geo => preview.get(o.key) ?? o.g;

function handlesFor(o: Obj, single: boolean): string {
  if (!single || o.kind === 'comment') return '';
  if (cropping === o.key) return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="fs-cx-h is-crop" data-h="${h}"></span>`).join('');
  const list = o.kind === 'text' ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  return list.map((h) => `<span class="fs-cx-h" data-h="${h}"></span>`).join('') + '<span class="fs-cx-h is-rot" data-h="rot"></span>';
}

function paintBox(n: HTMLElement, o: Obj, single: boolean): void {
  const g = geo(o);
  const style = `left:${calc(g.x)};top:${calc(g.y)};width:${calc(g.w)};height:${calc(g.h)};transform:rotate(${Math.round(g.rot * 100) / 100}deg)`;
  if (n.getAttribute('style') !== style) n.setAttribute('style', style);
  setClass(n, 'is-selected', sel.includes(o.key));
  setClass(n, 'is-faint', !sel.includes(o.key));
  let html = sel.includes(o.key) ? handlesFor(o, single) : '';
  if (cropping === o.key && o.item) {
    const c = cropDraft ?? o.item.crop ?? NO_CROP, W = g.w / Math.max(0.01, 1 - c.l - c.r), H = g.h / Math.max(0.01, 1 - c.t - c.b);
    const fx = o.item.flipH ? -(c.r * W) : -(c.l * W), fy = o.item.flipV ? -(c.b * H) : -(c.t * H);
    html = `<span class="fs-cx-full" style="left:${calc(fx)};top:${calc(fy)};width:${calc(W)};height:${calc(H)}"></span>${html}`;
  }
  if (n.dataset.h !== html) { n.innerHTML = html; n.dataset.h = html; }
}

const layers = new PageLayers('content', (index, layer) => {
  const host = hostRef;
  const page = index + 1;
  if (host && mode !== 'idle' && !loaded.has(page)) want(page);
  const list = !host || mode === 'idle' ? [] : objects(page, host).filter((o) => sel.includes(o.key) || o.kind === 'text' || o.kind === 'picture' || o.kind === 'pic');
  const single = sel.length === 1;
  patchList(layer, list, {
    key: (o) => o.key,
    create: (o) => { const n = el('<div class="fs-cx-box"></div>'); paintBox(n, o, single); return n; },
    update: (n, o) => paintBox(n, o, single),
  });
});

function want(page: number): void {
  queued.add(page);
  if (flushing) return;
  flushing = true;
  queueMicrotask(() => void flush());
}

async function flush(): Promise<void> {
  const host = hostRef;
  const d = host?.doc();
  const pages = [...queued].filter((p) => !loaded.has(p)).sort((a, b) => a - b);
  queued.clear();
  if (!host || !d || !pages.length) { flushing = false; return; }
  for (const p of pages) loaded.add(p);
  try {
    const got = await pdfApi.act<{ items: Item[]; pictures: Pic[] }>(d.id, 'items', { pages: pages.join(',') });
    if (host.doc()?.id !== d.id) { flushing = false; return; }
    const set = new Set(pages);
    items = [...items.filter((x) => !set.has(x.page)), ...got.items];
    pics = [...pics.filter((x) => !set.has(x.page)), ...got.pictures];
    sel = sel.filter((k) => !k.startsWith('p:') || pics.some((x) => `p:${x.page}:${x.op}` === k));
  } catch { for (const p of pages) loaded.delete(p); }
  flushing = false;
  if (queued.size) want([...queued][0]);
  layers.repaint(pages.map((p) => p - 1));
  sync();
}

function reload(host: ToolHost): void {
  const d = host.doc();
  if (!d) { items = []; pics = []; loaded.clear(); loadedFor = ''; return; }
  if (loadedFor === d.id) return;
  const keep = [...loaded];
  if (loadedFor && d.key !== keyOf) { items = []; pics = []; sel = []; }
  loadedFor = d.id;
  keyOf = d.key;
  loaded.clear();
  for (const p of keep.length ? keep : [host.ctx.viewer.currentPage()]) want(p);
}
let keyOf = '';

function waitRender(page: number, ms = 5000): Promise<void> {
  return new Promise((resolve) => {
    const list = waiters.get(page - 1) ?? [];
    let done = false;
    const fin = (): void => { if (!done) { done = true; resolve(); } };
    list.push(fin);
    waiters.set(page - 1, list);
    window.setTimeout(fin, ms);
  });
}

async function act(host: ToolHost, body: Record<string, unknown>, label: string, busy: string, page?: number): Promise<(Derived & { ids?: string[]; converted?: Record<string, string> }) | null> {
  const d = host.doc();
  if (!d) return null;
  let out: (Derived & { ids?: string[]; converted?: Record<string, string> }) | null = null;
  await host.ctx.run(busy, async () => {
    try {
      const res = await pdfApi.act<Derived & { ids?: string[]; converted?: Record<string, string> }>(d.id, 'edit_items', body);
      const painted = page ? waitRender(page) : null;
      await host.ctx.commit(res, label);
      out = res;
      if (painted) await painted;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  return out;
}

function ref(o: Obj): Record<string, unknown> {
  return o.item ? { id: o.item.id, page: o.page } : { page: o.page, picture: o.pic?.op };
}

function adopt(changes: Map<string, Geo>, res: { converted?: Record<string, string> }, extra: Partial<Item> = {}): void {
  for (const [k, g] of changes) {
    if (k.startsWith('i:')) {
      const it = items.find((x) => x.id === k.slice(2));
      if (it) Object.assign(it, { x: g.x, y: g.y, w: g.w, h: it.kind === 'text' ? it.h : g.h, rot: g.rot }, extra);
    } else if (k.startsWith('p:')) {
      const id = res.converted?.[k.slice(2)];
      const p = pics.find((x) => `p:${x.page}:${x.op}` === k);
      if (!id || !p) continue;
      pics = pics.filter((x) => x !== p);
      items = [...items, { id, kind: 'picture', page: p.page, x: g.x, y: g.y, w: g.w, h: g.h, rot: g.rot, flipV: p.flipV, z: 0, crop: { ...NO_CROP }, ...extra }];
    }
  }
}

function remap(res: { converted?: Record<string, string> } | null): void {
  if (!res?.converted) return;
  sel = sel.map((k) => (k.startsWith('p:') && res.converted?.[k.slice(2)] ? `i:${res.converted[k.slice(2)]}` : k));
  if (cropping?.startsWith('p:') && res.converted[cropping.slice(2)]) cropping = `i:${res.converted[cropping.slice(2)]}`;
}

async function applyGeo(host: ToolHost, changes: Map<string, Geo>, label: string): Promise<void> {
  const objs = allSelected(host).filter((o) => changes.has(o.key));
  const updates: Array<Record<string, unknown>> = [];
  for (const o of objs) {
    const g = changes.get(o.key) as Geo;
    if (o.kind === 'comment' && o.annot) {
      host.ctx.annot.update(o.annot.id, shifted(o.annot, g.x - o.g.x, g.y - o.g.y), label);
    } else {
      const u: Record<string, unknown> = { ...ref(o), x: round(g.x), y: round(g.y), rot: round(g.rot) };
      if (o.kind !== 'text') { u.w = round(g.w); u.h = round(g.h); } else if (Math.abs(g.w - o.g.w) > 0.01) u.w = round(g.w);
      updates.push(u);
    }
  }
  if (updates.length) {
    const res = await act(host, { update: updates }, label, 'Moving', objs[0].page);
    if (res) adopt(changes, res);
    remap(res);
  }
  preview.clear();
  repaint();
}

const round = (v: number): number => Math.round(v * 100) / 100;

function repaint(): void { layers.repaint(); sync(); }

function pick(o: Obj | null, add: boolean): void {
  if (cropping && (!o || o.key !== cropping)) { cropping = null; cropDraft = null; }
  if (!o) { if (!add) sel = []; }
  else if (add) sel = sel.includes(o.key) ? sel.filter((k) => k !== o.key) : [...sel, o.key];
  else if (!sel.includes(o.key)) sel = [o.key];
  repaint();
}

function hit(page: number, p: Pt, host: ToolHost): Obj | null {
  const list = objects(page, host);
  const sorted = [...list.filter((o) => o.kind === 'comment'), ...list.filter((o) => o.kind === 'text' || o.kind === 'picture').reverse(), ...list.filter((o) => o.kind === 'pic').reverse()];
  return sorted.find((o) => inside(geo(o), p)) ?? null;
}

async function editText(host: ToolHost, o: Obj | null, page: number, g: Geo): Promise<void> {
  const d = host.doc();
  if (!d || editing) return;
  const pv = host.ctx.viewer.pages[page - 1];
  if (!pv) return;
  const it = o?.item;
  const f = it?.font ? { ...it.font } : { ...font };
  editing = { key: o?.key ?? null, page, geo: g, font0: JSON.stringify(f), busy: false };
  const size = host.ctx.viewer.sizes[page - 1] ?? { w: 612, h: 792 };
  const under = it ? `/api/pdf/${encodeURIComponent(d.id)}/items/under?page=${page}&id=${encodeURIComponent(it.id)}&scale=2` : null;
  await editor.show({ page: pv.space, geo: g, font: f, paras: it?.paras ?? [{ align: 'left', list: 'none', level: 0, runs: [{ t: '' }] }], under, pageW: size.w, pageH: size.h });
  sync();
}

async function finishEdit(host: ToolHost): Promise<void> {
  const e = editing;
  if (!e || e.busy) return;
  e.busy = true;
  const paras = editor.value();
  const f = { ...editor.font };
  const item = e.key ? items.find((x) => `i:${x.id}` === e.key) : undefined;
  const empty = !plain(paras).trim();
  const same = !editor.changed() && JSON.stringify(f) === e.font0;
  if ((same && item) || (empty && !item)) { editor.close(); editing = null; repaint(); return; }
  editor.freeze();
  let res: Awaited<ReturnType<typeof act>> = null;
  if (empty && item) res = await act(host, { remove: [{ id: item.id, page: item.page }] }, 'Delete page text', 'Deleting', e.page);
  else if (item) res = await act(host, { update: [{ id: item.id, page: item.page, font: f, paras }] }, 'Edit page text', 'Saving text', e.page);
  else res = await act(host, { add: [{ kind: 'text', page: e.page, x: round(e.geo.x), y: round(e.geo.y), w: round(e.geo.w), rot: 0, font: f, paras }] }, 'Add page text', 'Adding text', e.page);
  if (res?.ids?.length) sel = [`i:${res.ids[0]}`];
  editor.close();
  editing = null;
  repaint();
}

function selectTool(host: ToolHost): PageTool {
  return {
    hint: 'Click to select text and pictures, Shift-click to add more, drag to move. Double-click text to edit it. Esc ends.',
    down: (pv, p, e) => {
      const page = pv.index + 1;
      if (editing) { void finishEdit(host); return; }
      const t = e.target as HTMLElement;
      const handle = t.closest<HTMLElement>('[data-h]')?.dataset.h;
      const now = performance.now();
      const o = handle ? allSelected(host).find((x) => x.page === page) ?? null : hit(page, p, host);
      const dbl = !!o && o.key === lastDown.key && now - lastDown.t < 450 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
      lastDown = { t: now, x: e.clientX, y: e.clientY, key: o?.key ?? '' };
      if (dbl && o && o.kind === 'text') { sel = [o.key]; void editText(host, o, page, geo(o)); return; }
      if (dbl && o && (o.kind === 'picture' || o.kind === 'pic')) { startCrop(host, o.key); return; }
      if (!handle) pick(o, e.shiftKey);
      if (!o) return;
      const base = new Map<string, Geo>();
      for (const s of allSelected(host)) base.set(s.key, { ...geo(s) });
      const crop0 = (o.item?.crop ?? NO_CROP);
      const kind: Drag['kind'] = handle === 'rot' ? 'rotate' : handle ? (cropping === o.key ? 'crop' : o.kind === 'text' ? 'width' : 'resize') : 'move';
      if (!sel.includes(o.key)) return;
      drag = { kind, page, p0: p, handle: handle ?? '', base, crop0: { ...crop0 }, moved: false };
    },
    move: (pv, p, e) => {
      const d = drag;
      if (!d || pv.index + 1 !== d.page) return;
      const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      if (!d.moved && Math.hypot(dx, dy) < 1.5) return;
      d.moved = true;
      const key = sel[0];
      if (d.kind === 'move') {
        for (const [k, g] of d.base) preview.set(k, { ...g, x: g.x + dx, y: g.y + dy });
      } else if (d.kind === 'rotate') {
        const g = d.base.get(key);
        if (!g) return;
        const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
        let ang = g.rot + (Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.p0.y - c.y, d.p0.x - c.x)) * 180 / Math.PI;
        if (e.shiftKey) ang = Math.round(ang / 15) * 15;
        ang = ((ang + 180) % 360 + 360) % 360 - 180;
        preview.set(key, { ...g, rot: ang });
      } else if (d.kind === 'resize' || d.kind === 'width') {
        const g = d.base.get(key);
        if (!g) return;
        preview.set(key, resized(g, d.handle, rot({ x: dx, y: dy }, -g.rot), d.kind === 'resize' && /^(nw|ne|se|sw)$/.test(d.handle) && !e.shiftKey));
      } else if (d.kind === 'crop') {
        const o = allSelected(host).find((x) => x.key === key);
        const g = d.base.get(key);
        if (!o?.item || !g) return;
        cropDraft = cropped(g, o.item, d.crop0, d.handle, rot({ x: dx, y: dy }, -g.rot));
        preview.set(key, recrop(g, !!o.item.flipH, !!o.item.flipV, d.crop0, cropDraft));
      }
      layers.repaint([d.page - 1]);
    },
    up: () => {
      const d = drag;
      drag = null;
      if (!d || !d.moved) return;
      if (d.kind === 'crop') { repaint(); return; }
      const changes = new Map<string, Geo>();
      for (const [k, g] of preview) changes.set(k, g);
      void applyGeo(host, changes, d.kind === 'move' ? 'Move' : d.kind === 'rotate' ? 'Rotate' : 'Resize');
    },
    key: (e) => key(host, e),
    cancel: () => { drag = null; preview.clear(); if (editing) void finishEdit(host); cropping = null; cropDraft = null; mode = 'idle'; sel = []; repaint(); },
  };
}

function resized(g: Geo, h: string, d: Pt, keepAspect: boolean): Geo {
  const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0, sy = h.includes('s') ? 1 : h.startsWith('n') ? -1 : 0;
  let nw = sx ? Math.max(4, g.w + sx * d.x) : g.w, nh = sy ? Math.max(4, g.h + sy * d.y) : g.h;
  if (keepAspect && sx && sy) { const k = Math.max(nw / g.w, nh / g.h); nw = g.w * k; nh = g.h * k; }
  const cx = sx ? -sx * g.w / 2 + sx * nw / 2 : 0, cy = sy ? -sy * g.h / 2 + sy * nh / 2 : 0;
  const c = rot({ x: cx, y: cy }, g.rot);
  const mx = g.x + g.w / 2 + c.x, my = g.y + g.h / 2 + c.y;
  return { x: mx - nw / 2, y: my - nh / 2, w: nw, h: nh, rot: g.rot };
}

function cropped(g: Geo, it: Item, c0: Crop, h: string, d: Pt): Crop {
  const W = g.w / Math.max(0.01, 1 - c0.l - c0.r), H = g.h / Math.max(0.01, 1 - c0.t - c0.b);
  let dx = d.x / W, dy = d.y / H;
  if (it.flipH) dx = -dx;
  if (it.flipV) dy = -dy;
  const c = { ...c0 };
  const east = it.flipH ? h.includes('w') : h.includes('e'), west = it.flipH ? h.includes('e') : h.includes('w');
  const south = it.flipV ? h.startsWith('n') : h.includes('s'), north = it.flipV ? h.includes('s') : h.startsWith('n');
  if (west) c.l = c0.l + dx;
  if (east) c.r = c0.r - dx;
  if (north) c.t = c0.t + dy;
  if (south) c.b = c0.b - dy;
  for (const k of ['l', 't', 'r', 'b'] as const) c[k] = Math.max(0, Math.min(0.95, c[k]));
  if (c.l + c.r > 0.9) { if (west) c.l = 0.9 - c.r; else c.r = 0.9 - c.l; }
  if (c.t + c.b > 0.9) { if (north) c.t = 0.9 - c.b; else c.b = 0.9 - c.t; }
  return c;
}

function startCrop(host: ToolHost, key: string): void {
  sel = [key];
  cropping = key;
  const o = allSelected(host)[0];
  cropDraft = o?.item?.crop ? { ...o.item.crop } : { ...NO_CROP };
  repaint();
}

async function finishCrop(host: ToolHost, apply: boolean): Promise<void> {
  const key = cropping;
  const c = cropDraft;
  cropping = null;
  cropDraft = null;
  const o = key ? allSelected(host).find((x) => x.key === key) : null;
  if (!apply || !o || !c) { preview.clear(); repaint(); return; }
  const before = o.item?.crop ?? NO_CROP;
  if (['l', 't', 'r', 'b'].every((k) => Math.abs(before[k as keyof Crop] - c[k as keyof Crop]) < 1e-4)) { preview.clear(); repaint(); return; }
  const res = await act(host, { update: [{ ...ref(o), crop: { l: round4(c.l), t: round4(c.t), r: round4(c.r), b: round4(c.b) } }] }, 'Crop picture', 'Cropping', o.page);
  if (res) adopt(new Map([[o.key, recrop(o.g, !!o.item?.flipH, !!o.item?.flipV, before, c)]]), res, { crop: { ...c } });
  remap(res);
  preview.clear();
  repaint();
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function key(host: ToolHost, e: KeyboardEvent): boolean {
  if (editing) return false;
  if (e.key === 'Escape') {
    if (cropping) { void finishCrop(host, false); return true; }
    if (sel.length) { sel = []; repaint(); return true; }
    return false;
  }
  if (e.key === 'Enter' && cropping) { void finishCrop(host, true); return true; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { void remove(host); return true; }
  const step = e.shiftKey ? 10 : 1;
  const arrow: Record<string, Pt> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
  if (arrow[e.key] && sel.length) { void nudge(host, arrow[e.key]); return true; }
  if (e.key === 'Enter' && sel.length === 1) {
    const o = allSelected(host)[0];
    if (o?.kind === 'text') { void editText(host, o, o.page, geo(o)); return true; }
  }
  return false;
}

async function nudge(host: ToolHost, d: Pt): Promise<void> {
  const changes = new Map<string, Geo>();
  for (const o of allSelected(host)) changes.set(o.key, { ...o.g, x: o.g.x + d.x, y: o.g.y + d.y });
  for (const [k, g] of changes) preview.set(k, g);
  layers.repaint();
  await applyGeo(host, changes, 'Move');
}

async function remove(host: ToolHost): Promise<void> {
  const objs = allSelected(host);
  const engine = objs.filter((o) => o.kind === 'text' || o.kind === 'picture' || o.kind === 'pic').map(ref);
  for (const o of objs) {
    if (o.annot) host.ctx.annot.remove(o.annot.id);
  }
  sel = [];
  cropping = null;
  if (engine.length) await act(host, { remove: engine }, engine.length > 1 ? 'Delete page items' : 'Delete page item', 'Deleting');
  repaint();
}

async function arrange(host: ToolHost, to: 'front' | 'back' | 'forward' | 'backward'): Promise<void> {
  const objs = allSelected(host);
  const engine = objs.filter((o) => o.kind === 'text' || o.kind === 'picture' || o.kind === 'pic');
  const notes = objs.filter((o) => o.annot);
  if (notes.length) {
    const list = [...host.ctx.annot.items];
    for (const o of notes) {
      const i = list.findIndex((a) => a.id === o.annot?.id);
      if (i < 0) continue;
      const [a] = list.splice(i, 1);
      const same = list.map((x, k) => ({ x, k })).filter((v) => v.x.page === a.page);
      let at = i;
      if (to === 'front') at = list.length;
      else if (to === 'back') at = 0;
      else if (to === 'forward') at = (same.find((v) => v.k >= i)?.k ?? i - 1) + 1;
      else at = [...same].reverse().find((v) => v.k < i)?.k ?? i;
      list.splice(Math.max(0, Math.min(list.length, at)), 0, a);
    }
    host.ctx.annot.replace(list, 'Arrange comments');
  }
  if (engine.length) {
    const order = to === 'front' || to === 'backward' ? engine : [...engine].reverse();
    const res = await act(host, { arrange: order.map((o) => ({ ...ref(o), to })) }, 'Arrange', 'Arranging');
    remap(res);
  }
  repaint();
}

function align(host: ToolHost, how: AlignHow): void {
  const objs = allSelected(host);
  const page = objs[0]?.page;
  const list = objs.filter((o) => o.page === page);
  const moves = alignMoves(list.map((o) => ({ key: o.key, ...bbox(o.g) })), how);
  if (!moves.size) return;
  const changes = new Map<string, Geo>();
  for (const o of list) { const m = moves.get(o.key); if (m) changes.set(o.key, { ...o.g, x: o.g.x + m.dx, y: o.g.y + m.dy }); }
  for (const [k, g] of changes) preview.set(k, g);
  layers.repaint();
  void applyGeo(host, changes, how.startsWith('dist') ? 'Distribute' : 'Align');
}

async function pictureEdit(host: ToolHost, how: string): Promise<void> {
  const objs = allSelected(host).filter((o) => o.kind === 'picture' || o.kind === 'pic');
  if (!objs.length) return;
  if (how === 'crop') { if (cropping) await finishCrop(host, true); else startCrop(host, objs[0].key); return; }
  const updates = objs.map((o) => {
    const g = o.g;
    const u: Record<string, unknown> = { ...ref(o) };
    if (how === 'left' || how === 'right') u.rot = (((g.rot + (how === 'left' ? -90 : 90)) + 180) % 360 + 360) % 360 - 180;
    if (how === 'flipH') u.flipH = !o.item?.flipH;
    if (how === 'flipV') u.flipV = !(o.item?.flipV ?? o.pic?.flipV);
    if (how === 'uncrop') u.crop = NO_CROP;
    return u;
  });
  const res = await act(host, { update: updates }, how === 'uncrop' ? 'Reset crop' : how.startsWith('flip') ? 'Flip picture' : 'Rotate picture', 'Changing picture', objs[0].page);
  if (res && (how === 'left' || how === 'right')) adopt(new Map(objs.map((o, k) => [o.key, { ...o.g, rot: Number(updates[k].rot) }])), res);
  else if (res && how.startsWith('flip')) for (const [k, o] of objs.entries()) adopt(new Map([[o.key, o.g]]), res, how === 'flipH' ? { flipH: !!updates[k].flipH } : { flipV: !!updates[k].flipV });
  remap(res);
  repaint();
}

async function textFormat(host: ToolHost, what: string, value?: string): Promise<void> {
  if (editing) {
    if (what in RUN_CMD) editor.command(RUN_CMD[what]);
    else if (what === 'color') editor.command('foreColor', value);
    else if (what === 'align') editor.command(ALIGN_CMD[value as keyof typeof ALIGN_CMD]);
    else if (what === 'list') editor.setList(value as 'bullet' | 'number');
    else if (what === 'family' || what === 'size' || what === 'line') {
      if (what === 'family') editor.font.family = value as Font['family'];
      if (what === 'size') editor.font.size = Math.max(4, Math.min(288, Number(value) || 12));
      if (what === 'line') editor.font.lineHeight = Number(value) || 1.25;
      editor.style();
      editor.restore();
    }
    sync();
    return;
  }
  const texts = allSelected(host).filter((o) => o.kind === 'text' && o.item);
  if (!texts.length) {
    if (what === 'family') font.family = value as Font['family'];
    if (what === 'size') font.size = Math.max(4, Math.min(288, Number(value) || 12));
    if (what === 'color' && value) font.color = value;
    if (what === 'line') font.lineHeight = Number(value) || 1.25;
    sync();
    return;
  }
  const updates = texts.map((o) => {
    const it = o.item as Item;
    const f = { ...(it.font ?? font) };
    let paras = it.paras ?? [];
    if (what === 'family') f.family = value as Font['family'];
    else if (what === 'size') f.size = Math.max(4, Math.min(288, Number(value) || 12));
    else if (what === 'line') f.lineHeight = Number(value) || 1.25;
    else if (what === 'color' && value) { f.color = value; paras = paras.map((p) => ({ ...p, runs: p.runs.map((r) => { const { color: _c, ...rest } = r; return rest; }) })); }
    else if (what === 'align') paras = paras.map((p) => ({ ...p, align: value as Para['align'] }));
    else if (what === 'list') { const on = paras.every((p) => p.list === value); paras = paras.map((p) => ({ ...p, list: on ? 'none' : value as Para['list'] })); }
    else if (what in RUN_CMD) {
      const k = what as 'b' | 'i' | 'u' | 's' | 'sup' | 'sub';
      const on = paras.every((p) => p.runs.every((r) => !r.t.trim() || r[k]));
      paras = paras.map((p) => ({ ...p, runs: p.runs.map((r) => { const n = { ...r, [k]: !on }; if (!on && k === 'sup') n.sub = false; if (!on && k === 'sub') n.sup = false; return n; }) }));
    }
    return { id: it.id, page: it.page, font: f, paras };
  });
  await act(host, { update: updates }, 'Format page text', 'Formatting');
  repaint();
}

async function convertComment(host: ToolHost): Promise<void> {
  const notes = allSelected(host).filter((o) => o.annot && (o.annot.kind === 'freetext'));
  if (!notes.length) return;
  const adds = notes.map((o) => {
    const a = o.annot as Annot;
    return { kind: 'text', page: a.page, x: round((a.x ?? 0) + 2), y: round((a.y ?? 0) + 2), w: round(Math.max(20, (a.w ?? 120) + 6)), rot: 0,
      font: { family: 'sans', size: a.size ?? 12, color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#111111', lineHeight: 1.25 }, text: a.text ?? '' };
  });
  const res = await act(host, { add: adds }, 'Make page text', 'Making page text');
  if (!res) return;
  for (const o of notes) if (o.annot) host.ctx.annot.remove(o.annot.id);
  sel = (res.ids ?? []).map((id) => `i:${id}`);
  repaint();
}

function setMode(host: ToolHost, next: Mode): void {
  if (editing) void finishEdit(host);
  if (cropping) void finishCrop(host, true);
  mode = next;
  if (next === 'idle') { host.useTool(null); sel = []; }
  else if (next === 'select') host.useTool(selectTool(host));
  else if (next === 'text') host.useTool(textTool(host));
  else if (next === 'picture') host.useTool(pictureTool(host));
  reload(host);
  repaint();
}

function textTool(host: ToolHost): PageTool {
  let p0: Pt | null = null;
  let page = 0;
  return {
    hint: 'Click where the text starts, or drag across to set its width. Esc ends.',
    down: (pv, p) => { p0 = p; page = pv.index + 1; },
    up: (pv, p) => {
      if (!p0) return;
      const size = host.ctx.viewer.sizes[page - 1] ?? { w: 612, h: 792 };
      const dragged = Math.abs(p.x - p0.x) > 8;
      const x = dragged ? Math.min(p0.x, p.x) : p0.x, w = dragged ? Math.abs(p.x - p0.x) : Math.max(40, Math.min(240, size.w - p0.x - 18));
      const y = p0.y - font.size * font.lineHeight / 2;
      p0 = null;
      mode = 'select';
      host.useTool(selectTool(host));
      sel = [];
      repaint();
      void editText(host, null, pv.index + 1, { x, y, w, h: font.size * font.lineHeight, rot: 0 });
    },
    key: (e) => key(host, e),
    cancel: () => { p0 = null; },
  };
}

function pictureTool(host: ToolHost): PageTool {
  return {
    hint: 'Click where the top left of the picture goes. Esc ends.',
    down: (pv, p) => {
      const pic = picture;
      if (!pic) return;
      const size = host.ctx.viewer.sizes[pv.index] ?? { w: 612, h: 792 };
      const w = Math.min(pic.w * 0.75, size.w * 0.5), h = w * (pic.h / Math.max(1, pic.w));
      picture = null;
      mode = 'select';
      host.useTool(selectTool(host));
      void act(host, { add: [{ kind: 'picture', page: pv.index + 1, x: round(p.x), y: round(p.y), w: round(w), h: round(h), data: pic.data }] }, 'Add picture', 'Adding picture').then((res) => {
        if (res?.ids?.length) sel = [`i:${res.ids[0]}`];
        repaint();
      });
    },
    key: (e) => key(host, e),
    cancel: () => { picture = null; },
  };
}

function choosePicture(host: ToolHost): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > 60 * 1024 * 1024) { toast('Pictures can be at most 60 MB', 'error'); return; }
    const r = new FileReader();
    r.onload = () => {
      const data = String(r.result);
      const img = new Image();
      img.onload = () => { picture = { data, w: img.naturalWidth || 400, h: img.naturalHeight || 300, name: f.name }; setMode(host, 'picture'); };
      img.onerror = () => toast(`${f.name} is not a picture formpdf can read`, 'error');
      img.src = data;
    };
    r.readAsDataURL(f);
  };
  input.click();
}

function sync(): void {
  const root = rootEl, host = hostRef;
  if (!root || !host) return;
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-m]'))) setClass(b, 'is-active', b.dataset.m === mode);
  const objs = allSelected(host);
  const texts = objs.filter((o) => o.kind === 'text');
  const picsSel = objs.filter((o) => o.kind === 'picture' || o.kind === 'pic');
  const engine = objs;
  const samePage = new Set(objs.map((o) => o.page)).size <= 1;
  const textOn = !!editing || texts.length > 0 || mode === 'text';
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-g="text"] [data-f]'))) setDisabled(b, !textOn);
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-g="picture"] [data-p]'))) setDisabled(b, !picsSel.length || !!editing);
  setClass(q(root, '[data-p="crop"]'), 'is-active', !!cropping);
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-z]'))) setDisabled(b, !engine.length || !!editing);
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-a]'))) setDisabled(b, !samePage || objs.length < (b.dataset.a?.startsWith('dist') ? 3 : 2) || !!editing);
  setDisabled(q<HTMLButtonElement>(root, '[data-t="delete"]'), !objs.length || !!editing);
  setDisabled(q<HTMLButtonElement>(root, '[data-t="convert"]'), !objs.some((o) => o.annot?.kind === 'freetext') || !!editing);
  const f = editing ? editor.font : texts[0]?.item?.font ?? font;
  const fam = q<HTMLSelectElement>(root, '[data-f="family"]');
  if (fam.value !== f.family) fam.value = f.family;
  const size = q<HTMLInputElement>(root, '[data-f="size"]');
  if (document.activeElement !== size && size.value !== String(f.size)) size.value = String(f.size);
  const color = q<HTMLInputElement>(root, '[data-f="color"]');
  if (color.value.toLowerCase() !== f.color.toLowerCase()) color.value = f.color.toLowerCase();
  const line = q<HTMLSelectElement>(root, '[data-f="line"]');
  if (line.value !== String(f.lineHeight)) line.value = String(f.lineHeight);
  const paras = editing ? null : texts[0]?.item?.paras;
  const alignNow = editing ? editor.align() : paras?.[0]?.align ?? '';
  const listNow = editing ? editor.list() : paras?.[0]?.list ?? '';
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-f="align"]'))) setClass(b, 'is-active', textOn && b.dataset.v === alignNow);
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-f="list"]'))) setClass(b, 'is-active', textOn && b.dataset.v === listNow);
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-f="run"]'))) {
    const k = b.dataset.v ?? '';
    const on = editing ? editor.state(STATE_CMD[k]) : !!paras && paras.every((p) => p.runs.every((r) => !r.t.trim() || !!r[k as 'b']));
    setClass(b, 'is-active', textOn && on);
  }
  const n = objs.length;
  setText(q(root, '[data-t="note"]'),
    editing ? 'Type the text. Format it with the controls below. Click outside it or press Esc when done.'
      : cropping ? 'Drag the handles to crop. Enter keeps the crop, Esc cancels.'
        : mode === 'text' ? 'Click on the page where the text goes.'
          : mode === 'picture' ? 'Click on the page where the picture goes.'
            : mode === 'select' ? (n ? `${n} selected${!samePage ? ' on more than one page' : ''}. Drag to move, use the handles to resize or rotate.` : 'Click text, a picture or a comment to select it; Shift-click selects more.')
              : 'Add text and pictures that stay editable, or select what is on the page to move, resize, rotate, crop, arrange and align it.');
}

const btn = (attr: string, ico: string, label: string): string => `<button class="fs-icon-btn is-sm" type="button" ${attr} title="${label}" aria-label="${label}">${icon(ico, 14)}</button>`;

registerTool({
  id: 'content',
  tab: 'edit',
  title: 'Text and pictures',
  words: ['add text', 'edit text', 'add picture', 'image', 'crop picture', 'rotate picture', 'flip', 'arrange', 'bring to front', 'send to back', 'align objects', 'distribute', 'page text', 'list', 'justify'],
  section: () => `<div class="fs-seg is-quiet fs-tool-seg" role="group" aria-label="Text and pictures"><button type="button" data-m="select">${icon('cursor', 14)}Select</button><button type="button" data-m="text">${icon('textBox', 14)}Add text</button><button type="button" data-m="picture">${icon('image', 14)}Add picture</button></div>
<p class="fs-note fs-tool-note" data-t="note"></p>
<div class="fs-cx-group" data-g="text">
<div class="fs-cx-row"><select class="fs-tool-unit" data-f="family" aria-label="Font"><option value="sans">Inter</option><option value="serif">Noto Serif</option><option value="mono">JetBrains Mono</option></select><input class="fs-input fs-cx-num" type="number" min="4" max="288" step="0.5" data-f="size" aria-label="Font size"><input class="fs-cx-color" type="color" data-f="color" aria-label="Text colour" title="Text colour"></div>
<div class="fs-cx-btns">${btn('data-f="run" data-v="b"', 'bold', 'Bold')}${btn('data-f="run" data-v="i"', 'italic', 'Italic')}${btn('data-f="run" data-v="u"', 'underline', 'Underline')}${btn('data-f="run" data-v="s"', 'strike', 'Strike through')}${btn('data-f="run" data-v="sup"', 'superscript', 'Superscript')}${btn('data-f="run" data-v="sub"', 'subscript', 'Subscript')}</div>
<div class="fs-cx-btns">${btn('data-f="align" data-v="left"', 'alignLeft', 'Align left')}${btn('data-f="align" data-v="center"', 'alignCenter', 'Centre')}${btn('data-f="align" data-v="right"', 'alignRight', 'Align right')}${btn('data-f="align" data-v="justify"', 'alignJustify', 'Justify')}<span class="fs-cx-gap"></span>${btn('data-f="list" data-v="bullet"', 'bulletList', 'Bulleted list')}${btn('data-f="list" data-v="number"', 'numberList', 'Numbered list')}</div>
<label class="fs-field is-stack fs-tool-field"><span>Line spacing</span><select class="fs-tool-unit" data-f="line" aria-label="Line spacing"><option value="1">1.0</option><option value="1.15">1.15</option><option value="1.25">1.25</option><option value="1.5">1.5</option><option value="2">2.0</option></select></label>
</div>
<div class="fs-pdfwb-subhead">Picture</div>
<div class="fs-cx-btns" data-g="picture">${btn('data-p="left"', 'undo', 'Rotate left')}${btn('data-p="right"', 'redo', 'Rotate right')}${btn('data-p="flipH"', 'flipH', 'Flip horizontally')}${btn('data-p="flipV"', 'flipV', 'Flip vertically')}${btn('data-p="crop"', 'crop', 'Crop (Enter keeps it)')}<button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-p="uncrop">Reset crop</button></div>
<div class="fs-pdfwb-subhead">Arrange</div>
<div class="fs-cx-btns">${btn('data-z="front"', 'bringFront', 'Bring to front')}${btn('data-z="forward"', 'bringForward', 'Bring forward')}${btn('data-z="backward"', 'sendBackward', 'Send backward')}${btn('data-z="back"', 'sendBack', 'Send to back')}</div>
<div class="fs-pdfwb-subhead">Align and distribute</div>
<div class="fs-cx-btns">${btn('data-a="left"', 'alignLeftEdge', 'Align left edges')}${btn('data-a="center"', 'alignHcenterEdge', 'Align centres')}${btn('data-a="right"', 'alignRightEdge', 'Align right edges')}${btn('data-a="top"', 'alignTopEdge', 'Align top edges')}${btn('data-a="middle"', 'alignVcenterEdge', 'Align middles')}${btn('data-a="bottom"', 'alignBottomEdge', 'Align bottom edges')}${btn('data-a="distH"', 'distributeH', 'Distribute across')}${btn('data-a="distV"', 'distributeV', 'Distribute down')}</div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="convert">Make page text</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-t="delete">${icon('delete', 14)}Delete</button></div>`,
  mount: (root, host) => {
    rootEl = root;
    hostRef = host;
    root.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b && editing) e.preventDefault();
    });
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b || (b as HTMLButtonElement).disabled) return;
      if (b.dataset.m) {
        const m = b.dataset.m as Mode;
        if (m === 'picture') { choosePicture(host); return; }
        setMode(host, mode === m && m === 'select' ? 'idle' : m);
        return;
      }
      if (b.dataset.f === 'run' || b.dataset.f === 'align' || b.dataset.f === 'list') { void textFormat(host, b.dataset.f === 'run' ? b.dataset.v ?? '' : b.dataset.f, b.dataset.v); return; }
      if (b.dataset.p) { void pictureEdit(host, b.dataset.p); return; }
      if (b.dataset.z) { void arrange(host, b.dataset.z as 'front'); return; }
      if (b.dataset.a) { align(host, b.dataset.a as AlignHow); return; }
      if (b.dataset.t === 'delete') void remove(host);
      if (b.dataset.t === 'convert') void convertComment(host);
    });
    for (const f of ['family', 'line'] as const) q<HTMLSelectElement>(root, `[data-f="${f}"]`).addEventListener('change', (e) => void textFormat(host, f, (e.target as HTMLSelectElement).value));
    q<HTMLInputElement>(root, '[data-f="size"]').addEventListener('change', (e) => void textFormat(host, 'size', (e.target as HTMLInputElement).value));
    q<HTMLInputElement>(root, '[data-f="color"]').addEventListener('change', (e) => void textFormat(host, 'color', (e.target as HTMLInputElement).value.toUpperCase()));
    editor.area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.stopPropagation(); void finishEdit(host); return; }
      if (e.key === 'Tab') { e.preventDefault(); if (!editor.indent(e.shiftKey ? -1 : 1)) document.execCommand('insertText', false, '    '); return; }
      e.stopPropagation();
    });
    for (const ev of ['keyup', 'mouseup'] as const) editor.area.addEventListener(ev, () => sync());
    sync();
  },
  sync: (_root, host) => {
    const d = host.doc();
    if (!d) { if (mode !== 'idle') mode = 'idle'; items = []; pics = []; sel = []; loaded.clear(); loadedFor = ''; return; }
    if (d.id !== loadedFor && mode !== 'idle') reload(host);
    if (mode !== 'idle' && host.activeTool() === null && !editing) { mode = 'idle'; sel = []; cropping = null; layers.repaint(); }
    sync();
  },
  page: (pv: PageView) => layers.mount(pv),
  rendered: (pv: PageView) => {
    const list = waiters.get(pv.index);
    if (list?.length) { waiters.delete(pv.index); for (const fn of list) fn(); }
  },
  commands: (host) => [
    { id: 'tool-content-select', label: 'Select text and pictures', words: ['select objects', 'move picture'], enabled: () => !!host.doc(), run: () => { host.setTab('edit'); setMode(host, 'select'); } },
    { id: 'tool-add-text', label: 'Add page text', words: ['type on the page', 'text box on the page'], enabled: () => !!host.doc(), run: () => { host.setTab('edit'); setMode(host, 'text'); } },
    { id: 'tool-add-picture', label: 'Add a picture to the page…', words: ['insert image', 'place picture'], enabled: () => !!host.doc(), run: () => { host.setTab('edit'); choosePicture(host); } },
    { id: 'tool-front', label: 'Bring to front', keys: ['Shift+Mod+]'], enabled: () => sel.length > 0, run: () => void arrange(host, 'front') },
    { id: 'tool-forward', label: 'Bring forward', keys: ['Mod+]'], enabled: () => sel.length > 0, run: () => void arrange(host, 'forward') },
    { id: 'tool-backward', label: 'Send backward', keys: ['Mod+['], enabled: () => sel.length > 0, run: () => void arrange(host, 'backward') },
    { id: 'tool-back', label: 'Send to back', keys: ['Shift+Mod+['], enabled: () => sel.length > 0, run: () => void arrange(host, 'back') },
  ],
});
