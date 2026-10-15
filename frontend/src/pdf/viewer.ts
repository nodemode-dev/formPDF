import { AnnotationMode, getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PageViewport, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { RefProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { el, patchList, setClass, setStyleVar } from '../ui/dom';
import type { PageSize } from './api';

GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = import.meta.glob<string>(['../../node_modules/pdfjs-dist/cmaps/*.bcmap', '../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', '../../node_modules/pdfjs-dist/wasm/*.wasm'], { query: '?url', import: 'default', eager: true, exhaustive: true });
const ASSET_URL = new Map<string, string>(Object.entries(ASSETS).map(([p, u]) => [p.slice(p.lastIndexOf('/') + 1), u]));

class BinaryData {
  async fetch({ filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = ASSET_URL.get(filename);
    if (!url) throw new Error(`missing pdf asset ${filename}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pdf asset ${filename}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export function openDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data, BinaryDataFactory: BinaryData, useWorkerFetch: false, enableXfa: false }).promise;
}

export const CSS_UNITS = 96 / 72;
const MAX_PIXELS = 16777216;
const KEEP_CANVASES = 24;
const KEEP_PREVIEWS = 300;
const LARGE_PAGES = 200;
const LARGE_BYTES = 50 * 1048576;
const SETTLE_LARGE = 140;
const TEXT_IDLE = 350;
export type PreviewUrl = (page: number, scale: number) => string;
const THUMB_W = 120;
const THUMB_H = 156;
const PAD = 16;

export type FitMode = 'width' | 'page' | null;
export type Layout = 'single' | 'continuous' | 'two' | 'two-continuous';
const GAP_X = 10;
interface LinkAnnot { subtype?: string; rect?: number[]; url?: string; dest?: unknown }
export interface Hit { page: number; start: number; end: number }
interface PageText { text: string; starts: number[]; lens: number[] }

export function isTextItem(i: unknown): i is TextItem {
  return typeof i === 'object' && i !== null && typeof (i as TextItem).str === 'string';
}

export class PageView {
  readonly box: HTMLElement;
  textHost: HTMLElement;
  readonly space: HTMLElement;
  readonly hits: HTMLElement;
  canvas: HTMLCanvasElement | null = null;
  renderedKey = '';
  task: RenderTask | null = null;
  text: TextLayer | null = null;
  textKey = '';
  visible = false;
  seen = 0;
  linksGen = -1;
  preview: HTMLImageElement | null = null;
  previewKey = '';
  shown = 0;
  constructor(readonly index: number, public size: PageSize) {
    this.box = el(`<div class="fs-pdf-page" data-key="${index}" data-page="${index + 1}"><div class="textLayer"></div><div class="fs-pdf-space"><div class="fs-pdf-hits"></div></div></div>`);
    this.textHost = this.box.querySelector('.textLayer') as HTMLElement;
    this.space = this.box.querySelector('.fs-pdf-space') as HTMLElement;
    this.hits = this.space.querySelector('.fs-pdf-hits') as HTMLElement;
  }
}

export interface ViewerHooks {
  page(n: number): void;
  zoom(pct: number): void;
  mounted(pv: PageView): void;
  textReady(pv: PageView): void;
  rendered(pv: PageView): void;
  link?(url: string): void;
}

export class Viewer {
  readonly scroller: HTMLElement;
  readonly host: HTMLElement;
  doc: PDFDocumentProxy | null = null;
  pages: PageView[] = [];
  sizes: PageSize[] = [];
  zoom = 1;
  fit: FitMode = 'width';
  viewRot = 0;
  gen = 0;
  layout: Layout = 'continuous';
  cover = false;
  private flipAt = 0;
  private flipAcc = 0;
  private task: PDFDocumentLoadingTask | null = null;
  private readonly io: IntersectionObserver;
  private active = 0;
  private queued = false;
  private settleAt = 0;
  private current = 1;
  private texts = new Map<number, Promise<TextContent>>();
  private plain = new Map<number, Promise<PageText>>();
  private thumbs = new Map<string, Promise<HTMLCanvasElement>>();
  private scrollQueued = false;
  private parked: { page: number; rel: number; ay: number; ax: number; left: number } | null = null;
  large = false;
  previewUrl: PreviewUrl | null = null;
  private textTimer = 0;

  constructor(parent: HTMLElement, private readonly hooks: ViewerHooks) {
    this.scroller = el('<div class="fs-pdf-scroll" tabindex="-1"><div class="fs-pdf-pages"></div></div>');
    this.host = this.scroller.firstElementChild as HTMLElement;
    parent.appendChild(this.scroller);
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const pv = this.pages[Number((e.target as HTMLElement).dataset.key)];
        if (pv) { if (e.isIntersecting && !pv.visible) pv.shown = performance.now(); pv.visible = e.isIntersecting; if (pv.visible) pv.seen = performance.now(); }
      }
      this.schedule();
    }, { root: this.scroller, rootMargin: '900px 200px' });
    this.scroller.addEventListener('scroll', () => {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => { this.scrollQueued = false; this.track(); if (this.large && this.doc) this.previews(); });
      if (this.large) { this.lastScroll = performance.now(); window.clearTimeout(this.textTimer); this.textTimer = window.setTimeout(() => this.idleText(), TEXT_IDLE); }
    }, { passive: true });
    new ResizeObserver(() => { if (this.fit && this.pages.length && this.scroller.clientWidth) this.applyFit(this.fit, false); }).observe(this.scroller);
    this.scroller.addEventListener('wheel', (e) => this.wheelFlip(e), { passive: true });
    this.applyK();
  }

  get paged(): boolean { return this.layout === 'single' || this.layout === 'two'; }

  private get twoUp(): boolean { return this.layout === 'two' || this.layout === 'two-continuous'; }

  spread(n: number): number[] {
    const total = this.pages.length;
    const p = Math.max(1, Math.min(total, n));
    if (!this.twoUp) return [p];
    if (this.cover) return p === 1 ? [1] : [p % 2 === 0 ? p : p - 1, p % 2 === 0 ? p + 1 : p].filter((x) => x <= total);
    const first = p % 2 === 1 ? p : p - 1;
    return [first, first + 1].filter((x) => x <= total);
  }

  setLayout(layout: Layout, cover: boolean): void {
    const n = this.current;
    this.layout = layout;
    this.cover = cover;
    const h = this.host;
    if (h.dataset.layout !== layout) h.dataset.layout = layout;
    if (h.hasAttribute('data-cover') !== cover) h.toggleAttribute('data-cover', cover);
    if (h.hasAttribute('data-paged') !== this.paged) h.toggleAttribute('data-paged', this.paged);
    this.showSpread(this.paged ? n : 0);
    if (!this.scroller.clientHeight || !this.pages.length) return;
    if (this.fit) this.applyFit(this.fit, false);
    this.goTo(n);
    this.schedule();
  }

  private showSpread(n: number): void {
    const keep = new Set(n ? this.spread(n) : []);
    for (const pv of this.pages) setClass(pv.box, 'is-off', n > 0 && !keep.has(pv.index + 1));
  }

  isShown(index: number): boolean { return !this.pages[index]?.box.classList.contains('is-off'); }

  step(dir: 1 | -1): void {
    const cur = this.spread(this.current);
    const target = dir > 0 ? cur[cur.length - 1] + 1 : cur[0] - 1;
    if (target >= 1 && target <= this.pages.length) this.goTo(target);
  }

  private wheelFlip(e: WheelEvent): void {
    if (!this.paged || e.ctrlKey || e.metaKey || !this.pages.length || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const s = this.scroller, atEnd = s.scrollTop + s.clientHeight >= s.scrollHeight - 2, atTop = s.scrollTop <= 1;
    if (!(e.deltaY > 0 ? atEnd : atTop)) { this.flipAcc = 0; return; }
    this.flipAcc += e.deltaY;
    const now = performance.now();
    if (Math.abs(this.flipAcc) < 80 || now - this.flipAt < 420) return;
    this.flipAcc = 0;
    this.flipAt = now;
    const before = this.current;
    this.step(e.deltaY > 0 ? 1 : -1);
    if (this.current !== before && e.deltaY < 0) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  park(): void {
    if (this.scroller.clientHeight && this.pages.length) this.parked = this.anchor(0, 0);
  }

  unpark(): void {
    if (!this.scroller.clientHeight) return;
    if (this.fit && this.pages.length) this.applyFit(this.fit, false);
    if (this.parked) { this.restore(this.parked); this.parked = null; }
    this.track();
    this.schedule();
  }

  k(): number { return this.zoom * CSS_UNITS; }
  total(pv: PageView | number): number { const s = typeof pv === 'number' ? this.sizes[pv] : pv.size; return ((s?.rotate ?? 0) + this.viewRot) % 360; }
  currentPage(): number { return this.current; }

  async load(url: string, sizes: PageSize[], opts: { password?: string; onPassword?: (retry: boolean) => Promise<string | null>; keep?: boolean; bytes?: number; preview?: PreviewUrl } = {}): Promise<PDFDocumentProxy> {
    const keepAt = opts.keep && this.scroller.clientHeight ? this.anchor() : null;
    this.task?.destroy().catch(() => undefined);
    const large = sizes.length >= LARGE_PAGES || (opts.bytes ?? 0) >= LARGE_BYTES;
    const task = getDocument({ url, password: opts.password, BinaryDataFactory: BinaryData, useWorkerFetch: false, enableXfa: false,
      ...(large ? { disableAutoFetch: true, disableStream: true, rangeChunkSize: 1048576 } : {}) });
    this.task = task;
    if (opts.onPassword) {
      const ask = opts.onPassword;
      task.onPassword = (update: (pw: string) => void, reason: number) => {
        void ask(reason === 2).then((pw) => { if (pw === null) void task.destroy(); else update(pw); });
      };
    }
    const doc = await task.promise;
    if (this.task !== task) { void task.destroy(); throw new Error('superseded'); }
    this.task = null;
    const old = this.doc;
    this.doc = doc;
    this.gen += 1;
    this.large = large;
    this.previewUrl = opts.preview ?? null;
    if (this.host.hasAttribute('data-large') !== large) this.host.toggleAttribute('data-large', large);
    this.texts.clear();
    this.plain.clear();
    this.thumbs.clear();
    for (const pv of this.pages) { pv.task?.cancel(); pv.task = null; }
    this.setSizes(sizes);
    if (this.paged) {
      const at = opts.keep ? Math.min(this.current, sizes.length) || 1 : 1;
      this.showSpread(at);
      if (at !== this.current) { this.current = at; this.hooks.page(at); }
    }
    const shown = this.scroller.clientHeight > 0;
    if (!opts.keep) {
      this.fit = 'width';
      this.viewRot = 0;
      this.parked = shown ? null : { page: 0, rel: 0, ay: 0, ax: 0, left: 0 };
      if (shown) this.applyFit('width', false);
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = 0;
    } else if (!shown) {
      this.parked = this.parked ?? keepAt;
    } else if (keepAt) {
      if (this.fit) this.applyFit(this.fit, false);
      this.restore(keepAt);
    }
    this.track();
    this.schedule();
    if (old && old !== doc) window.setTimeout(() => void old.loadingTask.destroy(), 1500);
    return doc;
  }

  close(): void {
    this.task?.destroy().catch(() => undefined);
    this.task = null;
    const doc = this.doc;
    this.doc = null;
    this.gen += 1;
    for (const pv of this.pages) { pv.task?.cancel(); this.io.unobserve(pv.box); pv.box.remove(); }
    this.pages = [];
    this.sizes = [];
    if (doc) void doc.loadingTask.destroy();
  }

  private setSizes(sizes: PageSize[]): void {
    this.sizes = sizes;
    const next: PageView[] = [];
    for (let i = 0; i < sizes.length; i++) {
      let pv = this.pages[i];
      if (!pv) {
        pv = new PageView(i, sizes[i]);
        this.io.observe(pv.box);
        this.hooks.mounted(pv);
      }
      pv.size = sizes[i];
      next.push(pv);
    }
    for (const pv of this.pages.slice(sizes.length)) { pv.task?.cancel(); this.io.unobserve(pv.box); }
    this.pages = next;
    patchList(this.host, next, { key: (pv) => String(pv.index), create: (pv) => pv.box, update: () => undefined });
    for (const pv of next) { this.dims(pv); pv.textKey = ''; pv.renderedKey = pv.renderedKey ? 'stale' : ''; }
  }

  private dims(pv: PageView): void {
    const t = this.total(pv), { w, h } = pv.size;
    setStyleVar(pv.box, '--pw', String(t % 180 ? h : w));
    setStyleVar(pv.box, '--ph', String(t % 180 ? w : h));
    setStyleVar(pv.space, '--rw', String(w));
    setStyleVar(pv.space, '--rh', String(h));
    if (pv.space.dataset.mainRotation !== String(t)) pv.space.dataset.mainRotation = String(t);
  }

  private applyK(): void {
    setStyleVar(this.host, '--k', String(this.k()));
    this.hooks.zoom(Math.round(this.zoom * 100));
  }

  private anchor(ax?: number, ay?: number): { page: number; rel: number; ay: number; ax: number; left: number } | null {
    if (!this.pages.length) return null;
    const y = this.scroller.scrollTop + (ay ?? 0);
    const list = this.paged ? this.pages.filter((p) => !p.box.classList.contains('is-off')) : this.pages;
    let pv = list[0] ?? this.pages[0];
    for (const p of list) { if (p.box.offsetTop <= y) pv = p; else break; }
    return { page: pv.index, rel: (y - pv.box.offsetTop) / Math.max(1, pv.box.offsetHeight), ay: ay ?? 0, ax: ax ?? 0, left: this.scroller.scrollLeft + (ax ?? 0) };
  }

  private restore(a: { page: number; rel: number; ay: number; ax: number; left: number }, ratio = 1): void {
    const pv = this.pages[Math.min(a.page, this.pages.length - 1)];
    if (!pv) return;
    this.scroller.scrollTop = pv.box.offsetTop + a.rel * pv.box.offsetHeight - a.ay;
    if (this.fit) this.center();
    else this.scroller.scrollLeft = a.left * ratio - a.ax;
  }

  private center(): void { this.scroller.scrollLeft = Math.max(0, (this.host.scrollWidth - this.scroller.clientWidth) / 2); }

  setZoom(z: number, at?: { x: number; y: number }, keepFit = false): void {
    const next = Math.max(0.1, Math.min(8, z));
    if (Math.abs(next - this.zoom) < 1e-4) return;
    const r = this.scroller.getBoundingClientRect();
    const ax = at ? at.x - r.left : this.scroller.clientWidth / 2;
    const ay = at ? at.y - r.top : this.scroller.clientHeight / 2;
    const a = this.anchor(ax, ay);
    const ratio = next / this.zoom;
    this.zoom = next;
    if (!keepFit) this.fit = null;
    this.applyK();
    if (a) this.restore(a, ratio);
    this.settleAt = performance.now() + 180;
    this.schedule();
    this.track();
  }

  zoomStep(dir: 1 | -1, at?: { x: number; y: number }): void {
    const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
    const cur = this.zoom;
    const next = dir > 0 ? steps.find((s) => s > cur + 0.001) ?? 8 : [...steps].reverse().find((s) => s < cur - 0.001) ?? 0.1;
    this.setZoom(next, at);
  }

  applyFit(mode: 'width' | 'page', anchor = true): void {
    const pv = this.pages[this.current - 1] ?? this.pages[0];
    if (!pv) return;
    let pw = 0, ph = 0;
    for (const n of this.spread(pv.index + 1)) {
      const p = this.pages[n - 1], t = this.total(p);
      pw += (t % 180 ? p.size.h : p.size.w) * CSS_UNITS;
      ph = Math.max(ph, (t % 180 ? p.size.w : p.size.h) * CSS_UNITS);
    }
    if (this.twoUp && this.spread(pv.index + 1).length === 1) pw *= 2;
    const gap = this.twoUp ? GAP_X : 0;
    const availW = Math.max(80, this.scroller.clientWidth - PAD * 2 - 8 - gap), availH = Math.max(80, this.scroller.clientHeight - PAD * 2);
    const z = mode === 'width' ? Math.min(availW / pw, 4) : Math.min(availW / pw, availH / ph);
    this.fit = mode;
    if (anchor) { this.setZoom(z, undefined, true); if (mode === 'page') this.goTo(this.current); return; }
    this.zoom = Math.max(0.1, Math.min(8, z));
    this.applyK();
    this.center();
    this.settleAt = performance.now() + 120;
    this.schedule();
  }

  rotateView(delta: 90 | -90): void {
    const a = this.anchor(0, 0);
    this.viewRot = (this.viewRot + delta + 360) % 360;
    for (const pv of this.pages) { this.dims(pv); pv.textKey = ''; }
    if (this.fit) this.applyFit(this.fit, false);
    if (a) this.restore({ ...a, rel: 0, ay: 0 });
    this.schedule();
  }

  goTo(n: number, smooth = false): void {
    const pv = this.pages[Math.max(0, Math.min(this.pages.length - 1, n - 1))];
    if (!pv) return;
    if (this.paged) {
      const first = this.spread(pv.index + 1)[0];
      this.showSpread(first);
      this.scroller.scrollTop = 0;
      if (this.fit) this.center();
      if (first !== this.current) { this.current = first; this.hooks.page(first); }
      this.schedule();
      return;
    }
    this.scroller.scrollTo({ top: Math.max(0, pv.box.offsetTop - PAD), behavior: smooth ? 'smooth' : 'auto' });
    this.track();
  }

  scrollToPoint(page: number, x: number, y: number): void {
    const pv = this.pages[page];
    if (!pv) return;
    if (this.paged && !this.isShown(page)) this.goTo(page + 1);
    const k = this.k(), t = this.total(pv), W = pv.size.w, H = pv.size.h;
    const [dx, dy] = t === 90 ? [H - y, x] : t === 180 ? [W - x, H - y] : t === 270 ? [y, W - x] : [x, y];
    this.scroller.scrollTop = pv.box.offsetTop + dy * k - this.scroller.clientHeight / 3;
    const left = pv.box.offsetLeft + dx * k - this.scroller.clientWidth / 2;
    if (left > this.scroller.scrollLeft + this.scroller.clientWidth - 40 || left < this.scroller.scrollLeft) this.scroller.scrollLeft = Math.max(0, left);
  }

  private track(): void {
    if (!this.pages.length || !this.scroller.clientHeight || this.paged) return;
    const y = this.scroller.scrollTop + this.scroller.clientHeight * 0.3;
    let n = 1, top = -1;
    for (const p of this.pages) { const t = p.box.offsetTop; if (t <= y) { if (t > top) { n = p.index + 1; top = t; } } else break; }
    if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 2) {
      const last = this.pages[this.pages.length - 1];
      if (last.box.offsetTop >= this.scroller.scrollTop) n = this.spread(last.index + 1)[0];
    }
    if (n !== this.current) { this.current = n; this.hooks.page(n); }
  }

  pageAtClient(x: number, y: number): PageView | null {
    for (const pv of this.pages) {
      if (!pv.visible) continue;
      const r = pv.box.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return pv;
    }
    return null;
  }

  toPage(pv: PageView, cx: number, cy: number): { x: number; y: number } {
    const r = pv.box.getBoundingClientRect(), k = this.k();
    const dx = cx - r.left, dy = cy - r.top, W = pv.size.w * k, H = pv.size.h * k;
    const t = this.total(pv);
    const [px, py] = t === 90 ? [dy, H - dx] : t === 180 ? [W - dx, H - dy] : t === 270 ? [W - dy, dx] : [dx, dy];
    return { x: px / k, y: py / k };
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.pump(); });
  }

  private key(pv: PageView): string { return `${this.gen}|${this.k().toFixed(4)}|${this.total(pv)}`; }

  private previewScale(): number {
    const want = this.k() * Math.min(2, window.devicePixelRatio || 1) * 0.5;
    return [0.25, 0.5, 0.75, 1, 1.5].find((s) => s >= want) ?? 1.5;
  }

  private loading = new Set<PageView>();

  private onScreen(pv: PageView): boolean {
    const top = pv.box.offsetTop - this.scroller.scrollTop;
    return top < this.scroller.clientHeight && top + pv.box.offsetHeight > 0;
  }

  private previews(): void {
    if (!this.previewUrl || this.viewRot) return;
    const key = `${this.gen}|${this.previewScale()}`;
    for (const pv of [...this.loading]) {
      if (!pv.visible && pv.preview && !this.onScreen(pv)) { pv.preview.removeAttribute('src'); pv.previewKey = ''; this.loading.delete(pv); }
    }
    const cur = this.current - 1;
    const near = new Set(this.pages.filter((pv) => pv.visible));
    for (let i = Math.max(0, cur - 2); i < Math.min(this.pages.length, cur + 4); i++) if (this.onScreen(this.pages[i])) near.add(this.pages[i]);
    const want = [...near].filter((pv) => pv.previewKey !== key && !(pv.canvas && pv.renderedKey === this.key(pv)))
      .sort((a, b) => Number(this.onScreen(b)) - Number(this.onScreen(a)) || Math.abs(a.index - cur) - Math.abs(b.index - cur));
    const urgent = want.some((pv) => this.onScreen(pv));
    for (const pv of want) {
      if (this.loading.size >= 3 || (urgent && !this.onScreen(pv) && this.loading.size >= 1)) break;
      let img = pv.preview;
      if (!img) {
        img = el<HTMLImageElement>('<img class="fs-pdf-preview" alt="" decoding="async" draggable="false">');
        img.addEventListener('load', () => { this.loading.delete(pv); this.schedule(); });
        img.addEventListener('error', () => { this.loading.delete(pv); pv.previewKey = ''; });
        pv.box.insertBefore(img, pv.box.firstChild);
        pv.preview = img;
      }
      pv.previewKey = key;
      const src = this.previewUrl(pv.index + 1, this.previewScale());
      if (img.getAttribute('src') !== src) { img.setAttribute('src', src); this.loading.add(pv); }
      if (img.hidden && !(pv.canvas && pv.renderedKey === this.key(pv))) img.hidden = false;
    }
    const kept = this.pages.filter((p) => p.preview);
    if (kept.length > KEEP_PREVIEWS) {
      const cur = this.current - 1;
      for (const pv of kept.filter((p) => !p.visible).sort((a, b) => Math.abs(b.index - cur) - Math.abs(a.index - cur)).slice(0, kept.length - KEEP_PREVIEWS)) {
        pv.preview?.remove();
        pv.preview = null;
        pv.previewKey = '';
      }
    }
  }

  private pump(): void {
    if (!this.doc) return;
    this.previews();
    const wait = this.settleAt - performance.now();
    if (wait > 0) { window.setTimeout(() => this.schedule(), wait); return; }
    while (this.active < 2) {
      const cur = this.current - 1;
      const now = performance.now();
      let later = 0;
      const want = this.pages.filter((p) => {
        if (!p.visible || p.task || p.renderedKey === this.key(p)) return false;
        if (this.large && p.preview && now - p.shown < SETTLE_LARGE) { later = Math.max(later, SETTLE_LARGE - (now - p.shown)); return false; }
        return true;
      }).sort((a, b) => Math.abs(a.index - cur) - Math.abs(b.index - cur));
      const pv = want[0];
      if (!pv) { if (later) window.setTimeout(() => this.schedule(), later + 5); this.evict(); return; }
      this.active += 1;
      void this.render(pv).catch(() => undefined).finally(() => { this.active -= 1; this.schedule(); });
    }
  }

  private async render(pv: PageView): Promise<void> {
    const doc = this.doc, gen = this.gen;
    if (!doc) return;
    const key = this.key(pv);
    const page = await doc.getPage(pv.index + 1);
    if (gen !== this.gen || key !== this.key(pv)) return;
    const viewport = page.getViewport({ scale: this.k(), rotation: this.total(pv) });
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.className = 'fs-pdf-canvas';
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    const task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined, annotationMode: AnnotationMode.ENABLE });
    pv.task = task;
    try { await task.promise; } finally { if (pv.task === task) pv.task = null; }
    if (gen !== this.gen) return;
    if (pv.canvas) pv.box.replaceChild(canvas, pv.canvas);
    else pv.box.insertBefore(canvas, pv.box.firstChild);
    if (pv.canvas) pv.canvas.width = 0;
    pv.canvas = canvas;
    pv.renderedKey = key;
    pv.seen = performance.now();
    if (pv.preview && !pv.preview.hidden) pv.preview.hidden = true;
    this.hooks.rendered(pv);
    if (this.large && !this.idle()) return;
    await this.decorate(pv, page, viewport, gen);
  }

  private idle(): boolean { return performance.now() - this.lastScroll > TEXT_IDLE; }

  busy(): boolean { return this.loading.size > 0 || this.active > 0 || performance.now() - this.lastScroll < 250; }

  private lastScroll = 0;

  private async decorate(pv: PageView, page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, viewport: PageViewport, gen: number): Promise<void> {
    await this.ensureText(pv, viewport);
    if (pv.linksGen !== gen) {
      pv.linksGen = gen;
      void page.getAnnotations({ intent: 'display' }).then((list: LinkAnnot[]) => { if (gen === this.gen) this.paintLinks(pv, list, page.view); }).catch(() => undefined);
    }
  }

  private idleText(): void {
    const doc = this.doc, gen = this.gen;
    if (!doc || !this.large) return;
    for (const pv of this.pages) {
      if (!pv.visible || !pv.canvas || pv.renderedKey !== this.key(pv) || (pv.textKey === `${gen}|${this.total(pv)}` && pv.linksGen === gen)) continue;
      void doc.getPage(pv.index + 1).then((page) => {
        if (gen !== this.gen || !pv.canvas) return;
        return this.decorate(pv, page, page.getViewport({ scale: this.k(), rotation: this.total(pv) }), gen);
      }).catch(() => undefined);
    }
  }

  private paintLinks(pv: PageView, list: LinkAnnot[], view: number[]): void {
    let layer = pv.space.querySelector('.fs-pdf-links') as HTMLElement | null;
    if (!layer) { layer = el('<div class="fs-pdf-links"></div>'); pv.space.insertBefore(layer, pv.space.firstChild); }
    const links = list.filter((a) => a.subtype === 'Link' && Array.isArray(a.rect) && (a.url || a.dest)).map((a, i) => ({ a, i }));
    patchList(layer, links, {
      key: (x) => `${this.gen}|${x.i}`,
      create: ({ a, i }) => {
        const [x1, y1, x2, y2] = a.rect as number[];
        const x = Math.min(x1, x2) - view[0], y = view[3] - Math.max(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        const node = el<HTMLAnchorElement>(`<a class="fs-pdf-link" href="#" data-i="${i}" style="left:calc(var(--k) * ${x}px);top:calc(var(--k) * ${y}px);width:calc(var(--k) * ${w}px);height:calc(var(--k) * ${h}px)"></a>`);
        node.title = a.url ?? 'Go to destination';
        node.addEventListener('click', (e) => {
          e.preventDefault();
          if (a.url) { if (this.hooks.link) this.hooks.link(a.url); else window.open(a.url, '_blank', 'noopener,noreferrer'); }
          else void this.navigate(a.dest);
        });
        return node;
      },
      update: () => undefined,
    });
  }

  private async navigate(dest: unknown): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : Array.isArray(dest) ? dest : null;
    const ref: unknown = explicit?.[0];
    const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref as RefProxy) : -1;
    if (index >= 0) this.goTo(index + 1);
  }

  private async ensureText(pv: PageView, viewport: PageViewport): Promise<void> {
    const key = `${this.gen}|${this.total(pv)}`;
    if (pv.textKey === key && pv.text) { pv.text.update({ viewport }); return; }
    const content = await this.textContent(pv.index);
    if (!this.doc || key !== `${this.gen}|${this.total(pv)}`) return;
    pv.text?.cancel();
    const host = el('<div class="textLayer"></div>');
    const layer = new TextLayer({ textContentSource: content, container: host, viewport });
    await layer.render();
    host.appendChild(el('<div class="endOfContent"></div>'));
    pv.textHost.replaceWith(host);
    pv.textHost = host;
    pv.text = layer;
    pv.textKey = key;
    this.hooks.textReady(pv);
  }

  private evict(): void {
    const drawn = this.pages.filter((p) => p.canvas);
    if (drawn.length <= KEEP_CANVASES) return;
    const victims = drawn.filter((p) => !p.visible).sort((a, b) => a.seen - b.seen).slice(0, drawn.length - KEEP_CANVASES);
    for (const pv of victims) {
      if (!pv.canvas) continue;
      pv.canvas.width = 0;
      pv.canvas.remove();
      pv.canvas = null;
      pv.renderedKey = '';
      if (pv.preview) { pv.preview.hidden = false; pv.previewKey = ''; }
      pv.text?.cancel();
      pv.text = null;
      pv.textKey = '';
      pv.textHost.replaceChildren();
    }
  }

  textContent(index: number): Promise<TextContent> {
    let p = this.texts.get(index);
    if (!p) {
      const doc = this.doc;
      if (!doc) return Promise.reject(new Error('no document'));
      p = doc.getPage(index + 1).then((page) => page.getTextContent());
      this.texts.set(index, p);
    }
    return p;
  }

  pageText(index: number): Promise<PageText> {
    let p = this.plain.get(index);
    if (!p) {
      p = this.textContent(index).then((tc) => {
        let text = '';
        const starts: number[] = [], lens: number[] = [];
        for (const item of tc.items) {
          if (!isTextItem(item)) continue;
          starts.push(text.length);
          lens.push(item.str.length);
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
        return { text, starts, lens };
      });
      this.plain.set(index, p);
    }
    return p;
  }

  thumb(index: number, cssW: number): Promise<HTMLCanvasElement> {
    const key = `${this.gen}|${index}|${cssW}`;
    let p = this.thumbs.get(key);
    if (!p) {
      const doc = this.doc;
      if (!doc) return Promise.reject(new Error('no document'));
      p = doc.getPage(index + 1).then(async (page) => {
        const rot = this.sizes[index]?.rotate ?? page.rotate;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: (cssW / base.width) * ratio, rotation: rot });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
        return canvas;
      });
      p.catch(() => this.thumbs.delete(key));
      this.thumbs.set(key, p);
      if (this.thumbs.size > 400) { const first = this.thumbs.keys().next().value; if (first !== undefined) this.thumbs.delete(first); }
    }
    return p;
  }

  setClass(cls: string, on: boolean): void { setClass(this.scroller, cls, on); }
}

export class Thumbs {
  readonly root: HTMLElement;
  private readonly io: IntersectionObserver;
  private drawn = new Map<number, string>();
  private visible = new Set<number>();
  private busy = false;
  private current = 0;
  onPick: (n: number) => void = () => undefined;

  constructor(private readonly viewer: Viewer) {
    this.root = el('<div class="fs-pdf-thumbs" role="listbox" aria-label="Pages"></div>');
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.key);
        if (e.isIntersecting) this.visible.add(i); else this.visible.delete(i);
      }
      void this.pump();
    }, { root: this.root, rootMargin: '400px 0px' });
    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('.fs-pdf-thumb') as HTMLElement | null;
      if (b) this.onPick(Number(b.dataset.key) + 1);
    });
  }

  sync(sizes: PageSize[]): void {
    const items = sizes.map((s, i) => ({ i, s }));
    patchList(this.root, items, {
      key: (it) => String(it.i),
      create: (it) => {
        const node = el(`<button class="fs-pdf-thumb" type="button" role="option"><span class="fs-pdf-thumb-box"></span><span class="fs-pdf-thumb-n">${it.i + 1}</span></button>`);
        this.io.observe(node);
        return node;
      },
      update: () => undefined,
    });
    for (const it of items) {
      const node = this.root.children[it.i] as HTMLElement;
      const box = node.firstElementChild as HTMLElement;
      const odd = it.s.rotate % 180 !== 0;
      const w = odd ? it.s.h : it.s.w, h = odd ? it.s.w : it.s.h;
      const k = Math.min(THUMB_W / Math.max(w, 1), THUMB_H / Math.max(h, 1));
      const bw = `${Math.max(8, Math.round(w * k))}px`, bh = `${Math.max(8, Math.round(h * k))}px`;
      if (box.style.width !== bw) box.style.width = bw;
      if (box.style.height !== bh) box.style.height = bh;
    }
    void this.pump();
  }

  invalidate(): void { void this.pump(); }

  setCurrent(n: number): void {
    const prev = this.root.children[this.current] as HTMLElement | undefined;
    if (prev) { setClass(prev, 'is-current', false); prev.setAttribute('aria-selected', 'false'); }
    this.current = n - 1;
    const node = this.root.children[this.current] as HTMLElement | undefined;
    if (!node) return;
    setClass(node, 'is-current', true);
    node.setAttribute('aria-selected', 'true');
    const r = node.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    if (r.top < rr.top || r.bottom > rr.bottom) node.scrollIntoView({ block: 'nearest' });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const gen = this.viewer.gen;
        const next = [...this.visible].sort((a, b) => a - b).find((i) => this.drawn.get(i) !== String(gen) && i < this.viewer.pages.length);
        if (next === undefined || !this.viewer.doc) break;
        this.drawn.set(next, String(gen));
        const url = this.viewer.large ? this.viewer.previewUrl : null;
        if (url) {
          const box = this.root.children[next]?.firstElementChild as HTMLElement | undefined;
          if (!box) continue;
          const s = this.viewer.sizes[next];
          const scale = Math.max(0.125, Math.round((THUMB_W * Math.min(2, window.devicePixelRatio || 1) / Math.max(1, s ? s.w : 612)) * 8) / 8);
          const img = (box.firstElementChild as HTMLImageElement | null)?.tagName === 'IMG' ? box.firstElementChild as HTMLImageElement : el<HTMLImageElement>('<img class="fs-pdf-thumb-img" alt="" decoding="async" draggable="false">');
          const src = url(next + 1, scale);
          if (img.getAttribute('src') !== src) {
            for (let n = 0; this.viewer.busy() && n < 40; n++) await new Promise((r) => window.setTimeout(r, 150));
            if (!this.visible.has(next)) { this.drawn.delete(next); continue; }
            await new Promise<void>((resolve) => {
              const done = (): void => { img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
              img.addEventListener('load', done);
              img.addEventListener('error', done);
              img.setAttribute('src', src);
              if (img.parentElement !== box) box.replaceChildren(img);
            });
            await new Promise((r) => window.setTimeout(r, this.viewer.busy() ? 120 : 0));
          } else if (img.parentElement !== box) box.replaceChildren(img);
          continue;
        }
        try {
          const src = await this.viewer.thumb(next, 120);
          const box = this.root.children[next]?.firstElementChild as HTMLElement | undefined;
          if (!box || gen !== this.viewer.gen) continue;
          const c = document.createElement('canvas');
          c.width = src.width;
          c.height = src.height;
          c.getContext('2d')?.drawImage(src, 0, 0);
          box.replaceChildren(c);
        } catch { this.drawn.delete(next); break; }
      }
    } finally { this.busy = false; }
  }
}
