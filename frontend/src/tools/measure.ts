import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { PageView } from '../pdf/viewer';
import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { PageLayers } from './overlay';

type Mode = 'distance' | 'perimeter' | 'area' | 'calibrate';
type P = [number, number];
interface Item { page: number; index: number; kind: string; points: P[]; text: string; unit: string; value?: number; author: string }

const UNITS: Record<string, number> = { mm: 25.4 / 72, cm: 2.54 / 72, m: 0.0254 / 72, in: 1 / 72, ft: 1 / 864, pt: 1 };
const LABEL: Record<string, string> = { distance: 'Distance', perimeter: 'Perimeter', area: 'Area' };
const SNAP_PX = 9;

let unit = 'mm';
let factor = UNITS.mm;
let calibrated = false;
let calLength = 0;
let mode: Mode | null = null;
let page = 0;
let fixed: P[] = [];
let cursor: P | null = null;
let snapAt: P | null = null;
let pressed = false;
let lastDown: { t: number; p: P } | null = null;
let items: Item[] = [];
let order: string[] = [];
let orderFor = '';
let loadedFor = '';
let loading = '';
let rootEl: HTMLElement | null = null;
let hostRef: ToolHost | null = null;
const snaps = new Map<string, P[] | 'loading'>();
const scales = new Map<string, { unit: string; factor: number; calibrated: boolean }>();

const fmt = (kind: string, v: number, u: string): string => `${v.toLocaleString(undefined, { maximumFractionDigits: v >= 1000 ? 0 : v >= 100 ? 1 : 2 })} ${kind === 'area' ? 'sq ' : ''}${u}`;
const dist = (a: P, b: P): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polyLen = (pts: P[]): number => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
const polyArea = (pts: P[]): number => Math.abs(pts.reduce((s, p, i) => { const n = pts[(i + 1) % pts.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;

function measureOf(kind: string, pts: P[]): number {
  if (kind === 'area') return polyArea(pts) * factor * factor;
  return polyLen(kind === 'perimeter' ? pts : pts.slice(0, 2)) * factor;
}

function shown(): P[] { return cursor ? [...fixed, cursor] : fixed; }

const layers = new PageLayers('measure', (index, layer) => {
  let svg = layer.querySelector<SVGSVGElement>('svg');
  const pv = hostRef?.ctx.viewer.pages[index];
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fs-pdf-measure');
    svg.innerHTML = '<polygon class="fs-msr-fill"/><polyline class="fs-msr-line"/><g class="fs-msr-label"><rect/><text/></g><circle class="fs-msr-snap" r="3.5"/>';
    layer.appendChild(svg);
  }
  if (pv) svg.setAttribute('viewBox', `0 0 ${pv.size.w} ${pv.size.h}`);
  const pts = page === index + 1 && mode ? shown() : [];
  const kind = mode === 'calibrate' ? 'distance' : mode ?? 'distance';
  const line = svg.querySelector('.fs-msr-line') as SVGPolylineElement, fill = svg.querySelector('.fs-msr-fill') as SVGPolygonElement;
  const lab = svg.querySelector('.fs-msr-label') as SVGGElement, snap = svg.querySelector('.fs-msr-snap') as SVGCircleElement;
  const attr = pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  line.setAttribute('points', attr);
  fill.setAttribute('points', kind === 'area' && pts.length > 2 ? attr : '');
  setClass(svg, 'is-cal', mode === 'calibrate');
  if (pts.length >= 2) {
    const v = measureOf(kind, pts);
    const text = mode === 'calibrate' ? `${polyLen(pts.slice(0, 2)).toFixed(1)} pt on the page` : fmt(kind, v, unit);
    const at: P = kind === 'area' ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : kind === 'distance' ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - 6] : [pts[pts.length - 1][0], pts[pts.length - 1][1] - 8];
    const t = lab.querySelector('text') as SVGTextElement, r = lab.querySelector('rect') as SVGRectElement;
    if (t.textContent !== text) t.textContent = text;
    t.setAttribute('x', at[0].toFixed(2));
    t.setAttribute('y', at[1].toFixed(2));
    const w = text.length * 5.1 + 8;
    r.setAttribute('x', (at[0] - w / 2).toFixed(2));
    r.setAttribute('y', (at[1] - 9).toFixed(2));
    r.setAttribute('width', w.toFixed(2));
    lab.setAttribute('visibility', 'visible');
  } else lab.setAttribute('visibility', 'hidden');
  if (snapAt && page === index + 1 && mode) { snap.setAttribute('cx', snapAt[0].toFixed(2)); snap.setAttribute('cy', snapAt[1].toFixed(2)); snap.setAttribute('visibility', 'visible'); } else snap.setAttribute('visibility', 'hidden');
});

function repaint(): void { layers.repaint(); }

function loadSnaps(host: ToolHost, pv: PageView): P[] {
  const d = host.doc();
  if (!d) return [];
  const key = `${d.id}|${pv.index + 1}`;
  const got = snaps.get(key);
  if (got === 'loading') return [];
  if (got) return got;
  snaps.set(key, 'loading');
  void pdfApi.act<{ points: Array<[number, number, string]> }>(d.id, 'snap_points', { page: pv.index + 1 })
    .then((r) => snaps.set(key, r.points.map((p) => [p[0], p[1]] as P))).catch(() => snaps.set(key, []));
  return [];
}

function adjust(host: ToolHost, pv: PageView, p: { x: number; y: number }, e: PointerEvent): P {
  let out: P = [p.x, p.y];
  const last = fixed[fixed.length - 1];
  if (e.shiftKey && last) {
    const a = Math.round(Math.atan2(out[1] - last[1], out[0] - last[0]) / (Math.PI / 4)) * (Math.PI / 4), len = dist(last, out);
    out = [last[0] + Math.cos(a) * len, last[1] + Math.sin(a) * len];
  }
  snapAt = null;
  const on = rootEl ? q<HTMLInputElement>(rootEl, '[data-t="snap"]').checked : true;
  if (on && !e.shiftKey) {
    const tol = SNAP_PX / host.ctx.viewer.k();
    let best = tol;
    for (const s of loadSnaps(host, pv)) { const dd = dist(s, out); if (dd < best) { best = dd; snapAt = s; } }
    if (snapAt) out = [snapAt[0], snapAt[1]];
  }
  return out;
}

function stop(): void { mode = null; fixed = []; cursor = null; snapAt = null; pressed = false; page = 0; repaint(); syncForm(); }

async function finish(host: ToolHost): Promise<void> {
  const kind = mode;
  const pts = [...fixed];
  if (!kind) return;
  if (kind === 'calibrate') {
    calLength = polyLen(pts.slice(0, 2));
    host.useTool(null);
    if (rootEl) { syncForm(); q<HTMLInputElement>(rootEl, '[data-t="known"]').focus(); }
    return;
  }
  const need = kind === 'area' ? 3 : 2;
  const at = page;
  host.useTool(null);
  if (pts.length < need || polyLen(pts) < 1) return;
  const d = host.doc();
  if (!d) return;
  await host.ctx.run('Measuring', async () => {
    try {
      const res = await pdfApi.act<Derived & { values?: string[] }>(d.id, 'measure', { add: [{ kind, page: at, points: kind === 'distance' ? pts.slice(0, 2) : pts, unit, factor }] });
      await host.ctx.commit(res, `Measure ${kind}`);
      if (res.values?.[0]) toast(`${LABEL[kind]}: ${res.values[0]}`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

function start(host: ToolHost, m: Mode): void {
  host.setTab('comment');
  stop();
  mode = m;
  if (document.activeElement instanceof HTMLElement && rootEl?.contains(document.activeElement)) document.activeElement.blur();
  const hint = m === 'distance' ? 'Click the start and the end, or drag. Shift keeps 45 degree steps. Esc ends.'
    : m === 'calibrate' ? 'Click both ends of something whose real length you know. Esc ends.'
      : 'Click each corner. Double-click or Enter finishes, Backspace removes the last corner, Shift keeps 45 degree steps. Esc ends.';
  host.useTool({
    hint,
    down: (pv, p, e) => {
      if (page && page !== pv.index + 1) return;
      page = pv.index + 1;
      const pt = adjust(host, pv, p, e);
      const now = performance.now();
      const twice = !!lastDown && now - lastDown.t < 450 && dist(lastDown.p, pt) * host.ctx.viewer.k() < 6;
      lastDown = { t: now, p: pt };
      if (m === 'distance' || m === 'calibrate') {
        if (!fixed.length) { fixed = [pt]; cursor = pt; pressed = true; }
        else { fixed = [fixed[0], pt]; cursor = null; repaint(); void finish(host); return; }
      } else if (twice && fixed.length >= (m === 'area' ? 3 : 2)) { cursor = null; repaint(); void finish(host); return; }
      else if (!fixed.length || dist(fixed[fixed.length - 1], pt) > 0.5) fixed = [...fixed, pt];
      repaint();
    },
    move: (pv, p, e) => {
      if (!mode || (page && page !== pv.index + 1)) return;
      cursor = adjust(host, pv, p, e);
      if (!fixed.length) cursor = null;
      repaint();
    },
    up: (pv, p, e) => {
      if ((m === 'distance' || m === 'calibrate') && pressed && fixed.length === 1) {
        pressed = false;
        const pt = adjust(host, pv, p, e);
        if (dist(fixed[0], pt) * host.ctx.viewer.k() > 6) { fixed = [fixed[0], pt]; cursor = null; repaint(); void finish(host); }
      }
    },
    key: (e) => {
      if (e.key === 'Enter' && (m === 'perimeter' || m === 'area')) { cursor = null; void finish(host); return true; }
      if (e.key === 'Backspace' && fixed.length) { fixed = fixed.slice(0, -1); repaint(); return true; }
      return false;
    },
    cancel: () => { if (mode !== 'calibrate' || !calLength) stop(); else { mode = null; fixed = []; cursor = null; snapAt = null; repaint(); } },
  });
  syncForm();
}

function remember(host: ToolHost): void {
  const d = host.doc();
  if (!d) return;
  scales.set(d.key, { unit, factor, calibrated });
  try { localStorage.setItem(`fs-measure-${d.key}`, JSON.stringify({ unit, factor, calibrated })); } catch { return; }
}

function recall(host: ToolHost): void {
  const d = host.doc();
  if (!d) return;
  let s = scales.get(d.key);
  if (!s) { try { s = JSON.parse(localStorage.getItem(`fs-measure-${d.key}`) ?? 'null') ?? undefined; } catch { s = undefined; } }
  if (s && UNITS[s.unit] && s.factor > 0) { unit = s.unit; factor = s.factor; calibrated = s.calibrated; }
}

function syncForm(): void {
  const root = rootEl;
  if (!root) return;
  for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-m]'))) setClass(b, 'is-on', b.dataset.m === mode);
  const sel = q<HTMLSelectElement>(root, '[data-t="unit"]');
  if (sel.value !== unit) sel.value = unit;
  const per = factor.toPrecision(4).replace(/\.?0+$/, '');
  setText(q(root, '[data-t="scale"]'), calibrated ? `Scale: 1 pt on the page = ${per} ${unit} (calibrated)` : `Scale: true size (1 pt = ${per} ${unit})`);
  const known = q<HTMLInputElement>(root, '[data-t="known"]');
  setDisabled(known, !calLength);
  setDisabled(q<HTMLButtonElement>(root, '[data-t="set"]'), !calLength || !(Number(known.value) > 0));
  setDisabled(q<HTMLButtonElement>(root, '[data-t="reset"]'), !calibrated);
  setText(q(root, '[data-t="calnote"]'), calLength ? `The line you drew is ${calLength.toFixed(1)} pt on the page. Its real length:` : 'Calibrate: draw a line over something whose real length you know.');
  setDisabled(q<HTMLButtonElement>(root, '[data-t="csv"]'), !items.length);
}

function renderList(root: HTMLElement): void {
  const fill = (n: HTMLElement, it: Item): void => { setText(q(n, '.fs-row-title'), it.text || LABEL[it.kind]); setText(q(n, '.fs-row-sub'), `${LABEL[it.kind] ?? it.kind} · page ${it.page}`); };
  patchList(q(root, '[data-t="list"]'), items, {
    key: (it) => `${it.page}|${it.index}|${it.text}`,
    create: (it) => { const n = el(`<div class="fs-row fs-tool-row" data-t="pick"><span class="fs-row-icon">${icon('ruler', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><button class="fs-icon-btn is-sm" type="button" data-t="remove" title="Remove measurement" aria-label="Remove measurement">${icon('delete', 14)}</button></div>`); fill(n, it); return n; },
    update: fill,
  });
  setText(q(root, '[data-t="count"]'), String(items.length));
  setHidden(q(root, '[data-t="empty"]'), items.length > 0 || loading !== '');
  syncForm();
}

async function load(root: HTMLElement, host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) { items = []; loadedFor = ''; renderList(root); return; }
  if (loadedFor === d.id || loading === d.id) return;
  loading = d.id;
  try {
    const got = await pdfApi.act<{ measurements: Item[] }>(d.id, 'measurements');
    if (host.doc()?.id !== d.id) return;
    if (orderFor !== d.key) { order = []; orderFor = d.key; recall(host); }
    const key = (x: Item): string => `${x.page}|${x.index}|${x.text}`;
    const rank = new Map(order.map((k, i) => [k, i]));
    items = got.measurements.map((x, i) => ({ x, r: rank.get(key(x)) ?? order.length + i })).sort((a, b) => a.r - b.r).map((v) => v.x);
    order = items.map(key);
    loadedFor = d.id;
  } catch { items = []; } finally { if (loading === d.id) loading = ''; }
  renderList(root);
}

function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(host: ToolHost): void {
  const d = host.doc();
  if (!d || !items.length) return;
  const rows = [['Page', 'Number', 'Kind', 'Value', 'Unit', 'Label', 'Author'], ...items.map((it) => [it.page, it.index + 1, it.kind, it.value ?? '', it.kind === 'area' ? `sq ${it.unit}` : it.unit, it.text, it.author])];
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  void host.ctx.deliver(new Blob([csv], { type: 'text/csv' }), `${d.name.replace(/\.pdf$/i, '')} measurements.csv`);
}

registerTool({
  id: 'measure',
  tab: 'comment',
  title: 'Measure',
  words: ['measure', 'ruler', 'distance', 'perimeter', 'area', 'scale', 'dimension'],
  section: () => `<div class="fs-seg is-quiet fs-tool-seg" role="group" aria-label="Measure"><button type="button" data-m="distance">${icon('ruler', 14)}Distance</button><button type="button" data-m="perimeter">Perimeter</button><button type="button" data-m="area">Area</button></div>
<label class="fs-field is-stack fs-tool-field"><span>Unit</span><select class="fs-tool-unit" data-t="unit" aria-label="Unit">${Object.keys(UNITS).map((u) => `<option value="${u}">${u}</option>`).join('')}</select></label>
<p class="fs-note" data-t="scale"></p>
<p class="fs-note fs-tool-note" data-t="calnote"></p>
<div class="fs-tool-cal"><input class="fs-input" type="number" min="0" step="any" data-t="known" placeholder="Real length" aria-label="Real length" disabled><button class="fs-btn fs-btn-sm" type="button" data-t="set" disabled>Set scale</button></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-m="calibrate">Calibrate…</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-t="reset" disabled>True size</button></div>
<label class="fs-check"><input type="checkbox" data-t="snap" checked>Snap to lines, corners and crossings</label>
<div class="fs-pdfwb-subhead">In this PDF <span class="fs-badge is-count" data-t="count">0</span></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-t="list"></div><p class="fs-note fs-tool-empty" data-t="empty">No measurements yet. Each one is saved in the PDF as a measurement comment other readers show.</p></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="csv" disabled>${icon('download', 14)}Export CSV</button></div>`,
  mount: (root, host) => {
    rootEl = root;
    hostRef = host;
    syncForm();
    q<HTMLSelectElement>(root, '[data-t="unit"]').addEventListener('change', (e) => {
      const next = (e.target as HTMLSelectElement).value;
      if (!UNITS[next] || next === unit) return;
      factor = factor * (UNITS[next] / UNITS[unit]);
      unit = next;
      remember(host);
      syncForm();
      repaint();
    });
    q<HTMLInputElement>(root, '[data-t="known"]').addEventListener('input', () => syncForm());
    q<HTMLInputElement>(root, '[data-t="known"]').addEventListener('keydown', (e) => { if (e.key === 'Enter') q<HTMLButtonElement>(root, '[data-t="set"]').click(); });
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const m = t.closest<HTMLElement>('[data-m]')?.dataset.m as Mode | undefined;
      if (m) { if (!host.doc()) { toast('Open a PDF first'); return; } if (mode === m) host.useTool(null); else start(host, m); return; }
      const a = t.closest<HTMLElement>('[data-t]')?.dataset.t;
      const row = items.find((x) => `${x.page}|${x.index}|${x.text}` === t.closest<HTMLElement>('[data-key]')?.dataset.key);
      if (a === 'set') {
        const known = Number(q<HTMLInputElement>(root, '[data-t="known"]').value);
        if (calLength > 0 && known > 0) { factor = known / calLength; calibrated = true; calLength = 0; q<HTMLInputElement>(root, '[data-t="known"]').value = ''; remember(host); syncForm(); toast(`Scale set: 1 pt = ${factor.toPrecision(4)} ${unit}`); }
      } else if (a === 'reset') { factor = UNITS[unit]; calibrated = false; remember(host); syncForm(); }
      else if (a === 'csv') exportCsv(host);
      else if (a === 'remove' && row) {
        const d = host.doc();
        if (d) void host.ctx.run('Removing the measurement', async () => { try { await host.ctx.commit(await pdfApi.act<Derived>(d.id, 'measure', { remove: [{ page: row.page, index: row.index }] }), 'Remove measurement'); } catch (err) { toast((err as Error).message, 'error'); } });
      } else if (a === 'pick' && row?.points.length) {
        const xs = row.points.map((p) => p[0]), ys = row.points.map((p) => p[1]);
        const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(4, Math.max(...xs) - Math.min(...xs)), h: Math.max(4, Math.max(...ys) - Math.min(...ys)) };
        host.ctx.viewer.scrollToPoint(row.page - 1, box.x + box.w / 2, box.y);
        host.ctx.annot.pulse(row.page, [box]);
      }
    });
  },
  sync: (root, host) => {
    hostRef = host;
    if (mode && host.activeTool() === null) stop();
    if (!host.doc()) { calLength = 0; }
    void load(root, host);
  },
  page: (pv) => layers.mount(pv),
  commands: (host) => [
    { id: 'tool-measure-distance', label: 'Measure distance', words: ['ruler', 'length'], enabled: () => !!host.doc(), run: () => start(host, 'distance') },
    { id: 'tool-measure-perimeter', label: 'Measure perimeter', words: ['ruler', 'polyline'], enabled: () => !!host.doc(), run: () => start(host, 'perimeter') },
    { id: 'tool-measure-area', label: 'Measure area', words: ['ruler', 'polygon', 'square'], enabled: () => !!host.doc(), run: () => start(host, 'area') },
  ],
});
