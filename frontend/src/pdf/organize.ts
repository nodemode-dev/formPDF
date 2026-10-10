import { el, patchList, setClass, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import type { OrganizePage, PageSize } from './api';

export interface OrgItem { key: string; src: string; page: number; rotate: number; blank?: boolean; w: number; h: number; base: number; from?: string }
export interface OrgHooks { thumb(item: OrgItem): Promise<HTMLCanvasElement | string>; changed(): void; drop(files: File[], at: number): void }

const BOX = 148;
let seq = 0;
const nextKey = (): string => `o${(seq++).toString(36)}`;

export class Organizer {
  readonly root: HTMLElement;
  readonly grid: HTMLElement;
  items: OrgItem[] = [];
  selected = new Set<string>();
  dirty = false;
  docId = '';
  private anchorKey: string | null = null;
  private readonly io: IntersectionObserver;
  private drawn = new Map<string, string>();
  private drag: { keys: string[]; x: number; y: number; started: boolean; ghost: HTMLElement | null; target: number; pointer: number } | null = null;
  private scrollTimer = 0;

  constructor(private readonly hooks: OrgHooks) {
    this.root = el('<div class="fs-pdf-org" tabindex="-1"><div class="fs-pdf-org-grid" role="listbox" aria-multiselectable="true"></div><div class="fs-pdf-org-marker" hidden></div></div>');
    this.grid = this.root.firstElementChild as HTMLElement;
    this.io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) this.loadThumb(e.target as HTMLElement); }, { root: this.root, rootMargin: '300px 0px' });
    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.moveTo(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', () => this.endDrag());
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); this.markDrop(e.clientX, e.clientY); } });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget as Node | null)) this.hideMarker(); });
    this.root.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const at = this.dropIndex(e.clientX, e.clientY);
      this.hideMarker();
      this.hooks.drop(files, at);
    });
  }

  reset(docId: string, sizes: PageSize[]): void {
    this.docId = docId;
    this.items = sizes.map((s, i) => ({ key: nextKey(), src: docId, page: i + 1, rotate: 0, w: s.w, h: s.h, base: s.rotate }));
    this.selected.clear();
    this.anchorKey = null;
    this.dirty = false;
    this.drawn.clear();
    this.render();
  }

  payload(items = this.items): OrganizePage[] {
    return items.map((it) => (it.blank ? { blank: true as const, w: it.w, h: it.h } : { src: it.src, page: it.page, rotate: it.rotate }));
  }

  selection(): OrgItem[] { return this.items.filter((it) => this.selected.has(it.key)); }

  insertAt(): number {
    const idx = this.items.map((it, i) => (this.selected.has(it.key) ? i : -1)).filter((i) => i >= 0);
    return idx.length ? Math.max(...idx) + 1 : this.items.length;
  }

  insert(items: Array<Omit<OrgItem, 'key'>>, at: number): void {
    const made = items.map((it) => ({ ...it, key: nextKey() }));
    this.items.splice(Math.max(0, Math.min(this.items.length, at)), 0, ...made);
    this.selected = new Set(made.map((m) => m.key));
    this.touch();
  }

  rotate(delta: 90 | -90): void {
    const sel = this.selected.size ? this.selected : new Set(this.items.map((i) => i.key));
    for (const it of this.items) if (sel.has(it.key)) it.rotate = (it.rotate + delta + 360) % 360;
    this.touch();
  }

  remove(): void {
    if (!this.selected.size) return;
    this.items = this.items.filter((it) => !this.selected.has(it.key));
    this.selected.clear();
    this.touch();
  }

  blank(): void {
    const at = this.insertAt();
    const ref = this.items[Math.max(0, at - 1)];
    const odd = ref ? (ref.base + ref.rotate) % 180 !== 0 : false;
    this.insert([{ src: '', page: 0, rotate: 0, blank: true, w: ref ? (odd ? ref.h : ref.w) : 612, h: ref ? (odd ? ref.w : ref.h) : 792, base: 0 }], at);
  }

  selectAll(): void { this.selected = new Set(this.items.map((i) => i.key)); this.render(); this.hooks.changed(); }

  private touch(): void { this.dirty = true; this.render(); this.hooks.changed(); }

  render(): void {
    patchList(this.grid, this.items, {
      key: (it) => it.key,
      create: (it) => {
        const n = el(`<div class="fs-pdf-card" role="option" tabindex="-1"><div class="fs-pdf-card-box"><div class="fs-pdf-card-thumb"></div></div><div class="fs-pdf-card-foot"><span class="fs-pdf-card-n"></span><span class="fs-pdf-card-from"></span></div></div>`);
        this.paint(n, it);
        this.io.observe(n);
        return n;
      },
      update: (n, it) => this.paint(n, it),
    });
    this.items.forEach((it, i) => {
      const n = this.grid.children[i] as HTMLElement;
      setText(n.querySelector('.fs-pdf-card-n'), String(i + 1));
    });
  }

  private paint(n: HTMLElement, it: OrgItem): void {
    const odd = it.base % 180 !== 0;
    const bw = odd ? it.h : it.w, bh = odd ? it.w : it.h;
    const turned = it.rotate % 180 !== 0;
    const va = turned ? bh / bw : bw / bh;
    const [vw, vh] = va >= 1 ? [BOX, BOX / va] : [BOX * va, BOX];
    const [ew, eh] = turned ? [vh, vw] : [vw, vh];
    const thumb = n.querySelector('.fs-pdf-card-thumb') as HTMLElement;
    const css = `width:${Math.round(ew)}px;height:${Math.round(eh)}px;transform:translate(-50%,-50%) rotate(${it.rotate}deg)`;
    if (thumb.getAttribute('style') !== css) thumb.setAttribute('style', css);
    setClass(n, 'is-selected', this.selected.has(it.key));
    n.setAttribute('aria-selected', String(this.selected.has(it.key)));
    setClass(n, 'is-blank', !!it.blank);
    setText(n.querySelector('.fs-pdf-card-from'), it.blank ? 'Blank' : it.from ? `${it.from} p${it.page}` : it.rotate ? `${it.rotate}°` : '');
    if (it.blank && !thumb.firstChild) thumb.appendChild(el(`<span class="fs-pdf-card-blank">${icon('fileText', 18)}</span>`));
  }

  private loadThumb(n: HTMLElement): void {
    const it = this.items.find((x) => x.key === n.dataset.key);
    if (!it || it.blank) return;
    const sig = `${it.src}|${it.page}`;
    if (this.drawn.get(it.key) === sig) return;
    this.drawn.set(it.key, sig);
    const thumb = n.querySelector('.fs-pdf-card-thumb') as HTMLElement;
    void this.hooks.thumb(it).then((src) => {
      if (typeof src === 'string') {
        const img = new Image();
        img.decoding = 'async';
        img.draggable = false;
        img.alt = '';
        img.onload = () => thumb.replaceChildren(img);
        img.src = src;
      } else {
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        c.getContext('2d')?.drawImage(src, 0, 0);
        thumb.replaceChildren(c);
      }
    }).catch(() => this.drawn.delete(it.key));
  }

  private cardAt(x: number, y: number): { index: number; after: boolean } | null {
    const cards = Array.from(this.grid.children) as HTMLElement[];
    let best: { index: number; after: boolean; d: number } | null = null;
    cards.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      if (y < r.top - 12 || y > r.bottom + 12) return;
      const d = Math.abs(x - (r.left + r.width / 2));
      if (!best || d < best.d) best = { index: i, after: x > r.left + r.width / 2, d };
    });
    return best;
  }

  private dropIndex(x: number, y: number): number {
    const hit = this.cardAt(x, y);
    if (!hit) return this.items.length;
    return hit.index + (hit.after ? 1 : 0);
  }

  private markDrop(x: number, y: number): void {
    const marker = this.root.querySelector('.fs-pdf-org-marker') as HTMLElement;
    const hit = this.cardAt(x, y);
    const cards = this.grid.children;
    if (!hit || !cards.length) { marker.hidden = true; return; }
    const r = (cards[hit.index] as HTMLElement).getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    const left = (hit.after ? r.right + 6 : r.left - 6) - rr.left + this.root.scrollLeft;
    marker.style.left = `${Math.round(left - 1)}px`;
    marker.style.top = `${Math.round(r.top - rr.top + this.root.scrollTop)}px`;
    marker.style.height = `${Math.round(r.height)}px`;
    marker.hidden = false;
  }

  private hideMarker(): void { (this.root.querySelector('.fs-pdf-org-marker') as HTMLElement).hidden = true; }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const card = (e.target as HTMLElement).closest('.fs-pdf-card') as HTMLElement | null;
    if (!card) { if (e.target === this.root || e.target === this.grid) { this.selected.clear(); this.render(); this.hooks.changed(); } return; }
    const key = card.dataset.key as string;
    const mod = e.metaKey || e.ctrlKey;
    if (e.shiftKey && this.anchorKey) {
      const a = this.items.findIndex((i) => i.key === this.anchorKey), b = this.items.findIndex((i) => i.key === key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selected = new Set(this.items.slice(lo, hi + 1).map((i) => i.key));
    } else if (mod) {
      if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
      this.anchorKey = key;
    } else if (!this.selected.has(key)) {
      this.selected = new Set([key]);
      this.anchorKey = key;
    }
    this.render();
    this.hooks.changed();
    this.root.focus({ preventScroll: true });
    this.drag = { keys: this.items.filter((i) => this.selected.has(i.key)).map((i) => i.key), x: e.clientX, y: e.clientY, started: false, ghost: null, target: -1, pointer: e.pointerId };
  }

  private moveTo(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.started = true;
      this.root.setPointerCapture(d.pointer);
      d.ghost = el(`<div class="fs-pdf-org-ghost">${d.keys.length} page${d.keys.length === 1 ? '' : 's'}</div>`);
      this.root.appendChild(d.ghost);
      for (const k of d.keys) setClass(this.grid.querySelector(`[data-key="${k}"]`) as HTMLElement, 'is-dragging', true);
    }
    const rr = this.root.getBoundingClientRect();
    if (d.ghost) { d.ghost.style.left = `${e.clientX - rr.left + this.root.scrollLeft + 12}px`; d.ghost.style.top = `${e.clientY - rr.top + this.root.scrollTop + 12}px`; }
    d.target = this.dropIndex(e.clientX, e.clientY);
    this.markDrop(e.clientX, e.clientY);
    window.clearInterval(this.scrollTimer);
    const edge = 40;
    const dir = e.clientY < rr.top + edge ? -1 : e.clientY > rr.bottom - edge ? 1 : 0;
    if (dir) this.scrollTimer = window.setInterval(() => { this.root.scrollTop += dir * 14; }, 16);
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      const card = (e.target as HTMLElement).closest('.fs-pdf-card') as HTMLElement | null;
      if (card && !e.shiftKey && !e.metaKey && !e.ctrlKey && this.selected.size > 1) { this.selected = new Set([card.dataset.key as string]); this.anchorKey = card.dataset.key as string; this.render(); this.hooks.changed(); }
      this.drag = null;
      return;
    }
    const keys = new Set(d.keys);
    const moving = this.items.filter((i) => keys.has(i.key));
    const before = this.items.slice(0, Math.max(0, d.target)).filter((i) => !keys.has(i.key)).length;
    const rest = this.items.filter((i) => !keys.has(i.key));
    const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    const changed = next.some((it, i) => it !== this.items[i]);
    this.endDrag();
    if (changed) { this.items = next; this.touch(); }
  }

  private endDrag(): void {
    const d = this.drag;
    this.drag = null;
    window.clearInterval(this.scrollTimer);
    this.hideMarker();
    if (!d) return;
    if (this.root.hasPointerCapture(d.pointer)) this.root.releasePointerCapture(d.pointer);
    d.ghost?.remove();
    for (const k of d.keys) { const n = this.grid.querySelector(`[data-key="${k}"]`) as HTMLElement | null; if (n) setClass(n, 'is-dragging', false); }
  }
}
