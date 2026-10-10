import { el, patchList } from '../ui/dom';
import type { Hit, PageView, Viewer } from './viewer';

interface Box { key: string; x: number; y: number; w: number; h: number; current: boolean }

export class Finder {
  query = '';
  hits: Hit[] = [];
  index = -1;
  done = true;
  private run = 0;
  onChange: () => void = () => undefined;

  constructor(private readonly viewer: Viewer) {}

  async search(query: string): Promise<void> {
    const run = ++this.run;
    this.query = query;
    this.hits = [];
    this.index = -1;
    this.done = false;
    this.paintAll();
    this.onChange();
    const q = query.trim();
    if (!q || !this.viewer.doc) { this.done = true; this.onChange(); return; }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    const n = this.viewer.pages.length, start = this.viewer.currentPage() - 1;
    let jumped = false;
    for (let i = 0; i < n; i++) {
      let pt;
      try { pt = await this.viewer.pageText(i); } catch { continue; }
      if (run !== this.run) return;
      const found: Hit[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(pt.text); m; m = re.exec(pt.text)) {
        if (!m[0].length) { re.lastIndex += 1; continue; }
        found.push({ page: i, start: m.index, end: m.index + m[0].length });
        if (found.length > 2000) break;
      }
      if (found.length) {
        this.hits.push(...found);
        if (!jumped && i >= start) { jumped = true; this.index = this.hits.length - found.length; this.reveal(); }
        this.paint(this.viewer.pages[i]);
      }
      if (i % 16 === 15) this.onChange();
    }
    if (run !== this.run) return;
    if (!jumped && this.hits.length) { this.index = 0; this.reveal(); }
    this.done = true;
    this.onChange();
  }

  clear(): void { void this.search(''); }

  step(dir: 1 | -1): void {
    if (!this.hits.length) return;
    const prev = this.hits[this.index]?.page;
    this.index = (this.index + dir + this.hits.length) % this.hits.length;
    if (prev !== undefined && prev !== this.hits[this.index].page) this.paint(this.viewer.pages[prev]);
    this.reveal();
    this.onChange();
  }

  private reveal(): void {
    const hit = this.hits[this.index];
    if (!hit) return;
    const pv = this.viewer.pages[hit.page];
    if (!pv) return;
    if (!this.viewer.isShown(hit.page)) this.viewer.goTo(hit.page + 1);
    this.paint(pv);
    const node = pv.hits.querySelector('.is-current') as HTMLElement | null;
    if (node) node.scrollIntoView({ block: 'center', inline: 'nearest' });
    else {
      this.viewer.goTo(hit.page + 1);
      this.pendingReveal = hit;
    }
  }

  private pendingReveal: Hit | null = null;

  paintAll(): void { for (const pv of this.viewer.pages) this.paint(pv); }

  paint(pv: PageView | undefined): void {
    if (!pv) return;
    const boxes: Box[] = [];
    const layer = pv.text;
    if (layer && this.hits.length) {
      const divs = layer.textDivs;
      void this.viewer.pageText(pv.index).then((pt) => {
        const list: Box[] = [];
        const range = document.createRange();
        this.hits.forEach((hit, n) => {
          if (hit.page !== pv.index) return;
          for (let i = 0; i < pt.starts.length; i++) {
            const s0 = pt.starts[i], s1 = s0 + pt.lens[i];
            if (s1 <= hit.start || s0 >= hit.end) continue;
            const node = divs[i]?.firstChild;
            if (!node || node.nodeType !== Node.TEXT_NODE) continue;
            const len = (node.textContent ?? '').length;
            range.setStart(node, Math.min(len, Math.max(0, hit.start - s0)));
            range.setEnd(node, Math.min(len, Math.max(0, hit.end - s0)));
            Array.from(range.getClientRects()).forEach((r, k) => {
              if (r.width < 0.5 || r.height < 0.5) return;
              const a = this.viewer.toPage(pv, r.left, r.top), b = this.viewer.toPage(pv, r.right, r.bottom);
              list.push({ key: `${n}-${i}-${k}`, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), current: n === this.index });
            });
          }
        });
        this.apply(pv, list);
        const pend = this.pendingReveal;
        if (pend && pend.page === pv.index && this.hits[this.index] === pend) {
          this.pendingReveal = null;
          (pv.hits.querySelector('.is-current') as HTMLElement | null)?.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
      });
      return;
    }
    this.apply(pv, boxes);
  }

  private apply(pv: PageView, list: Box[]): void {
    const update = (node: HTMLElement, b: Box): void => {
      const css = `left:calc(var(--k) * ${b.x.toFixed(2)}px);top:calc(var(--k) * ${b.y.toFixed(2)}px);width:calc(var(--k) * ${b.w.toFixed(2)}px);height:calc(var(--k) * ${b.h.toFixed(2)}px)`;
      if (node.getAttribute('style') !== css) node.setAttribute('style', css);
      if (node.classList.contains('is-current') !== b.current) node.classList.toggle('is-current', b.current);
    };
    patchList(pv.hits, list, { key: (b) => b.key, create: (b) => { const n = el('<div class="fs-pdf-hit"></div>'); update(n, b); return n; }, update });
  }
}
