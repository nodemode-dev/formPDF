import { DEMOS, type DemoId } from '../demos/catalog';
import { pdfApi, type RecentItem } from '../pdf/api';
import { expandZips } from '../pdf/unzip';
import { brandMark } from './brand';
import { el, escapeHtml, patchList, q, setClass, setHidden, setText } from './dom';
import { icon } from './icons';
import { toast } from './toast';

export interface HomeHooks {
  openFiles(files: File[]): void;
  viewFiles(files: File[]): void;
  openPath(): void;
  openRecent(id: string): void;
  create(kind: 'pictures' | 'files', files?: File[]): void;
  scan(): void;
  preferences(): void;
  agents(): void;
  help(): void;
  demo(id: DemoId): void;
}

const demoCards = DEMOS.map((d) => `<div class="fs-card fs-home-demo" role="button" tabindex="0" data-demo="${d.id}" title="${d.line}"><span class="fs-card-preview fs-pdfwb-recent-prev">${d.art}</span><span class="fs-card-body"><span class="fs-card-name">${d.title}</span><span class="fs-card-meta">${d.line}</span></span></div>`).join('');

type View = 'start' | 'recent' | 'batch' | 'reviews';

const skeleton = `<div class="fs-card is-skeleton" data-key="__skeleton" aria-hidden="true"><span class="fs-card-preview fs-pdfwb-recent-prev"></span><span class="fs-card-body"><span class="fs-card-name">&nbsp;</span><span class="fs-card-meta">&nbsp;</span></span></div>`;
const empty = `<div class="fs-card is-empty" hidden><span class="fs-card-preview fs-pdfwb-recent-prev is-blank">${icon('filePdf', 28)}</span><span class="fs-card-body"><span class="fs-card-name">No PDFs yet</span><span class="fs-card-meta">Open one, or make one from pictures</span></span></div>`;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const OFFICE_FILE = /\.(docx?|docm|odt|rtf|pptx?|ppsx?|odp|key|xlsx?|xlsm|ods|csv|pages|numbers)$/i;

export class Home {
  readonly root: HTMLElement;
  private view: View = 'start';
  private items: RecentItem[] = [];

  constructor(private readonly hooks: HomeHooks) {
    this.root = el(`<section class="fs-home" aria-label="Home" hidden>
<div class="fs-home-drag" data-tauri-drag-region></div>
<nav class="fs-home-nav">
<div class="fs-home-brand">${brandMark(26)}formpdf <span>by nodemode.ai</span></div>
<button class="fs-home-nav-item is-active" type="button" data-v="start">${icon('sparkle', 16)}<span>Start</span></button>
<button class="fs-home-nav-item" type="button" data-v="recent">${icon('filePdf', 16)}<span>Recent PDFs</span><span class="fs-badge is-count fs-recent-count">0</span></button>
<button class="fs-home-nav-item" type="button" data-a="pictures">${icon('fileImage', 16)}<span>Create PDF from pictures</span></button>
<button class="fs-home-nav-item" type="button" data-a="merge">${icon('merge', 16)}<span>Merge PDFs</span></button>
<button class="fs-home-nav-item" type="button" data-a="scan">${icon('scanner', 16)}<span>Scan</span></button>
<button class="fs-home-nav-item" type="button" data-v="batch">${icon('layers', 16)}<span>Batch</span></button>
<button class="fs-home-nav-item" type="button" data-v="reviews">${icon('comments', 16)}<span>Reviews</span></button>
<div class="fs-home-nav-sep"></div>
<div class="fs-home-nav-title">Agents</div>
<button class="fs-home-nav-item" type="button" data-a="agents">${icon('agent', 16)}<span>Claude Code, Codex, Cursor</span></button>
<div class="fs-home-nav-foot">
<button class="fs-home-nav-item" type="button" data-a="local" title="Your PDFs stay on this computer">${icon('cloudOff', 16)}<span>Local only</span></button>
<button class="fs-home-nav-item" type="button" data-a="help">${icon('info', 16)}<span>Help</span></button>
<button class="fs-home-nav-item" type="button" data-a="prefs">${icon('settings', 16)}<span>Preferences</span></button>
</div></nav>
<div class="fs-home-main">
<div data-page="start">
<div class="fs-home-head"><div><h1 class="fs-home-title"></h1><p class="fs-home-sub is-line">Read, comment, fill and sign, organize, protect and convert PDFs on this computer.</p></div><div class="fs-home-head-actions"><button class="fs-btn" type="button" data-a="path">${icon('load', 14)}Open by path</button><button class="fs-btn" type="button" data-a="merge">${icon('merge', 14)}Merge PDFs</button></div></div>
<div class="fs-home-hero">
<span class="fs-home-hero-icon">${icon('filePdf', 26)}</span>
<div class="fs-home-hero-text"><div class="fs-home-hero-title">Open a PDF</div>
<div class="fs-home-hero-sub">Drop a PDF here, or pictures or Office files to make one. View and read aloud, search and compare, comment and stamp, fill, sign and build forms, organize, split and merge, add headers, footers and Bates numbers, find and redact, protect, compress, and export to Word or PowerPoint.</div>
<div class="fs-home-formats"><span class="fs-home-format">PDF</span><span class="fs-home-format">PNG</span><span class="fs-home-format">JPG</span><span class="fs-home-format">GIF</span><span class="fs-home-format">WEBP</span><span class="fs-home-format">TIFF</span><span class="fs-home-format">DOCX</span><span class="fs-home-format">PPTX</span><span class="fs-home-format">XLSX</span></div></div>
<div class="fs-home-hero-actions"><button class="fs-btn fs-btn-primary" type="button" data-a="open">${icon('folderOpen', 14)}Open PDF</button><button class="fs-btn" type="button" data-a="view" title="Open a PDF to read it, with the editing tools hidden">${icon('eye', 14)}View PDF</button><button class="fs-btn" type="button" data-a="pictures">${icon('fileImage', 14)}Create from pictures</button><button class="fs-btn fs-btn-ghost" type="button" data-a="agents">${icon('agent', 14)}Use your agent</button></div>
</div>
<section class="fs-home-section"><div class="fs-home-section-head"><h2 class="fs-home-section-title">Recent PDFs</h2><button class="fs-btn fs-btn-ghost fs-btn-sm" type="button" data-v="recent">See all</button></div><div class="fs-card-grid fs-home-recent">${skeleton}${empty}</div></section>
<section class="fs-home-section" data-home-demos><div class="fs-home-section-head"><h2 class="fs-home-section-title">Demos</h2></div><div class="fs-card-grid">${demoCards}</div></section>
</div>
<div data-page="recent" hidden><div class="fs-home-head"><div><h1 class="fs-home-title">Recent PDFs</h1><p class="fs-home-sub">The PDFs you opened here, newest first. Forget removes one from this list; the file itself stays where it is.</p></div></div><div class="fs-card-grid fs-home-recent-full">${skeleton}${empty}</div></div>
<div data-page="batch" hidden></div>
<div data-page="reviews" hidden></div>
</div></section>`);
    document.getElementById('app')?.appendChild(this.root);
    this.wire();
  }

  private wire(): void {
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const v = (t.closest('[data-v]') as HTMLElement | null)?.dataset.v as View | undefined;
      if (v) { this.show(v); return; }
      const demo = (t.closest('[data-demo]') as HTMLElement | null)?.dataset.demo as DemoId | undefined;
      if (demo) { this.hooks.demo(demo); return; }
      const card = t.closest('.fs-pdfwb-recent') as HTMLElement | null;
      if (card?.dataset.id) {
        if (t.closest('[data-forget]')) { void pdfApi.forget(card.dataset.keyid ?? '').then(() => this.load()); return; }
        this.hooks.openRecent(card.dataset.id);
        return;
      }
      const a = (t.closest('[data-a]') as HTMLElement | null)?.dataset.a;
      if (a === 'open') this.pick();
      else if (a === 'view') this.pick(true);
      else if (a === 'path') this.hooks.openPath();
      else if (a === 'pictures') this.hooks.create('pictures');
      else if (a === 'merge') this.hooks.create('files');
      else if (a === 'scan') this.hooks.scan();
      else if (a === 'prefs') this.hooks.preferences();
      else if (a === 'agents') this.hooks.agents();
      else if (a === 'help') this.hooks.help();
      else if (a === 'local') toast('Your PDFs, working copies and exports stay in the Formpdf folder on this computer.');
    });
    this.root.addEventListener('keydown', (e) => {
      const demo = (e.target as HTMLElement).closest('[data-demo]') as HTMLElement | null;
      if (demo && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.hooks.demo(demo.dataset.demo as DemoId); return; }
      const card = (e.target as HTMLElement).closest('.fs-pdfwb-recent') as HTMLElement | null;
      if (card?.dataset.id && (e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('[data-forget]')) { e.preventDefault(); this.hooks.openRecent(card.dataset.id); }
    });
    const hero = q(this.root, '.fs-home-hero');
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setClass(hero, 'is-drag-over', true); } });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget as Node | null)) setClass(hero, 'is-drag-over', false); });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      setClass(hero, 'is-drag-over', false);
      void this.dropped(Array.from(e.dataTransfer?.files ?? []));
    });
  }

  async dropped(given: File[]): Promise<void> {
    let all = given;
    try {
      all = await expandZips(given);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    {
      const pictures = all.filter((f) => IMAGE_FILE.test(f.name));
      const pdfs = all.filter((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
      const office = all.filter((f) => OFFICE_FILE.test(f.name));
      if (pictures.length || office.length || pdfs.length > 1) this.hooks.create(pictures.length && !pdfs.length && !office.length ? 'pictures' : 'files', all.filter((f) => pictures.includes(f) || pdfs.includes(f) || office.includes(f)));
      else if (pdfs.length) this.hooks.openFiles(pdfs);
      else if (all.length) toast('Drop a PDF, pictures, Office files or a zip of them');
      else if (given.length) toast('The zip has no PDFs, pictures or Office files in it');
    }
  }

  private pick(view = false): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,application/pdf';
    input.onchange = () => { const files = Array.from(input.files ?? []); if (files.length) (view ? this.hooks.viewFiles : this.hooks.openFiles)(files); };
    input.click();
  }

  async load(): Promise<void> {
    const h = new Date().getHours();
    setText(q(this.root, '[data-page="start"] .fs-home-title'), h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
    try { this.items = (await pdfApi.recent()).items; } catch { this.items = []; }
    setText(q(this.root, '.fs-recent-count'), String(this.items.length));
    this.render(q(this.root, '.fs-home-recent'), this.items.slice(0, 8));
    this.render(q(this.root, '.fs-home-recent-full'), this.items);
  }

  private render(grid: HTMLElement, items: RecentItem[]): void {
    const update = (n: HTMLElement, it: RecentItem): void => {
      setText(n.querySelector('.fs-card-name'), it.name);
      setText(n.querySelector('.fs-card-meta'), `${it.pages} page${it.pages === 1 ? '' : 's'} · ${new Date(it.opened * 1000).toLocaleDateString()}`);
      n.title = it.path ?? it.name;
    };
    patchList(grid, items, {
      key: (it) => `${it.key}|${it.id}`,
      create: (it) => {
        const n = el(`<div class="fs-card fs-pdfwb-recent" role="button" tabindex="0" data-id="${escapeHtml(it.id)}" data-keyid="${escapeHtml(it.key)}"><span class="fs-card-preview fs-pdfwb-recent-prev"></span><span class="fs-card-body"><span class="fs-card-name"></span><span class="fs-card-meta"></span></span><button class="fs-icon-btn is-sm fs-pdfwb-forget" type="button" data-forget title="Forget" aria-label="Forget this PDF">${icon('close', 12)}</button></div>`);
        update(n, it);
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => (n.querySelector('.fs-card-preview') as HTMLElement).appendChild(img);
        img.src = pdfApi.renderUrl(it.id, 1, 0.4);
        return n;
      },
      update,
    });
    const none = grid.querySelector<HTMLElement>('.fs-card.is-empty');
    if (none) setHidden(none, items.length > 0);
  }

  show(v: View = this.view): void {
    this.view = v;
    for (const page of Array.from(this.root.querySelectorAll<HTMLElement>('[data-page]'))) setHidden(page, page.dataset.page !== v);
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-home-nav-item[data-v]'))) setClass(b, 'is-active', b.dataset.v === v);
    this.onView(v);
  }

  onView: (v: View) => void = () => undefined;

  open(): void {
    setHidden(this.root, false);
    document.body.classList.add('nm-home');
    void this.load();
  }

  close(): void {
    setHidden(this.root, true);
    document.body.classList.remove('nm-home');
  }

  get isOpen(): boolean { return !this.root.hidden; }
}
