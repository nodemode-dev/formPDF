import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Thumbs, Viewer, openDocument, type PageView } from '../../../frontend/src/pdf/viewer';
import { Comparer, ComparePanel } from '../../../frontend/src/pdf/compare';
import { icon } from '../../../frontend/src/ui/icons';
import { el, escapeHtml, mountOnce, patchList, q, setClass, setDisabled, setHidden, setText } from '../../../frontend/src/ui/dom';
import { VERSION } from '../../../frontend/src/version';
import logoUrl from '../../../frontend/public/formpdf-logo.png';
import type { HiddenItem, Match } from '../../../frontend/src/pdf/api';
import { blocksOf, compareRuns, findIn, hiddenScan, listPics, pageRuns, readMeta, redact, sanitize, setMeta, type Area, type Block, type FindBody, type PageRuns, type Pic } from './engine';
import { protect, type Perms } from './crypto';
import { toDocx, toHtml, toMarkdown, toRtf, toText, zip } from './convert';
import { LIBRARY, loadPack } from './media';

type Tab = 'view' | 'protect' | 'compare' | 'extract' | 'convert';
interface Size { w: number; h: number; rotate: number }
interface Snapshot { bytes: Uint8Array; label: string }

const TABS: Array<[Tab, string]> = [['view', 'View'], ['protect', 'Protect'], ['compare', 'Compare'], ['extract', 'Extract'], ['convert', 'Convert']];
const NOTES: Record<Tab, string> = {
  view: 'Open a PDF, or pick one from the library. Everything stays in this tab.',
  protect: 'Find what must go, black it out, drop what the file hides, then lock the copy.',
  compare: 'Set two versions side by side and step through every difference.',
  extract: 'Pull the text and the pictures out of the pages.',
  convert: 'Save the pages as Word, a web page, rich text or Markdown.',
};
const HIDDEN_HELP: Record<string, string> = { fields: 'Fields are kept by this demo.' };
const MODES: Array<[string, string]> = [['text', 'Words or phrase'], ['email', 'Email addresses'], ['phone', 'Phone numbers'], ['card', 'Credit card numbers'], ['date', 'Dates'], ['regex', 'Pattern (regular expression)']];
const FORMATS: Array<[string, string, string]> = [['docx', 'Word document (.docx)', 'fileWord'], ['html', 'Web page (.html)', 'filePdf'], ['rtf', 'Rich text (.rtf)', 'fileText'], ['md', 'Markdown (.md)', 'fileText'], ['txt', 'Plain text (.txt)', 'fileText']];
const MIME: Record<string, string> = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html', rtf: 'application/rtf', md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip', jpg: 'image/jpeg' };

const ic = (name: string, size = 16): string => `<span class="icon" style="width:${size}px;height:${size}px">${icon(name, size)}</span>`;
const sec = (title: string, body: string, extra = ''): string => `<section class="fs-pdfwb-sec" ${extra}><h3 class="fs-pdfwb-sec-title">${title}</h3>${body}</section>`;
const row = (label: string, ctl: string): string => `<div class="fs-prop-row"><span class="fs-prop-label">${label}</span><div class="fs-prop-ctl">${ctl}</div></div>`;
const btn = (a: string, i: string, label: string, cls = ''): string => `<button class="fs-btn fs-btn-sm ${cls}" type="button" data-a="${a}">${i ? icon(i, 14) : ''}<span>${label}</span></button>`;
const iconBtn = (a: string, i: string, title: string): string => `<button class="fs-icon-btn" type="button" data-a="${a}" title="${title}" aria-label="${title}">${ic(i)}</button>`;
const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const calc = (v: number): string => `calc(var(--k) * ${Math.round(v * 100) / 100}px)`;
const stemOf = (n: string): string => n.replace(/\.pdf$/i, '');
const libRows = (act: string, verb: string): string => LIBRARY.map((d) => `<div class="pt-lib"><span class="pt-lib-text"><span class="pt-name">${d.title}</span><span class="fs-note">${d.note}</span></span><button class="fs-btn fs-btn-sm" type="button" data-a="${act}" data-lib="${d.id}"><span>${verb}</span></button></div>`).join('');

const HTML = `
<div class="fs-pdfwb has-doc is-booting" id="wb" data-tab="protect">
  <header class="fs-pdfwb-title">
    <div class="fs-brand"><img class="fs-mark" src="${logoUrl}" width="22" height="22" alt="" draggable="false"><span class="fs-brand-name">formpdf</span></div>
    <div class="pt-crumbs"><span class="fs-pdfwb-crumb">DEMO ${VERSION}</span>
    <nav class="pt-demos" aria-label="Demos"><a href="../../demo/index.html">Pages and search</a><a href="../sign/index.html">Annotate and sign</a><a class="is-here" href="index.html" aria-current="page">Redact, compare, convert</a></nav></div>
    <div class="fs-pdfwb-doc"><span class="fs-pdfwb-name" data-r="name"></span><span class="fs-chip fs-pdfwb-edited is-off" data-r="edited">Edited</span></div>
    <div class="fs-pdfwb-actions">
      ${iconBtn('undo', 'undo', 'Undo')}${iconBtn('redo', 'redo', 'Redo')}
      <button class="fs-btn" type="button" data-a="open">${ic('folderOpen')}<span>Open PDF</span></button>
      <button class="fs-btn fs-btn-primary" type="button" data-a="save">${ic('save')}<span>Save</span></button>
    </div>
  </header>
  <div class="fs-pdfwb-tools">
    <nav class="fs-pdfwb-tabs" role="tablist">${TABS.map(([t, l]) => `<button class="fs-pdfwb-tab" type="button" role="tab" data-tab="${t}">${l}</button>`).join('')}</nav>
    <div class="fs-tb fs-pdfwb-set"><span class="fs-pdfwb-settext" data-r="tabnote"></span></div>
  </div>
  <main class="fs-pdfwb-main">
    <aside class="fs-pdfwb-side">
      <div class="fs-pdfwb-sidehead"><div class="fs-seg is-quiet"><button type="button" class="is-on">Pages</button></div><span class="fs-strip-count" data-r="side-count"></span></div>
      <div class="fs-pdfwb-sidebody"></div>
    </aside>
    <section class="fs-pdfwb-center" data-r="center">
      <div class="pt-opening" data-r="opening"><span class="pt-opening-card"><strong data-r="opening-title">Opening the season report</strong><span class="fs-note">Four pages with contacts, a card number and hidden data</span><span class="pt-bar"></span></span></div>
      <div class="pt-drop" data-r="drop" hidden><div class="pt-drop-card">${ic('upload', 28)}<strong>Drop a PDF to open it</strong><span>It stays in this browser tab.</span></div></div>
    </section>
    <aside class="fs-pdfwb-panel">
      <div class="pt-pane" data-pane="view" hidden>
        ${sec('Document', `<dl class="fs-kv pt-props"><dt>Title</dt><dd data-r="i-title"></dd><dt>Author</dt><dd data-r="i-author"></dd><dt>Pages</dt><dd data-r="i-pages"></dd><dt>Size</dt><dd data-r="i-size"></dd><dt>Producer</dt><dd data-r="i-prod"></dd></dl>`)}
        ${sec('Library', libRows('lib-open', 'Open'))}
      </div>
      <div class="pt-pane" data-pane="protect">
        ${sec('Find text to redact', `${row('Find', `<select data-r="fr-mode" aria-label="What to find">${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}
          <div class="fs-pdfwb-frq"><label class="fs-search">${icon('search', 14)}<input type="search" data-r="fr-query" placeholder="Word or phrase" spellcheck="false" aria-label="Text to find"></label></div>
          <div class="fs-pdfwb-fropts"><label class="fs-check"><input type="checkbox" data-r="fr-case">Match case</label><label class="fs-check"><input type="checkbox" data-r="fr-whole">Whole words</label></div>
          <div class="fs-pdfwb-btns">${btn('fr-find', 'find', 'Find')}</div>
          <div class="fs-pdfwb-frhead"><span class="fs-pdfwb-frcount" data-r="fr-count"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="fr-all">Select all</button></div>
          <div class="fs-list fs-pdfwb-matches" data-r="matches"></div>
          <div class="fs-pdfwb-btns" data-r="fr-btns">${btn('fr-redact', 'eraser', 'Redact ticked', 'fs-btn-danger')}</div>
          <p class="fs-note">The marks are drawn as they will look once applied. Applying removes the words from the file: each marked page becomes a picture with its other text kept selectable, the raster mode of the full app.</p>`)}
        ${sec('Redaction log', `<p class="fs-note" data-r="log-note">Nothing redacted yet.</p><label class="fs-check"><input type="checkbox" data-r="log-hide">Hide the removed words</label><div class="fs-list pt-log" data-r="log"></div>`)}
        ${sec('Remove hidden information', `<p class="fs-note" data-r="hid-note">Looking at what this PDF carries besides its pages.</p><div class="fs-pdfwb-hidlist" data-r="hid-list">${['metadata', 'javascript', 'attachments', 'comments', 'fields', 'layers', 'links', 'bookmarks', 'thumbnails', 'private'].map((k) => `<label class="fs-check fs-pdfwb-hidrow" data-hk="${k}"><input type="checkbox" data-r="hid-tick" data-k="${k}"><span class="fs-pdfwb-hidlabel"></span><span class="fs-pdfwb-hidcount"></span></label>`).join('')}</div><div class="fs-pdfwb-btns">${btn('hid-scan', 'find', 'Check again', 'fs-btn-ghost')}${btn('hid-remove', '', 'Remove ticked', 'fs-btn-danger')}</div>`)}
        ${sec('Metadata', `${row('Title', '<input class="fs-input" type="text" data-r="m-title">')}${row('Author', '<input class="fs-input" type="text" data-r="m-author">')}${row('Subject', '<input class="fs-input" type="text" data-r="m-subject">')}${row('Keywords', '<input class="fs-input" type="text" data-r="m-keywords">')}<div class="fs-pdfwb-btns">${btn('meta-save', 'check', 'Save metadata')}${btn('meta-strip', '', 'Remove all', 'fs-btn-ghost')}</div>`)}
        ${sec('Password', `${row('Password', '<input class="fs-input" type="password" data-r="pw1" autocomplete="new-password">')}${row('Confirm', '<input class="fs-input" type="password" data-r="pw2" autocomplete="new-password">')}${row('Owner', '<input class="fs-input" type="password" data-r="pw-owner" placeholder="Optional" autocomplete="new-password">')}
          <div class="fs-pdfwb-perms">${[['print', 'Printing'], ['copy', 'Copying text'], ['modify', 'Editing'], ['annotate', 'Comments'], ['fill', 'Filling forms'], ['assemble', 'Page changes']].map(([k, l]) => `<label class="fs-check"><input type="checkbox" data-perm="${k}" checked>${l}</label>`).join('')}</div>
          <p class="fs-note">AES-256. Readers need the password to open the file; the owner password unlocks the restrictions.</p>
          <div class="fs-pdfwb-btns">${btn('protect', 'lockFile', 'Protect')}</div>
          <div class="pt-proof" data-r="proof" hidden>
            <p class="fs-note" data-r="proof-head"></p>
            <ul class="pt-checks" data-r="proof-list"></ul>
            ${row('Try', '<input class="fs-input" type="password" data-r="try-pw" placeholder="Password to try" autocomplete="off">')}
            <div class="fs-pdfwb-btns">${btn('try', 'unlock', 'Open protected copy', 'fs-btn-ghost')}${btn('protect-save', 'download', 'Download protected copy')}</div>
          </div>`)}
      </div>
      <div class="pt-pane" data-pane="compare" hidden>
        ${sec('Versions', `<p class="fs-note">The open PDF is compared with another version. Nothing in either file changes.</p><div data-r="cmp-lib"></div>`)}
        ${sec('Compare', '<div data-r="cmphost"></div>')}
      </div>
      <div class="pt-pane" data-pane="extract" hidden>
        ${sec('Pages', `${row('From', '<input class="fs-input" type="text" data-r="ex-pages" placeholder="All pages, or 1-3, 5">')}`)}
        ${sec('Text', `<div class="fs-pdfwb-btns">${btn('ex-text', 'fileText', 'Extract text')}</div><textarea class="fs-input fs-pdfwb-text" data-r="ex-out" readonly spellcheck="false" hidden></textarea><div class="fs-pdfwb-btns" data-r="ex-textbtns" hidden>${btn('text-copy', '', 'Copy')}${btn('text-txt', 'download', '.txt')}${btn('text-md', 'download', '.md')}</div>`)}
        ${sec('Images', `<div class="fs-pdfwb-btns">${btn('ex-images', 'fileImage', 'Extract images')}</div><p class="fs-note" data-r="img-note"></p><div class="fs-asset-grid pt-images" data-r="img-grid"></div><div class="fs-pdfwb-btns" data-r="img-btns" hidden>${btn('img-zip', 'download', 'Download all (.zip)')}</div>`)}
      </div>
      <div class="pt-pane" data-pane="convert" hidden>
        ${sec('Convert', `<p class="fs-note">Paragraphs in reading order, headings, tables and pictures. Running headers and footers are left out.</p>${row('Format', `<select data-r="cv-fmt" aria-label="Format">${FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}${row('Pages', '<input class="fs-input" type="text" data-r="cv-pages" placeholder="All pages">')}<div class="fs-pdfwb-btns">${btn('cv-export', 'download', 'Export', 'fs-btn-primary')}</div><p class="fs-note" data-r="cv-note"></p>`)}
        ${sec('Preview as Markdown', `<pre class="pt-preview" data-r="cv-prev"></pre>`)}
      </div>
    </aside>
  </main>
  <footer class="fs-status fs-pdfwb-status">
    <div class="fs-status-left"><span class="fs-st" data-r="st-doc"></span><span class="fs-st fs-st-hint" data-r="st-hint">Ready</span></div>
    <div class="fs-status-right">
      <span class="fs-st"><input class="fs-input pt-pg" data-r="pg" type="text" inputmode="numeric" aria-label="Page"><span data-r="pg-of"></span></span>
      ${iconBtn('zoom-out', 'zoomOut', 'Zoom out')}<span class="fs-st fs-st-zoom" data-r="zoom">100%</span>${iconBtn('zoom-in', 'zoomIn', 'Zoom in')}${iconBtn('fit-w', 'fitView', 'Fit width')}${iconBtn('fit-p', 'zoomFit', 'Fit page')}
    </div>
  </footer>
  <input type="file" accept="application/pdf,.pdf" data-r="file-open" hidden>
  <input type="file" accept="application/pdf,.pdf" data-r="file-cmp" hidden>
</div>`;

const matchKey = (m: Match): string => `${m.page}:${m.rects[0]?.x ?? 0}:${m.rects[0]?.y ?? 0}:${m.text}`;

export function start(host: HTMLElement): void {
  mountOnce(host, HTML);
  const root = q(host, '#wb');
  const r = (name: string): HTMLElement => q(root, `[data-r="${name}"]`);
  const input = (name: string): HTMLInputElement => r(name) as HTMLInputElement;
  const sel = (name: string): HTMLSelectElement => r(name) as HTMLSelectElement;

  let bytes: Uint8Array = new Uint8Array(0);
  let name = LIBRARY[0].file;
  let undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let tab: Tab = 'protect';
  let sizes: Size[] = [];
  let blobUrl = '';
  let loading = 0;
  let matches: Match[] = [];
  let ticked = new Set<number>();
  let matchesFor: Uint8Array | null = null;
  let hidden: HiddenItem[] = [];
  let hidTicked = new Set<string>();
  let hidFor: Uint8Array | null = null;
  let log: Array<{ page: number; text: string }> = [];
  let protectedCopy: { bytes: Uint8Array; password: string } | null = null;
  let pics: Pic[] = [];
  let picsFor: Uint8Array | null = null;
  let textOut = '';
  let blocksFor: { bytes: Uint8Array; blocks: Block[]; pics: Pic[] } | null = null;
  let other: { name: string; bytes: Uint8Array } | null = null;
  const runCache = new WeakMap<Uint8Array, Promise<PageRuns[]>>();
  const runsOf = (b: Uint8Array): Promise<PageRuns[]> => { let p = runCache.get(b); if (!p) { p = pageRuns(b); runCache.set(b, p); } return p; };

  const hint = (t: string): void => setText(r('st-hint'), t);
  const center = r('center');
  const layers = new Map<number, HTMLElement>();
  const markNodes = (index: number): Array<{ key: string; x: number; y: number; w: number; h: number }> => {
    const out: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
    matches.forEach((m, i) => {
      if (!ticked.has(i) || m.page !== index + 1 || matchesFor !== bytes) return;
      m.rects.forEach((rc, k) => out.push({ key: `${matchKey(m)}|${k}`, x: rc.x - 1, y: rc.y - 1, w: rc.w + 2, h: rc.h + 2 }));
    });
    return out;
  };
  const paintMarks = (index: number): void => {
    const layer = layers.get(index);
    if (!layer) return;
    const style = (b: { x: number; y: number; w: number; h: number }): string => `left:${calc(b.x)};top:${calc(b.y)};width:${calc(b.w)};height:${calc(b.h)}`;
    patchList(layer, markNodes(index), {
      key: (b) => b.key,
      create: (b) => { const n = el(`<div class="fs-pdf-annot" data-kind="redact" data-origin="find"></div>`); n.setAttribute('style', style(b)); return n; },
      update: (n, b) => { const s = style(b); if (n.getAttribute('style') !== s) n.setAttribute('style', s); },
    });
  };
  const paintAllMarks = (): void => { for (const i of layers.keys()) paintMarks(i); };

  const viewer: Viewer = new Viewer(center, {
    page: (n) => onPage(n),
    zoom: (pct) => { setText(r('zoom'), `${pct}%`); },
    mounted: (pv: PageView) => {
      let layer = layers.get(pv.index);
      if (!layer || !pv.space.contains(layer)) {
        layer = el('<div class="fs-pdf-cmps"></div>');
        pv.space.appendChild(layer);
        layers.set(pv.index, layer);
      }
      paintMarks(pv.index);
      comparer.mount(pv);
    },
    textReady: () => undefined,
    rendered: () => undefined,
  });
  const comparer = new Comparer(viewer);
  const cmpPanel = new ComparePanel(comparer);
  comparer.onChange = () => cmpPanel.sync();
  q(root, '[data-r="cmphost"]').appendChild(cmpPanel.root);
  const thumbs = new Thumbs(viewer);
  q(root, '.fs-pdfwb-sidebody').prepend(thumbs.root);
  thumbs.onPick = (n) => viewer.goTo(n);

  const onPage = (n: number): void => {
    const pg = input('pg');
    if (document.activeElement !== pg && pg.value !== String(n)) pg.value = String(n);
    thumbs.setCurrent(n);
  };

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
  };

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

  async function refreshInfo(): Promise<void> {
    try {
      const m = await readMeta(bytes);
      setText(r('i-title'), m.title || 'None');
      setText(r('i-author'), m.author || 'None');
      setText(r('i-prod'), m.producer || 'None');
      for (const k of ['title', 'author', 'subject', 'keywords'] as const) if (document.activeElement !== r(`m-${k}`)) input(`m-${k}`).value = m[k];
    } catch { setText(r('i-title'), 'Unavailable'); }
  }

  async function show(data: Uint8Array, label: string, keep: boolean): Promise<void> {
    const run = ++loading;
    const next = await measure(data);
    if (run !== loading) return;
    const url = URL.createObjectURL(new Blob([data.slice()], { type: 'application/pdf' }));
    bytes = data;
    matches = [];
    ticked = new Set();
    matchesFor = null;
    renderMatches();
    paintAllMarks();
    await viewer.load(url, next, { keep, bytes: data.length });
    setHidden(r('opening'), true);
    const old = blobUrl;
    blobUrl = url;
    if (old) window.setTimeout(() => URL.revokeObjectURL(old), 4000);
    sizes = next;
    thumbs.sync(next);
    thumbs.setCurrent(Math.min(viewer.currentPage(), next.length) || 1);
    sync();
    void refreshInfo();
    void scanHidden();
    if (comparer.result) void runCompare();
    if (label) hint(label);
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
    try { await measure(data); } catch (e) {
      const pw = e instanceof Error && /password/i.test(`${e.name} ${e.message}`);
      hint(pw ? 'This PDF is password protected. Protect a copy here, then try the password in the Protect tab.' : `That file could not be read as a PDF${e instanceof Error ? ` (${e.message.slice(0, 120)})` : ''}.`);
      return;
    }
    undoStack = [];
    redoStack = [];
    log = [];
    renderLog();
    protectedCopy = null;
    setHidden(r('proof'), true);
    comparer.set(null);
    pics = [];
    picsFor = null;
    name = fileName;
    await show(data, `Opened ${fileName}`, false);
    viewer.applyFit('page');
  }

  async function libOpen(id: string): Promise<void> {
    const doc = LIBRARY.find((d) => d.id === id);
    if (!doc) return;
    hint(`Opening ${doc.title}...`);
    try { await openBytes(await loadPack(id), doc.file); } catch (e) { hint(`${doc.title} could not be loaded: ${e instanceof Error ? e.message : String(e)}`); }
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

  function setTab(next: Tab): void {
    if (next === tab) return;
    tab = next;
    root.dataset.tab = next;
    for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab')) {
      const on = b.dataset.tab === next;
      setClass(b, 'is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of root.querySelectorAll<HTMLElement>('[data-pane]')) setHidden(p, p.dataset.pane !== next);
    setText(r('tabnote'), NOTES[next]);
    if (next === 'convert') void renderPreview();
  }

  const findBody = (): FindBody => {
    const mode = sel('fr-mode').value;
    const base: FindBody = { caseSensitive: (r('fr-case') as HTMLInputElement).checked, wholeWord: (r('fr-whole') as HTMLInputElement).checked };
    if (mode === 'text' || mode === 'regex') return { ...base, query: input('fr-query').value, regex: mode === 'regex' };
    return { preset: mode as FindBody['preset'] };
  };

  async function runFind(): Promise<void> {
    const body = findBody();
    if (!body.preset && !(body.query ?? '').trim()) { r('fr-query').focus(); return; }
    const found = findIn(await runsOf(bytes), body);
    matches = found;
    ticked = new Set(found.map((_, i) => i));
    matchesFor = bytes;
    renderMatches();
    paintAllMarks();
    if (found[0]) viewer.goTo(found[0].page);
    hint(found.length ? `${found.length} match${found.length === 1 ? '' : 'es'} found` : 'Nothing like that found in the text of this PDF.');
  }

  function renderMatches(): void {
    const n = matches.length;
    const pagesN = new Set(matches.map((m) => m.page)).size;
    const head = q(root, '.fs-pdfwb-frhead');
    setHidden(head, matchesFor === null);
    setText(r('fr-count'), !n ? 'No matches' : `${n} match${n === 1 ? '' : 'es'} on ${pagesN} page${pagesN === 1 ? '' : 's'} · ${ticked.size} ticked`);
    const all = q(root, '[data-a="fr-all"]');
    setHidden(all, !n);
    setText(all.querySelector('span:not(.icon)') ?? all, ticked.size === n ? 'Clear ticks' : 'Select all');
    setHidden(r('fr-btns'), !n);
    setDisabled(q(root, '[data-a="fr-redact"]') as HTMLButtonElement, !ticked.size);
    const list = matches.map((m, i) => ({ m, i }));
    const update = (node: HTMLElement, x: { m: Match; i: number }): void => {
      const box = node.querySelector('input') as HTMLInputElement;
      if (box.checked !== ticked.has(x.i)) box.checked = ticked.has(x.i);
      for (const t of [box, node.querySelector('.fs-pdfwb-matchbody') as HTMLElement]) if (t.dataset.i !== String(x.i)) t.dataset.i = String(x.i);
    };
    patchList(r('matches'), list, {
      key: (x) => matchKey(x.m),
      create: (x) => {
        const node = el(`<div class="fs-pdfwb-match"><input type="checkbox" data-r="fr-tick" aria-label="Redact this match"><button class="fs-pdfwb-matchbody" type="button" data-r="fr-go"><span class="fs-pdfwb-matchpage">p. ${x.m.page}</span><span class="fs-pdfwb-ctx"><span></span><mark></mark><span></span></span></button></div>`);
        const parts = node.querySelectorAll('.fs-pdfwb-ctx > *');
        setText(parts[0], x.m.before);
        setText(parts[1], x.m.text);
        setText(parts[2], x.m.after);
        update(node, x);
        return node;
      },
      update,
    });
  }

  function renderLog(): void {
    const hide = (r('log-hide') as HTMLInputElement).checked;
    setText(r('log-note'), log.length ? `${log.length} item${log.length === 1 ? '' : 's'} removed from the file, not covered. The log is never written into the PDF.` : 'Nothing redacted yet.');
    patchList(r('log'), log.map((l, i) => ({ ...l, i })), {
      key: (l) => `${l.i}|${l.page}`,
      create: (l) => {
        const n = el(`<div class="pt-logrow"><span class="fs-pdfwb-matchpage">p. ${l.page}</span><span class="pt-logtext"></span></div>`);
        setText(n.querySelector('.pt-logtext'), hide ? '[removed]' : l.text);
        return n;
      },
      update: (n, l) => setText(n.querySelector('.pt-logtext'), hide ? '[removed]' : l.text),
    });
  }

  async function scanHidden(): Promise<void> {
    const src = bytes;
    try { hidden = await hiddenScan(src); } catch { hidden = []; }
    if (src !== bytes) return;
    hidFor = src;
    hidTicked = new Set(hidden.filter((h) => h.count && h.key !== 'fields' && h.key !== 'links').map((h) => h.key));
    renderHidden();
  }

  function renderHidden(): void {
    const total = hidden.filter((h) => h.count > 0).length;
    setText(r('hid-note'), hidFor !== bytes ? 'Looking at what this PDF carries besides its pages.' : total ? `This PDF has ${total} kind${total === 1 ? '' : 's'} of hidden information. Tick what to remove; it goes in one step that Undo can take back until you save.` : 'Nothing hidden was found in this PDF.');
    for (const it of hidden) {
      const rowEl = root.querySelector<HTMLElement>(`[data-hk="${it.key}"]`);
      if (!rowEl) continue;
      const box = rowEl.querySelector('input') as HTMLInputElement;
      setDisabled(box, !it.count || it.key === 'fields');
      const on = it.count > 0 && hidTicked.has(it.key);
      if (box.checked !== on) box.checked = on;
      setText(rowEl.querySelector('.fs-pdfwb-hidlabel'), it.label);
      setText(rowEl.querySelector('.fs-pdfwb-hidcount'), it.count ? `${it.count} found${it.note ? ` · ${it.note}` : ''}${HIDDEN_HELP[it.key] ? ` · ${HIDDEN_HELP[it.key]}` : ''}` : 'None found');
      setClass(rowEl, 'is-none', !it.count);
    }
    setDisabled(q(root, '[data-a="hid-remove"]') as HTMLButtonElement, ![...hidTicked].some((k) => hidden.some((h) => h.key === k && h.count)));
  }

  const permsOf = (): Perms => {
    const p: Record<string, boolean> = {};
    for (const b of root.querySelectorAll<HTMLInputElement>('[data-perm]')) p[b.dataset.perm as string] = b.checked;
    return p as unknown as Perms;
  };

  async function tryOpen(data: Uint8Array, pw: string): Promise<{ ok: boolean; line: string }> {
    try {
      const doc = await openDocument2(data, pw);
      const page = await doc.getPage(1);
      const tc = await page.getTextContent();
      const first = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ').trim().slice(0, 48);
      const n = doc.numPages;
      void doc.loadingTask.destroy();
      return { ok: true, line: `Opens: ${n} pages, page 1 starts "${first}"` };
    } catch (e) {
      return { ok: false, line: e instanceof Error && /password/i.test(`${e.name} ${e.message}`) ? (pw ? 'Refused: that password is not right' : 'Refused: a password is needed') : `Could not open: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  function renderProof(lines: Array<{ ok: boolean; text: string }>, head: string): void {
    setHidden(r('proof'), false);
    setText(r('proof-head'), head);
    patchList(r('proof-list'), lines.map((l, i) => ({ ...l, i })), {
      key: (l) => String(l.i),
      create: (l) => {
        const n = el('<li class="pt-check"><span class="pt-dot"></span><span class="pt-checktext"></span></li>');
        setClass(n, 'is-ok', l.ok);
        setText(n.querySelector('.pt-checktext'), l.text);
        return n;
      },
      update: (n, l) => { setClass(n, 'is-ok', l.ok); setText(n.querySelector('.pt-checktext'), l.text); },
    });
  }

  function cmpLib(): void {
    const others = LIBRARY.filter((d) => d.file !== name && d.id !== 'apollo-summary');
    mountOnce(r('cmp-lib'), others.map((d) => `<div class="pt-lib"><span class="pt-lib-text"><span class="pt-name">${d.title}</span><span class="fs-note">${d.note}</span></span><button class="fs-btn fs-btn-sm" type="button" data-a="cmp-lib" data-lib="${d.id}"><span>Compare</span></button></div>`).join(''));
  }

  async function runCompare(): Promise<void> {
    if (!other) return;
    const o = other;
    const mine = await runsOf(bytes);
    const theirs = await runsOf(o.bytes);
    const res = compareRuns(mine, theirs, cmpPanel.otherIsNewer);
    comparer.set(res, `${bytes.length}-${o.bytes.length}-${undoStack.length}`, o.name);
    hint(`Compared with ${o.name}: ${res.changes.length} difference${res.changes.length === 1 ? '' : 's'}`);
  }

  async function compareWith(data: Uint8Array, label: string, olderIsOther = true): Promise<void> {
    other = { name: label, bytes: data };
    const sel2 = q(cmpPanel.root, '[data-c="newer"]') as HTMLSelectElement;
    sel2.value = olderIsOther ? '0' : '1';
    await runCompare();
    if (comparer.result?.changes.length) comparer.go(comparer.result.changes[0].id);
  }

  async function ensureBlocks(): Promise<{ blocks: Block[]; pics: Pic[] }> {
    if (blocksFor && blocksFor.bytes === bytes) return blocksFor;
    const p = await listPics(bytes);
    const b = await blocksOf(bytes, p);
    blocksFor = { bytes, blocks: b, pics: p };
    return blocksFor;
  }

  const rangeOf = (text: string, n: number): number[] => {
    const set = new Set<number>();
    const t = text.trim();
    if (!t) { for (let i = 1; i <= n; i++) set.add(i); }
    for (const part of t.split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) continue;
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
  };

  async function renderPreview(): Promise<void> {
    const src = bytes;
    const { blocks } = await ensureBlocks();
    if (src !== bytes) return;
    const md = toMarkdown(blocks.filter((b) => b.kind !== 'image'));
    setText(r('cv-prev'), md.slice(0, 1800) + (md.length > 1800 ? '\n...' : ''));
  }

  async function exportAs(): Promise<void> {
    const fmt = sel('cv-fmt').value;
    const { blocks, pics: allPics } = await ensureBlocks();
    const pages = new Set(rangeOf(input('cv-pages').value, sizes.length));
    if (!pages.size) { hint(`Enter pages between 1 and ${sizes.length}, like 1-3,5.`); return; }
    const use = blocks.filter((b) => pages.has(b.page));
    const title = (await readMeta(bytes)).title || stemOf(name);
    const stem = stemOf(name);
    let data: Uint8Array | string;
    if (fmt === 'docx') data = toDocx(use, allPics, title);
    else if (fmt === 'html') data = toHtml(use, allPics, title);
    else if (fmt === 'rtf') data = toRtf(use, allPics);
    else if (fmt === 'md') data = toMarkdown(use);
    else data = toText(use);
    download(data, `${stem}.${fmt}`, MIME[fmt]);
    const size = typeof data === 'string' ? new Blob([data]).size : data.length;
    setText(r('cv-note'), `Saved ${stem}.${fmt} · ${kb(size)} · ${use.filter((b) => b.kind === 'h1' || b.kind === 'h2').length} headings, ${use.filter((b) => b.kind === 'p').length} paragraphs, ${use.filter((b) => b.kind === 'table').length} table${use.filter((b) => b.kind === 'table').length === 1 ? '' : 's'}, ${use.filter((b) => b.kind === 'image').length} picture${use.filter((b) => b.kind === 'image').length === 1 ? '' : 's'}`);
    hint(`Exported ${stem}.${fmt}`);
  }

  async function extractText(): Promise<void> {
    const runs = await runsOf(bytes);
    const pages = rangeOf(input('ex-pages').value, runs.length);
    if (!pages.length) { hint(`Enter pages between 1 and ${runs.length}, like 1-3,5.`); return; }
    textOut = pages.map((p) => `## Page ${p}\n\n${runs[p - 1].text.trim() || 'No text on this page. It may be a scan.'}\n`).join('\n');
    const out = r('ex-out') as HTMLTextAreaElement;
    out.value = textOut;
    setHidden(out, false);
    setHidden(r('ex-textbtns'), false);
    hint(`Extracted the text of ${pages.length} page${pages.length === 1 ? '' : 's'}`);
  }

  async function extractImages(): Promise<void> {
    const src = bytes;
    const list = (await listPics(src)).filter((p) => rangeOf(input('ex-pages').value, sizes.length).includes(p.page));
    if (src !== bytes) return;
    pics = list;
    picsFor = src;
    setText(r('img-note'), list.length ? `${list.length} picture${list.length === 1 ? '' : 's'} found, at their original size. Click one to save it.` : 'No pictures that can be saved as they are. Scanned pages hold their picture in a format this demo does not unpack.');
    setHidden(r('img-btns'), !list.length);
    patchList(r('img-grid'), list.map((p, i) => ({ p, i })), {
      key: (x) => x.p.name,
      create: (x) => {
        const node = el(`<button class="fs-asset" type="button" data-r="img-one" data-i="${x.i}" title="${x.p.name} · ${x.p.w} x ${x.p.h}"><img alt="${escapeHtml(x.p.name)}"></button>`);
        const url = URL.createObjectURL(new Blob([x.p.bytes.slice()], { type: 'image/jpeg' }));
        (node.querySelector('img') as HTMLImageElement).src = url;
        return node;
      },
      update: () => undefined,
    });
  }

  r('matches').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const row2 = t.closest('.fs-pdfwb-match') as HTMLElement | null;
    if (!row2) return;
    const i = Number((row2.querySelector('input') as HTMLInputElement).dataset.i);
    if (t.closest('[data-r="fr-tick"]')) {
      if (ticked.has(i)) ticked.delete(i); else ticked.add(i);
      renderMatches();
      paintAllMarks();
    } else if (t.closest('[data-r="fr-go"]')) {
      const m = matches[i];
      viewer.scrollToPoint(m.page - 1, m.rects[0].x, m.rects[0].y);
    }
  });

  r('log-hide').addEventListener('change', renderLog);
  r('hid-list').addEventListener('change', (e) => {
    const b = e.target as HTMLInputElement;
    const k = b.dataset.k as string;
    if (b.checked) hidTicked.add(k); else hidTicked.delete(k);
    renderHidden();
  });
  r('fr-mode').addEventListener('change', () => {
    const m = sel('fr-mode').value;
    const text = m === 'text' || m === 'regex';
    setHidden(q(root, '.fs-pdfwb-frq'), !text);
    setHidden(q(root, '.fs-pdfwb-fropts'), !text);
    (r('fr-query') as HTMLInputElement).placeholder = m === 'regex' ? 'Regular expression' : 'Word or phrase';
  });
  r('fr-query').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void guarded('Finding', runFind); });
  r('pg').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const n = Number(input('pg').value);
    if (n >= 1 && n <= sizes.length) viewer.goTo(n);
    input('pg').blur();
  });

  cmpPanel.onPick = () => (r('file-cmp') as HTMLInputElement).click();
  cmpPanel.onClear = () => { comparer.set(null); other = null; };

  const actions: Record<string, () => void> = {
    open: () => (r('file-open') as HTMLInputElement).click(),
    save: () => download(bytes, undoStack.length ? `${stemOf(name)}-edited.pdf` : name, MIME.pdf),
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
    'fr-find': () => void guarded('Finding', runFind),
    'fr-all': () => { ticked = ticked.size === matches.length ? new Set() : new Set(matches.map((_, i) => i)); renderMatches(); paintAllMarks(); },
    'fr-redact': () => void guarded('Redacting', async () => {
      const areas: Area[] = [];
      matches.forEach((m, i) => { if (ticked.has(i)) for (const rc of m.rects) areas.push({ page: m.page, x: rc.x - 1, y: rc.y - 1, w: rc.w + 2, h: rc.h + 2, label: m.text }); });
      if (!areas.length) return;
      const body = findBody();
      const res = await redact(bytes, areas);
      log = [...log, ...res.log];
      await commit(res.bytes, `Redacted ${res.items} item${res.items === 1 ? '' : 's'}`);
      renderLog();
      const left = findIn(await runsOf(bytes), body).length;
      hint(`Redacted ${res.items} item${res.items === 1 ? '' : 's'} on ${res.pages.length} page${res.pages.length === 1 ? '' : 's'}. Searching the new copy again finds ${left}.`);
    }),
    'hid-scan': () => void scanHidden(),
    'hid-remove': () => void guarded('Removing hidden information', async () => {
      const keys = [...hidTicked].filter((k) => hidden.some((h) => h.key === k && h.count));
      if (!keys.length) return;
      const res = await sanitize(bytes, keys);
      await commit(res.bytes, `Removed hidden information (${keys.length} kind${keys.length === 1 ? '' : 's'})`);
    }),
    'meta-save': () => void guarded('Saving metadata', async () => {
      const g = (k: string): string => input(`m-${k}`).value.trim();
      await commit(await setMeta(bytes, { title: g('title'), author: g('author'), subject: g('subject'), keywords: g('keywords') }), 'Saved metadata');
    }),
    'meta-strip': () => void guarded('Removing metadata', async () => {
      const res = await sanitize(bytes, ['metadata']);
      await commit(res.bytes, 'Removed all metadata');
    }),
    protect: () => void guarded('Protecting', async () => {
      const pw = input('pw1').value;
      if (!pw) { input('pw1').focus(); hint('Type a password first.'); return; }
      if (pw !== input('pw2').value) { input('pw2').focus(); hint('The two passwords differ.'); return; }
      const out = await protect(bytes, pw, input('pw-owner').value, permsOf());
      protectedCopy = { bytes: out, password: pw };
      const none = await tryOpen(out, '');
      const right = await tryOpen(out, pw);
      renderProof([
        { ok: !none.ok, text: `Without the password: ${none.line}` },
        { ok: right.ok, text: `With the password: ${right.line}` },
        { ok: true, text: `AES-256, ${kb(out.length)}, made from the open version of ${name}` },
      ], 'Protected copy ready. The working copy in the window is unchanged.');
      hint('Protected copy ready to download');
    }),
    try: () => void guarded('Trying the password', async () => {
      if (!protectedCopy) return;
      const res = await tryOpen(protectedCopy.bytes, input('try-pw').value);
      hint(res.line);
      renderProof([{ ok: res.ok, text: `With "${input('try-pw').value ? '*'.repeat(input('try-pw').value.length) : 'no password'}": ${res.line}` }], 'Protected copy test');
    }),
    'protect-save': () => { if (protectedCopy) download(protectedCopy.bytes, `${stemOf(name)}-protected.pdf`, MIME.pdf); },
    'ex-text': () => void guarded('Extracting text', extractText),
    'text-copy': () => { void navigator.clipboard?.writeText(textOut).then(() => hint('Text copied'), () => hint('Copy was blocked by the browser')); },
    'text-txt': () => download(textOut, `${stemOf(name)}.txt`, MIME.txt),
    'text-md': () => download(textOut, `${stemOf(name)}.md`, MIME.md),
    'ex-images': () => void guarded('Extracting pictures', extractImages),
    'img-zip': () => { if (picsFor) download(zip(pics.map((p) => ({ name: p.name, data: p.bytes }))), `${stemOf(name)}-pictures.zip`, MIME.zip); },
    'cv-export': () => void guarded('Converting', exportAs),
    'zoom-in': () => viewer.zoomStep(1),
    'zoom-out': () => viewer.zoomStep(-1),
    'fit-w': () => viewer.applyFit('width'),
    'fit-p': () => viewer.applyFit('page'),
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tabBtn = t.closest('.fs-pdfwb-tab') as HTMLElement | null;
    if (tabBtn) { setTab(tabBtn.dataset.tab as Tab); return; }
    const img = t.closest('[data-r="img-one"]') as HTMLElement | null;
    if (img) { const p = pics[Number(img.dataset.i)]; if (p) download(p.bytes, p.name, MIME.jpg); return; }
    const hitEl = t.closest('[data-a]') as HTMLElement | null;
    const a = hitEl?.dataset.a;
    if (a === 'lib-open' && hitEl?.dataset.lib) void libOpen(hitEl.dataset.lib);
    else if (a === 'cmp-lib' && hitEl?.dataset.lib) {
      const id = hitEl.dataset.lib;
      const doc = LIBRARY.find((d) => d.id === id);
      if (doc) void guarded('Comparing', async () => compareWith(await loadPack(id), doc.title, id === 'report-draft'));
    } else if (a && actions[a]) actions[a]();
  });

  r('file-open').addEventListener('change', (e) => { const i = e.target as HTMLInputElement; const f = i.files?.[0]; if (f) void f.arrayBuffer().then((b) => openBytes(new Uint8Array(b), f.name)); i.value = ''; });
  r('file-cmp').addEventListener('change', (e) => {
    const i = e.target as HTMLInputElement;
    const f = i.files?.[0];
    if (f) void guarded('Comparing', async () => compareWith(new Uint8Array(await f.arrayBuffer()), f.name, cmpPanel.otherIsNewer === false));
    i.value = '';
  });

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
    const f = Array.from(e.dataTransfer?.files ?? []).find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (!f) { hint('Drop a PDF file.'); return; }
    void f.arrayBuffer().then((b) => openBytes(new Uint8Array(b), f.name));
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) { e.preventDefault(); actions[e.shiftKey ? 'redo' : 'undo'](); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); actions.save(); }
  });

  for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab')) if (b.dataset.tab === tab) { setClass(b, 'is-on', true); b.setAttribute('aria-selected', 'true'); }
  setText(r('tabnote'), NOTES[tab]);
  cmpLib();
  (q(root, '[data-a="undo"]') as HTMLButtonElement).disabled = true;
  (q(root, '[data-a="redo"]') as HTMLButtonElement).disabled = true;
  sel('fr-mode').value = 'email';
  setHidden(q(root, '.fs-pdfwb-frq'), true);
  setHidden(q(root, '.fs-pdfwb-fropts'), true);
  setHidden(q(root, '.fs-pdfwb-frhead'), true);
  setHidden(r('fr-btns'), true);

  const ready = loadPack(LIBRARY[0].id).then(async (d) => {
    await openBytes(d, LIBRARY[0].file);
    await runFind();
    setClass(root, 'is-booting', false);
  }, () => { setText(r('opening-title'), 'The season report could not be loaded'); setClass(root, 'is-booting', false); });
  (window as unknown as { __formpdfProtect: unknown }).__formpdfProtect = { ready, viewer, actions, setTab, libOpen, comparer };
}

function openDocument2(data: Uint8Array, password: string): ReturnType<typeof openDocument> {
  return getDocument({ data: data.slice(), password: password || undefined, useWorkerFetch: false, enableXfa: false }).promise;
}
