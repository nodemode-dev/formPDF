import { el, escapeHtml, patchList, setClass, setHtml } from '../ui/dom';
import type { Annot, Area, Pt, Rect, StampSpec } from './api';
import { stampSvg } from './stamps';
import type { PageView, Viewer } from './viewer';

export type Tool = 'select' | 'hand' | 'highlight' | 'underline' | 'strikeout' | 'note' | 'freetext' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'redact' | 'crop' | 'place' | 'form' | 'custom';
export const MARKUP_TOOLS: readonly Tool[] = ['highlight', 'underline', 'strikeout'];
export const DRAW_TOOLS: readonly Tool[] = ['note', 'freetext', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'redact', 'crop', 'place', 'form', 'custom'];
export interface PageTool {
  hint: string;
  down(pv: PageView, p: { x: number; y: number }, e: PointerEvent): void;
  move?(pv: PageView, p: { x: number; y: number }, e: PointerEvent): void;
  up?(pv: PageView, p: { x: number; y: number }, e: PointerEvent): void;
  key?(e: KeyboardEvent): boolean;
  cancel?(): void;
}
export type Placement = { kind: 'image'; image: string; aspect: number; width: number; label: string; flatten?: boolean } | { kind: 'freetext'; text: string; size: number; label: string }
  | { kind: 'stamp'; spec: StampSpec; color: string; w: number; h: number; label: string; flatten: boolean };
export interface AnnotHooks { changed(label: string): void; select(id: string | null): void; areas(): void; toolDone(): void; crop(): void }
export interface Style { color: string; width: number; opacity: number; size: number }

export const KIND_LABEL: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikethrough', note: 'Note', freetext: 'Text', ink: 'Drawing', rect: 'Rectangle',
  ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', image: 'Image', reply: 'Reply', squiggly: 'Squiggly', stamp: 'Stamp', polygon: 'Polygon',
  polyline: 'Polyline', caret: 'Insert text', attachment: 'Attachment', sound: 'Sound', redact: 'Redaction mark',
};
const NOTE = 20;
const SVG_KINDS = new Set(['highlight', 'underline', 'strikeout', 'ink', 'rect', 'ellipse', 'line', 'arrow']);
const BOXED = new Set(['freetext', 'image', 'rect', 'ellipse', 'stamp']);

let seq = 0;
export const uid = (p: string): string => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();
const calc = (v: number): string => `calc(var(--k) * ${n2(v)}px)`;

export function bounds(a: Annot): Rect {
  const pad = (a.width ?? 2) / 2 + 1;
  const pts = (list: Pt[], extra = 0): Rect => {
    const xs = list.map((p) => p[0]), ys = list.map((p) => p[1]);
    const x0 = Math.min(...xs) - pad - extra, y0 = Math.min(...ys) - pad - extra;
    return { x: x0, y: y0, w: Math.max(...xs) + pad + extra - x0, h: Math.max(...ys) + pad + extra - y0 };
  };
  if (a.rects?.length) {
    const x0 = Math.min(...a.rects.map((r) => r.x)) - 1, y0 = Math.min(...a.rects.map((r) => r.y)) - 1;
    return { x: x0, y: y0, w: Math.max(...a.rects.map((r) => r.x + r.w)) + 1 - x0, h: Math.max(...a.rects.map((r) => r.y + r.h)) + 1 - y0 };
  }
  if (a.kind === 'ink' && a.paths?.length) return pts(a.paths.flat());
  if ((a.kind === 'line' || a.kind === 'arrow') && a.points?.length) return pts(a.points, a.kind === 'arrow' ? Math.max(8, (a.width ?? 2) * 4) : 0);
  if (a.kind === 'note') return { x: a.x ?? 0, y: a.y ?? 0, w: NOTE, h: NOTE };
  const p = a.kind === 'rect' || a.kind === 'ellipse' ? pad : 0;
  return { x: (a.x ?? 0) - p, y: (a.y ?? 0) - p, w: (a.w ?? 0) + 2 * p, h: (a.h ?? 0) + 2 * p };
}

export function shifted(a: Annot, dx: number, dy: number): Annot {
  const out: Annot = { ...a };
  if (a.rects) out.rects = a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  if (a.points) out.points = a.points.map((p) => [p[0] + dx, p[1] + dy] as Pt);
  if (a.paths) out.paths = a.paths.map((path) => path.map((p) => [p[0] + dx, p[1] + dy] as Pt));
  if (a.x !== undefined) out.x = a.x + dx;
  if (a.y !== undefined) out.y = a.y + dy;
  return out;
}

function svgBody(a: Annot): string {
  const c = escapeHtml(a.color), w = a.width ?? 2, op = a.opacity ?? 1, rot = a.rot ?? 0;
  if (a.kind === 'highlight') return (a.rects ?? []).map((r) => `<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.w)}" height="${n2(r.h)}" fill="${c}" fill-opacity="${a.opacity ?? 0.4}"/>`).join('');
  if (a.kind === 'underline' || a.kind === 'strikeout') {
    return (a.rects ?? []).map((r) => {
      const across = rot % 180 === 0 ? r.h : r.w, lw = Math.max(0.75, Math.min(across * 0.08, 3)), under = a.kind === 'underline';
      let x1: number, y1: number, x2: number, y2: number;
      if (rot % 180 === 0) {
        const y = under ? (rot === 0 ? r.y + r.h - lw / 2 : r.y + lw / 2) : r.y + r.h / 2;
        [x1, y1, x2, y2] = [r.x, y, r.x + r.w, y];
      } else {
        const x = under ? (rot === 90 ? r.x + r.w - lw / 2 : r.x + lw / 2) : r.x + r.w / 2;
        [x1, y1, x2, y2] = [x, r.y, x, r.y + r.h];
      }
      return `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" stroke="${c}" stroke-opacity="${op}" stroke-width="${n2(lw)}" stroke-linecap="round"/>`;
    }).join('');
  }
  const stroke = `stroke="${c}" stroke-width="${n2(w)}" stroke-opacity="${op}" stroke-linecap="round" stroke-linejoin="round"`;
  if (a.kind === 'ink') return (a.paths ?? []).map((p) => `<path d="${p.map((q, i) => `${i ? 'L' : 'M'}${n2(q[0])} ${n2(q[1])}`).join('')}${p.length === 1 ? 'l0.01 0' : ''}" fill="none" ${stroke}/>`).join('');
  const fill = a.fill ? `fill="${escapeHtml(a.fill)}" fill-opacity="${op}"` : 'fill="none"';
  if (a.kind === 'rect') return `<rect x="${n2(a.x ?? 0)}" y="${n2(a.y ?? 0)}" width="${n2(a.w ?? 0)}" height="${n2(a.h ?? 0)}" ${fill} ${stroke}/>`;
  if (a.kind === 'ellipse') return `<ellipse cx="${n2((a.x ?? 0) + (a.w ?? 0) / 2)}" cy="${n2((a.y ?? 0) + (a.h ?? 0) / 2)}" rx="${n2((a.w ?? 0) / 2)}" ry="${n2((a.h ?? 0) / 2)}" ${fill} ${stroke}/>`;
  const [[x1, y1], [x2, y2]] = a.points ?? [[0, 0], [0, 0]];
  let body = `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" ${stroke}/>`;
  if (a.kind === 'arrow') {
    const ang = Math.atan2(y2 - y1, x2 - x1), size = Math.max(8, w * 4);
    const p = (s: number): string => `${n2(x2 - size * Math.cos(ang + s * 0.4887))} ${n2(y2 - size * Math.sin(ang + s * 0.4887))}`;
    body += `<path d="M${p(-1)} L${n2(x2)} ${n2(y2)} L${p(1)}" fill="none" ${stroke}/>`;
  }
  return body;
}

const NOTE_ICON = (color: string): string => `<svg viewBox="0 0 20 20"><path d="M1.5 1.5h17v12.5h-11l-4 4v-4h-2z" fill="${escapeHtml(color)}" stroke="rgba(0,0,0,0.45)" stroke-width="0.8" stroke-linejoin="round"/><path d="M5 5.5h10M5 8.5h10M5 11.5h6" stroke="rgba(0,0,0,0.5)" stroke-width="1" stroke-linecap="round"/></svg>`;

function upright(a: Annot, inner: string): string {
  const rot = a.rot ?? 0, w = a.w ?? 0, h = a.h ?? 0, [cw, ch] = rot % 180 ? [h, w] : [w, h];
  return `<div class="fs-pdf-upright" style="width:${calc(cw)};height:${calc(ch)};transform:translate(-50%,-50%) rotate(${-rot}deg)">${inner}</div>`;
}

function contentOf(a: Annot, f: Rect): { html: string; key: string } {
  if (SVG_KINDS.has(a.kind)) {
    const html = `<svg viewBox="${n2(f.x)} ${n2(f.y)} ${n2(f.w)} ${n2(f.h)}" preserveAspectRatio="none">${svgBody(a)}</svg>`;
    return { html, key: html };
  }
  if (a.kind === 'note') return { html: NOTE_ICON(a.color), key: `note|${a.color}` };
  if (a.kind === 'image') return { html: upright(a, `<img alt="" draggable="false" src="${escapeHtml(a.image ?? '')}">`), key: `img|${a.w}|${a.h}|${a.rot}|${a.opacity}|${(a.image ?? '').length}|${(a.image ?? '').slice(-32)}` };
  if (a.kind === 'stamp' && a.stamp) {
    const rot = a.rot ?? 0, [cw, ch] = rot % 180 ? [a.h ?? 0, a.w ?? 0] : [a.w ?? 0, a.h ?? 0];
    const html = upright(a, stampSvg(a.stamp, a.color, cw, ch, a.opacity ?? 1));
    return { html, key: html };
  }
  const style = `font-size:${calc(a.size ?? 12)};color:${escapeHtml(a.color)};${a.fill ? `background:${escapeHtml(a.fill)};` : ''}`;
  const html = upright(a, `<div class="fs-pdf-ft" style="${style}">${escapeHtml(a.text ?? '')}</div>`);
  return { html, key: html };
}

type Item = { key: string; annot?: Annot; area?: Area; crop?: Area };
interface Session { pv: PageView; tool: Tool; p0: { x: number; y: number }; pts: Pt[]; draft: HTMLElement; last: { x: number; y: number } }
interface Move { id: string; pv: PageView; x0: number; y0: number; node: HTMLElement; resize: boolean; base: Rect; area: boolean; moved: boolean }

export class Annotator {
  items: Annot[] = [];
  areas: Area[] = [];
  cropBox: Area | null = null;
  selected: string | null = null;
  tool: Tool = 'select';
  style: Style = { color: '#FFD400', width: 2, opacity: 1, size: 12 };
  placement: Placement | null = null;
  flattenComments = false;
  custom: PageTool | null = null;
  private customPv: PageView | null = null;
  private layers = new Map<number, HTMLElement>();
  private session: Session | null = null;
  private move: Move | null = null;
  private pan: { x: number; y: number; left: number; top: number } | null = null;
  private editing: { id: string; box: HTMLElement; input: HTMLTextAreaElement } | null = null;

  constructor(private readonly viewer: Viewer, private readonly hooks: AnnotHooks) {
    const host = viewer.host;
    host.addEventListener('pointerdown', (e) => this.down(e));
    host.addEventListener('pointermove', (e) => this.moveTo(e));
    host.addEventListener('pointerup', (e) => this.up(e));
    host.addEventListener('pointercancel', () => this.cancel());
    host.addEventListener('dblclick', (e) => {
      const node = (e.target as HTMLElement).closest('.fs-pdf-annot') as HTMLElement | null;
      const a = node ? this.items.find((x) => x.id === node.dataset.key) : undefined;
      if (a && (a.kind === 'freetext' || a.kind === 'note')) { e.preventDefault(); this.edit(a.id); }
    });
  }

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el('<div class="fs-pdf-annots"></div>');
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.render(pv.index);
  }

  setItems(items: Annot[]): void {
    const pages = new Set([...this.items, ...items].map((a) => a.page - 1));
    this.items = items;
    if (this.selected && !items.some((a) => a.id === this.selected) && !this.areas.some((a) => a.id === this.selected)) this.select(null);
    for (const p of pages) this.render(p);
  }

  setAreas(areas: Area[]): void {
    const pages = new Set([...this.areas, ...areas].map((a) => a.page - 1));
    this.areas = areas;
    for (const p of pages) this.render(p);
    this.hooks.areas();
  }

  setCrop(box: Area | null): void {
    const prev = this.cropBox;
    this.cropBox = box;
    if (prev) this.render(prev.page - 1);
    if (box && box.page !== prev?.page) this.render(box.page - 1);
  }

  renderAll(): void { for (const p of this.layers.keys()) this.render(p); }

  render(index: number): void {
    const layer = this.layers.get(index);
    if (!layer) return;
    const crop = this.cropBox;
    const list: Item[] = [
      ...this.items.filter((a) => a.page === index + 1 && a.kind !== 'reply').map((a) => ({ key: a.id, annot: a })),
      ...this.areas.filter((a) => a.page === index + 1).map((a) => ({ key: a.id, area: a })),
      ...(crop && crop.page === index + 1 ? [{ key: 'crop', crop }] : []),
    ];
    patchList(layer, list, {
      key: (it) => it.key,
      create: (it) => { const n = el('<div class="fs-pdf-annot"></div>'); this.paint(n, it); return n; },
      update: (n, it) => this.paint(n, it),
    });
  }

  private paint(n: HTMLElement, it: Item): void {
    if (it.crop) {
      const b = it.crop;
      if (n.dataset.kind !== 'crop') n.dataset.kind = 'crop';
      const inner = (n.firstElementChild as HTMLElement | null) ?? n.appendChild(el('<div class="fs-pdf-cropbox"></div>'));
      const css = `left:${calc(b.x)};top:${calc(b.y)};width:${calc(b.w)};height:${calc(b.h)}`;
      if (inner.getAttribute('style') !== css) inner.setAttribute('style', css);
      return;
    }
    const f = it.annot ? bounds(it.annot) : (it.area as Area);
    const css = `left:${calc(f.x)};top:${calc(f.y)};width:${calc(f.w)};height:${calc(f.h)}`;
    if (n.getAttribute('style') !== css) n.setAttribute('style', css);
    const kind = it.annot ? it.annot.kind : 'redact';
    if (n.dataset.kind !== kind) n.dataset.kind = kind;
    if (it.annot) {
      const c = contentOf(it.annot, f);
      const handle = this.selected === it.key && BOXED.has(kind) ? '<span class="fs-pdf-handle"></span>' : '';
      setHtml(n, c.html + handle, c.key + handle);
      const title = it.annot.text || it.annot.quote || KIND_LABEL[kind];
      if (n.title !== title) n.title = title;
    } else {
      setHtml(n, this.selected === it.key ? '<span class="fs-pdf-handle"></span>' : '', this.selected === it.key ? 'h' : '');
    }
    setClass(n, 'is-selected', this.selected === it.key);
  }

  select(id: string | null): void {
    if (this.selected === id) return;
    const prev = this.selected;
    this.selected = id;
    for (const key of [prev, id]) {
      if (!key) continue;
      const a = this.items.find((x) => x.id === key) ?? this.areas.find((x) => x.id === key);
      if (a) this.render(a.page - 1);
    }
    this.hooks.select(id);
  }

  setTool(tool: Tool): void {
    this.commitEdit();
    this.cancel();
    if (tool !== 'custom' && this.custom) { this.custom.cancel?.(); this.custom = null; }
    this.customPv = null;
    this.tool = tool;
    if (tool !== 'select') this.select(null);
  }

  remove(id: string | null = this.selected): boolean {
    if (!id) return false;
    if (this.areas.some((a) => a.id === id)) { this.setAreas(this.areas.filter((a) => a.id !== id)); this.select(null); return true; }
    const a = this.items.find((x) => x.id === id);
    if (!a) return false;
    this.select(null);
    this.setItems(this.items.filter((x) => x.id !== id));
    this.hooks.changed(`Delete ${KIND_LABEL[a.kind].toLowerCase()}`);
    return true;
  }

  update(id: string, patch: Partial<Annot>, label: string): void {
    this.setItems(this.items.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    this.hooks.changed(label);
  }

  clear(): void {
    if (!this.items.length) return;
    this.select(null);
    this.setItems([]);
    this.hooks.changed('Discard comments');
  }

  add(a: Annot, label: string): void {
    this.setItems([...this.items, a]);
    this.hooks.changed(label);
  }

  replace(items: Annot[], label: string): void {
    this.setItems(items);
    this.hooks.changed(label);
  }

  pulse(page: number, rects: Rect[]): void {
    for (const old of Array.from(this.viewer.host.querySelectorAll('.fs-pdf-pulse'))) old.remove();
    const layer = this.layers.get(page - 1);
    if (!layer) return;
    for (const r of rects) {
      const n = el(`<div class="fs-pdf-pulse" style="left:${calc(r.x - 2)};top:${calc(r.y - 2)};width:${calc(r.w + 4)};height:${calc(r.h + 4)}"></div>`);
      n.addEventListener('animationend', () => n.remove(), { once: true });
      layer.appendChild(n);
    }
  }

  reveal(id: string): void {
    const a = this.items.find((x) => x.id === id) ?? this.areas.find((x) => x.id === id);
    if (!a) return;
    const f = 'kind' in a ? bounds(a) : a;
    this.viewer.scrollToPoint(a.page - 1, f.x + f.w / 2, f.y);
    this.select(id);
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.tool === 'form') return;
    if (this.tool === 'custom') {
      const pv = this.viewer.pageAtClient(e.clientX, e.clientY);
      if (!pv || !this.custom) return;
      e.preventDefault();
      this.customPv = pv;
      this.viewer.host.setPointerCapture(e.pointerId);
      this.custom.down(pv, this.viewer.toPage(pv, e.clientX, e.clientY), e);
      return;
    }
    const t = e.target as HTMLElement;
    if (t.closest('.fs-pdf-edit, .fs-pdf-field, .fs-pdf-notepop, .fs-pdf-fbox')) return;
    if (this.editing) this.commitEdit();
    if (this.tool === 'hand') {
      e.preventDefault();
      this.pan = { x: e.clientX, y: e.clientY, left: this.viewer.scroller.scrollLeft, top: this.viewer.scroller.scrollTop };
      this.viewer.host.setPointerCapture(e.pointerId);
      return;
    }
    if (this.tool === 'select') {
      const node = t.closest('.fs-pdf-annot') as HTMLElement | null;
      const pv = node ? this.viewer.pageAtClient(e.clientX, e.clientY) : null;
      if (node && pv && node.dataset.key) {
        e.preventDefault();
        const id = node.dataset.key;
        this.select(id);
        const a = this.items.find((x) => x.id === id);
        const area = this.areas.find((x) => x.id === id);
        const p = this.viewer.toPage(pv, e.clientX, e.clientY);
        this.move = { id, pv, x0: p.x, y0: p.y, node, resize: !!t.closest('.fs-pdf-handle'), base: a ? bounds(a) : (area as Area), area: !!area, moved: false };
        this.viewer.host.setPointerCapture(e.pointerId);
        return;
      }
      if (this.selected) this.select(null);
      return;
    }
    if (MARKUP_TOOLS.includes(this.tool)) return;
    const pv = this.viewer.pageAtClient(e.clientX, e.clientY);
    if (!pv) return;
    e.preventDefault();
    const p0 = this.viewer.toPage(pv, e.clientX, e.clientY);
    if (this.tool === 'note' || this.tool === 'place') { this.createAt(pv, p0); return; }
    const layer = this.layers.get(pv.index);
    if (!layer) return;
    const draft = el('<div class="fs-pdf-draft"></div>');
    layer.appendChild(draft);
    this.session = { pv, tool: this.tool, p0, pts: [[p0.x, p0.y]], draft, last: p0 };
    this.viewer.host.setPointerCapture(e.pointerId);
  }

  private moveTo(e: PointerEvent): void {
    if (this.tool === 'custom') {
      const pv = this.customPv ?? this.viewer.pageAtClient(e.clientX, e.clientY);
      if (pv && this.custom?.move) this.custom.move(pv, this.viewer.toPage(pv, e.clientX, e.clientY), e);
      return;
    }
    if (this.pan) {
      this.viewer.scroller.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
      this.viewer.scroller.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      return;
    }
    if (this.move) {
      const m = this.move, p = this.viewer.toPage(m.pv, e.clientX, e.clientY);
      const dx = p.x - m.x0, dy = p.y - m.y0;
      if (!m.moved && Math.hypot(dx, dy) < 1.5) return;
      m.moved = true;
      if (m.resize) {
        m.node.style.width = calc(Math.max(6, m.base.w + dx));
        m.node.style.height = calc(Math.max(6, m.base.h + dy));
      } else {
        m.node.style.left = calc(m.base.x + dx);
        m.node.style.top = calc(m.base.y + dy);
      }
      return;
    }
    const s = this.session;
    if (!s) return;
    const p = this.viewer.toPage(s.pv, e.clientX, e.clientY);
    const W = s.pv.size.w, H = s.pv.size.h;
    p.x = Math.max(0, Math.min(W, p.x));
    p.y = Math.max(0, Math.min(H, p.y));
    s.last = p;
    if (s.tool === 'ink') {
      const prev = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - prev[0], p.y - prev[1]) >= 0.8) s.pts.push([p.x, p.y]);
    }
    const a = this.draftAnnot(s);
    if (!a) return;
    const boxed = s.tool === 'redact' || s.tool === 'freetext' || s.tool === 'crop';
    const f = boxed ? { x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 0, h: a.h ?? 0 } : bounds(a);
    s.draft.setAttribute('style', `left:${calc(f.x)};top:${calc(f.y)};width:${calc(f.w)};height:${calc(f.h)}`);
    s.draft.dataset.kind = s.tool;
    const inner = SVG_KINDS.has(a.kind) && !boxed ? contentOf(a, f).html : '';
    if (inner || s.draft.firstChild) s.draft.innerHTML = inner;
  }

  private draftAnnot(s: Session): Annot | null {
    const { p0, last } = s;
    const box = { x: Math.min(p0.x, last.x), y: Math.min(p0.y, last.y), w: Math.abs(last.x - p0.x), h: Math.abs(last.y - p0.y) };
    const base = { id: 'draft', page: s.pv.index + 1, color: this.style.color, width: this.style.width, opacity: this.style.opacity, rot: this.viewer.total(s.pv) };
    switch (s.tool) {
      case 'ink': return { ...base, kind: 'ink', paths: [s.pts.slice()] };
      case 'rect': case 'ellipse': case 'redact': case 'freetext': case 'crop': return { ...base, kind: s.tool === 'ellipse' ? 'ellipse' : 'rect', ...box };
      case 'line': case 'arrow': return { ...base, kind: s.tool, points: [[p0.x, p0.y], [last.x, last.y]] };
      default: return null;
    }
  }

  private up(e: PointerEvent): void {
    if (this.viewer.host.hasPointerCapture(e.pointerId)) this.viewer.host.releasePointerCapture(e.pointerId);
    if (this.tool === 'custom') {
      const pv = this.customPv;
      this.customPv = null;
      if (pv && this.custom?.up) this.custom.up(pv, this.viewer.toPage(pv, e.clientX, e.clientY), e);
      return;
    }
    if (this.pan) { this.pan = null; return; }
    if (this.move) {
      const m = this.move;
      this.move = null;
      if (!m.moved) return;
      const p = this.viewer.toPage(m.pv, e.clientX, e.clientY);
      const dx = p.x - m.x0, dy = p.y - m.y0;
      if (m.area) {
        this.setAreas(this.areas.map((a) => (a.id !== m.id ? a : m.resize ? { ...a, w: Math.max(4, a.w + dx), h: Math.max(4, a.h + dy) } : { ...a, x: a.x + dx, y: a.y + dy })));
        return;
      }
      const a = this.items.find((x) => x.id === m.id);
      if (!a) return;
      if (m.resize) {
        let w = Math.max(6, (a.w ?? 0) + dx), h = Math.max(6, (a.h ?? 0) + dy);
        if ((a.kind === 'image' || a.kind === 'stamp') && !e.shiftKey && (a.w ?? 0) > 0) h = w * ((a.h ?? 1) / (a.w ?? 1));
        if (a.kind === 'image' && e.shiftKey) w = Math.max(6, w);
        this.update(a.id, { w, h }, `Resize ${KIND_LABEL[a.kind].toLowerCase()}`);
      } else this.update(a.id, shifted(a, dx, dy), `Move ${KIND_LABEL[a.kind].toLowerCase()}`);
      return;
    }
    if (this.session) { this.finish(this.session); return; }
    if (MARKUP_TOOLS.includes(this.tool)) window.setTimeout(() => this.fromSelection(), 0);
  }

  private cancel(): void {
    if (this.session) { this.session.draft.remove(); this.session = null; }
    this.move = null;
    this.pan = null;
  }

  private finish(s: Session): void {
    this.session = null;
    s.draft.remove();
    const a = this.draftAnnot(s);
    if (!a) return;
    const id = uid(s.tool === 'redact' ? 'r' : 'a');
    if (s.tool === 'crop') {
      if ((a.w ?? 0) < 4 || (a.h ?? 0) < 4) return;
      this.setCrop({ id: 'crop', page: a.page, x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 0, h: a.h ?? 0 });
      this.hooks.crop();
      return;
    }
    if (s.tool === 'redact') {
      if ((a.w ?? 0) < 2 || (a.h ?? 0) < 2) return;
      this.setAreas([...this.areas, { id, page: a.page, x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 0, h: a.h ?? 0 }]);
      return;
    }
    if (s.tool === 'freetext') {
      const small = (a.w ?? 0) < 12 || (a.h ?? 0) < 8;
      const size = this.style.size, rot = a.rot ?? 0;
      const box = small ? orient(s.p0, 180, size * 1.3 + 8, rot, s.pv.size.w, s.pv.size.h) : { x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 180, h: a.h ?? 24 };
      const text: Annot = { id, page: a.page, kind: 'freetext', color: this.style.color, opacity: 1, rot, size, ...box, text: '', flatten: this.flattenComments ? true : undefined };
      this.add(text, 'Add text');
      this.hooks.toolDone();
      this.select(id);
      this.edit(id);
      return;
    }
    if (s.tool === 'ink' && (a.paths?.[0]?.length ?? 0) < 2 && Math.hypot(s.last.x - s.p0.x, s.last.y - s.p0.y) < 0.5) return;
    if ((s.tool === 'rect' || s.tool === 'ellipse') && ((a.w ?? 0) < 3 || (a.h ?? 0) < 3)) return;
    if ((s.tool === 'line' || s.tool === 'arrow') && Math.hypot(s.last.x - s.p0.x, s.last.y - s.p0.y) < 3) return;
    this.add({ ...a, id, flatten: this.flattenComments ? true : undefined }, `Add ${KIND_LABEL[a.kind].toLowerCase()}`);
  }

  private createAt(pv: PageView, p: { x: number; y: number }): void {
    const rot = this.viewer.total(pv), W = pv.size.w, H = pv.size.h;
    const clampBox = (w: number, h: number): { x: number; y: number } => ({ x: Math.max(0, Math.min(W - w, p.x - w / 2)), y: Math.max(0, Math.min(H - h, p.y - h / 2)) });
    if (this.tool === 'note') {
      const at = clampBox(NOTE, NOTE);
      const id = uid('a');
      this.add({ id, page: pv.index + 1, kind: 'note', color: this.style.color, opacity: 1, rot, ...at, text: '', flatten: this.flattenComments ? true : undefined }, 'Add note');
      this.hooks.toolDone();
      this.select(id);
      this.edit(id);
      return;
    }
    const pl = this.placement;
    if (!pl) return;
    const id = uid('a');
    if (pl.kind === 'image') {
      const w0 = pl.width, h0 = pl.width / Math.max(0.05, pl.aspect);
      const [w, h] = rot % 180 ? [h0, w0] : [w0, h0];
      this.add({ id, page: pv.index + 1, kind: 'image', color: '#111111', opacity: 1, rot, ...clampBox(w, h), w, h, image: pl.image, flatten: pl.flatten ?? true }, `Place ${pl.label}`);
    } else if (pl.kind === 'stamp') {
      const [w, h] = rot % 180 ? [pl.h, pl.w] : [pl.w, pl.h];
      this.add({ id, page: pv.index + 1, kind: 'stamp', color: pl.color, opacity: 1, rot, ...clampBox(w, h), w, h, stamp: pl.spec, text: [pl.spec.label, pl.spec.sub].filter(Boolean).join(' ') || (pl.spec.mark === 'cross' ? 'Cross' : 'Check mark'), flatten: pl.flatten ? true : undefined }, `Place ${pl.label}`);
    } else {
      const w0 = Math.max(40, pl.text.length * pl.size * 0.56 + 10), h0 = pl.size * 1.3 + 8;
      const [w, h] = rot % 180 ? [h0, w0] : [w0, h0];
      this.add({ id, page: pv.index + 1, kind: 'freetext', color: this.style.color === '#FFD400' ? '#111111' : this.style.color, opacity: 1, rot, size: pl.size, ...clampBox(w, h), w, h, text: pl.text, flatten: true }, `Place ${pl.label}`);
    }
    this.select(id);
    this.placement = null;
    this.hooks.toolDone();
  }

  private fromSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.viewer.host.contains(range.commonAncestorContainer)) return;
    const by = new Map<number, Rect[]>();
    let rot = 0;
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const pv = this.viewer.pageAtClient(r.left + r.width / 2, r.top + r.height / 2);
      if (!pv) continue;
      const box = pv.box.getBoundingClientRect();
      if (r.height > box.height * 0.25 && r.width > box.width * 0.25) continue;
      const a = this.viewer.toPage(pv, r.left, r.top), b = this.viewer.toPage(pv, r.right, r.bottom);
      rot = this.viewer.total(pv);
      const list = by.get(pv.index) ?? [];
      list.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
      by.set(pv.index, list);
    }
    const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 240);
    sel.removeAllRanges();
    const kind = this.tool as 'highlight' | 'underline' | 'strikeout';
    let last = '';
    for (const [page, rects] of by) {
      const merged = merge(rects, rot);
      if (!merged.length) continue;
      last = uid('a');
      this.items = [...this.items, { id: last, page: page + 1, kind, color: this.style.color, opacity: kind === 'highlight' ? 0.4 : this.style.opacity, rot, rects: merged, quote, flatten: this.flattenComments ? true : undefined }];
      this.render(page);
    }
    if (last) this.hooks.changed(`Add ${KIND_LABEL[kind].toLowerCase()}`);
  }

  edit(id: string): void {
    this.commitEdit();
    const a = this.items.find((x) => x.id === id);
    const layer = a ? this.layers.get(a.page - 1) : undefined;
    const node = layer?.querySelector(`.fs-pdf-annot[data-key="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!a || !layer || !node) return;
    const input = el<HTMLTextAreaElement>('<textarea class="fs-pdf-edit" spellcheck="true" rows="1"></textarea>');
    input.value = a.text ?? '';
    let box: HTMLElement;
    if (a.kind === 'note') {
      box = el(`<div class="fs-pdf-notepop" style="left:${calc((a.x ?? 0) + NOTE + 4)};top:${calc(a.y ?? 0)}"></div>`);
      input.placeholder = 'Write a note';
      box.appendChild(input);
      layer.appendChild(box);
    } else {
      box = node.querySelector('.fs-pdf-upright') as HTMLElement;
      input.setAttribute('style', `font-size:${calc(a.size ?? 12)};color:${a.color}`);
      input.placeholder = 'Type here';
      node.classList.add('is-editing');
      box.appendChild(input);
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.commitEdit(); }
    });
    input.addEventListener('blur', () => window.setTimeout(() => { if (this.editing?.input === input) this.commitEdit(); }, 0));
    this.editing = { id, box, input };
    input.focus();
  }

  commitEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const a = this.items.find((x) => x.id === ed.id);
    const text = ed.input.value.replace(/\s+$/, '');
    if (a?.kind === 'note') ed.box.remove();
    else { ed.input.remove(); ed.box.closest('.fs-pdf-annot')?.classList.remove('is-editing'); }
    if (!a) return;
    if (a.kind === 'freetext' && !text.trim()) { this.select(null); this.setItems(this.items.filter((x) => x.id !== a.id)); this.hooks.changed('Delete text'); return; }
    if (text !== (a.text ?? '')) this.update(a.id, { text }, a.kind === 'note' ? 'Edit note' : 'Edit text');
  }

  get isEditing(): boolean { return this.editing !== null; }
}

function orient(p: { x: number; y: number }, dw: number, dh: number, rot: number, W: number, H: number): Rect {
  const ex = rot === 90 ? [0, -1] : rot === 180 ? [-1, 0] : rot === 270 ? [0, 1] : [1, 0];
  const ey = rot === 90 ? [1, 0] : rot === 180 ? [0, -1] : rot === 270 ? [-1, 0] : [0, 1];
  const cx = p.x + dw * ex[0] + dh * ey[0], cy = p.y + dw * ex[1] + dh * ey[1];
  const w = Math.abs(cx - p.x), h = Math.abs(cy - p.y);
  return { x: Math.max(0, Math.min(W - w, Math.min(p.x, cx))), y: Math.max(0, Math.min(H - h, Math.min(p.y, cy))), w, h };
}

function merge(rects: Rect[], rot: number): Rect[] {
  const horizontal = rot % 180 === 0;
  const sorted = rects.slice().sort((a, b) => (horizontal ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
  const out: Rect[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const overlap = horizontal ? Math.min(prev.y + prev.h, r.y + r.h) - Math.max(prev.y, r.y) : Math.min(prev.x + prev.w, r.x + r.w) - Math.max(prev.x, r.x);
      const gap = horizontal ? r.x - (prev.x + prev.w) : r.y - (prev.y + prev.h);
      const size = horizontal ? Math.min(prev.h, r.h) : Math.min(prev.w, r.w);
      if (overlap > size * 0.5 && gap < size * 0.6 && gap > -size * 4) {
        const x0 = Math.min(prev.x, r.x), y0 = Math.min(prev.y, r.y);
        out[out.length - 1] = { x: x0, y: y0, w: Math.max(prev.x + prev.w, r.x + r.w) - x0, h: Math.max(prev.y + prev.h, r.y + r.h) - y0 };
        continue;
      }
    }
    out.push({ ...r });
  }
  return out.filter((r) => r.w > 0.5 && r.h > 0.5);
}
