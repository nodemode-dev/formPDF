import { Finder } from '../../frontend/src/pdf/find';
import { Thumbs, Viewer, openDocument, type PageView } from '../../frontend/src/pdf/viewer';
import { ICONS } from '../../frontend/src/ui/icons';
import { el, escapeHtml, mountOnce, patchList, q, setClass, setHidden, setText } from '../../frontend/src/ui/dom';
import { VERSION } from '../../frontend/src/version';
import logoUrl from '../../frontend/public/formpdf-logo.png';
import { applyPlan, extractPages, mergeInto, numberPages, pageCount, parseRange, readInfo, setTitle, watermark, type NumberFormat, type NumberPos, type PlanCard } from './pdfops';
import { makeSample } from './sample';
import { LIBRARY, loadPack } from './media';

type Tab = 'view' | 'organize' | 'extract' | 'merge' | 'stamp';
interface Size { w: number; h: number; rotate: number }
interface Snapshot { bytes: Uint8Array; label: string }
interface Queued { name: string; bytes: Uint8Array; pages: number }

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'view', label: 'View' },
  { id: 'organize', label: 'Organize' },
  { id: 'extract', label: 'Extract' },
  { id: 'merge', label: 'Merge' },
  { id: 'stamp', label: 'Number and mark' },
];
const CARD = 148;

const ic = (name: string, size = 16): string => `<span class="icon" style="width:${size}px;height:${size}px">${ICONS[name] ?? ''}</span>`;
const btn = (a: string, icon: string, label: string, cls = ''): string => `<button class="fs-btn ${cls}" type="button" data-a="${a}">${icon ? ic(icon) : ''}<span>${label}</span></button>`;
const iconBtn = (a: string, icon: string, title: string): string => `<button class="fs-icon-btn" type="button" data-a="${a}" title="${title}" aria-label="${title}">${ic(icon)}</button>`;
const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const libRows = (verb: string, act: string): string => LIBRARY.map((d) => `<div class="dm-lib"><span class="dm-lib-text"><span class="dm-qname">${d.title}</span><span class="dm-muted">${d.note}</span></span><button class="fs-btn" type="button" data-a="${act}" data-lib="${d.id}"><span>${verb}</span></button></div>`).join('');

const HTML = `
<div class="fs-pdfwb has-doc" id="wb" data-tab="view">
  <header class="fs-pdfwb-title">
    <div class="fs-brand"><img class="fs-mark" src="${logoUrl}" width="22" height="22" alt="" draggable="false"><span class="fs-brand-name">formpdf</span></div>
    <span class="fs-pdfwb-crumb">DEMO ${VERSION}</span>
    <nav class="dm-demos" aria-label="Demos"><a href="./index.html" aria-current="page">Pages and search</a><a href="../demos/sign/index.html">Annotate and sign</a><a href="../demos/protect/index.html">Redact, compare, convert</a></nav>
    <div class="fs-pdfwb-doc"><span class="fs-pdfwb-name" data-r="name"></span><span class="fs-chip fs-pdfwb-edited is-off" data-r="edited">Edited</span></div>
    <div class="fs-pdfwb-actions">
      ${iconBtn('undo', 'undo', 'Undo')}${iconBtn('redo', 'redo', 'Redo')}
      ${btn('open', 'folderOpen', 'Open PDF')}${btn('sample', 'newFile', 'Sample')}${btn('save', 'save', 'Save', 'fs-btn-primary')}
    </div>
  </header>
  <div class="fs-pdfwb-tools">
    <nav class="fs-pdfwb-tabs" role="tablist">${TABS.map((t) => `<button class="fs-pdfwb-tab" type="button" role="tab" data-tab="${t.id}">${t.label}</button>`).join('')}</nav>
    <div class="fs-pdfwb-set" data-set="view">
      <div class="fs-seg is-quiet dm-seg" data-r="layout"><button type="button" data-layout="continuous" title="Continuous">${ic('pageScroll')}</button><button type="button" data-layout="single" title="Single page">${ic('pageSingle')}</button><button type="button" data-layout="two-continuous" title="Two pages">${ic('pageTwoScroll')}</button></div>
      ${btn('rot-l', 'rotate', 'Rotate view', 'fs-btn-ghost')}
      <span class="dm-sep"></span>
      <span class="dm-find">${ic('search')}<input class="fs-input dm-find-in" data-r="find" type="search" placeholder="Find in document" aria-label="Find in document"><span class="dm-count" data-r="count"></span>${iconBtn('find-prev', 'chevronUp', 'Previous match')}${iconBtn('find-next', 'chevronDown', 'Next match')}</span>
    </div>
    <div class="fs-pdfwb-set" data-set="organize" hidden>
      ${btn('org-left', 'rotate', 'Rotate left', 'is-flip')}${btn('org-right', 'rotate', 'Rotate right')}${btn('org-delete', 'delete', 'Delete')}${btn('org-all', 'check', 'Select all', 'fs-btn-ghost')}${btn('org-extract', 'pageExtract', 'Extract selected')}
      <span class="dm-sep"></span>
      ${btn('org-reset', 'history', 'Reset', 'fs-btn-ghost')}${btn('org-apply', 'check', 'Apply changes', 'fs-btn-primary')}
    </div>
    <div class="fs-pdfwb-set" data-set="extract" hidden>
      <label class="dm-lab">Pages</label><input class="fs-input dm-range" data-r="range" type="text" value="1" aria-label="Page range">
      ${btn('ex-pages', 'pageExtract', 'Extract pages to PDF')}
      <span class="dm-sep"></span>
      ${btn('ex-text', 'fileText', 'Save all text')}${btn('ex-copy', 'duplicate', 'Copy page text', 'fs-btn-ghost')}
    </div>
    <div class="fs-pdfwb-set" data-set="merge" hidden>
      ${btn('mg-add', 'add', 'Add PDFs')}
      <select class="fs-input dm-sel" data-r="mg-where" aria-label="Where"><option value="end">At the end</option><option value="start">At the start</option><option value="after">After page</option></select>
      <input class="fs-input dm-num" data-r="mg-after" type="number" min="1" value="1" aria-label="After page">
      <span class="dm-sep"></span>
      ${btn('mg-go', 'merge', 'Merge', 'fs-btn-primary')}${btn('mg-clear', 'close', 'Clear list', 'fs-btn-ghost')}
    </div>
    <div class="fs-pdfwb-set" data-set="stamp" hidden>
      ${btn('st-num', 'numberList', 'Add page numbers')}${btn('st-mark', 'stamp', 'Add watermark')}
      <span class="fs-pdfwb-settext">Options are in the panel on the right.</span>
    </div>
  </div>
  <main class="fs-pdfwb-main">
    <aside class="fs-pdfwb-side">
      <div class="fs-pdfwb-sidehead"><div class="fs-seg is-quiet"><button type="button" class="is-on">Pages</button></div><span class="dm-muted" data-r="side-count"></span></div>
      <div class="fs-pdfwb-sidebody"></div>
    </aside>
    <section class="fs-pdfwb-center" data-r="center">
      <div class="fs-pdf-org" data-r="org" tabindex="0" hidden><div class="fs-pdf-org-grid" data-r="grid"></div><div class="fs-pdf-org-marker" data-r="marker" hidden></div></div>
      <div class="dm-opening" data-r="opening"><span class="dm-opening-card"><strong data-r="opening-title">Opening Alice in Wonderland</strong><span class="dm-muted">An illustrated edition, typeset as a PDF</span><span class="dm-bar"></span></span></div>
      <div class="dm-drop" data-r="drop" hidden><div class="dm-drop-card">${ic('upload', 28)}<strong>Drop a PDF to open it</strong><span>It stays in this browser tab.</span></div></div>
    </section>
    <aside class="fs-pdfwb-panel">
      <div class="dm-pane" data-pane="view">
        <section class="dm-sec"><h3>Document</h3>
          <dl class="dm-kv"><dt>Title</dt><dd data-r="i-title"></dd><dt>Author</dt><dd data-r="i-author"></dd><dt>Pages</dt><dd data-r="i-pages"></dd><dt>Size</dt><dd data-r="i-size"></dd><dt>Producer</dt><dd data-r="i-prod"></dd></dl>
          <div class="dm-row"><input class="fs-input" data-r="title-in" type="text" placeholder="New title" aria-label="New title">${btn('set-title', 'check', 'Set title')}</div>
        </section>
        <section class="dm-sec"><h3>Library</h3>${libRows('Open', 'lib-open')}</section>
        <section class="dm-sec"><h3>Matches</h3><div class="dm-hits" data-r="hits"><p class="dm-muted">Type in the find box to search every page.</p></div></section>
      </div>
      <div class="dm-pane" data-pane="organize" hidden>
        <section class="dm-sec"><h3>Pages</h3><p class="dm-muted" data-r="org-info"></p>
          <p class="dm-muted">Click a page to select it, shift or ctrl click to select more. Drag selected pages to a new place in the grid. Apply changes writes a new working copy.</p></section>
      </div>
      <div class="dm-pane" data-pane="extract" hidden>
        <section class="dm-sec"><h3>Text on page <span data-r="tx-page"></span></h3><pre class="dm-text" data-r="tx"></pre></section>
      </div>
      <div class="dm-pane" data-pane="merge" hidden>
        <section class="dm-sec"><h3>Library</h3>${libRows('Add', 'lib-add')}</section>
        <section class="dm-sec"><h3>Files to merge</h3><div class="dm-queue" data-r="queue"><p class="dm-muted">Add PDFs from your computer. They are inserted into the open document.</p></div></section>
      </div>
      <div class="dm-pane" data-pane="stamp" hidden>
        <section class="dm-sec"><h3>Page numbers</h3>
          <label class="dm-field">Format<select class="fs-input" data-r="n-fmt"><option value="page-of">Page 1 of N</option><option value="slash">1 / N</option><option value="plain">1</option></select></label>
          <label class="dm-field">Position<select class="fs-input" data-r="n-pos"><option value="bc">Bottom center</option><option value="br">Bottom right</option><option value="bl">Bottom left</option><option value="tc">Top center</option><option value="tr">Top right</option><option value="tl">Top left</option></select></label>
          <label class="dm-field">Size<input class="fs-input" data-r="n-size" type="number" min="6" max="48" value="10"></label>
          <label class="dm-field">Start at<input class="fs-input" data-r="n-from" type="number" min="0" value="1"></label>
        </section>
        <section class="dm-sec"><h3>Watermark</h3>
          <label class="dm-field">Text<input class="fs-input" data-r="w-text" type="text" value="DRAFT"></label>
          <label class="dm-field">Opacity<input data-r="w-op" type="range" min="5" max="100" value="25"></label>
          <label class="dm-field">Size<input class="fs-input" data-r="w-size" type="number" min="20" max="200" value="96"></label>
        </section>
      </div>
    </aside>
  </main>
  <footer class="fs-status fs-pdfwb-status">
    <div class="fs-status-left"><span class="fs-st" data-r="st-doc"></span><span class="fs-st fs-st-hint" data-r="st-hint">Ready</span></div>
    <div class="fs-status-right">
      <span class="fs-st"><input class="fs-input dm-pg" data-r="pg" type="text" inputmode="numeric" aria-label="Page"><span data-r="pg-of"></span></span>
      ${iconBtn('zoom-out', 'zoomOut', 'Zoom out')}<span class="fs-st fs-st-zoom" data-r="zoom">100%</span>${iconBtn('zoom-in', 'zoomIn', 'Zoom in')}${iconBtn('fit-w', 'fitView', 'Fit width')}${iconBtn('fit-p', 'zoomFit', 'Fit page')}
    </div>
  </footer>
  <input type="file" accept="application/pdf,.pdf" data-r="file-open" hidden>
  <input type="file" accept="application/pdf,.pdf" multiple data-r="file-merge" hidden>
</div>`;

export function start(host: HTMLElement): void {
  mountOnce(host, HTML);
  const root = q(host, '#wb');
  const r = (name: string): HTMLElement => q(root, `[data-r="${name}"]`);
  const input = (name: string): HTMLInputElement => r(name) as HTMLInputElement;

  let bytes: Uint8Array = new Uint8Array(0);
  let name = LIBRARY[0].file;
  let undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let tab: Tab = 'view';
  let sizes: Size[] = [];
  let plan: PlanCard[] = [];
  let selected = new Set<number>();
  let lastClicked = -1;
  let uid = 0;
  let blobUrl = '';
  let queue: Queued[] = [];
  let loading = 0;
  let dragUids: number[] = [];
  let dropAt = -1;

  const hint = (t: string): void => setText(r('st-hint'), t);
  const center = r('center');
  const viewer = new Viewer(center, {
    page: (n) => onPage(n),
    zoom: (pct) => { setText(r('zoom'), `${pct}%`); },
    mounted: () => undefined,
    textReady: (pv: PageView) => finder.paint(pv),
    rendered: () => undefined,
  });
  const finder = new Finder(viewer);
  const thumbs = new Thumbs(viewer);
  q(root, '.fs-pdfwb-sidebody').prepend(thumbs.root);
  thumbs.onPick = (n) => { if (tab === 'organize') focusCard(n - 1); else viewer.goTo(n); };

  const sync = (): void => {
    setText(r('name'), name);
    setClass(r('edited'), 'is-off', undoStack.length === 0);
    (q(root, '[data-a="undo"]') as HTMLButtonElement).disabled = undoStack.length === 0;
    (q(root, '[data-a="redo"]') as HTMLButtonElement).disabled = redoStack.length === 0;
    setText(r('st-doc'), `${sizes.length} page${sizes.length === 1 ? '' : 's'} · ${kb(bytes.length)}`);
    setText(r('pg-of'), `of ${sizes.length}`);
    if (document.activeElement !== r('pg')) input('pg').value = String(viewer.currentPage());
    setText(r('side-count'), String(sizes.length));
    setText(r('i-pages'), String(sizes.length));
    setText(r('i-size'), kb(bytes.length));
    const s = sizes[Math.max(0, viewer.currentPage() - 1)];
    if (s) hint(`Page ${Math.round(s.w)} x ${Math.round(s.h)} pt`);
  };

  const onPage = (n: number): void => {
    const pg = input('pg');
    if (document.activeElement !== pg && pg.value !== String(n)) pg.value = String(n);
    thumbs.setCurrent(n);
    if (tab === 'extract') void showText(n);
  };

  async function showText(n: number): Promise<void> {
    setText(r('tx-page'), String(n));
    try {
      const pt = await viewer.pageText(n - 1);
      setText(r('tx'), pt.text.trim() || 'No text on this page. It may be a scan.');
    } catch { setText(r('tx'), ''); }
  }

  async function measure(data: Uint8Array): Promise<Size[]> {
    const doc = await openDocument(data.slice());
    const out: Size[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      out.push({ w: p.view[2] - p.view[0], h: p.view[3] - p.view[1], rotate: p.rotate });
    }
    void doc.loadingTask.destroy();
    return out;
  }

  async function show(data: Uint8Array, label: string, keep: boolean): Promise<void> {
    const run = ++loading;
    const next = await measure(data);
    if (run !== loading) return;
    const url = URL.createObjectURL(new Blob([data.slice()], { type: 'application/pdf' }));
    await viewer.load(url, next, { keep, bytes: data.length });
    setHidden(r('opening'), true);
    const old = blobUrl;
    blobUrl = url;
    if (old) window.setTimeout(() => URL.revokeObjectURL(old), 4000);
    bytes = data;
    sizes = next;
    plan = next.map((_, i) => ({ uid: uid++, src: i, rot: 0 }));
    selected = new Set();
    lastClicked = -1;
    thumbs.sync(next);
    thumbs.setCurrent(Math.min(viewer.currentPage(), next.length) || 1);
    void finder.search(input('find').value);
    renderOrg();
    sync();
    void refreshInfo();
    if (tab === 'extract') void showText(viewer.currentPage());
    if (label) hint(label);
  }

  async function refreshInfo(): Promise<void> {
    try {
      const info = await readInfo(bytes);
      setText(r('i-title'), info.title || 'None');
      setText(r('i-author'), info.author || 'None');
      setText(r('i-prod'), info.producer || 'None');
    } catch { setText(r('i-title'), 'Unavailable'); }
  }

  async function commit(next: Uint8Array, label: string): Promise<void> {
    undoStack.push({ bytes, label });
    redoStack = [];
    await show(next, label, true);
  }

  async function guarded(label: string, job: () => Promise<void>): Promise<void> {
    hint(`${label}...`);
    try { await job(); } catch (e) { hint(`${label} failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function openBytes(data: Uint8Array, fileName: string): Promise<void> {
    try {
      await measure(data);
    } catch (e) {
      const msg = e instanceof Error && /password/i.test(`${e.name} ${e.message}`) ? 'This PDF is password protected. The demo opens unprotected files only.' : `That file could not be read as a PDF${e instanceof Error ? ` (${e.message.slice(0, 120)})` : ''}.`;
      hint(msg);
      return;
    }
    undoStack = [];
    redoStack = [];
    queue = [];
    renderQueue();
    name = fileName;
    await show(data, `Opened ${fileName}`, false);
  }

  async function libOpen(id: string): Promise<void> {
    const doc = LIBRARY.find((d) => d.id === id);
    if (!doc) return;
    hint(`Opening ${doc.title}...`);
    try { await openBytes(await loadPack(id), doc.file); viewer.applyFit('page'); } catch (e) { hint(`${doc.title} could not be loaded: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function libAdd(id: string): Promise<void> {
    const doc = LIBRARY.find((d) => d.id === id);
    if (!doc) return;
    if (queue.some((f) => f.name === doc.file)) { hint(`${doc.title} is already in the list.`); return; }
    hint(`Adding ${doc.title}...`);
    try {
      const data = await loadPack(id);
      queue.push({ name: doc.file, bytes: data, pages: await pageCount(data) });
      renderQueue();
      hint(`${queue.length} file${queue.length === 1 ? '' : 's'} ready to merge`);
    } catch (e) { hint(`${doc.title} could not be loaded: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function openFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  function download(data: Uint8Array | string, fileName: string, type: string): void {
    const blob = new Blob([typeof data === 'string' ? data : data.slice()], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const stem = (): string => name.replace(/\.pdf$/i, '');

  function setTab(next: Tab): void {
    if (next === tab) return;
    if (tab !== 'organize' && next === 'organize') viewer.park();
    tab = next;
    root.dataset.tab = next;
    for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab')) {
      const on = b.dataset.tab === next;
      setClass(b, 'is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const s of root.querySelectorAll<HTMLElement>('[data-set]')) setHidden(s, s.dataset.set !== next);
    for (const p of root.querySelectorAll<HTMLElement>('[data-pane]')) setHidden(p, p.dataset.pane !== next);
    const org = next === 'organize';
    setHidden(r('org'), !org);
    setHidden(viewer.scroller, org);
    if (!org) viewer.unpark();
    if (org) renderOrg();
    if (next === 'extract') void showText(viewer.currentPage());
  }

  function renderOrg(): void {
    const grid = r('grid');
    patchList(grid, plan, { key: (c) => String(c.uid), create: createCard, update: updateCard });
    const dirty = isDirty();
    (q(root, '[data-a="org-apply"]') as HTMLButtonElement).disabled = !dirty;
    (q(root, '[data-a="org-reset"]') as HTMLButtonElement).disabled = !dirty;
    for (const a of ['org-left', 'org-right', 'org-delete', 'org-extract']) (q(root, `[data-a="${a}"]`) as HTMLButtonElement).disabled = selected.size === 0;
    setText(r('org-info'), `${plan.length} page${plan.length === 1 ? '' : 's'} · ${selected.size} selected · ${dirty ? 'not applied yet' : 'no changes'}`);
  }

  function isDirty(): boolean {
    return plan.length !== sizes.length || plan.some((c, i) => c.src !== i || c.rot !== 0);
  }

  const cardIo = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const node = e.target as HTMLElement;
      if (!e.isIntersecting || node.dataset.drawn) continue;
      node.dataset.drawn = '1';
      const src = Number(node.dataset.src);
      void viewer.thumb(src, CARD).then((c) => {
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d')?.drawImage(c, 0, 0);
        const host = node.querySelector('.fs-pdf-card-thumb') as HTMLElement;
        host.replaceChildren(copy);
      }).catch(() => { delete node.dataset.drawn; });
    }
  }, { root: null, rootMargin: '400px' });

  function createCard(c: PlanCard): HTMLElement {
    const node = el(`<div class="fs-pdf-card" draggable="true" role="option"><div class="fs-pdf-card-box"><div class="fs-pdf-card-thumb"></div></div><div class="fs-pdf-card-foot"><span class="fs-pdf-card-n"></span><span class="fs-pdf-card-from"></span></div></div>`);
    node.dataset.src = String(c.src);
    node.dataset.uid = String(c.uid);
    cardIo.observe(node);
    return node;
  }

  function updateCard(node: HTMLElement, c: PlanCard): void {
    const idx = plan.indexOf(c);
    const s = sizes[c.src];
    const ownOdd = s.rotate % 180 !== 0;
    const dw = ownOdd ? s.h : s.w, dh = ownOdd ? s.w : s.h;
    const turned = c.rot % 180 !== 0;
    const bw = turned ? dh : dw, bh = turned ? dw : dh;
    const k = Math.min(CARD / bw, CARD / bh);
    const thumb = node.querySelector('.fs-pdf-card-thumb') as HTMLElement;
    const w = `${Math.round(dw * k)}px`, h = `${Math.round(dh * k)}px`;
    if (thumb.style.width !== w) thumb.style.width = w;
    if (thumb.style.height !== h) thumb.style.height = h;
    const tf = `translate(-50%, -50%) rotate(${c.rot}deg)`;
    if (thumb.style.transform !== tf) thumb.style.transform = tf;
    setText(node.querySelector('.fs-pdf-card-n'), String(idx + 1));
    setText(node.querySelector('.fs-pdf-card-from'), idx + 1 === c.src + 1 ? '' : `was ${c.src + 1}`);
    setClass(node, 'is-selected', selected.has(c.uid));
    node.setAttribute('aria-selected', String(selected.has(c.uid)));
  }

  function focusCard(index: number): void {
    const node = r('grid').children[index] as HTMLElement | undefined;
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function cardAt(target: EventTarget | null): HTMLElement | null {
    return (target as HTMLElement | null)?.closest?.('.fs-pdf-card') as HTMLElement | null;
  }

  r('grid').addEventListener('click', (e) => {
    const node = cardAt(e.target);
    if (!node) return;
    const id = Number(node.dataset.uid);
    const idx = plan.findIndex((c) => c.uid === id);
    if (e.shiftKey && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
      selected = new Set(plan.slice(a, b + 1).map((c) => c.uid));
    } else if (e.metaKey || e.ctrlKey) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      lastClicked = idx;
    } else {
      selected = new Set([id]);
      lastClicked = idx;
    }
    renderOrg();
  });

  r('grid').addEventListener('dragstart', (e) => {
    const node = cardAt(e.target);
    if (!node) return;
    const id = Number(node.dataset.uid);
    if (!selected.has(id)) { selected = new Set([id]); renderOrg(); }
    dragUids = plan.filter((c) => selected.has(c.uid)).map((c) => c.uid);
    e.dataTransfer?.setData('text/plain', 'pages');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    for (const c of r('grid').children) setClass(c as HTMLElement, 'is-dragging', dragUids.includes(Number((c as HTMLElement).dataset.uid)));
  });

  r('grid').addEventListener('dragover', (e) => {
    if (!dragUids.length) return;
    e.preventDefault();
    const org = r('org');
    const cards = Array.from(r('grid').children) as HTMLElement[];
    let at = cards.length;
    let rect: DOMRect | null = null;
    for (let i = 0; i < cards.length; i++) {
      const b = cards[i].getBoundingClientRect();
      const sameRow = e.clientY >= b.top && e.clientY <= b.bottom;
      if (sameRow && e.clientX < b.left + b.width / 2) { at = i; rect = b; break; }
      if (e.clientY < b.top) { at = i; rect = b; break; }
    }
    dropAt = at;
    const ref = rect ?? cards[cards.length - 1]?.getBoundingClientRect();
    if (!ref) return;
    const o = org.getBoundingClientRect();
    const marker = r('marker');
    const x = (rect ? ref.left : ref.right) - o.left + org.scrollLeft - 6;
    marker.style.left = `${x}px`;
    marker.style.top = `${ref.top - o.top + org.scrollTop}px`;
    marker.style.height = `${ref.height}px`;
    setHidden(marker, false);
  });

  const endDrag = (): void => {
    dragUids = [];
    dropAt = -1;
    setHidden(r('marker'), true);
    for (const c of r('grid').children) setClass(c as HTMLElement, 'is-dragging', false);
  };
  r('grid').addEventListener('dragend', endDrag);
  r('grid').addEventListener('drop', (e) => {
    if (!dragUids.length || dropAt < 0) return;
    e.preventDefault();
    const moving = plan.filter((c) => dragUids.includes(c.uid));
    const before = plan.slice(0, dropAt).filter((c) => !dragUids.includes(c.uid));
    const after = plan.slice(dropAt).filter((c) => !dragUids.includes(c.uid));
    plan = [...before, ...moving, ...after];
    endDrag();
    renderOrg();
  });

  function rotateSelected(delta: number): void {
    for (const c of plan) if (selected.has(c.uid)) c.rot = (((c.rot + delta) % 360) + 360) % 360;
    renderOrg();
  }

  function applyOrganize(): void {
    void guarded('Applying page changes', async () => {
      const out = await applyPlan(bytes, plan);
      await commit(out, `Applied: ${plan.length} pages`);
    });
  }

  function mergeQueue(): void {
    if (!queue.length) { hint('Add one or more PDFs first.'); return; }
    const where = (r('mg-where') as HTMLSelectElement).value;
    const at = where === 'start' ? 0 : where === 'after' ? Number(input('mg-after').value) || 0 : sizes.length;
    void guarded('Merging', async () => {
      const out = await mergeInto(bytes, queue.map((f) => f.bytes), at);
      const count = queue.length;
      queue = [];
      renderQueue();
      await commit(out, `Merged ${count} file${count === 1 ? '' : 's'}`);
    });
  }

  function renderQueue(): void {
    const host = r('queue');
    if (!queue.length) { host.replaceChildren(el('<p class="dm-muted">Add PDFs from your computer. They are inserted into the open document.</p>')); return; }
    patchList(host, queue, {
      key: (f) => f.name + f.bytes.length,
      create: (f) => el(`<div class="dm-qrow"><span class="dm-qname">${escapeHtml(f.name)}</span><span class="dm-muted">${f.pages} page${f.pages === 1 ? '' : 's'}</span></div>`),
      update: () => undefined,
    });
    for (const p of Array.from(host.children)) if (!(p as HTMLElement).dataset.key) p.remove();
  }

  async function addToQueue(files: FileList | null): Promise<void> {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const data = new Uint8Array(await f.arrayBuffer());
        queue.push({ name: f.name, bytes: data, pages: await pageCount(data) });
      } catch { hint(`${f.name} could not be read as a PDF.`); }
    }
    renderQueue();
    hint(`${queue.length} file${queue.length === 1 ? '' : 's'} ready to merge`);
  }

  function renderHits(): void {
    const host = r('hits');
    const total = finder.hits.length;
    setText(r('count'), finder.query.trim() ? (finder.done ? `${total ? finder.index + 1 : 0} of ${total}` : 'Searching') : '');
    if (!finder.query.trim()) { host.replaceChildren(el('<p class="dm-muted">Type in the find box to search every page.</p>')); return; }
    const shown = finder.hits.slice(0, 60);
    const nodes = shown.map((h, i) => {
      const row = el(`<button class="dm-hit" type="button" data-i="${i}"><span class="dm-hit-page">p. ${h.page + 1}</span><span class="dm-hit-text"></span></button>`);
      void viewer.pageText(h.page).then((pt) => {
        const a = Math.max(0, h.start - 24), b = Math.min(pt.text.length, h.end + 32);
        (row.querySelector('.dm-hit-text') as HTMLElement).textContent = pt.text.slice(a, b).replace(/\s+/g, ' ');
      });
      setClass(row, 'is-current', i === finder.index);
      return row;
    });
    if (!nodes.length) nodes.push(el('<p class="dm-muted">No matches.</p>'));
    host.replaceChildren(...nodes);
  }
  finder.onChange = renderHits;

  r('hits').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.dm-hit') as HTMLElement | null;
    if (!row) return;
    finder.index = Number(row.dataset.i) - 1;
    finder.step(1);
  });

  let findTimer = 0;
  r('find').addEventListener('input', () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(() => void finder.search(input('find').value), 180);
  });
  r('find').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { window.clearTimeout(findTimer); if (finder.query !== input('find').value) void finder.search(input('find').value); else finder.step((e as KeyboardEvent).shiftKey ? -1 : 1); }
  });

  r('layout').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    viewer.setLayout(b.dataset.layout as 'continuous' | 'single' | 'two-continuous', false);
    for (const x of r('layout').querySelectorAll('button')) setClass(x, 'is-on', x === b);
  });
  setClass(r('layout').firstElementChild as HTMLElement, 'is-on', true);

  r('pg').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const n = Number(input('pg').value);
    if (n >= 1 && n <= sizes.length) viewer.goTo(n);
    input('pg').blur();
  });

  const actions: Record<string, () => void> = {
    open: () => (r('file-open') as HTMLInputElement).click(),
    sample: () => void libOpen(LIBRARY[0].id),
    save: () => download(bytes, undoStack.length ? `${stem()}-edited.pdf` : name, 'application/pdf'),
    undo: () => {
      const s = undoStack.pop();
      if (!s) return;
      redoStack.push({ bytes, label: s.label });
      void show(s.bytes, `Undid: ${s.label}`, true);
    },
    redo: () => {
      const s = redoStack.pop();
      if (!s) return;
      undoStack.push({ bytes, label: s.label });
      void show(s.bytes, `Redid: ${s.label}`, true);
    },
    'rot-l': () => viewer.rotateView(90),
    'find-prev': () => finder.step(-1),
    'find-next': () => finder.step(1),
    'org-left': () => rotateSelected(-90),
    'org-right': () => rotateSelected(90),
    'org-delete': () => {
      if (selected.size >= plan.length) { hint('A document needs at least one page.'); return; }
      plan = plan.filter((c) => !selected.has(c.uid));
      selected = new Set();
      renderOrg();
    },
    'org-all': () => { selected = selected.size === plan.length ? new Set() : new Set(plan.map((c) => c.uid)); renderOrg(); },
    'org-extract': () => void guarded('Extracting', async () => {
      const idx = plan.filter((c) => selected.has(c.uid)).map((c) => c.src);
      download(await extractPages(bytes, idx), `${stem()}-selected.pdf`, 'application/pdf');
      hint(`Extracted ${idx.length} page${idx.length === 1 ? '' : 's'}`);
    }),
    'org-reset': () => {
      plan = sizes.map((_, i) => ({ uid: uid++, src: i, rot: 0 }));
      selected = new Set();
      renderOrg();
    },
    'org-apply': applyOrganize,
    'ex-pages': () => void guarded('Extracting', async () => {
      const idx = parseRange(input('range').value, sizes.length);
      if (!idx.length) { hint(`Enter pages between 1 and ${sizes.length}, like 1-3,5.`); return; }
      download(await extractPages(bytes, idx), `${stem()}-pages.pdf`, 'application/pdf');
      hint(`Extracted ${idx.length} page${idx.length === 1 ? '' : 's'}`);
    }),
    'ex-text': () => void guarded('Reading text', async () => {
      const parts: string[] = [];
      for (let i = 0; i < sizes.length; i++) parts.push(`--- Page ${i + 1} ---\n${(await viewer.pageText(i)).text.trim()}\n`);
      download(parts.join('\n'), `${stem()}.txt`, 'text/plain');
      hint(`Saved the text of ${sizes.length} pages`);
    }),
    'ex-copy': () => {
      const t = r('tx').textContent ?? '';
      void navigator.clipboard?.writeText(t).then(() => hint('Page text copied'), () => hint('Copy was blocked by the browser'));
    },
    'mg-add': () => (r('file-merge') as HTMLInputElement).click(),
    'mg-go': mergeQueue,
    'mg-clear': () => { queue = []; renderQueue(); hint('List cleared'); },
    'st-num': () => void guarded('Adding page numbers', async () => {
      const out = await numberPages(bytes, (r('n-fmt') as HTMLSelectElement).value as NumberFormat, (r('n-pos') as HTMLSelectElement).value as NumberPos, Number(input('n-size').value) || 10, Number(input('n-from').value) || 1);
      await commit(out, 'Added page numbers');
    }),
    'st-mark': () => void guarded('Adding the watermark', async () => {
      const text = input('w-text').value.trim();
      if (!text) { hint('Type the watermark text first.'); return; }
      const out = await watermark(bytes, text, (Number(input('w-op').value) || 25) / 100, Number(input('w-size').value) || 96);
      await commit(out, 'Added watermark');
    }),
    'set-title': () => void guarded('Setting the title', async () => {
      const t = input('title-in').value.trim();
      if (!t) return;
      await commit(await setTitle(bytes, t), 'Set title');
      input('title-in').value = '';
    }),
    'zoom-in': () => viewer.zoomStep(1),
    'zoom-out': () => viewer.zoomStep(-1),
    'fit-w': () => viewer.applyFit('width'),
    'fit-p': () => viewer.applyFit('page'),
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tabBtn = t.closest('.fs-pdfwb-tab') as HTMLElement | null;
    if (tabBtn) { setTab(tabBtn.dataset.tab as Tab); return; }
    const hit = t.closest('[data-a]') as HTMLElement | null;
    const a = hit?.dataset.a;
    if (a === 'lib-open' && hit?.dataset.lib) void libOpen(hit.dataset.lib);
    else if (a === 'lib-add' && hit?.dataset.lib) void libAdd(hit.dataset.lib);
    else if (a && actions[a]) actions[a]();
  });

  r('file-open').addEventListener('change', (e) => { const i = e.target as HTMLInputElement; void openFile(i.files?.[0]); i.value = ''; });
  r('file-merge').addEventListener('change', (e) => { const i = e.target as HTMLInputElement; void addToQueue(i.files).then(() => { i.value = ''; }); });

  let depth = 0;
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth += 1; setHidden(r('drop'), false); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setHidden(r('drop'), true); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setHidden(r('drop'), true);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!files.length) { hint('Drop a PDF file.'); return; }
    if (tab === 'merge') void addToQueue(e.dataTransfer?.files ?? null);
    else void openFile(files[0]);
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setTab('view'); input('find').focus(); input('find').select(); }
    else if (mod && e.key.toLowerCase() === 'z' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); actions[e.shiftKey ? 'redo' : 'undo'](); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); actions.save(); }
  });

  for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab')) if (b.dataset.tab === 'view') { setClass(b, 'is-on', true); b.setAttribute('aria-selected', 'true'); }
  (q(root, '[data-a="undo"]') as HTMLButtonElement).disabled = true;
  (q(root, '[data-a="redo"]') as HTMLButtonElement).disabled = true;
  (window as unknown as { __formpdfDemo: unknown }).__formpdfDemo = { ready: loadPack(LIBRARY[0].id).then(async (d) => { await openBytes(d, LIBRARY[0].file); viewer.applyFit('page'); }, async () => { setText(r('opening-title'), 'Opening the offline sample'); await openBytes(await makeSample(), 'harbor-light-field-guide.pdf'); }), viewer, libOpen, libAdd, open: openBytes, setTab, actions };
}
