import { Annotator, DRAW_TOOLS, KIND_LABEL, MARKUP_TOOLS, uid, type Tool } from '../../../frontend/src/pdf/annotate';
import type { Annot, Field } from '../../../frontend/src/pdf/api';
import { Fields, SignaturePad, typedSignature } from '../../../frontend/src/pdf/fill';
import { Thumbs, Viewer, openDocument, type PageView } from '../../../frontend/src/pdf/viewer';
import { STAMPS, dynamicLine, paletteHtml, stampSize } from '../../../frontend/src/pdf/stamps';
import { icon } from '../../../frontend/src/ui/icons';
import { el, escapeHtml, mountOnce, patchList, q, setClass, setHidden, setText } from '../../../frontend/src/ui/dom';
import logoUrl from '../../../frontend/public/formpdf-logo.png';
import { LIBRARY, loadPack, packMeta, type Anchor } from './media';
import { readFields, readInfo, writePdf } from './pdfwrite';

type Tab = 'comment' | 'fill' | 'finish';
type Sub = 'fields' | 'signature' | 'stamps';
interface Size { w: number; h: number; rotate: number }
interface Snap { bytes: Uint8Array; annots: Annot[]; values: Record<string, string>; label: string }
interface FieldRow { key: string; f: Field; i: number }

const AUTHOR = 'Ana Rivera';
const PALETTE = ['#FFD400', '#22C55E', '#38BDF8', '#F472B6', '#E11D48', '#2563EB', '#111111'];
const TOOL_COLOR: Record<string, string> = { highlight: '#FFD400', underline: '#2563EB', strikeout: '#E11D48', note: '#FFD400', freetext: '#111111', ink: '#E11D48', rect: '#E11D48', ellipse: '#E11D48', line: '#111111', arrow: '#E11D48', squiggly: '#16A34A' };
const HINTS: Partial<Record<Tool, string>> = {
  select: 'Select text, or click a comment to move it. Double-click a text box to edit.', highlight: 'Select text to highlight it.', underline: 'Select text to underline it.',
  strikeout: 'Select text to strike it through.', squiggly: 'Select text to squiggle-underline it.', note: 'Click where the note goes.', freetext: 'Click or drag to add a text box.',
  ink: 'Drag to draw.', rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw an ellipse.', line: 'Drag to draw a line.', arrow: 'Drag to draw an arrow.',
};
const FIELD_ICON: Record<string, string> = { text: 'fieldText', checkbox: 'fieldCheck', radio: 'fieldRadio', choice: 'fieldDropdown', signature: 'signature' };
const TABS: Array<[Tab, string]> = [['comment', 'Comment'], ['fill', 'Fill Forms and Sign'], ['finish', 'Flatten and save']];
const UNDER = '<path d="M7 4.5v6a5 5 0 0 0 10 0v-6M5.5 20h13"/>';
const SQUIG = '<path d="M7 4.5v6a5 5 0 0 0 10 0v-6M4.5 20l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5"/>';
const RECT = '<rect x="4" y="6" width="16" height="12" rx="1"/>';
const ELLIPSE = '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>';
const svg = (body: string): string => `<span class="icon" style="width:16px;height:16px" aria-hidden="true"><svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg></span>`;
const toolBtn = (t: Tool, label: string, ic: string): string => `<button class="fs-tb-btn" type="button" data-tool="${t}" title="${label}" aria-label="${label}">${ic}</button>`;
const sec = (title: string, body: string): string => `<section class="fs-pdfwb-sec"><h3 class="fs-pdfwb-sec-title">${title}</h3>${body}</section>`;
const kb = (v: number): string => (v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1024))} KB`);
const libRows = LIBRARY.map((d) => `<div class="dm-lib"><span class="dm-lib-text"><span class="dm-qname">${d.title}</span><span class="dm-muted">${d.note}</span></span><button class="fs-btn fs-btn-sm" type="button" data-a="lib-open" data-lib="${d.id}"><span>Open</span></button></div>`).join('');
const titleCase = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const today = (): string => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const HTML = `
<div class="fs-pdfwb has-doc" id="wb" data-tab="fill" data-tool="select">
<header class="fs-pdfwb-title">
<div class="fs-brand"><img class="fs-mark" src="${logoUrl}" width="22" height="22" alt="" draggable="false"><span class="fs-brand-name">formpdf</span></div>
<nav class="dm-demos" aria-label="Demos"><a href="../../demo/index.html">1 View and pages</a><a href="./index.html" aria-current="page">2 Annotate and sign</a><a href="../protect/index.html">3 Redact and protect</a></nav>
<div class="fs-pdfwb-doc"><span class="fs-pdfwb-name" data-r="name"></span><span class="fs-badge fs-pdfwb-edited is-off" data-r="edited">Edited</span></div>
<div class="fs-pdfwb-actions">
<button class="fs-icon-btn" type="button" data-a="undo" title="Undo" aria-label="Undo">${icon('undo', 16)}</button>
<button class="fs-icon-btn" type="button" data-a="redo" title="Redo" aria-label="Redo">${icon('redo', 16)}</button>
<span class="fs-sep"></span>
<button class="fs-tt-btn" type="button" data-a="open" title="Open a PDF from your computer" aria-label="Open a PDF">${icon('folderOpen', 16)}</button>
<button class="fs-share-btn" type="button" data-a="save">${icon('save', 14)}<span>Save</span></button>
</div>
</header>
<div class="fs-pdfwb-tools">
<div class="fs-pdfwb-tabs" role="tablist">${TABS.map(([t, l]) => `<button class="fs-pdfwb-tab" type="button" role="tab" data-tab="${t}">${l}</button>`).join('')}</div>
<span class="fs-sep"></span>
<div class="fs-tb fs-pdfwb-set" data-for="comment" hidden>${toolBtn('select', 'Select', icon('cursor', 16))}<span class="fs-sep"></span>${toolBtn('highlight', 'Highlight text', icon('highlighter', 16))}${toolBtn('underline', 'Underline text', svg(UNDER))}${toolBtn('strikeout', 'Strike through text', icon('strike', 16))}${toolBtn('squiggly', 'Squiggly underline', svg(SQUIG))}<span class="fs-sep"></span>${toolBtn('note', 'Sticky note', icon('sticky', 16))}${toolBtn('freetext', 'Text box', icon('textBox', 16))}${toolBtn('ink', 'Draw', icon('pen', 16))}${toolBtn('rect', 'Rectangle', svg(RECT))}${toolBtn('ellipse', 'Ellipse', svg(ELLIPSE))}${toolBtn('line', 'Line', icon('line', 16))}${toolBtn('arrow', 'Arrow', icon('arrow', 16))}<span class="fs-sep"></span><div class="fs-tb-group fs-pdfwb-palette">${PALETTE.map((c) => `<button class="fs-swatch" type="button" data-color="${c}" title="${c}" style="background:${c}"></button>`).join('')}</div><span class="fs-sep"></span><select class="fs-input dm-sel" data-r="width" aria-label="Line width" title="Line width"><option value="1">1 pt</option><option value="2" selected>2 pt</option><option value="3">3 pt</option><option value="5">5 pt</option></select><select class="fs-input dm-sel" data-r="size" aria-label="Text size" title="Text size"><option value="10">10 pt</option><option value="12" selected>12 pt</option><option value="14">14 pt</option><option value="18">18 pt</option><option value="24">24 pt</option></select></div>
<div class="fs-tb fs-pdfwb-set" data-for="fill">${toolBtn('select', 'Fill fields', icon('cursor', 16))}${toolBtn('freetext', 'Add text', icon('textBox', 16))}<button class="fs-tb-btn has-label" type="button" data-a="sign" title="Place your signature">${icon('signature', 16)}<span>Sign</span></button><button class="fs-tb-btn has-label" type="button" data-a="date" title="Place today's date">${icon('stamp', 16)}<span>Date</span></button><span class="fs-sep"></span><span class="fs-pdfwb-settext" data-r="fillhint"></span></div>
<div class="fs-tb fs-pdfwb-set" data-for="finish" hidden><span class="fs-pdfwb-settext">Burn the form and the marks into the pages so nothing can be edited, or keep them as real comments in the file.</span></div>
</div>
<div class="fs-pdfwb-main">
<aside class="fs-pdfwb-side">
<div class="fs-pdfwb-sidehead"><div class="fs-seg is-quiet"><button type="button" class="is-on">Pages</button></div><span class="fs-strip-count fs-pdfwb-count" data-r="side-count"></span></div>
<div class="fs-pdfwb-sidebody"></div>
</aside>
<main class="fs-pdfwb-center" data-r="center">
<div class="dm-opening" data-r="opening"><span class="dm-opening-card"><strong data-r="opening-title">Opening the loan agreement</strong><span class="dm-muted">A fillable form with comments to review</span><span class="dm-bar"></span></span></div>
<div class="dm-drop" data-r="drop" hidden><div class="dm-drop-card">${icon('upload', 28)}<strong>Drop a PDF to open it</strong><span>It stays in this browser tab.</span></div></div>
</main>
<aside class="fs-pdfwb-panel">
<div class="dm-pane" data-pane="comment" hidden>
${sec('Comments', `<p class="fs-note" data-r="c-note"></p><div class="fs-pdfwb-annots"><div class="fs-pdfwb-annots-area" data-r="c-list"></div></div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="c-clear">Discard all</button></div>`)}
${sec('Documents', `${libRows}<p class="fs-note">Open your own PDF with the folder button, or drop it on the window.</p>`)}
</div>
<div class="dm-pane" data-pane="fill">
<div class="dm-subs"><div class="fs-seg is-quiet" data-r="subs"><button type="button" data-sub="fields" class="is-on">Form fields</button><button type="button" data-sub="signature">Signature</button><button type="button" data-sub="stamps">Stamps</button></div></div>
<div class="dm-sub" data-subpane="fields">
${sec('Form fields', `<div class="dm-progress"><span class="dm-progress-bar"><span data-r="f-bar"></span></span><span class="dm-muted" data-r="f-sum"></span></div><div class="fs-pdfwb-btns dm-fbtns"><button class="fs-btn fs-btn-sm" type="button" data-a="f-next">${icon('chevronDown', 14)}Next missing</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="f-discard">Discard entries</button></div><div class="dm-flist" data-r="f-list"></div>`)}
</div>
<div class="dm-sub" data-subpane="signature" hidden>
${sec('Signature', `<div class="fs-seg fs-pdfwb-sigmode"><button type="button" data-a="sig-draw">Draw</button><button type="button" data-a="sig-type" class="is-on">Type</button></div><div class="fs-pdfwb-sigdraw" data-r="sigdraw" hidden></div><div class="fs-pdfwb-sigtype" data-r="sigtype"><input class="fs-input" type="text" data-r="sig-text" value="Ana Rivera" placeholder="Type your name" spellcheck="false"><div class="fs-pdfwb-sigpreview" data-r="sigprev"></div></div><div class="fs-pdfwb-sigrow"><span class="fs-swatch is-chosen" data-a="sig-color" data-c="#1E2A78" style="background:#1E2A78" title="Blue ink"></span><span class="fs-swatch" data-a="sig-color" data-c="#111111" style="background:#111111" title="Black ink"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="sig-clear">Clear</button><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="sig-place">${icon('signature', 14)}Place</button></div><p class="fs-note">Then click the page where the signature goes, or press Sign here on a signature line. Signatures are stamped into the page.</p>`)}
</div>
<div class="dm-sub" data-subpane="stamps" hidden>
${sec('Stamps', `<label class="dm-field">Stamped by<input class="fs-input" type="text" data-r="stamp-name" value="Ana Rivera" spellcheck="false"></label><p class="fs-note">Pick a stamp, then click the page. Dynamic stamps carry your name and the time.</p><div data-r="stamp-palette">${paletteHtml(dynamicLine('Ana Rivera'))}</div>`)}
</div>
</div>
<div class="dm-pane" data-pane="finish" hidden>
${sec('Flatten and save', `<label class="fs-check"><input type="checkbox" data-r="flat-fields" checked>Flatten form fields (no longer editable)</label><label class="fs-check"><input type="checkbox" data-r="flat-marks" checked>Flatten comments and highlights into the pages</label><dl class="dm-kv"><dt>Form entries</dt><dd data-r="w-fields"></dd><dt>Comments</dt><dd data-r="w-marks"></dd><dt>Signatures</dt><dd data-r="w-sigs"></dd></dl><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="apply">${icon('check', 14)}Apply to working copy</button><button class="fs-btn fs-btn-sm" type="button" data-a="save">${icon('save', 14)}Save a copy</button></div><p class="fs-note">Apply writes the entries and marks into a new working copy you can still undo. Save downloads the same result without changing the window.</p>`)}
${sec('Document', `<dl class="dm-kv"><dt>Title</dt><dd data-r="i-title"></dd><dt>Pages</dt><dd data-r="i-pages"></dd><dt>Size</dt><dd data-r="i-size"></dd><dt>Form fields</dt><dd data-r="i-fields"></dd><dt>Comments</dt><dd data-r="i-annots"></dd></dl>`)}
${sec('Documents', `${libRows}`)}
</div>
</aside>
</div>
<footer class="fs-status fs-pdfwb-status">
<div class="fs-status-left"><span class="fs-st" data-r="st-doc"></span><span class="fs-st-hint fs-pdfwb-hint" data-r="st-hint">Ready</span></div>
<div class="fs-status-right">
<span class="fs-pdfwb-pagebox"><input class="fs-pdfwb-pagein" data-r="pg" type="text" inputmode="numeric" aria-label="Page number" value="1"><span class="fs-pdfwb-pageof" data-r="pg-of"></span></span>
<button class="fs-icon-btn" type="button" data-a="zoom-out" title="Zoom out" aria-label="Zoom out">${icon('zoomOut', 14)}</button>
<span class="fs-st fs-st-zoom" data-r="zoom">100%</span>
<button class="fs-icon-btn" type="button" data-a="zoom-in" title="Zoom in" aria-label="Zoom in">${icon('zoomIn', 14)}</button>
<button class="fs-icon-btn" type="button" data-a="fit-w" title="Fit width" aria-label="Fit width">${icon('fitView', 14)}</button>
<button class="fs-icon-btn" type="button" data-a="fit-p" title="Fit page" aria-label="Fit page">${icon('zoomFit', 14)}</button>
</div>
</footer>
<input type="file" accept="application/pdf,.pdf" data-r="file-open" hidden>
</div>`;

export function start(host: HTMLElement): void {
  mountOnce(host, HTML);
  const root = q(host, '#wb');
  const r = (name: string): HTMLElement => q(root, `[data-r="${name}"]`);
  const input = (name: string): HTMLInputElement => r(name) as HTMLInputElement;

  let bytes: Uint8Array = new Uint8Array(0);
  let name = LIBRARY[0].file;
  let docId = '';
  let docSeq = 0;
  let tab: Tab = 'fill';
  let sub: Sub = 'fields';
  let sizes: Size[] = [];
  let blobUrl = '';
  let loading = 0;
  let sigMode: 'draw' | 'type' = 'type';
  let sigColor = '#1E2A78';
  let sigLive = 0;
  let undoStack: Snap[] = [];
  let redoStack: Snap[] = [];
  let last: Snap = { bytes, annots: [], values: {}, label: '' };
  let committed = 0;
  let recordTimer = 0;
  let busy = false;
  let labels: Record<string, string> = {};

  const hint = (t: string): void => setText(r('st-hint'), t);
  const center = r('center');
  const viewer = new Viewer(center, {
    page: (n) => onPage(n),
    zoom: (pct) => { setText(r('zoom'), `${pct}%`); },
    mounted: (pv: PageView) => { annot.mount(pv); fields.mount(pv); },
    textReady: () => undefined,
    rendered: () => undefined,
  });
  const annot = new Annotator(viewer, {
    changed: (label) => record(label),
    select: () => syncMarks(),
    areas: () => undefined,
    toolDone: () => setTool('select'),
    crop: () => undefined,
  });
  const fields = new Fields(viewer);
  const thumbs = new Thumbs(viewer);
  q(root, '.fs-pdfwb-sidebody').prepend(thumbs.root);
  thumbs.onPick = (n) => viewer.goTo(n);
  const pad = new SignaturePad();
  pad.color = sigColor;
  r('sigdraw').appendChild(pad.root);
  pad.onChange = () => syncSig();
  annot.style.color = TOOL_COLOR.select ?? '#FFD400';

  const snapshot = (label: string): Snap => ({ bytes, annots: annot.items.map((a) => ({ ...a })), values: fields.pending(), label });

  function record(label: string): void {
    undoStack.push(last);
    if (undoStack.length > 80) undoStack.shift();
    last = snapshot(label);
    redoStack = [];
    syncMarks();
    syncFields();
    syncChrome();
  }

  function scheduleRecord(): void {
    window.clearTimeout(recordTimer);
    recordTimer = window.setTimeout(() => {
      const now = JSON.stringify(fields.pending());
      if (now === JSON.stringify(last.values)) return;
      record('Fill form');
    }, 700);
  }

  fields.onChange = () => { syncFields(); syncChrome(); scheduleRecord(); };
  fields.onSign = (f) => void placeSignature({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h });

  const dirty = (): boolean => undoStack.length > 0 || committed > 0;

  function syncChrome(): void {
    setText(r('name'), name);
    setClass(r('edited'), 'is-off', !dirty());
    (q(root, '.fs-pdfwb-actions [data-a="undo"]') as HTMLButtonElement).disabled = undoStack.length === 0;
    (q(root, '.fs-pdfwb-actions [data-a="redo"]') as HTMLButtonElement).disabled = redoStack.length === 0;
    setText(r('st-doc'), `${sizes.length} page${sizes.length === 1 ? '' : 's'} · ${kb(bytes.length)}`);
    setText(r('pg-of'), `of ${sizes.length}`);
    setText(r('side-count'), String(sizes.length));
    setText(r('i-pages'), String(sizes.length));
    setText(r('i-size'), kb(bytes.length));
    syncSummary();
  }

  function onPage(n: number): void {
    const pg = input('pg');
    if (document.activeElement !== pg && pg.value !== String(n)) pg.value = String(n);
    thumbs.setCurrent(n);
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

  async function show(data: Uint8Array, keep: boolean): Promise<void> {
    const run = ++loading;
    const next = await measure(data);
    if (run !== loading) return;
    const list = await readFields(data, labels).catch(() => [] as Field[]);
    const url = URL.createObjectURL(new Blob([data.slice()], { type: 'application/pdf' }));
    fields.reset();
    docId = `d${docSeq++}`;
    fields.fields = list;
    fields.loadedFor = docId;
    await viewer.load(url, next, { keep, bytes: data.length });
    setHidden(r('opening'), true);
    const old = blobUrl;
    blobUrl = url;
    if (old) window.setTimeout(() => URL.revokeObjectURL(old), 4000);
    bytes = data;
    sizes = next;
    thumbs.sync(next);
    thumbs.setCurrent(Math.min(viewer.currentPage(), next.length) || 1);
    fields.renderAll();
    syncFields();
    syncChrome();
    void refreshInfo();
  }

  async function refreshInfo(): Promise<void> {
    try {
      const info = await readInfo(bytes);
      setText(r('i-title'), info.title || 'None');
      setText(r('i-fields'), String(info.fields || 'None'));
      setText(r('i-annots'), String(info.annots || 'None'));
    } catch { setText(r('i-title'), 'Unavailable'); }
  }

  const rect = (a: Anchor): Array<{ x: number; y: number; w: number; h: number }> => a.rects;

  function seedMarks(id: string): Annot[] {
    const meta = packMeta(id);
    if (!meta) return [];
    const a = meta.anchors;
    const base = { rot: 0, opacity: 1 };
    const out: Annot[] = [];
    if (a.deposit) out.push({ ...base, id: uid('a'), page: a.deposit.page, kind: 'highlight', color: '#FFD400', opacity: 0.4, rects: rect(a.deposit), quote: 'A refundable deposit of 40 dollars is held until the instrument is returned complete' });
    if (a.deposit) {
      const r0 = a.deposit.rects[0];
      out.push({ ...base, id: uid('a'), page: a.deposit.page, kind: 'note', color: '#FFD400', x: 574, y: r0.y - 4, text: 'Deposit is repaid within seven days of the return. Confirm the amount with the treasurer before pickup.' });
    }
    if (a.sun) out.push({ ...base, id: uid('a'), page: a.sun.page, kind: 'underline', color: '#2563EB', rects: rect(a.sun), quote: 'will never point it at or near the sun' });
    if (a.damage) out.push({ ...base, id: uid('a'), page: a.damage.page, kind: 'squiggly', color: '#16A34A', rects: rect(a.damage), quote: 'Damage from a fall, from water, or from use against these conditions' });
    return out;
  }

  async function openBytes(data: Uint8Array, fileName: string, seed: string): Promise<void> {
    try {
      await measure(data);
    } catch (e) {
      const msg = e instanceof Error && /password/i.test(`${e.name} ${e.message}`) ? 'This PDF is password protected. The demo opens unprotected files only.' : `That file could not be read as a PDF${e instanceof Error ? ` (${e.message.slice(0, 120)})` : ''}.`;
      hint(msg);
      return;
    }
    annot.setItems([]);
    undoStack = [];
    redoStack = [];
    committed = 0;
    labels = packMeta(seed)?.labels ?? {};
    name = fileName;
    await show(data, false);
    annot.setItems(seed ? seedMarks(seed) : []);
    last = snapshot('');
    syncMarks();
    syncChrome();
    hint(`Opened ${fileName}`);
  }

  async function libOpen(id: string): Promise<void> {
    const doc = LIBRARY.find((d) => d.id === id);
    if (!doc) return;
    hint(`Opening ${doc.title}...`);
    try {
      await openBytes(await loadPack(id), doc.file, id === 'loan-form' ? id : '');
      viewer.applyFit('page');
      if (id !== 'loan-form' && tab === 'fill') setTab('comment');
    } catch (e) { hint(`${doc.title} could not be loaded: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function openFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, '');
  }

  function download(data: Uint8Array, fileName: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data.slice()], { type: 'application/pdf' }));
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const stem = (): string => name.replace(/\.pdf$/i, '');
  const opts = (): { flatten: boolean; flattenFields: boolean; author: string } => ({ flatten: input('flat-marks').checked, flattenFields: input('flat-fields').checked, author: AUTHOR });

  async function guarded(label: string, job: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    hint(`${label}...`);
    try { await job(); } catch (e) { hint(`${label} failed: ${e instanceof Error ? e.message : String(e)}`); } finally { busy = false; }
  }

  async function save(): Promise<void> {
    await guarded('Saving', async () => {
      if (!dirty()) { download(bytes, name); hint(`Saved ${name}`); return; }
      const out = await writePdf(bytes, annot.items, fields.pending(), opts());
      const file = `${stem()}-signed.pdf`;
      download(out, file);
      hint(`Saved ${file} · ${kb(out.length)}`);
    });
  }

  async function apply(): Promise<void> {
    await guarded('Applying', async () => {
      const out = await writePdf(bytes, annot.items, fields.pending(), opts());
      undoStack.push(last);
      annot.setItems([]);
      committed += 1;
      await show(out, true);
      last = snapshot('Apply to working copy');
      redoStack = [];
      syncMarks();
      syncChrome();
      hint(`Applied to the working copy · ${kb(out.length)}`);
    });
  }

  async function restore(s: Snap): Promise<void> {
    if (s.bytes !== bytes) await show(s.bytes, true);
    annot.setItems(s.annots.map((a) => ({ ...a })));
    fields.values.clear();
    for (const [k, v] of Object.entries(s.values)) fields.values.set(k, v);
    fields.renderAll();
    syncFields();
    syncMarks();
    syncChrome();
  }

  async function undo(): Promise<void> {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(last);
    last = prev;
    await restore(prev);
    hint('Undone');
  }

  async function redo(): Promise<void> {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(last);
    last = next;
    await restore(next);
    hint(next.label || 'Redone');
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
    for (const s of root.querySelectorAll<HTMLElement>('.fs-pdfwb-set')) setHidden(s, s.dataset.for !== next);
    for (const p of root.querySelectorAll<HTMLElement>('[data-pane]')) setHidden(p, p.dataset.pane !== next);
    fields.setActive(next === 'fill');
    if (next === 'comment') annot.flattenComments = false;
    setTool('select');
    syncSummary();
  }

  function setSub(next: Sub): void {
    sub = next;
    for (const b of root.querySelectorAll<HTMLElement>('[data-sub]')) setClass(b, 'is-on', b.dataset.sub === next);
    for (const p of root.querySelectorAll<HTMLElement>('[data-subpane]')) setHidden(p, p.dataset.subpane !== next);
    if (next === 'signature') void syncSig();
  }

  function setTool(tool: Tool): void {
    if (tool === 'place' && !annot.placement) tool = 'select';
    if (tool !== 'place') annot.placement = null;
    annot.flattenComments = tab === 'fill';
    annot.setTool(tool);
    root.dataset.tool = tool;
    viewer.setClass('is-drawing', DRAW_TOOLS.includes(tool));
    viewer.setClass('is-marking', MARKUP_TOOLS.includes(tool));
    for (const b of root.querySelectorAll<HTMLElement>('.fs-tb-btn[data-tool]')) setClass(b, 'is-on', b.dataset.tool === tool && !b.closest('[hidden]'));
    if (TOOL_COLOR[tool]) annot.style.color = TOOL_COLOR[tool];
    syncPalette();
    const pl = annot.placement;
    hint(tool === 'place' && pl ? `Click where the ${pl.label} goes. Esc cancels.` : HINTS[tool] ?? (tab === 'fill' ? 'Click a field to fill it, or press Sign here on a signature line.' : ''));
  }

  function syncPalette(): void {
    for (const b of root.querySelectorAll<HTMLElement>('.fs-swatch[data-color]')) setClass(b, 'is-chosen', b.dataset.color?.toLowerCase() === annot.style.color.toLowerCase());
  }

  function pickColor(c: string): void {
    annot.style.color = c;
    const t = annot.tool;
    if (TOOL_COLOR[t]) TOOL_COLOR[t] = c;
    const sel = annot.selected;
    const a = sel ? annot.items.find((x) => x.id === sel) : undefined;
    if (a && a.kind !== 'image' && a.kind !== 'stamp') annot.update(a.id, { color: c }, 'Change colour');
    syncPalette();
  }

  const allowed = ['select', 'highlight', 'underline', 'strikeout', 'squiggly', 'note', 'freetext', 'ink', 'rect', 'ellipse', 'line', 'arrow'];

  function unique(): FieldRow[] {
    const seen = new Set<string>();
    const out: FieldRow[] = [];
    fields.fields.forEach((f, i) => { if (!seen.has(f.name)) { seen.add(f.name); out.push({ key: f.name, f, i }); } });
    return out;
  }

  const signedBy = (f: Field): boolean => annot.items.some((a) => a.kind === 'image' && a.page === f.page && (a.x ?? 0) + (a.w ?? 0) / 2 >= f.x - 4 && (a.x ?? 0) + (a.w ?? 0) / 2 <= f.x + f.w + 4 && (a.y ?? 0) + (a.h ?? 0) / 2 >= f.y - 4 && (a.y ?? 0) + (a.h ?? 0) / 2 <= f.y + f.h + 4);

  function statusOf(row: FieldRow): { done: boolean; text: string } {
    const f = row.f;
    if (f.type === 'signature') { const s = signedBy(f); return { done: s, text: s ? 'Signed' : f.required ? 'Required, press Sign here' : 'Optional' }; }
    const v = fields.current(f.name) ?? '';
    if (f.type === 'checkbox') return { done: v !== '' && v !== 'Off', text: v !== '' && v !== 'Off' ? 'Ticked' : 'Not ticked' };
    if (f.type === 'radio') return { done: v !== '' && v !== 'Off', text: v && v !== 'Off' ? titleCase(v) : 'Not chosen' };
    return { done: v.trim() !== '', text: v.trim() || (f.required ? 'Required' : 'Empty') };
  }

  function missing(): FieldRow[] {
    return unique().filter((row) => row.f.required && !statusOf(row).done);
  }

  function syncFields(): void {
    let moved = false;
    for (const f of fields.fields) {
      if (f.type !== 'signature') continue;
      const v = signedBy(f) ? 'signed' : '';
      if (f.value !== v) { f.value = v; moved = true; }
    }
    if (moved) fields.renderAll();
    const rows = unique();
    const req = rows.filter((x) => x.f.required);
    const left = missing();
    const done = req.length - left.length;
    setText(r('f-sum'), req.length ? (left.length ? `${done} of ${req.length} required filled` : `All ${req.length} required fields done`) : 'No required fields');
    (r('f-bar') as HTMLElement).style.width = `${req.length ? Math.round((done / req.length) * 100) : 0}%`;
    patchList(r('f-list'), rows, {
      key: (x) => `${docId}|${x.key}`,
      create: (x) => {
        const n = el(`<button class="fs-row dm-frow" type="button" data-fi="${x.i}"><span class="fs-row-icon">${icon(FIELD_ICON[x.f.type] ?? 'fieldText', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="dm-state"></span></button>`);
        paintField(n, x);
        return n;
      },
      update: (n, x) => paintField(n, x),
    });
  }

  function paintField(n: HTMLElement, x: FieldRow): void {
    const s = statusOf(x);
    const title = x.f.tooltip ?? titleCase(x.f.name);
    const t = n.querySelector('.fs-row-title') as HTMLElement, sb = n.querySelector('.fs-row-sub') as HTMLElement, st = n.querySelector('.dm-state') as HTMLElement;
    if (t.textContent !== title) t.textContent = title;
    const sub2 = `Page ${x.f.page} · ${s.text}`;
    if (sb.textContent !== sub2) sb.textContent = sub2;
    setClass(st, 'is-done', s.done);
    setClass(st, 'is-req', !s.done && x.f.required);
    n.dataset.fi = String(x.i);
  }

  function goField(i: number): void {
    const f = fields.fields[i];
    if (!f) return;
    if (tab !== 'fill') setTab('fill');
    viewer.scrollToPoint(f.page - 1, f.x + f.w / 2, f.y + f.h / 2);
    window.setTimeout(() => {
      const ctl = viewer.host.querySelector<HTMLElement>(`.fs-pdf-field [data-i="${i}"], .fs-pdf-field [data-sign="${i}"]`);
      ctl?.focus({ preventScroll: true });
    }, 380);
  }

  function marksRows(): Annot[] { return annot.items.filter((a) => a.kind !== 'reply' && a.kind !== 'image' && a.kind !== 'stamp'); }

  function syncMarks(): void {
    const list = annot.items.filter((a) => a.kind !== 'reply');
    const n = list.length;
    setText(r('c-note'), n ? `${n} item${n === 1 ? '' : 's'} on the pages. Click one to find it.` : 'Nothing on the pages yet. Pick a tool above and mark the document.');
    patchList(r('c-list'), list, {
      key: (a) => a.id,
      create: (a) => {
        const node = el(`<div class="fs-pdfwb-thread" data-key="${escapeHtml(a.id)}"><div class="fs-row fs-pdfwb-arow" data-a="pick"><span class="fs-row-icon"><span class="fs-pdfwb-dot"></span></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><button class="fs-icon-btn is-sm" type="button" data-a="annot-del" title="Delete" aria-label="Delete">${icon('delete', 14)}</button></div></div>`);
        paintMark(node, a);
        return node;
      },
      update: (node, a) => paintMark(node, a),
    });
    syncSummary();
  }

  function paintMark(node: HTMLElement, a: Annot): void {
    const row = node.firstElementChild as HTMLElement;
    const dot = row.querySelector('.fs-pdfwb-dot') as HTMLElement;
    const t = row.querySelector('.fs-row-title') as HTMLElement, sb = row.querySelector('.fs-row-sub') as HTMLElement;
    const color = a.kind === 'image' ? '#1E2A78' : a.color;
    if (dot.style.background !== color) dot.style.background = color;
    const title = a.kind === 'image' ? 'Signature' : a.kind === 'stamp' ? `${a.text ?? 'Stamp'}` : `${KIND_LABEL[a.kind]}${a.text || a.quote ? `: ${(a.text || a.quote || '').slice(0, 48)}` : ''}`;
    if (t.textContent !== title) t.textContent = title;
    const s = `Page ${a.page}`;
    if (sb.textContent !== s) sb.textContent = s;
    setClass(row, 'is-selected', annot.selected === a.id);
  }

  function syncSummary(): void {
    const pend = Object.keys(fields.pending()).length;
    const sigs = annot.items.filter((a) => a.kind === 'image').length;
    const marks = marksRows().length + annot.items.filter((a) => a.kind === 'stamp').length;
    setText(r('w-fields'), pend ? `${pend} changed` : 'No changes');
    setText(r('w-marks'), marks ? String(marks) : 'None');
    setText(r('w-sigs'), sigs ? String(sigs) : 'None');
  }

  async function signatureImage(): Promise<{ url: string; aspect: number } | null> {
    if (sigMode === 'draw') { pad.color = sigColor; return pad.image(); }
    return typedSignature(input('sig-text').value, sigColor);
  }

  async function syncSig(): Promise<void> {
    const run = ++sigLive;
    const prev = r('sigprev');
    prev.style.color = sigColor;
    setText(prev, input('sig-text').value);
    if (run !== sigLive) return;
  }

  async function placeSignature(at?: { page: number; x: number; y: number; w: number; h: number }): Promise<boolean> {
    const img = await signatureImage();
    if (!img) { setSub('signature'); hint('Draw or type your signature first.'); return false; }
    if (at) {
      let w = at.w, h = at.w / img.aspect;
      if (h > at.h) { h = at.h; w = at.h * img.aspect; }
      annot.add({ id: uid('a'), page: at.page, kind: 'image', color: '#111111', opacity: 1, rot: 0, x: at.x + (at.w - w) / 2, y: at.y + (at.h - h) / 2, w, h, image: img.url, flatten: true }, 'Sign field');
      syncFields();
      hint('Signed. Flatten and save when you are ready.');
      return true;
    }
    annot.placement = { kind: 'image', image: img.url, aspect: img.aspect, width: 150, label: 'signature' };
    setTool('place');
    return true;
  }

  function placeStamp(id: string): void {
    const def = STAMPS.find((s) => s.id === id);
    if (!def) return;
    const spec = def.dynamic ? { ...def.spec, sub: dynamicLine(input('stamp-name').value) } : def.spec;
    const { w, h } = stampSize(spec);
    annot.placement = { kind: 'stamp', spec, color: def.color, w, h, label: `${def.title.toLowerCase()} stamp`, flatten: true };
    setTool('place');
  }

  function placeDate(): void {
    annot.placement = { kind: 'freetext', text: today(), size: 11, label: 'date' };
    setTool('place');
  }

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tabBtn = t.closest<HTMLElement>('.fs-pdfwb-tab');
    if (tabBtn) { setTab(tabBtn.dataset.tab as Tab); return; }
    const tb = t.closest<HTMLElement>('.fs-tb-btn[data-tool]');
    if (tb) { const tool = tb.dataset.tool as Tool; setTool(allowed.includes(tool) ? tool : 'select'); return; }
    const sw = t.closest<HTMLElement>('.fs-swatch[data-color]');
    if (sw) { pickColor(sw.dataset.color ?? '#FFD400'); return; }
    const sb = t.closest<HTMLElement>('[data-sub]');
    if (sb) { setSub(sb.dataset.sub as Sub); return; }
    const stamp = t.closest<HTMLElement>('[data-stamp]');
    if (stamp) { placeStamp(stamp.dataset.stamp ?? ''); return; }
    const fr = t.closest<HTMLElement>('.dm-frow');
    if (fr) { goField(Number(fr.dataset.fi)); return; }
    const del = t.closest<HTMLElement>('[data-a="annot-del"]');
    if (del) { const id = (del.closest('.fs-pdfwb-thread') as HTMLElement | null)?.dataset.key; if (id) annot.remove(id); return; }
    const pick = t.closest<HTMLElement>('[data-a="pick"]');
    if (pick) { const id = (pick.closest('.fs-pdfwb-thread') as HTMLElement | null)?.dataset.key; if (id) annot.reveal(id); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    switch (a) {
      case 'undo': void undo(); break;
      case 'redo': void redo(); break;
      case 'open': (r('file-open') as HTMLInputElement).click(); break;
      case 'save': void save(); break;
      case 'apply': void apply(); break;
      case 'sign': void placeSignature(); break;
      case 'date': placeDate(); break;
      case 'lib-open': void libOpen(t.closest<HTMLElement>('[data-lib]')?.dataset.lib ?? ''); break;
      case 'zoom-in': viewer.zoomStep(1); break;
      case 'zoom-out': viewer.zoomStep(-1); break;
      case 'fit-w': viewer.applyFit('width'); break;
      case 'fit-p': viewer.applyFit('page'); break;
      case 'c-clear': annot.clear(); break;
      case 'f-discard': fields.discard(); record('Discard entries'); break;
      case 'f-next': { const m = missing()[0]; if (m) goField(m.i); else hint('Every required field is filled.'); break; }
      case 'sig-draw': case 'sig-type': {
        sigMode = a === 'sig-draw' ? 'draw' : 'type';
        for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-sigmode button')) setClass(b, 'is-on', b.dataset.a === a);
        setHidden(r('sigdraw'), sigMode !== 'draw');
        setHidden(r('sigtype'), sigMode !== 'type');
        break;
      }
      case 'sig-color': {
        sigColor = t.closest<HTMLElement>('[data-c]')?.dataset.c ?? sigColor;
        for (const s of root.querySelectorAll<HTMLElement>('[data-a="sig-color"]')) setClass(s, 'is-chosen', s.dataset.c === sigColor);
        pad.color = sigColor;
        pad.paint();
        void syncSig();
        break;
      }
      case 'sig-clear': if (sigMode === 'draw') pad.clear(); else { input('sig-text').value = ''; void syncSig(); } break;
      case 'sig-place': void placeSignature(); break;
      default: break;
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t === r('sig-text')) void syncSig();
    if (t === r('stamp-name')) {
      const line = dynamicLine(input('stamp-name').value);
      const pal = r('stamp-palette');
      pal.innerHTML = paletteHtml(line);
    }
  });

  r('width').addEventListener('change', () => { annot.style.width = Number(input('width').value); });
  r('size').addEventListener('change', () => { annot.style.size = Number(input('size').value); });
  r('file-open').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; (e.target as HTMLInputElement).value = ''; void openFile(f); });
  r('pg').addEventListener('change', () => { const n = Number(input('pg').value); if (Number.isFinite(n) && n >= 1) viewer.goTo(Math.min(sizes.length, n)); });

  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).closest('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); void (e.shiftKey ? redo() : undo()); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (typing) return;
    if (e.key === 'Escape') { setTool('select'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && annot.selected) { e.preventDefault(); annot.remove(); }
  });

  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth += 1; setHidden(r('drop'), false); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setHidden(r('drop'), true); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setHidden(r('drop'), true);
    void openFile(e.dataTransfer?.files[0]);
  });

  for (const b of root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab')) setClass(b, 'is-on', b.dataset.tab === tab);
  for (const s of root.querySelectorAll<HTMLElement>('.fs-pdfwb-set')) setHidden(s, s.dataset.for !== tab);
  setText(r('fillhint'), 'Fill the form, then press Sign here on the signature line.');
  fields.setActive(true);
  void syncSig();
  syncMarks();
  setTool('select');
  setText(r('name'), name);

  void (async () => {
    try {
      await openBytes(await loadPack('loan-form'), LIBRARY[0].file, 'loan-form');
      viewer.applyFit('page');
    } catch (e) {
      setText(r('opening-title'), `The loan agreement could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
