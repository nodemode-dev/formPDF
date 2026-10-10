import { el, escapeHtml, patchList, setClass, setHidden, setHtml, setStyleVar } from '../ui/dom';
import { pdfApi, type ReflowBlock, type ReflowPage, type Rect } from './api';
import type { PageView, Viewer } from './viewer';

const SIZE_KEY = 'fs-pdf-reflow-size';
const CHUNK = 6;
export const REFLOW_SIZES = [14, 15, 16, 17, 18, 20, 22, 24, 26, 28];

export function remember(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function recall(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function runsHtml(b: ReflowBlock): string {
  const runs = b.runs?.length ? b.runs : [{ text: b.text ?? '', bold: false, italic: false }];
  return runs.map((r) => {
    let t = escapeHtml(r.text);
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    return t;
  }).join('');
}

function blockHtml(b: ReflowBlock): string {
  if (b.kind === 'table') {
    const rows = b.rows ?? [];
    return `<div class="fs-pdf-rf-table"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`)).join('')}</tr>`).join('')}</table></div>`;
  }
  const cls = [b.align === 'center' ? 'is-center' : b.align === 'right' ? 'is-right' : '', b.list ? 'is-list' : ''].filter(Boolean).join(' ');
  const attr = cls ? ` class="${cls}"` : '';
  if (b.kind === 'heading') { const h = Math.min(4, (b.level ?? 2) + 1); return `<h${h}${attr}>${runsHtml(b)}</h${h}>`; }
  return `<p${attr}>${runsHtml(b)}</p>`;
}

function pageHtml(p: ReflowPage): string {
  if (!p.blocks.length) return '<p class="fs-pdf-rf-empty">This page has no text to show. It may be a scan or a picture.</p>';
  return p.blocks.map(blockHtml).join('');
}

export class Reflow {
  readonly root: HTMLElement;
  private readonly doc: HTMLElement;
  private docId = '';
  private total = 0;
  private state = new Map<number, 'loading' | 'done'>();
  private wanted = new Set<number>();
  private pumping = false;
  private readonly io: IntersectionObserver;
  private current = 1;
  private scrollQueued = false;
  private guessed = false;
  private target = 0;
  private onReady: (() => void) | null = null;
  size = 18;
  onPage: (n: number) => void = () => undefined;

  constructor() {
    this.root = el('<div class="fs-pdf-reflow" tabindex="-1" hidden><article class="fs-pdf-rf-doc" aria-label="Reading mode"></article></div>');
    this.doc = this.root.firstElementChild as HTMLElement;
    const saved = Number(recall(SIZE_KEY));
    if (REFLOW_SIZES.includes(saved)) this.size = saved;
    setStyleVar(this.doc, '--rf-size', `${this.size}px`);
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.want(Number((e.target as HTMLElement).dataset.page));
      void this.pump();
    }, { root: this.root, rootMargin: '900px 0px' });
    this.root.addEventListener('scroll', () => {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => { this.scrollQueued = false; this.track(); });
    }, { passive: true });
  }

  get open(): boolean { return !this.root.hidden; }

  show(docId: string, total: number, page: number): Promise<void> {
    if (docId !== this.docId || total !== this.total) {
      const prev = this.onReady;
      this.onReady = null;
      prev?.();
      this.docId = docId;
      this.total = total;
      this.state.clear();
      this.wanted.clear();
      this.guessed = false;
      setClass(this.doc, 'is-waiting', true);
      const items = Array.from({ length: total }, (_, i) => i + 1);
      for (const s of Array.from(this.doc.children)) this.io.unobserve(s);
      patchList(this.doc, items, {
        key: (n) => `${docId}|${n}`,
        create: (n) => el(`<section class="fs-pdf-rf-page is-pending" data-page="${n}"><header class="fs-pdf-rf-label">Page ${n}</header><div class="fs-pdf-rf-body"></div></section>`),
        update: () => undefined,
      });
      for (const s of Array.from(this.doc.children)) this.io.observe(s);
    }
    setHidden(this.root, false);
    this.target = page;
    this.want(page);
    const ready = this.state.get(page) === 'done' ? Promise.resolve() : new Promise<void>((resolve) => { this.onReady = resolve; });
    void this.pump();
    this.goTo(page);
    return ready.then(() => {
      if (this.target === page) this.goTo(page);
      setClass(this.doc, 'is-waiting', false);
    });
  }

  hide(): void { setHidden(this.root, true); }

  reset(): void {
    const r = this.onReady;
    this.onReady = null;
    r?.();
    for (const s of Array.from(this.doc.children)) this.io.unobserve(s);
    this.doc.replaceChildren();
    this.docId = '';
    this.total = 0;
    this.state.clear();
    this.wanted.clear();
  }

  currentPage(): number { return this.current; }

  goTo(n: number): void {
    const s = this.section(n);
    if (!s) return;
    this.root.scrollTop = Math.max(0, s.offsetTop);
    this.setCurrent(n);
  }

  setSize(px: number): void {
    if (px === this.size) return;
    const n = this.current, s = this.section(n);
    const rel = s ? (this.root.scrollTop - s.offsetTop) / Math.max(1, s.offsetHeight) : 0;
    this.size = px;
    setStyleVar(this.doc, '--rf-size', `${px}px`);
    remember(SIZE_KEY, String(px));
    if (s) this.root.scrollTop = s.offsetTop + rel * s.offsetHeight;
  }

  private section(n: number): HTMLElement | null { return this.doc.children[n - 1] as HTMLElement | undefined ?? null; }

  private setCurrent(n: number): void {
    if (n === this.current) return;
    this.current = n;
    this.onPage(n);
  }

  private track(): void {
    if (this.root.hidden || !this.total) return;
    const y = this.root.scrollTop + this.root.clientHeight * 0.25;
    let lo = 0, hi = this.doc.children.length - 1, n = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.doc.children[mid] as HTMLElement).offsetTop <= y) { n = mid + 1; lo = mid + 1; } else hi = mid - 1;
    }
    this.setCurrent(n);
  }

  private want(n: number): void { if (n >= 1 && n <= this.total && !this.state.has(n)) this.wanted.add(n); }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.wanted.size && !this.root.hidden) {
        const near = [...this.wanted].sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current))[0];
        let a = near, b = near;
        while (b - a + 1 < CHUNK && b + 1 <= this.total && !this.state.has(b + 1)) b += 1;
        while (b - a + 1 < CHUNK && a - 1 >= 1 && !this.state.has(a - 1) && this.wanted.has(a - 1)) a -= 1;
        for (let p = a; p <= b; p++) { this.state.set(p, 'loading'); this.wanted.delete(p); }
        const id = this.docId;
        let res: ReflowPage[] = [];
        try { res = (await pdfApi.reflow(id, `${a}-${b}`)).pages; } catch {
          res = Array.from({ length: b - a + 1 }, (_, k) => ({ page: a + k, blocks: [] }));
        }
        if (id !== this.docId) return;
        for (const p of res) this.fill(p);
        if (!this.guessed && res.length) {
          this.guessed = true;
          const hs = res.map((p) => this.section(p.page)?.offsetHeight ?? 0).filter((h) => h > 0);
          if (hs.length) setStyleVar(this.doc, '--rf-guess', `${Math.round(hs.reduce((s, h) => s + h, 0) / hs.length)}px`);
        }
        if (this.onReady && this.state.get(this.target) === 'done') { const r = this.onReady; this.onReady = null; r(); }
      }
    } finally { this.pumping = false; }
  }

  private fill(p: ReflowPage): void {
    const s = this.section(p.page);
    if (!s) return;
    this.state.set(p.page, 'done');
    const above = s.offsetTop + 1 < this.root.scrollTop;
    const before = s.offsetHeight;
    setHtml(s.querySelector('.fs-pdf-rf-body') as HTMLElement, pageHtml(p), `${this.docId}|${p.page}`);
    setClass(s, 'is-pending', false);
    if (above) this.root.scrollTop += s.offsetHeight - before;
  }
}

interface Chunk { page: number; text: string; start: number; end: number; map: number[] }
interface Box { key: string; x: number; y: number; w: number; h: number; word: boolean }

function chunks(text: string, page: number): Chunk[] {
  let clean = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === '\n' || ch === '\r' || ch === '\t') ch = ' ';
    if (ch === ' ' && (!clean || clean.endsWith(' '))) continue;
    if (ch === ' ' && clean.endsWith('-') && /\p{Ll}/u.test(text[i + 1] ?? '') && (text[i - 1] === '\n' || text[i - 1] === '\r')) { clean = clean.slice(0, -1); map.pop(); continue; }
    clean += ch;
    map.push(i);
  }
  const out: Chunk[] = [];
  let s = 0;
  const push = (e: number): void => {
    const raw = clean.slice(s, e), t = raw.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) {
      const a = s + (raw.length - raw.trimStart().length);
      out.push({ page, text: t, start: map[a], end: map[a + t.length - 1] + 1, map: map.slice(a, a + t.length) });
    }
    s = e;
  };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (/[.!?]/.test(ch) && (i + 1 >= clean.length || /[\s"')\]”’]/.test(clean[i + 1]))) {
      let e = i + 1;
      while (e < clean.length && /["')\]”’]/.test(clean[e])) e += 1;
      push(e);
    } else if (ch === ' ' && i - s > 240) push(i);
  }
  push(clean.length);
  return out;
}

export function textRects(viewer: Viewer, pv: PageView, starts: number[], lens: number[], start: number, end: number): Rect[] {
  const divs = pv.text?.textDivs ?? [];
  const out: Rect[] = [];
  const range = document.createRange();
  for (let i = 0; i < starts.length; i++) {
    const s0 = starts[i], s1 = s0 + lens[i];
    if (s1 <= start || s0 >= end) continue;
    const node = divs[i]?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const len = (node.textContent ?? '').length;
    range.setStart(node, Math.min(len, Math.max(0, start - s0)));
    range.setEnd(node, Math.min(len, Math.max(0, end - s0)));
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const a = viewer.toPage(pv, r.left, r.top), b = viewer.toPage(pv, r.right, r.bottom);
      out.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
    }
  }
  return out;
}

export type SpeakState = 'idle' | 'playing' | 'paused';

export class Speaker {
  readonly supported: boolean;
  state: SpeakState = 'idle';
  voiceURI = '';
  rate = 1;
  page = 0;
  error = '';
  private mode: 'page' | 'end' = 'page';
  private list: Chunk[] = [];
  private index = 0;
  private cur: { page: number; start: number; end: number; ws: number; we: number } | null = null;
  private layers = new Map<number, HTMLElement>();
  private run = 0;
  private revealed = '';
  onState: () => void = () => undefined;
  onVoices: () => void = () => undefined;

  constructor(private readonly viewer: Viewer) {
    this.supported = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
    if (this.supported) window.speechSynthesis.addEventListener('voiceschanged', () => this.onVoices());
  }

  voices(): SpeechSynthesisVoice[] {
    if (!this.supported) return [];
    try { return window.speechSynthesis.getVoices(); } catch { return []; }
  }

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el('<div class="fs-pdf-speak"></div>');
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.paint(pv);
  }

  readPage(n: number): void { this.start(n, 'page'); }
  readFrom(n: number): void { this.start(n, 'end'); }

  pause(): void {
    if (!this.supported || this.state !== 'playing') return;
    window.speechSynthesis.pause();
    this.state = 'paused';
    this.onState();
  }

  resume(): void {
    if (!this.supported || this.state !== 'paused') return;
    window.speechSynthesis.resume();
    this.state = 'playing';
    this.onState();
  }

  stop(): void {
    this.run += 1;
    if (this.supported && (this.state !== 'idle' || window.speechSynthesis.speaking)) window.speechSynthesis.cancel();
    const was = this.cur?.page;
    this.cur = null;
    this.list = [];
    if (was) { const pv = this.viewer.pages[was - 1]; if (pv) this.paint(pv); }
    if (this.state !== 'idle') { this.state = 'idle'; this.onState(); }
  }

  private start(n: number, mode: 'page' | 'end'): void {
    if (!this.supported || !this.viewer.doc) return;
    this.stop();
    const run = ++this.run;
    this.mode = mode;
    this.error = '';
    this.state = 'playing';
    this.onState();
    void this.load(n, run);
  }

  private async load(n: number, run: number): Promise<void> {
    if (run !== this.run) return;
    if (n > this.viewer.pages.length) { this.finish(); return; }
    this.page = n;
    this.onState();
    let text = '';
    try { text = (await this.viewer.pageText(n - 1)).text; } catch { text = ''; }
    if (run !== this.run) return;
    this.list = chunks(text, n);
    this.index = 0;
    if (!this.list.length) { if (this.mode === 'end') void this.load(n + 1, run); else this.finish(); return; }
    if (!this.viewer.isShown(n - 1) || !this.viewer.pages[n - 1]?.visible) this.viewer.goTo(n);
    this.next(run);
  }

  private next(run: number): void {
    if (run !== this.run) return;
    const c = this.list[this.index];
    if (!c) {
      if (this.mode === 'end' && this.page < this.viewer.pages.length) void this.load(this.page + 1, run);
      else this.finish();
      return;
    }
    const u = new SpeechSynthesisUtterance(c.text);
    const v = this.voices().find((x) => x.voiceURI === this.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.rate;
    u.onstart = () => { if (run !== this.run) return; this.cur = { page: c.page, start: c.start, end: c.end, ws: -1, we: -1 }; this.repaint(c.page); };
    u.onboundary = (e) => {
      if (run !== this.run || !this.cur || (e.name && e.name !== 'word')) return;
      const i = Math.max(0, Math.min(c.text.length - 1, e.charIndex));
      const len = e.charLength || (/^\S+/.exec(c.text.slice(i))?.[0].length ?? 1);
      this.cur = { ...this.cur, ws: c.map[i], we: c.map[Math.min(c.text.length, i + len) - 1] + 1 };
      this.repaint(c.page);
    };
    u.onend = () => { if (run !== this.run) return; this.index += 1; this.next(run); };
    u.onerror = (e) => {
      if (run !== this.run || e.error === 'interrupted' || e.error === 'canceled') return;
      this.error = e.error === 'not-allowed' ? 'Reading aloud was blocked. Click Read again.' : 'This voice could not read the page.';
      this.stop();
    };
    window.speechSynthesis.speak(u);
    if (this.state === 'paused') window.speechSynthesis.pause();
  }

  private finish(): void {
    const was = this.cur?.page;
    this.cur = null;
    if (was) this.repaint(was);
    this.state = 'idle';
    this.onState();
  }

  private repaint(page: number): void {
    const pv = this.viewer.pages[page - 1];
    if (pv) this.paint(pv);
  }

  paint(pv: PageView): void {
    const layer = this.layers.get(pv.index);
    if (!layer) return;
    const c = this.cur;
    if (!c || c.page !== pv.index + 1 || !pv.text) { if (layer.firstChild) patchList(layer, [], { key: () => '', create: () => el('<i></i>'), update: () => undefined }); return; }
    const cur = c;
    void this.viewer.pageText(pv.index).then((pt) => {
      if (this.cur !== cur) return;
      const boxes: Box[] = textRects(this.viewer, pv, pt.starts, pt.lens, cur.start, cur.end).map((r, k) => ({ key: `s${cur.start}-${k}`, ...r, word: false }));
      if (cur.ws >= 0) boxes.push(...textRects(this.viewer, pv, pt.starts, pt.lens, cur.ws, cur.we).map((r, k) => ({ key: `w${cur.ws}-${k}`, ...r, word: true })));
      const update = (n: HTMLElement, b: Box): void => {
        const css = `left:calc(var(--k) * ${b.x.toFixed(2)}px);top:calc(var(--k) * ${b.y.toFixed(2)}px);width:calc(var(--k) * ${b.w.toFixed(2)}px);height:calc(var(--k) * ${b.h.toFixed(2)}px)`;
        if (n.getAttribute('style') !== css) n.setAttribute('style', css);
      };
      patchList(layer, boxes, { key: (b) => b.key, create: (b) => { const n = el(`<div class="fs-pdf-say${b.word ? ' is-word' : ''}"></div>`); update(n, b); return n; }, update });
      const key = `${cur.page}|${cur.start}`;
      const first = boxes[0];
      if (first && this.revealed !== key) {
        this.revealed = key;
        const node = layer.firstElementChild as HTMLElement | null, box = this.viewer.scroller.getBoundingClientRect();
        const r = node?.getBoundingClientRect();
        if (r && (r.top < box.top + 24 || r.bottom > box.bottom - 24)) this.viewer.scrollToPoint(pv.index, first.x + first.w / 2, first.y);
      }
    });
  }
}
