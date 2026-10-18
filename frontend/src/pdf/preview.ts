import { Dialog } from '../ui/dialogs';
import { el, q, setClass, setText } from '../ui/dom';
import { openDocument } from './viewer';

export interface PreviewOpts { data: Uint8Array; name: string; bytes: number; saveAs(): void; print(): void }

const size = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const PAPER: Array<[string, number, number]> = [['Letter', 612, 792], ['Legal', 612, 1008], ['A4', 595.28, 841.89], ['A3', 841.89, 1190.55], ['A5', 419.53, 595.28], ['Tabloid', 792, 1224]];
const paper = (w: number, h: number): string => {
  const [a, b] = w < h ? [w, h] : [h, w];
  const hit = PAPER.find(([, x, y]) => Math.abs(x - a) < 2 && Math.abs(y - b) < 2);
  return hit ? `${hit[0]}${w > h ? ' landscape' : ''}` : `${(w / 72).toFixed(2)} x ${(h / 72).toFixed(2)} in`;
};

class PreviewDialog extends Dialog {
  private readonly pages: HTMLElement;
  private readonly info: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private doc: Awaited<ReturnType<typeof openDocument>> | null = null;
  private opts: PreviewOpts | null = null;
  private actual = false;

  constructor() {
    super('Preview', 1040);
    q<HTMLElement>(this.scrim, '.fs-dialog').classList.add('fs-preview');
    this.body.appendChild(el('<div class="fs-preview-pages" role="document" tabindex="0" aria-label="Pages as they will be saved"></div>'));
    this.pages = q(this.body, '.fs-preview-pages');
    this.info = el('<span class="fs-preview-info fs-note"></span>');
    this.foot.appendChild(this.info);
    const zoom = this.button('Actual size', 'ghost', () => {
      this.actual = !this.actual;
      setClass(this.pages, 'is-actual', this.actual);
      setText(zoom, this.actual ? 'Fit width' : 'Actual size');
    });
    this.button('Print…', 'ghost', () => { const o = this.opts; this.close(); o?.print(); });
    this.button('Save As…', 'ghost', () => { const o = this.opts; this.close(); o?.saveAs(); });
    this.button('Close', 'primary', () => this.close());
    this.onClose = () => this.reset();
  }

  async show(o: PreviewOpts): Promise<void> {
    this.reset();
    this.opts = o;
    this.setTitle(`Preview · ${o.name}`);
    const doc = await openDocument(o.data);
    this.doc = doc;
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const count = doc.numPages === 1 ? '1 page' : `${doc.numPages} pages`;
    setText(this.info, `${count} · ${paper(first.width, first.height)} · ${size(o.bytes)} · exactly as it will be saved`);
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = i === 1 ? first : (await doc.getPage(i)).getViewport({ scale: 1 });
      const slot = el(`<div class="fs-preview-page" data-page="${i}" style="--w:${vp.width.toFixed(2)};--h:${vp.height.toFixed(2)}"><span class="fs-preview-no">${i}</span></div>`);
      frag.appendChild(slot);
    }
    this.pages.appendChild(frag);
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) void this.paint(en.target as HTMLElement);
    }, { root: this.pages, rootMargin: '600px 0px' });
    for (const slot of Array.from(this.pages.children)) this.observer.observe(slot);
    this.open(this.pages);
  }

  private async paint(slot: HTMLElement): Promise<void> {
    if (!this.doc || slot.dataset.done) return;
    slot.dataset.done = '1';
    this.observer?.unobserve(slot);
    const page = await this.doc.getPage(Number(slot.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.5, (980 / base.width) * (window.devicePixelRatio || 1)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    if (slot.isConnected) slot.prepend(canvas);
  }

  private reset(): void {
    this.observer?.disconnect();
    this.observer = null;
    void this.doc?.loadingTask.destroy();
    this.doc = null;
    this.pages.replaceChildren();
    this.opts = null;
  }
}

let dialog: PreviewDialog | null = null;

export function showPreview(o: PreviewOpts): Promise<void> {
  dialog ??= new PreviewDialog();
  return dialog.show(o);
}
