import { q, setClass, setHidden, setTitle } from './dom';
import { icon } from './icons';

export const wantsCustomTitleBar = (): boolean => '__TAURI_INTERNALS__' in window && !/Mac/.test(navigator.platform);

type Win = ReturnType<typeof import('@tauri-apps/api/window').getCurrentWindow>;

export class CaptionButtons {
  private readonly boxes: HTMLElement[] = [];
  private win: Promise<Win> | null = null;
  private on = false;
  private maximized = false;
  private shown = false;

  constructor(header: HTMLElement, private readonly wanted: () => boolean) {
    this.add(header);
    window.addEventListener('resize', () => { if (this.on) void this.look(); });
    this.sync();
  }

  get active(): boolean { return this.on; }

  add(header: HTMLElement): void {
    const box = document.createElement('div');
    box.className = 'fs-caption';
    box.hidden = !this.on;
    box.innerHTML =
      `<button class="fs-caption-btn" type="button" data-cap="min" title="Minimize" aria-label="Minimize">${icon('capMin', 16)}</button>` +
      `<button class="fs-caption-btn" type="button" data-cap="max" title="${this.maximized ? 'Restore' : 'Maximize'}" aria-label="${this.maximized ? 'Restore' : 'Maximize'}">${icon(this.maximized ? 'capRestore' : 'capMax', 16)}</button>` +
      `<button class="fs-caption-btn is-close" type="button" data-cap="close" title="Close window" aria-label="Close window">${icon('close', 16)}</button>`;
    header.append(box);
    if ('__TAURI_INTERNALS__' in window) for (const n of header.querySelectorAll('.fs-menubar, .fs-pdfwb-doc, .fs-pdfwb-name')) n.setAttribute('data-tauri-drag-region', '');
    box.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-cap]') : null;
      if (b) void this.act(b.dataset.cap ?? '');
    });
    this.boxes.push(box);
  }

  sync(): void {
    const want = wantsCustomTitleBar() && this.wanted();
    if (want === this.on) return;
    this.on = want;
    for (const box of this.boxes) setHidden(box, !want);
    setClass(document.documentElement, 'has-caption-buttons', want);
    void this.use((w) => w.setDecorations(!want)).then(() => this.look());
  }

  private async use<T>(run: (w: Win) => Promise<T>): Promise<T | undefined> {
    try {
      this.win ??= import('@tauri-apps/api/window').then((m) => m.getCurrentWindow());
      return await run(await this.win);
    } catch { return undefined; }
  }

  private async act(what: string): Promise<void> {
    if (what === 'min') await this.use((w) => w.minimize());
    else if (what === 'max') { await this.use((w) => w.toggleMaximize()); await this.look(); }
    else if (what === 'close') await this.use((w) => w.close());
  }

  private async look(): Promise<void> {
    const now = !!(await this.use((w) => w.isMaximized()));
    if (now === this.maximized && this.shown) return;
    this.maximized = now;
    this.shown = true;
    for (const box of this.boxes) {
      const b = q<HTMLElement>(box, '[data-cap="max"]');
      b.innerHTML = icon(now ? 'capRestore' : 'capMax', 16);
      setTitle(b, now ? 'Restore' : 'Maximize');
      b.setAttribute('aria-label', now ? 'Restore' : 'Maximize');
    }
  }
}
