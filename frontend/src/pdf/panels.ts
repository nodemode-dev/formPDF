import { el, escapeHtml, patchList, q, setClass, setDisabled, setHidden, setText, setValue } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { KIND_LABEL, uid, type Annotator, type Tool } from './annotate';
import { pdfApi, type Annot, type Area, type Derived, type HeaderFooter, type HiddenItem, type ImageItem, type Match, type PdfComment, type PdfInfo, type Preset, type Status, type TableItem } from './api';
import { SignaturePad, typedSignature, type Fields } from './fill';
import type { Organizer } from './organize';
import { recall, remember } from './reading';
import { dynamicLine, paletteHtml, STAMPS, stampSize } from './stamps';
import type { Viewer } from './viewer';

export type Tab = 'view' | 'comment' | 'fill' | 'form' | 'edit' | 'organize' | 'extract' | 'protect' | 'convert' | 'access' | 'print';
export interface Doc { id: string; name: string; info: PdfInfo; key: string }
export interface Ctx {
  viewer: Viewer; annot: Annotator; fields: Fields; organizer: Organizer;
  doc(): Doc | null;
  run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>;
  commit(res: Derived, label: string): Promise<void>;
  flush(): Promise<string | null>;
  deliver(data: Blob | string, name: string): Promise<void>;
  tool(t: Tool): void;
  pickPdfs(multiple: boolean): Promise<File[]>;
  remember(id: string, password: string): void;
  insertPdfs(files: File[], at: number): Promise<void>;
  applyOrganize(): Promise<void>;
  act(name: string, value?: string): void;
}

const stem = (name: string): string => name.replace(/\.pdf$/i, '');
const fmtBytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toCsv = (t: TableItem): string => [t.header, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\n');
const sec = (title: string, body: string, extra = ''): string => `<section class="fs-pdfwb-sec" ${extra}><h3 class="fs-pdfwb-sec-title">${title}</h3>${body}</section>`;
const row = (label: string, ctl: string): string => `<div class="fs-prop-row"><span class="fs-prop-label">${label}</span><div class="fs-prop-ctl">${ctl}</div></div>`;
const PAPER: Array<[string, number, number]> = [['Letter', 612, 792], ['Legal', 612, 1008], ['A4', 595, 842], ['A3', 842, 1191], ['A5', 420, 595], ['Tabloid', 792, 1224]];
const SLOTS = ['header-left', 'header-center', 'header-right', 'footer-left', 'footer-center', 'footer-right'] as const;
type Slot = typeof SLOTS[number];
const TOKEN = /<<\s*(page|pages|date|file|bates)\s*>>/gi;
const STATUS: Array<[Status, string]> = [['none', 'None'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['completed', 'Completed']];
const PROP_LABELS = ['File', 'Pages', 'Page size', 'File size', 'PDF', 'Title', 'Author', 'Subject', 'Keywords', 'Created', 'Modified', 'Creator', 'Producer', 'Form fields', 'Security'];
const STATUS_LABEL: Record<Status, string> = { none: 'None', accepted: 'Accepted', rejected: 'Rejected', completed: 'Completed', cancelled: 'Cancelled' };
const SIDES = ['l', 't', 'r', 'b'] as const;
export const LAYOUTS: Array<[string, string, string]> = [['single', 'Single page', 'pageSingle'], ['continuous', 'Single page continuous', 'pageScroll'], ['two', 'Two-page', 'pageTwo'], ['two-continuous', 'Two-page continuous', 'pageTwoScroll']];
const HIDDEN_KEYS: Array<[string, string]> = [['metadata', 'Metadata'], ['javascript', 'JavaScript and actions'], ['attachments', 'Attached files'], ['comments', 'Comments and markups'], ['fields', 'Form fields'], ['layers', 'Hidden layers'], ['links', 'Links'], ['bookmarks', 'Bookmarks'], ['thumbnails', 'Page thumbnails'], ['private', 'Private application data'], ['hidden_text', 'Hidden text']];
const HIDDEN_HELP: Record<string, string> = { fields: 'Fields are flattened: their current values stay on the page.', layers: 'Hidden layers are dropped and the visible ones merged.', hidden_text: 'Scanned pages lose their searchable text.' };
const STAMP_NAME = 'fs-pdf-stamp-name';
const stampSec = (): string => sec('Stamps', `${paletteHtml('By you, with the date and time')}<div class="fs-pdfwb-subhead">More</div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="stamp-date">${icon('stamp', 14)}Date</button><button class="fs-btn fs-btn-sm" type="button" data-a="stamp-text">${icon('textBox', 14)}Text</button><button class="fs-btn fs-btn-sm" type="button" data-a="stamp-image">${icon('image', 14)}From a picture…</button></div>${row('Name', '<input class="fs-input" type="text" data-a="stamp-name" placeholder="Your name on dynamic stamps" spellcheck="false" aria-label="Name on dynamic stamps">')}<label class="fs-check"><input type="checkbox" data-a="stamp-flat">Flatten stamps into the page</label><p class="fs-note">Click a stamp, then click the page where it goes. Drag it to move it and its corner to resize it. Stamps stay as stamp comments that other readers can move or delete, unless flattened.</p>`, 'data-part="stamps"');
const num = (a: string, value: number, min: number, max: number): string => `<div class="fs-num"><input type="number" data-a="${a}" value="${value}" min="${min}" max="${max}" step="1"></div>`;
const quad = (prefix: string, title: Record<string, string>, value: number): string => `<div class="fs-pdfwb-quad">${Object.entries(title).map(([k, t]) => `<div class="fs-num" title="${t}"><span class="fs-num-label">${t[0]}</span><input type="number" min="0" step="1" value="${value}" data-a="${prefix}-${k}" aria-label="${t}"><span class="fs-unit">pt</span></div>`).join('')}</div>`;

interface ReplyView { key: string; who: string; text: string; pending: boolean }
interface ThreadView { key: string; pending: boolean; page: number; title: string; sub: string; color: string; status: Status; replies: ReplyView[]; open: boolean }

function parseRange(spec: string, n: number): number[] | null {
  const s = spec.trim();
  if (!s || s.toLowerCase() === 'all') return Array.from({ length: n }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of s.split(/[,\s;]+/)) {
    if (!part) continue;
    const m = /^(\d*)-(\d*)$/.exec(part);
    const [a, b] = m ? [m[1] ? Number(m[1]) : 1, m[2] ? Number(m[2]) : n] : /^\d+$/.test(part) ? [Number(part), Number(part)] : [NaN, NaN];
    if (!(a >= 1 && b <= n && a <= b)) return null;
    for (let p = a; p <= b; p++) if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : null;
}

function unrotate(m: [number, number, number, number], rot: number): [number, number, number, number] {
  const [l, t, r, b] = m;
  return rot === 90 ? [t, r, b, l] : rot === 180 ? [r, b, l, t] : rot === 270 ? [b, l, t, r] : [l, t, r, b];
}

function rerotate(u: [number, number, number, number], rot: number): [number, number, number, number] {
  const [left, top, right, bottom] = u;
  return rot === 90 ? [bottom, left, top, right] : rot === 180 ? [right, bottom, left, top] : rot === 270 ? [top, right, bottom, left] : [left, top, right, bottom];
}

function paperName(w: number, h: number): string {
  const [a, b] = w < h ? [w, h] : [h, w];
  const hit = PAPER.find(([, pw, ph]) => Math.abs(pw - a) < 3 && Math.abs(ph - b) < 3);
  const dims = `${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm`;
  return hit ? `${hit[0]}${w > h ? ' landscape' : ''} · ${dims}` : dims;
}

function dateText(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

export class Panes {
  readonly root: HTMLElement;
  private readonly pad = new SignaturePad();
  private sigMode: 'draw' | 'type' = 'draw';
  private sigColor = '#1E2A78';
  private images: ImageItem[] = [];
  private picked = new Set<string>();
  private tables: TableItem[] = [];
  private metaFor = '';
  private tab: Tab = 'view';
  private existing: PdfComment[] = [];
  private commentsFor = '';
  private marksFor = '';
  private filedMarks = 0;
  private commentsLoading = '';
  private openThread = '';
  private matches: Match[] = [];
  private ticked = new Set<number>();
  private matchesFor = '';
  private matchesKey = '';
  private stale = false;
  private hfFocus: Slot = 'footer-center';
  private hidden: HiddenItem[] = [];
  private hiddenFor = '';
  private hidTicked = new Set<string>();

  constructor(private readonly ctx: Ctx) {
    this.root = el(`<div class="fs-pdfwb-panes">
<div class="fs-pdfwb-pane" data-for="view">
${sec('Page display', `<div class="fs-pdfwb-layouts" role="radiogroup" aria-label="Page layout">${LAYOUTS.map(([v, l, ic]) => `<button class="fs-pdfwb-layout" type="button" role="radio" data-a="layout" data-v="${v}">${icon(ic, 18)}<span>${l}</span></button>`).join('')}</div><label class="fs-check"><input type="checkbox" data-a="cover">Show cover page in two-page view</label><div class="fs-pdfwb-btns fs-pdfwb-rfbtns"><button class="fs-btn fs-btn-sm" type="button" data-a="reading" aria-pressed="false">${icon('readMode', 14)}<span>Reading mode</span></button><button class="fs-icon-btn" type="button" data-a="rf-smaller" title="Smaller text" aria-label="Smaller text">${icon('textSmaller', 16)}</button><button class="fs-icon-btn" type="button" data-a="rf-larger" title="Larger text" aria-label="Larger text">${icon('textLarger', 16)}</button></div><p class="fs-note">Reading mode shows the text in one readable column, page after page, in reading order.</p>`)}
${sec('Read aloud', `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="say-page">${icon('speaker', 14)}Read this page</button><button class="fs-btn fs-btn-sm" type="button" data-a="say-end">${icon('readAloud', 14)}Read to the end</button></div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="say-pause">${icon('pause', 14)}<span>Pause</span></button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="say-stop">${icon('stop', 14)}Stop</button></div>${row('Voice', '<select data-a="say-voice" aria-label="Voice"><option value="">Default voice</option></select>')}${row('Speed', `<select data-a="say-rate" aria-label="Speed">${[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}×</option>`).join('')}</select>`)}<p class="fs-note fs-pdfwb-saynote"></p>`, 'data-part="say"')}
${sec('Document', `<dl class="fs-kv fs-pdfwb-props">${PROP_LABELS.map((k) => `<dt>${k}</dt><dd></dd>`).join('')}</dl>`)}
${sec('Find', `<label class="fs-search">${icon('search', 14)}<input type="search" class="fs-pdfwb-findq" placeholder="Search this PDF" spellcheck="false"></label><p class="fs-note fs-pdfwb-findnote">Press ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+F anywhere in the workbench.</p>`)}
${sec('Compare', '<div class="fs-pdfwb-cmphost"></div>', 'data-part="compare"')}
</div>
<div class="fs-pdfwb-pane" data-for="comment" hidden>
${sec(`Comments <span class="fs-badge is-count fs-pdfwb-ncount">0</span>`, `<label class="fs-check"><input type="checkbox" data-a="flatten-comments">Flatten into the page</label><p class="fs-note">Comments stay editable in other PDF readers unless flattened. They are written into the PDF, with their replies and status, when you save or apply. Select a comment to reply or set its status.</p><div class="fs-pdfwb-annots-area"><div class="fs-list fs-pdfwb-annots"></div><div class="fs-pdfwb-subhead fs-pdfwb-inpdf-head" hidden>In this PDF</div><div class="fs-list fs-pdfwb-inpdf"></div><div class="fs-empty fs-pdfwb-annots-empty" hidden><span class="fs-empty-icon">${icon('comment', 18)}</span><span class="fs-empty-title">No comments yet</span><span class="fs-empty-note">Choose a tool above, then select text or draw on a page.</span></div></div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="apply-annots">${icon('check', 14)}Apply to PDF</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="clear-annots">Discard all</button></div>`)}
</div>
<div class="fs-pdfwb-pane" data-for="fill" hidden>
${sec('Form fields', `<p class="fs-note fs-pdfwb-fieldnote">Looking for form fields…</p><label class="fs-check"><input type="checkbox" data-a="flatten-fields">Flatten fields (no longer editable)</label><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="apply-fields">${icon('check', 14)}Apply to form</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="discard-fields">Discard</button></div>`)}
${sec('Signature', `<div class="fs-seg fs-pdfwb-sigmode"><button type="button" data-a="sig-draw" class="is-on">Draw</button><button type="button" data-a="sig-type">Type</button></div><div class="fs-pdfwb-sigdraw"></div><div class="fs-pdfwb-sigtype" hidden><input class="fs-input" type="text" data-a="sig-text" placeholder="Type your name" spellcheck="false"><div class="fs-pdfwb-sigpreview"></div></div><div class="fs-pdfwb-sigrow"><span class="fs-swatch is-chosen" data-a="sig-color" data-c="#1E2A78" style="background:#1E2A78" title="Blue ink"></span><span class="fs-swatch" data-a="sig-color" data-c="#111111" style="background:#111111" title="Black ink"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="sig-clear">Clear</button><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="sig-place">${icon('signature', 14)}Place</button></div><p class="fs-note">Then click the page where the signature goes. Signatures are stamped into the page.</p>`)}
${stampSec()}
</div>
<div class="fs-pdfwb-pane" data-for="form" hidden></div>
<div class="fs-pdfwb-pane" data-for="edit" hidden>
${sec('Header and footer', `<span class="fs-pdfwb-hflabel">Header</span><div class="fs-pdfwb-hf3"><input class="fs-input" type="text" data-hf="header-left" placeholder="Left" aria-label="Header left" spellcheck="false"><input class="fs-input" type="text" data-hf="header-center" placeholder="Centre" aria-label="Header centre" spellcheck="false"><input class="fs-input" type="text" data-hf="header-right" placeholder="Right" aria-label="Header right" spellcheck="false"></div><span class="fs-pdfwb-hflabel">Footer</span><div class="fs-pdfwb-hf3"><input class="fs-input" type="text" data-hf="footer-left" placeholder="Left" aria-label="Footer left" spellcheck="false"><input class="fs-input" type="text" data-hf="footer-center" placeholder="Centre" aria-label="Footer centre" spellcheck="false" value="Page <<page>> of <<pages>>"><input class="fs-input" type="text" data-hf="footer-right" placeholder="Right" aria-label="Footer right" spellcheck="false"></div><div class="fs-pdfwb-tokens"><span class="fs-pdfwb-tokens-label">Insert</span><button class="fs-chip" type="button" data-a="hf-token" data-t="<<page>>">Page</button><button class="fs-chip" type="button" data-a="hf-token" data-t="<<pages>>">Pages</button><button class="fs-chip" type="button" data-a="hf-token" data-t="<<date>>">Date</button><button class="fs-chip" type="button" data-a="hf-token" data-t="<<file>>" title="File name">File</button><button class="fs-chip" type="button" data-a="hf-token" data-t="<<bates>>">Bates</button></div><div class="fs-pdfwb-hfprev" aria-label="Preview"><div class="fs-pdfwb-hfline" data-band="header"><span data-p="header-left"></span><span data-p="header-center"></span><span data-p="header-right"></span></div><div class="fs-pdfwb-hfbody"><i></i><i></i><i></i></div><div class="fs-pdfwb-hfline" data-band="footer"><span data-p="footer-left"></span><span data-p="footer-center"></span><span data-p="footer-right"></span></div></div><p class="fs-note fs-pdfwb-hfnote"></p>${row('Font', '<select data-a="hf-font" aria-label="Font"><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>')}${row('Size', '<div class="fs-num"><input type="number" min="4" max="96" step="0.5" value="10" data-a="hf-size"><span class="fs-unit">pt</span></div>')}${row('Colour', '<input type="color" class="fs-pdfwb-color" value="#333333" data-a="hf-color">')}${row('Margins', quad('hf', { t: 'Top', b: 'Bottom', l: 'Left', r: 'Right' }, 36))}${row('Pages', '<input class="fs-input" type="text" data-a="hf-pages" placeholder="All pages, or 2-">')}${row('Apply to', '<select data-a="hf-apply" aria-label="Apply to"><option value="all">Every page</option><option value="odd">Odd pages</option><option value="even">Even pages</option></select>')}${row('Start at', '<div class="fs-num"><input type="number" min="0" value="1" data-a="hf-start"></div>')}${row('Date', '<select data-a="hf-date" aria-label="Date format"><option value="short">Short (this computer)</option><option value="long">Long (this computer)</option><option value="iso">2026-10-08</option></select>')}<label class="fs-check"><input type="checkbox" data-a="hf-bates">Bates numbering</label><div class="fs-pdfwb-bates" hidden>${row('Prefix', '<input class="fs-input" type="text" data-a="bates-prefix" placeholder="For example ACME-" spellcheck="false">')}${row('Start', num('bates-start', 1, 0, 999999999))}${row('Digits', num('bates-digits', 6, 1, 15))}</div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="hf-add">Add header and footer</button></div>`)}
${sec('Crop pages', `<p class="fs-note">Cropping hides what is outside the box. Unlike redaction, the hidden content stays in the file and comes back if the crop is removed; to delete content for good, use Redact on the Protect tab.</p>${row('Margins', quad('crop', { l: 'Left', t: 'Top', r: 'Right', b: 'Bottom' }, 0))}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="crop-tool">${icon('crop', 14)}Draw on page</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="crop-clear">Clear</button></div>${row('Pages', '<input class="fs-input" type="text" data-a="crop-pages" placeholder="All pages, or 1-3">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="crop-current">This page</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="crop-every">All pages</button></div><p class="fs-note fs-pdfwb-cropnote"></p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="crop-apply">${icon('crop', 14)}Crop pages</button><button class="fs-btn fs-btn-sm" type="button" data-a="crop-auto">Remove white margins</button></div>`)}
${sec('Page numbers', `${row('Position', '<select data-a="pn-pos" aria-label="Position"><option value="bottom-center">Bottom centre</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="top-center">Top centre</option><option value="top-right">Top right</option><option value="top-left">Top left</option></select>')}${row('Format', '<select data-a="pn-fmt" aria-label="Format"><option value="{n}">1</option><option value="Page {n}">Page 1</option><option value="Page {n} of {total}">Page 1 of 9</option><option value="{n} / {total}">1 / 9</option></select>')}${row('Start at', '<div class="fs-num"><input type="number" min="0" value="1" data-a="pn-start"></div>')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="numbers">Add page numbers</button></div>`)}
${sec('Watermark', `${row('Text', '<input class="fs-input" type="text" data-a="wm-text" value="CONFIDENTIAL">')}${row('Opacity', '<input class="fs-slider" type="range" min="5" max="100" value="18" data-a="wm-op"><span class="fs-unit fs-pdfwb-wmv">18%</span>')}${row('Angle', '<div class="fs-num"><input type="number" value="45" min="-180" max="180" data-a="wm-angle"><span class="fs-unit">°</span></div>')}${row('Size', '<div class="fs-num"><input type="number" value="64" min="6" max="400" data-a="wm-size"><span class="fs-unit">pt</span></div>')}${row('Colour', '<input type="color" class="fs-pdfwb-color" value="#888888" data-a="wm-color">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="watermark">Add watermark</button></div>`)}
</div>
<div class="fs-pdfwb-pane" data-for="organize" hidden>
${sec('Pages', `<p class="fs-note fs-pdfwb-orgnote"></p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="org-left">${icon('undo', 14)}Rotate left</button><button class="fs-btn fs-btn-sm" type="button" data-a="org-right">${icon('redo', 14)}Rotate right</button><button class="fs-btn fs-btn-sm" type="button" data-a="org-delete">${icon('delete', 14)}Delete</button><button class="fs-btn fs-btn-sm" type="button" data-a="org-blank">${icon('pageInsert', 14)}Blank page</button><button class="fs-btn fs-btn-sm" type="button" data-a="org-insert">${icon('upload', 14)}Insert from PDF</button><button class="fs-btn fs-btn-sm" type="button" data-a="org-extract">${icon('pageExtract', 14)}Extract selected</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="org-all">Select all</button></div><p class="fs-note">Drag pages to reorder them. Drop a PDF on the grid to insert its pages there.</p>`)}
${sec('Split', `${row('Ranges', '<input class="fs-input" type="text" data-a="split-ranges" placeholder="1-3, 4-6, 7-">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="split">${icon('split', 14)}Split into files</button></div>`)}
${sec('Merge', `<p class="fs-note">Append whole PDFs to the end, keeping their bookmarks.</p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="merge">${icon('merge', 14)}Merge PDFs…</button></div>`)}
</div>
<div class="fs-pdfwb-pane" data-for="extract" hidden>
${sec('Pages', `${row('From', '<input class="fs-input" type="text" data-a="ex-pages" placeholder="All pages, or 1-3, 5">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="ex-current">This page</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="ex-all">All pages</button></div>`)}
${sec('Text', `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="ex-text">${icon('fileText', 14)}Extract text</button></div><textarea class="fs-input fs-pdfwb-text" readonly hidden spellcheck="false"></textarea><div class="fs-pdfwb-btns fs-pdfwb-textbtns" hidden><button class="fs-btn fs-btn-sm" type="button" data-a="text-copy">Copy</button><button class="fs-btn fs-btn-sm" type="button" data-a="text-txt">${icon('download', 14)}.txt</button><button class="fs-btn fs-btn-sm" type="button" data-a="text-md">${icon('download', 14)}.md</button></div>`)}
${sec('Images', `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="ex-images">${icon('image', 14)}Extract images</button></div><div class="fs-asset-grid fs-pdfwb-images"></div><div class="fs-pdfwb-btns fs-pdfwb-imgbtns" hidden><button class="fs-btn fs-btn-sm" type="button" data-a="img-download">${icon('download', 14)}Download</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="img-all">Select all</button></div>`)}
${sec('Tables', `<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="ex-tables">${icon('table', 14)}Extract tables</button><button class="fs-btn fs-btn-sm" type="button" data-a="tables-xlsx" hidden>${icon('download', 14)}.xlsx</button></div><div class="fs-pdfwb-tables"></div>`)}
</div>
<div class="fs-pdfwb-pane" data-for="protect" hidden>
${sec('Password', `${row('Password', '<input class="fs-input" type="password" data-a="pw1" autocomplete="new-password">')}${row('Confirm', '<input class="fs-input" type="password" data-a="pw2" autocomplete="new-password">')}${row('Owner', '<input class="fs-input" type="password" data-a="pw-owner" placeholder="Optional" autocomplete="new-password">')}<div class="fs-pdfwb-perms"><label class="fs-check"><input type="checkbox" data-perm="print" checked>Printing</label><label class="fs-check"><input type="checkbox" data-perm="copy" checked>Copying text</label><label class="fs-check"><input type="checkbox" data-perm="modify" checked>Editing</label><label class="fs-check"><input type="checkbox" data-perm="annotate" checked>Comments</label><label class="fs-check"><input type="checkbox" data-perm="fill" checked>Filling forms</label><label class="fs-check"><input type="checkbox" data-perm="assemble" checked>Page changes</label></div><p class="fs-note">AES-256. Readers need the password to open the file; the owner password unlocks the restrictions.</p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="protect">${icon('lockFile', 14)}Protect</button></div>`)}
${sec('Remove password', `${row('Password', '<input class="fs-input" type="password" data-a="unlock-pw" autocomplete="current-password">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="unlock">${icon('unlock', 14)}Remove protection</button></div>`, 'data-part="unlock"')}
${sec('Find text to redact', `${row('Find', '<select data-a="fr-mode" aria-label="What to find"><option value="text">Words or phrase</option><option value="email">Email addresses</option><option value="phone">Phone numbers</option><option value="card">Credit card numbers</option><option value="date">Dates</option><option value="regex">Pattern (regular expression)</option></select>')}<div class="fs-pdfwb-frq"><label class="fs-search">${icon('search', 14)}<input type="search" data-a="fr-query" placeholder="Word or phrase" spellcheck="false" aria-label="Text to find"></label></div><div class="fs-pdfwb-fropts"><label class="fs-check"><input type="checkbox" data-a="fr-case">Match case</label><label class="fs-check"><input type="checkbox" data-a="fr-whole">Whole words</label></div><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="fr-find">${icon('find', 14)}Find</button></div><div class="fs-pdfwb-frhead" hidden><span class="fs-pdfwb-frcount"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="fr-all">Select all</button></div><div class="fs-list fs-pdfwb-matches"></div><div class="fs-pdfwb-btns fs-pdfwb-frbtns" hidden><button class="fs-btn fs-btn-sm" type="button" data-a="fr-mark">${icon('eraser', 14)}Mark ticked</button><button class="fs-btn fs-btn-sm fs-btn-danger" type="button" data-a="fr-redact">Redact all matches</button></div>`)}
${sec('Redact', `<p class="fs-note fs-pdfwb-redactnote">Mark areas to black out, then apply.</p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="redact-tool">${icon('eraser', 14)}Mark areas</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="redact-clear">Clear</button></div>${row('Fill', '<input type="color" class="fs-pdfwb-color" value="#000000" data-a="redact-color" aria-label="Fill colour">')}${row('Text on box', '<input class="fs-input" type="text" data-a="redact-overlay" maxlength="120" placeholder="None, or REDACTED" spellcheck="false">')}<label class="fs-check"><input type="checkbox" data-a="redact-scan">Scanned pages: flatten marked pages to pictures</label><p class="fs-pdfwb-warn">${icon('warning', 14)}<span>Redaction is permanent. The text, pictures, shapes, comments and form fields under each box are removed from the file, not covered; the rest of the page stays selectable and searchable. Redaction marks already in the file are applied too.</span></p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-danger" type="button" data-a="redact-apply">Apply redactions</button></div>`)}
${sec('Metadata', `${row('Title', '<input class="fs-input" type="text" data-m="title">')}${row('Author', '<input class="fs-input" type="text" data-m="author">')}${row('Subject', '<input class="fs-input" type="text" data-m="subject">')}${row('Keywords', '<input class="fs-input" type="text" data-m="keywords">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="meta-save">${icon('check', 14)}Save metadata</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="meta-strip">Remove all</button></div>`)}
${sec('Remove hidden information', `<p class="fs-note fs-pdfwb-hidnote">Find what this PDF carries besides its visible pages: metadata, scripts, attachments, comments, form fields, hidden layers and more.</p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="hid-scan">${icon('find', 14)}<span>Find hidden information</span></button><button class="fs-btn fs-btn-sm fs-btn-danger" type="button" data-a="hid-remove" hidden>Remove ticked</button></div><div class="fs-pdfwb-hidlist" hidden>${HIDDEN_KEYS.map(([k, l]) => `<label class="fs-check fs-pdfwb-hidrow" data-hk="${k}"><input type="checkbox" data-a="hid-tick" data-k="${k}"><span class="fs-pdfwb-hidlabel">${l}</span><span class="fs-pdfwb-hidcount"></span></label>`).join('')}</div><p class="fs-note fs-pdfwb-hidhelp" hidden></p>`)}
</div>
<div class="fs-pdfwb-pane" data-for="convert" hidden>
${sec('PowerPoint', `<p class="fs-note">One slide per page at the page size. Words become editable text boxes (turned ones stay turned), tables PowerPoint tables, and lines, shapes and pictures PowerPoint objects; what cannot be rebuilt stays in the slide picture behind them.</p>${row('Pages', '<input class="fs-input" type="text" data-a="pptx-pages" placeholder="All pages">')}<label class="fs-check"><input type="checkbox" data-a="pptx-text" checked>Editable text, shapes and pictures</label><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="pptx">${icon('filePptx', 14)}Export to PowerPoint (.pptx)</button></div>`)}
${sec('Word document', `<p class="fs-note">Paragraphs in reading order with their sizes, bold and italic, headings, lists, pictures and tables become editable Word content. Columns stay columns, running headers and footers move into the Word header and footer with a live page number, and each page starts a new page.</p>${row('Pages', '<input class="fs-input" type="text" data-a="docx-pages" placeholder="All pages">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="docx">${icon('fileWord', 14)}Save as Word (.docx)</button></div>`)}
${sec('Compress', `${row('Quality', '<input class="fs-slider" type="range" min="20" max="95" value="70" data-a="cq"><span class="fs-unit fs-pdfwb-cqv">70</span>')}<p class="fs-note fs-pdfwb-cnote">Recompresses large pictures and removes duplicate objects.</p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="compress">Compress</button></div>`)}
${sec('Export pages as images', `${row('Scale', '<select data-a="png-scale" aria-label="Scale"><option value="1">72 dpi</option><option value="2" selected>144 dpi</option><option value="3">216 dpi</option><option value="4.1667">300 dpi</option></select>')}${row('Pages', '<input class="fs-input" type="text" data-a="png-pages" placeholder="All pages">')}<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-a="png-zip">${icon('fileImage', 14)}Download PNG zip</button></div>`)}
</div>
<div class="fs-pdfwb-pane" data-for="access" hidden></div>
<div class="fs-pdfwb-pane" data-for="print" hidden></div>
</div>`);
    q(this.root, '.fs-pdfwb-sigdraw').appendChild(this.pad.root);
    this.pad.onChange = () => this.syncSig();
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.input(e));
    q<HTMLInputElement>(this.root, '[data-a="flatten-comments"]').checked = false;
    this.root.addEventListener('focusin', (e) => { const s = (e.target as HTMLElement).dataset?.hf; if (s) this.hfFocus = s as Slot; });
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key !== 'Enter') return;
      if (t.classList.contains('fs-pdfwb-rtext') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (t.closest('.fs-pdfwb-thread')?.querySelector('[data-a="thread-reply"]') as HTMLElement | null)?.click(); }
      else if (t.dataset.a === 'fr-query') { e.preventDefault(); this.$('[data-a="fr-find"]').click(); }
    });
    const name = recall(STAMP_NAME) ?? '';
    for (const n of Array.from(this.root.querySelectorAll<HTMLInputElement>('[data-a="stamp-name"]'))) n.value = name;
    this.syncHF();
  }

  get stampName(): string { return this.$<HTMLInputElement>('[data-a="stamp-name"]').value.trim(); }

  private placeStamp(id: string): void {
    const def = STAMPS.find((s) => s.id === id);
    if (!def) return;
    const spec = def.dynamic ? { ...def.spec, sub: dynamicLine(this.stampName || 'Reviewer') } : { ...def.spec };
    const { w, h } = stampSize(spec);
    const flatten = this.$<HTMLInputElement>('[data-a="stamp-flat"]').checked;
    this.ctx.annot.placement = { kind: 'stamp', spec, color: def.color, w, h, label: `${def.title.toLowerCase()} stamp`, flatten };
    this.ctx.tool('place');
  }

  private pickStampImage(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const flatten = this.$<HTMLInputElement>('[data-a="stamp-flat"]').checked;
        this.ctx.annot.placement = { kind: 'image', image: c.toDataURL('image/png'), aspect: c.width / c.height, width: 140, label: 'stamp', flatten };
        this.ctx.tool('place');
      };
      img.onerror = () => { URL.revokeObjectURL(url); toast(`${f.name} could not be read as a picture`, 'error'); };
      img.src = url;
    };
    input.click();
  }

  private syncHidden(): void {
    const d = this.ctx.doc();
    const fresh = !!d && this.hiddenFor === d.id;
    setHidden(this.$('.fs-pdfwb-hidlist'), !fresh);
    setHidden(this.$('[data-a="hid-remove"]'), !fresh);
    const total = this.hidden.reduce((s, it) => s + (it.count > 0 ? 1 : 0), 0);
    setText(this.$('[data-a="hid-scan"] span:not(.icon)'), fresh ? 'Check again' : 'Find hidden information');
    setText(this.$('.fs-pdfwb-hidnote'), !fresh ? 'Find what this PDF carries besides its visible pages: metadata, scripts, attachments, comments, form fields, hidden layers and more.' : total ? `This PDF has ${total} kind${total === 1 ? '' : 's'} of hidden information. Tick what to remove; it all goes in one step that Undo can take back until you save.` : 'Nothing hidden was found in this PDF.');
    for (const it of this.hidden) {
      const rowEl = this.root.querySelector<HTMLElement>(`[data-hk="${it.key}"]`);
      if (!rowEl) continue;
      const box = rowEl.querySelector('input') as HTMLInputElement;
      setDisabled(box, !it.count);
      if (box.checked !== (it.count > 0 && this.hidTicked.has(it.key))) box.checked = it.count > 0 && this.hidTicked.has(it.key);
      setText(rowEl.querySelector('.fs-pdfwb-hidcount'), it.count ? `${it.count} found${it.note ? ` · ${it.note}` : ''}` : 'None found');
      setClass(rowEl, 'is-none', !it.count);
    }
    const help = [...this.hidTicked].filter((k) => HIDDEN_HELP[k] && this.hidden.some((it) => it.key === k && it.count)).map((k) => HIDDEN_HELP[k]);
    setHidden(this.$('.fs-pdfwb-hidhelp'), !fresh || !help.length);
    setText(this.$('.fs-pdfwb-hidhelp'), help.join(' '));
    setDisabled(this.$<HTMLButtonElement>('[data-a="hid-remove"]'), ![...this.hidTicked].some((k) => this.hidden.some((it) => it.key === k && it.count)));
  }

  show(tab: Tab): void {
    this.tab = tab;
    for (const p of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-pdfwb-pane'))) setHidden(p, p.dataset.for !== tab);
    if (tab === 'fill') requestAnimationFrame(() => this.pad.paint());
  }

  private $<T extends HTMLElement = HTMLElement>(sel: string): T { return q<T>(this.root, sel); }
  private val(a: string): string { return this.$<HTMLInputElement>(`[data-a="${a}"]`).value; }

  syncDoc(): void {
    const d = this.ctx.doc();
    const props = this.$('.fs-pdfwb-props');
    if (this.matchesFor && d?.key !== this.matchesKey) { this.matches = []; this.ticked.clear(); this.matchesFor = ''; this.stale = false; this.syncMatches(); }
    else if (this.matchesFor && d?.id !== this.matchesFor && !this.stale) { this.ticked.clear(); this.stale = true; this.syncMatches(); }
    const cells = [...props.querySelectorAll<HTMLElement>('dd')];
    if (!d) {
      for (const c of cells) { setText(c, ''); c.removeAttribute('title'); }
      if (this.commentsFor) { this.existing = []; this.commentsFor = ''; this.openThread = ''; this.syncAnnots(); }
      return;
    }
    void this.loadComments();
    void this.loadMarks();
    this.syncHF();
    this.syncCrop();
    const i = d.info, n = this.ctx.viewer.currentPage(), s = i.sizes[n - 1];
    const pairs: Array<[string, string]> = [
      ['File', d.name], ['Pages', String(i.pages)], ['Page size', s ? paperName(s.rotate % 180 ? s.h : s.w, s.rotate % 180 ? s.w : s.h) : ''], ['File size', fmtBytes(i.bytes)],
      ['PDF', i.version ?? ''], ['Title', i.title ?? ''], ['Author', i.author ?? ''], ['Subject', i.subject ?? ''], ['Keywords', i.keywords ?? ''],
      ['Created', dateText(i.created)], ['Modified', dateText(i.modified)], ['Creator', i.creator ?? ''], ['Producer', i.producer ?? ''],
      ['Form fields', String(i.fields || 'None')], ['Security', i.encrypted ? 'Password protected' : 'None'],
    ];
    pairs.forEach(([, v], idx) => { const c = cells[idx]; if (!c) return; setText(c, v || 'Not set'); if (v) c.title = v; else c.removeAttribute('title'); });
    if (this.metaFor !== d.id) {
      this.metaFor = d.id;
      for (const m of ['title', 'author', 'subject', 'keywords'] as const) setValue(this.$<HTMLInputElement>(`[data-m="${m}"]`), i[m] ?? '');
      setDisabled(this.$<HTMLButtonElement>('[data-a="unlock"]'), !i.encrypted);
      setDisabled(this.$<HTMLInputElement>('[data-a="unlock-pw"]'), !i.encrypted);
    }
    this.syncFields();
    this.syncOrganize();
    this.syncAreas();
    this.syncHidden();
  }

  syncAnnots(): void {
    const all = this.ctx.annot.items;
    const items = all.filter((a) => a.kind !== 'reply');
    const asks = all.filter((a) => a.kind === 'reply');
    setDisabled(this.$<HTMLButtonElement>('[data-a="apply-annots"]'), !all.length);
    setDisabled(this.$<HTMLButtonElement>('[data-a="clear-annots"]'), !all.length);
    const d = this.ctx.doc();
    if (d && this.commentsFor !== d.id) return;
    setText(this.$('.fs-pdfwb-ncount'), String(items.length + this.existing.length));
    setHidden(this.$('.fs-pdfwb-annots-empty'), items.length > 0 || this.existing.length > 0);
    setHidden(this.$('.fs-pdfwb-inpdf-head'), !this.existing.length || !items.length);
    const sel = this.ctx.annot.selected;
    const pending: ThreadView[] = items.map((a) => ({
      key: a.id, pending: true, page: a.page, title: `Page ${a.page} · ${KIND_LABEL[a.kind]}`, sub: a.text || a.quote || (a.flatten ? 'Stamped into the page' : 'Comment'),
      color: a.color, status: a.status ?? 'none', open: a.id === sel && !a.flatten, replies: (a.replies ?? []).map((r) => ({ key: r.id, who: 'You', text: r.text, pending: true })),
    }));
    const stored: ThreadView[] = this.existing.map((c) => {
      const key = `c${c.page}-${c.index}`;
      const mine = asks.filter((a) => a.page === c.page && a.target?.index === c.index);
      const st = [...mine].reverse().find((a) => a.status)?.status;
      return {
        key, pending: false, page: c.page, title: `Page ${c.page} · ${KIND_LABEL[c.kind] ?? c.label}${c.author ? ` · ${c.author}` : ''}`, sub: c.text || 'No text',
        color: c.color || '#9CA3AF', status: st ?? c.status, open: key === this.openThread,
        replies: [...c.replies.map((r, i) => ({ key: `e${i}`, who: r.author || 'Reviewer', text: r.text, pending: false })),
          ...mine.filter((a) => a.text).map((a) => ({ key: a.id, who: 'You', text: a.text ?? '', pending: true }))],
      };
    });
    this.threads(this.$('.fs-pdfwb-annots'), pending);
    this.threads(this.$('.fs-pdfwb-inpdf'), stored);
  }

  private threads(host: HTMLElement, list: ThreadView[]): void {
    const update = (n: HTMLElement, t: ThreadView): void => {
      const rowEl = n.firstElementChild as HTMLElement;
      setClass(rowEl, 'is-selected', t.open);
      setText(rowEl.querySelector('.fs-row-title'), t.title);
      setText(rowEl.querySelector('.fs-row-sub'), t.sub);
      const dot = rowEl.querySelector('.fs-pdfwb-dot') as HTMLElement;
      if (dot.style.background !== t.color) dot.style.background = t.color;
      const badge = rowEl.querySelector('.fs-pdfwb-st') as HTMLElement;
      setText(badge, t.replies.length ? `${STATUS_LABEL[t.status] === 'None' ? '' : `${STATUS_LABEL[t.status]} · `}${t.replies.length}` : STATUS_LABEL[t.status]);
      setHidden(badge, t.status === 'none' && !t.replies.length);
      for (const s of Object.keys(STATUS_LABEL)) setClass(badge, `is-${s}`, s === t.status);
      const box = n.querySelector('.fs-pdfwb-replies') as HTMLElement;
      setHidden(box, !t.open);
      for (const b of Array.from(box.querySelectorAll<HTMLElement>('[data-a="thread-status"]'))) setClass(b, 'is-on', b.dataset.s === t.status);
      patchList(box.querySelector('.fs-pdfwb-rlist') as HTMLElement, t.replies, {
        key: (r) => r.key,
        create: (r) => {
          const node = el(`<div class="fs-pdfwb-reply${r.pending ? ' is-pending' : ''}"><span class="fs-pdfwb-rwho"></span><span class="fs-pdfwb-rbody"></span>${r.pending ? `<button class="fs-icon-btn is-sm" type="button" data-a="reply-del" data-r="${escapeHtml(r.key)}" title="Remove reply" aria-label="Remove reply">${icon('close', 12)}</button>` : ''}</div>`);
          setText(node.querySelector('.fs-pdfwb-rwho'), r.pending ? `${r.who} · not saved yet` : r.who);
          setText(node.querySelector('.fs-pdfwb-rbody'), r.text);
          return node;
        },
        update: (node, r) => setText(node.querySelector('.fs-pdfwb-rbody'), r.text),
      });
    };
    patchList(host, list, {
      key: (t) => t.key,
      create: (t) => {
        const n = el(`<div class="fs-pdfwb-thread"><div class="fs-row fs-pdfwb-arow" data-a="thread-pick"><span class="fs-row-icon"><span class="fs-pdfwb-dot"></span></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-pdfwb-st" hidden></span>${t.pending ? `<button class="fs-icon-btn is-sm" type="button" data-a="annot-del" title="Delete" aria-label="Delete comment">${icon('delete', 14)}</button>` : ''}</div><div class="fs-pdfwb-replies" hidden><div class="fs-pdfwb-rlist"></div><textarea class="fs-input fs-pdfwb-rtext" rows="2" placeholder="Write a reply" aria-label="Reply"></textarea><div class="fs-pdfwb-rbar"><div class="fs-seg is-quiet fs-pdfwb-status" role="group" aria-label="Status">${STATUS.map(([s, l]) => `<button type="button" data-a="thread-status" data-s="${s}">${l}</button>`).join('')}</div><button class="fs-btn fs-btn-sm" type="button" data-a="thread-reply">Reply</button></div></div></div>`);
        update(n, t);
        return n;
      },
      update,
    });
  }

  private async loadComments(): Promise<void> {
    const d = this.ctx.doc();
    if (!d || this.tab !== 'comment' || this.commentsFor === d.id || this.commentsLoading === d.id) return;
    const id = d.id;
    this.commentsLoading = id;
    let list: PdfComment[] = [];
    try { list = (await pdfApi.comments(id)).comments; } catch { list = []; }
    if (this.commentsLoading === id) this.commentsLoading = '';
    if (this.ctx.doc()?.id !== id) return;
    this.existing = list;
    this.commentsFor = id;
    if (this.openThread && !list.some((c) => `c${c.page}-${c.index}` === this.openThread)) this.openThread = '';
    this.syncAnnots();
  }

  private async loadMarks(): Promise<void> {
    const d = this.ctx.doc();
    if (!d || this.tab !== 'protect' || this.marksFor === d.id) return;
    const id = d.id;
    this.marksFor = id;
    let n = 0;
    try { n = (await pdfApi.comments(id)).comments.filter((c) => c.kind === 'redact').length; } catch { n = 0; }
    if (this.ctx.doc()?.id !== id) return;
    this.filedMarks = n;
    this.syncAreas();
  }

  private threadAt(t: HTMLElement): { key: string; annot?: Annot; stored?: PdfComment } | null {
    const key = (t.closest('.fs-pdfwb-thread') as HTMLElement | null)?.dataset.key;
    if (!key) return null;
    const annot = this.ctx.annot.items.find((a) => a.id === key);
    const stored = annot ? undefined : this.existing.find((c) => `c${c.page}-${c.index}` === key);
    return annot || stored ? { key, annot, stored } : null;
  }

  private threadAction(a: string, t: HTMLElement): void {
    const c = this.ctx, th = this.threadAt(t);
    if (!th) return;
    const ann = c.annot;
    if (a === 'thread-pick') {
      if (th.annot) { this.openThread = ''; ann.reveal(th.annot.id); this.syncAnnots(); return; }
      const s = th.stored as PdfComment;
      ann.select(null);
      this.openThread = this.openThread === th.key ? '' : th.key;
      c.viewer.scrollToPoint(s.page - 1, s.rect.x + s.rect.w / 2, s.rect.y);
      if (this.openThread) ann.pulse(s.page, [s.rect]);
      this.syncAnnots();
      return;
    }
    if (a === 'thread-reply') {
      const box = (t.closest('.fs-pdfwb-thread') as HTMLElement).querySelector('.fs-pdfwb-rtext') as HTMLTextAreaElement;
      const text = box.value.trim();
      if (!text) { box.focus(); return; }
      box.value = '';
      if (th.annot) ann.update(th.annot.id, { replies: [...(th.annot.replies ?? []), { id: uid('re'), text }] }, 'Reply');
      else if (th.stored) ann.add({ id: uid('re'), page: th.stored.page, kind: 'reply', color: '', target: { index: th.stored.index, nm: th.stored.nm || undefined }, text }, 'Reply');
      return;
    }
    if (a === 'thread-status') {
      const s = (t.dataset.s ?? 'none') as Status;
      if (th.annot) { if ((th.annot.status ?? 'none') !== s) ann.update(th.annot.id, { status: s }, 'Set status'); return; }
      const st = th.stored as PdfComment;
      const prev = ann.items.filter((x) => x.kind === 'reply' && x.status && x.page === st.page && x.target?.index === st.index);
      if (s === (prev[prev.length - 1]?.status ?? st.status)) return;
      const rest = ann.items.filter((x) => !prev.includes(x));
      ann.replace(s === st.status ? rest : [...rest, { id: uid('rs'), page: st.page, kind: 'reply', color: '', target: { index: st.index, nm: st.nm || undefined }, status: s }], 'Set status');
      return;
    }
    if (a === 'reply-del') {
      const r = t.dataset.r ?? '';
      if (th.annot) ann.update(th.annot.id, { replies: (th.annot.replies ?? []).filter((x) => x.id !== r) }, 'Remove reply');
      else ann.remove(r);
    }
  }

  syncFields(): void {
    const f = this.ctx.fields;
    const d = this.ctx.doc();
    const count = new Set(f.fields.map((x) => x.name)).size;
    setText(this.$('.fs-pdfwb-fieldnote'), !d ? '' : f.loadedFor !== d.id ? 'Looking for form fields…' : count ? `${count} field${count === 1 ? '' : 's'} in this PDF${f.dirty ? ` · ${f.values.size} changed` : ''}. Type straight into the page.` : 'This PDF has no form fields. Use the stamps below to fill it in.');
    setDisabled(this.$<HTMLButtonElement>('[data-a="apply-fields"]'), !f.dirty && !(count && this.$<HTMLInputElement>('[data-a="flatten-fields"]').checked));
    setDisabled(this.$<HTMLButtonElement>('[data-a="discard-fields"]'), !f.dirty);
  }

  syncOrganize(): void {
    const o = this.ctx.organizer, sel = o.selected.size;
    setText(this.$('.fs-pdfwb-orgnote'), `${o.items.length} page${o.items.length === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}${o.dirty ? ' · not applied yet' : ''}`);
    for (const a of ['org-delete', 'org-extract']) setDisabled(this.$<HTMLButtonElement>(`[data-a="${a}"]`), !sel);
  }

  syncAreas(): void {
    const areas = this.ctx.annot.areas, pages = new Set(areas.map((a) => a.page)).size;
    const filed = this.marksFor && this.marksFor === this.ctx.doc()?.id ? this.filedMarks : 0;
    const drawn = areas.length ? `${areas.length} area${areas.length === 1 ? '' : 's'} marked on ${pages} page${pages === 1 ? '' : 's'}` : '';
    const saved = filed ? `${filed} redaction mark${filed === 1 ? '' : 's'} in the file` : '';
    setText(this.$('.fs-pdfwb-redactnote'), drawn || saved ? `${[drawn, saved].filter(Boolean).join(', ')}.` : 'Mark areas to remove, then apply.');
    setDisabled(this.$<HTMLButtonElement>('[data-a="redact-apply"]'), !areas.length && !filed);
    setDisabled(this.$<HTMLButtonElement>('[data-a="redact-clear"]'), !areas.length);
    setClass(this.$('[data-a="redact-tool"]'), 'is-on', this.ctx.annot.tool === 'redact');
    setClass(this.$('[data-a="crop-tool"]'), 'is-on', this.ctx.annot.tool === 'crop');
  }

  private hfVal(a: string): string { return this.$<HTMLInputElement>(`[data-a="${a}"]`).value; }

  private redactLook(): { color: string; overlay: string; mode: 'content' | 'raster' } {
    return { color: this.hfVal('redact-color'), overlay: this.hfVal('redact-overlay').trim(), mode: this.$<HTMLInputElement>('[data-a="redact-scan"]').checked ? 'raster' : 'content' };
  }

  private hfDate(): string {
    const fmt = this.sval('hf-date'), now = new Date();
    if (fmt === 'iso') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return fmt === 'long' ? now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : now.toLocaleDateString();
  }

  private hfBody(): HeaderFooter {
    const text = (s: Slot): string => this.$<HTMLInputElement>(`[data-hf="${s}"]`).value;
    const n = (a: string, d: number): number => { const v = Number(this.hfVal(a)); return Number.isFinite(v) && this.hfVal(a).trim() !== '' ? v : d; };
    const bates = this.$<HTMLInputElement>('[data-a="hf-bates"]').checked;
    return {
      header: { left: text('header-left'), center: text('header-center'), right: text('header-right') },
      footer: { left: text('footer-left'), center: text('footer-center'), right: text('footer-right') },
      size: n('hf-size', 10), color: this.hfVal('hf-color'), font: this.sval('hf-font') as HeaderFooter['font'],
      margins: { top: n('hf-t', 36), bottom: n('hf-b', 36), left: n('hf-l', 36), right: n('hf-r', 36) },
      pages: this.hfVal('hf-pages').trim() || undefined, start: Math.round(n('hf-start', 1)), apply: this.sval('hf-apply') as HeaderFooter['apply'],
      bates: bates ? { prefix: this.hfVal('bates-prefix'), start: Math.max(0, Math.round(n('bates-start', 1))), digits: Math.max(1, Math.min(15, Math.round(n('bates-digits', 6)))) } : undefined,
      date: this.hfDate(),
    };
  }

  syncHF(): void {
    const d = this.ctx.doc(), body = this.hfBody();
    const total = d?.info.pages ?? 0;
    const range = d ? parseRange(body.pages ?? '', total) : null;
    const shown = (range ?? []).filter((p) => body.apply === 'all' || (p % 2 === 1) === (body.apply === 'odd'));
    const first = shown[0];
    const hasBates = SLOTS.some((s) => /<<\s*bates\s*>>/i.test(this.$<HTMLInputElement>(`[data-hf="${s}"]`).value));
    const fill = (raw: string): string => raw.replace(TOKEN, (_, k: string) => {
      const key = k.toLowerCase();
      if (key === 'page') return String(body.start + Math.max(0, (range ?? []).indexOf(first ?? 1)));
      if (key === 'pages') return String(body.start + Math.max(1, (range ?? []).length || total) - 1);
      if (key === 'date') return body.date ?? '';
      if (key === 'file') return d?.name ?? 'document.pdf';
      return body.bates ? `${body.bates.prefix}${String(body.bates.start).padStart(body.bates.digits, '0')}` : '';
    });
    for (const s of SLOTS) {
      const [band, side] = s.split('-') as ['header' | 'footer', 'left' | 'center' | 'right'];
      let raw = body[band][side] ?? '';
      if (s === 'footer-right' && body.bates && !hasBates) raw = raw ? `${raw}  <<bates>>` : '<<bates>>';
      setText(this.$(`[data-p="${s}"]`), fill(raw));
    }
    const prev = this.$('.fs-pdfwb-hfprev');
    if (prev.style.color !== body.color) prev.style.color = body.color;
    if (prev.dataset.font !== body.font) prev.dataset.font = body.font;
    setHidden(this.$('.fs-pdfwb-bates'), !body.bates);
    const empty = !SLOTS.some((s) => this.$<HTMLInputElement>(`[data-hf="${s}"]`).value.trim()) && !body.bates;
    setText(this.$('.fs-pdfwb-hfnote'), !d ? '' : !range ? 'Check the page range, for example 2- or 1-3, 7.' : first === undefined ? `There are no ${body.apply} pages in that range.` : `Preview of page ${first}${shown.length > 1 ? `, one of ${shown.length} pages` : ''}.`);
    setDisabled(this.$<HTMLButtonElement>('[data-a="hf-add"]'), !d || empty || first === undefined);
  }

  private cropMargins(): [number, number, number, number] {
    return SIDES.map((k) => Math.max(0, Number(this.hfVal(`crop-${k}`)) || 0)) as [number, number, number, number];
  }

  syncCrop(source: 'draw' | 'type' | 'doc' = 'doc'): void {
    const c = this.ctx, d = c.doc(), drawn = c.annot.cropBox;
    if (source === 'draw' && drawn && d) {
      const s = d.info.sizes[drawn.page - 1];
      if (s) {
        const m = rerotate([drawn.x, drawn.y, s.w - drawn.x - drawn.w, s.h - drawn.y - drawn.h], s.rotate);
        SIDES.forEach((k, i) => { this.$<HTMLInputElement>(`[data-a="crop-${k}"]`).value = String(Math.max(0, Math.round(m[i] * 10) / 10)); });
      }
    }
    const m = this.cropMargins(), any = m.some((v) => v > 0);
    let note = 'Type margins or draw a box around what to keep.';
    if (!d || !any) { if (drawn) c.annot.setCrop(null); }
    else {
      const page = source === 'type' || !drawn || drawn.page > d.info.pages ? c.viewer.currentPage() : drawn.page;
      const s = d.info.sizes[page - 1];
      const [left, top, right, bottom] = unrotate(m, s?.rotate ?? 0);
      const box: Area = { id: 'crop', page, x: left, y: top, w: (s?.w ?? 0) - left - right, h: (s?.h ?? 0) - top - bottom };
      if (box.w < 18 || box.h < 18) { if (drawn) c.annot.setCrop(null); note = 'Those margins leave almost nothing of the page.'; }
      else {
        if (source !== 'draw' && (!drawn || drawn.page !== box.page || Math.abs(drawn.x - box.x) + Math.abs(drawn.y - box.y) + Math.abs(drawn.w - box.w) + Math.abs(drawn.h - box.h) > 0.05)) c.annot.setCrop(box);
        const [vw, vh] = (s?.rotate ?? 0) % 180 ? [box.h, box.w] : [box.w, box.h];
        note = `Keeps ${Math.round(vw)} × ${Math.round(vh)} pt of page ${page}; the box shows on that page.`;
      }
    }
    setText(this.$('.fs-pdfwb-cropnote'), d ? note : '');
    setDisabled(this.$<HTMLButtonElement>('[data-a="crop-apply"]'), !d || !any);
    setDisabled(this.$<HTMLButtonElement>('[data-a="crop-clear"]'), !any && !drawn);
  }

  private findBody(): { mode: string; body: { query?: string; regex?: boolean; preset?: Preset; caseSensitive?: boolean; wholeWord?: boolean } } {
    const mode = this.sval('fr-mode');
    const preset = ['email', 'phone', 'card', 'date'].includes(mode) ? mode as Preset : undefined;
    return {
      mode,
      body: preset ? { preset } : {
        query: this.hfVal('fr-query'), regex: mode === 'regex', caseSensitive: this.$<HTMLInputElement>('[data-a="fr-case"]').checked,
        wholeWord: mode === 'text' && this.$<HTMLInputElement>('[data-a="fr-whole"]').checked,
      },
    };
  }

  private syncFindMode(): void {
    const mode = this.sval('fr-mode');
    const preset = ['email', 'phone', 'card', 'date'].includes(mode);
    setHidden(this.$('.fs-pdfwb-frq'), preset);
    setHidden(this.$('.fs-pdfwb-fropts'), preset);
    setHidden(this.$<HTMLElement>('[data-a="fr-whole"]').closest('.fs-check') as HTMLElement, mode !== 'text');
    const input = this.$<HTMLInputElement>('[data-a="fr-query"]');
    const ph = mode === 'regex' ? 'For example \\bINV-\\d{6}\\b' : 'Word or phrase';
    if (input.placeholder !== ph) input.placeholder = ph;
  }

  private syncMatches(): void {
    const list = this.matches.map((m, i) => ({ m, i }));
    const pages = new Set(this.matches.map((m) => m.page)).size;
    setHidden(this.$('.fs-pdfwb-frhead'), !this.matchesFor);
    const n = this.matches.length;
    setText(this.$('.fs-pdfwb-frcount'), !n ? 'No matches' : this.stale ? `${n} match${n === 1 ? '' : 'es'} in an earlier version · Find again` : `${n} match${n === 1 ? '' : 'es'} on ${pages} page${pages === 1 ? '' : 's'} · ${this.ticked.size} ticked`);
    setHidden(this.$<HTMLElement>('[data-a="fr-all"]'), !n);
    setDisabled(this.$<HTMLButtonElement>('[data-a="fr-all"]'), this.stale);
    setText(this.$('[data-a="fr-all"]'), this.ticked.size === n ? 'Clear ticks' : 'Select all');
    setHidden(this.$('.fs-pdfwb-frbtns'), !n);
    setDisabled(this.$<HTMLButtonElement>('[data-a="fr-mark"]'), !this.ticked.size || this.stale);
    setDisabled(this.$<HTMLButtonElement>('[data-a="fr-redact"]'), this.stale);
    const update = (n: HTMLElement, x: { m: Match; i: number }): void => {
      const box = n.querySelector('input') as HTMLInputElement;
      setDisabled(box, this.stale);
      if (box.checked !== this.ticked.has(x.i)) box.checked = this.ticked.has(x.i);
      for (const node of [box, n.querySelector('.fs-pdfwb-matchbody') as HTMLElement]) if (node.dataset.i !== String(x.i)) node.dataset.i = String(x.i);
    };
    patchList(this.$('.fs-pdfwb-matches'), list, {
      key: (x) => `${x.m.page}:${x.m.rects[0]?.x ?? 0}:${x.m.rects[0]?.y ?? 0}:${x.m.text}`,
      create: (x) => {
        const n = el(`<div class="fs-pdfwb-match"><input type="checkbox" data-a="fr-tick" data-i="${x.i}" aria-label="Redact this match"><button class="fs-pdfwb-matchbody" type="button" data-a="fr-go" data-i="${x.i}"><span class="fs-pdfwb-matchpage">p. ${x.m.page}</span><span class="fs-pdfwb-ctx"><span></span><mark></mark><span></span></span></button></div>`);
        const parts = n.querySelectorAll('.fs-pdfwb-ctx > *');
        setText(parts[0], x.m.before);
        setText(parts[1], x.m.text);
        setText(parts[2], x.m.after);
        update(n, x);
        return n;
      },
      update,
    });
  }

  private matchAreas(which: Match[]): Area[] {
    return which.flatMap((m) => m.rects.map((r) => ({ id: uid('r'), page: m.page, x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 })));
  }

  private syncSig(): void {
    const ready = this.sigMode === 'draw' ? !this.pad.empty : this.val('sig-text').trim().length > 0;
    setDisabled(this.$<HTMLButtonElement>('[data-a="sig-place"]'), !ready);
  }

  private pagesSpec(): string { return this.val('ex-pages').trim(); }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement;
    const a = t.dataset.a;
    if (a === 'flatten-comments') this.ctx.annot.flattenComments = t.checked;
    else if (a === 'flatten-fields') this.syncFields();
    else if (a === 'sig-text') void this.preview();
    else if (a === 'cq') setText(this.$('.fs-pdfwb-cqv'), t.value);
    else if (a === 'wm-op') setText(this.$('.fs-pdfwb-wmv'), `${t.value}%`);
    else if (t.dataset.hf || a?.startsWith('hf-') || a?.startsWith('bates-')) this.syncHF();
    else if (a && /^crop-[ltrb]$/.test(a)) this.syncCrop('type');
    else if (a === 'fr-mode') this.syncFindMode();
    else if (a === 'stamp-name') {
      remember(STAMP_NAME, t.value.trim());
      for (const n of Array.from(this.root.querySelectorAll<HTMLInputElement>('[data-a="stamp-name"]'))) if (n !== t) n.value = t.value;
    } else if (a === 'hid-tick') {
      const k = t.dataset.k ?? '';
      if (t.checked) this.hidTicked.add(k); else this.hidTicked.delete(k);
      this.syncHidden();
    } else if ((a === 'say-voice' || a === 'say-rate') && e.type === 'change') this.ctx.act(a, t.value);
    else if (a === 'cover' && e.type === 'change') this.ctx.act('cover', t.checked ? '1' : '');
    else if (a === 'fr-tick') {
      const i = Number(t.dataset.i);
      if (t.checked) this.ticked.add(i); else this.ticked.delete(i);
      this.syncMatches();
    }
  }

  private async preview(): Promise<void> {
    const host = this.$('.fs-pdfwb-sigpreview');
    const text = this.val('sig-text');
    host.style.color = this.sigColor;
    setText(host, text);
    this.syncSig();
  }

  private async signatureImage(): Promise<{ url: string; aspect: number } | null> {
    if (this.sigMode === 'draw') { this.pad.color = this.sigColor; return this.pad.image(); }
    return typedSignature(this.val('sig-text'), this.sigColor);
  }

  async placeSignature(at?: { page: number; x: number; y: number; w: number; h: number }): Promise<boolean> {
    const img = await this.signatureImage();
    if (!img) { toast('Draw or type your signature first in the Signature panel.'); return false; }
    if (at) {
      const pv = this.ctx.viewer.pages[at.page - 1];
      const rot = pv ? this.ctx.viewer.total(pv) : 0;
      const [bw, bh] = rot % 180 ? [at.h, at.w] : [at.w, at.h];
      let w = bw, h = bw / img.aspect;
      if (h > bh) { h = bh; w = bh * img.aspect; }
      const [rw, rh] = rot % 180 ? [h, w] : [w, h];
      this.ctx.annot.add({ id: `a${Date.now().toString(36)}`, page: at.page, kind: 'image', color: '#111111', opacity: 1, rot, x: at.x + (at.w - rw) / 2, y: at.y + (at.h - rh) / 2, w: rw, h: rh, image: img.url, flatten: true }, 'Sign field');
      return true;
    }
    this.ctx.annot.placement = { kind: 'image', image: img.url, aspect: img.aspect, width: 150, label: 'signature' };
    this.ctx.tool('place');
    return true;
  }

  private stamp(text: string, label: string, size = 12): void {
    this.ctx.annot.placement = { kind: 'freetext', text, size, label };
    this.ctx.tool('place');
  }

  private click(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t || (t as HTMLButtonElement).disabled) return;
    const a = t.dataset.a as string;
    const c = this.ctx;
    const d = c.doc();
    switch (a) {
      case 'annot-del': { const id = (t.closest('.fs-pdfwb-thread') as HTMLElement | null)?.dataset.key; if (id) c.annot.remove(id); return; }
      case 'thread-pick': case 'thread-reply': case 'thread-status': case 'reply-del': this.threadAction(a, t); return;
      case 'hf-token': {
        const input = this.$<HTMLInputElement>(`[data-hf="${this.hfFocus}"]`), tok = t.dataset.t ?? '';
        const s0 = input.selectionStart ?? input.value.length, s1 = input.selectionEnd ?? s0;
        input.setRangeText(tok, s0, s1, 'end');
        input.focus();
        if (tok === '<<bates>>' && !this.$<HTMLInputElement>('[data-a="hf-bates"]').checked) this.$<HTMLInputElement>('[data-a="hf-bates"]').checked = true;
        this.syncHF();
        return;
      }
      case 'crop-tool': c.tool(c.annot.tool === 'crop' ? 'select' : 'crop'); return;
      case 'crop-clear': for (const k of SIDES) this.$<HTMLInputElement>(`[data-a="crop-${k}"]`).value = '0'; c.annot.setCrop(null); if (c.annot.tool === 'crop') c.tool('select'); this.syncCrop('type'); return;
      case 'crop-current': setValue(this.$<HTMLInputElement>('[data-a="crop-pages"]'), String(c.viewer.currentPage())); return;
      case 'crop-every': setValue(this.$<HTMLInputElement>('[data-a="crop-pages"]'), ''); return;
      case 'fr-all': this.ticked = this.ticked.size === this.matches.length ? new Set() : new Set(this.matches.map((_, i) => i)); this.syncMatches(); return;
      case 'fr-go': {
        const m = this.matches[Number(t.dataset.i)], r = m?.rects[0];
        if (!m || !r) return;
        c.viewer.scrollToPoint(m.page - 1, r.x + r.w / 2, r.y);
        c.annot.pulse(m.page, m.rects);
        return;
      }
      case 'fr-mark': {
        const picked = this.matches.filter((_, i) => this.ticked.has(i));
        if (!picked.length) return;
        c.annot.setAreas([...c.annot.areas, ...this.matchAreas(picked)]);
        this.ticked.clear();
        this.syncMatches();
        toast(`${picked.length} match${picked.length === 1 ? '' : 'es'} marked. Apply redactions to remove them.`);
        return;
      }
      case 'apply-annots': void c.run('Applying comments', () => c.flush()); return;
      case 'clear-annots': c.annot.clear(); return;
      case 'sig-draw': case 'sig-type': {
        this.sigMode = a === 'sig-draw' ? 'draw' : 'type';
        for (const b of Array.from(this.$('.fs-pdfwb-sigmode').children)) setClass(b, 'is-on', (b as HTMLElement).dataset.a === a);
        setHidden(this.$('.fs-pdfwb-sigdraw'), this.sigMode !== 'draw');
        setHidden(this.$('.fs-pdfwb-sigtype'), this.sigMode !== 'type');
        if (this.sigMode === 'draw') requestAnimationFrame(() => this.pad.paint());
        this.syncSig();
        return;
      }
      case 'sig-color': {
        this.sigColor = t.dataset.c ?? '#1E2A78';
        for (const s of Array.from(this.root.querySelectorAll('[data-a="sig-color"]'))) setClass(s, 'is-chosen', s === t);
        this.pad.color = this.sigColor;
        this.pad.paint();
        void this.preview();
        return;
      }
      case 'sig-clear': if (this.sigMode === 'draw') this.pad.clear(); else { setValue(this.$<HTMLInputElement>('[data-a="sig-text"]'), ''); void this.preview(); } return;
      case 'sig-place': void this.placeSignature(); return;
      case 'stamp-date': this.stamp(new Date().toLocaleDateString(), 'date'); return;
      case 'stamp-text': c.tool('freetext'); return;
      case 'stamp': this.placeStamp(t.dataset.stamp ?? ''); return;
      case 'stamp-image': this.pickStampImage(); return;
      case 'layout': c.act('layout', t.dataset.v); return;
      case 'reading': case 'rf-smaller': case 'rf-larger': case 'say-page': case 'say-end': case 'say-pause': case 'say-stop': c.act(a); return;
    }
    if (!d) return;
    switch (a) {
      case 'apply-fields': void c.run('Filling the form', async () => {
        const flat = this.$<HTMLInputElement>('[data-a="flatten-fields"]').checked;
        const res = await pdfApi.fill(d.id, c.fields.pending(), flat);
        c.fields.discard();
        await c.commit(res, flat ? 'Fill and flatten form' : 'Fill form');
      }); return;
      case 'discard-fields': c.fields.discard(); return;
      case 'org-left': c.organizer.rotate(-90); return;
      case 'org-right': c.organizer.rotate(90); return;
      case 'org-delete': c.organizer.remove(); return;
      case 'org-blank': c.organizer.blank(); return;
      case 'org-all': c.organizer.selectAll(); return;
      case 'org-insert': void c.pickPdfs(true).then((files) => (files.length ? c.insertPdfs(files, c.organizer.insertAt()) : undefined)); return;
      case 'org-extract': void c.run('Extracting pages', async () => {
        const sel = c.organizer.selection();
        if (!sel.length) return;
        const res = await pdfApi.organize(d.id, c.organizer.payload(sel));
        await c.deliver(pdfApi.fileUrl(res.id, true), `${stem(d.name)} (extract).pdf`);
      }); return;
      case 'split': void c.run('Splitting', async () => {
        const ranges = this.val('split-ranges').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        if (!ranges.length) { toast('Type page ranges such as 1-3, 4-6'); return; }
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.split(id, ranges);
        for (const p of res.parts) await c.deliver(pdfApi.fileUrl(p.id, true), p.name);
        toast(`Split into ${res.parts.length} file${res.parts.length === 1 ? '' : 's'}`);
      }); return;
      case 'merge': void c.pickPdfs(true).then((files) => {
        if (!files.length) return;
        return c.run('Merging', async () => {
          const id = await c.flush() ?? d.id;
          const others: string[] = [];
          for (const f of files) others.push((await pdfApi.open(f, f.name)).id);
          await c.commit(await pdfApi.merge([id, ...others]), `Merge ${files.length} PDF${files.length === 1 ? '' : 's'}`);
        });
      }); return;
      case 'ex-current': setValue(this.$<HTMLInputElement>('[data-a="ex-pages"]'), String(c.viewer.currentPage())); return;
      case 'ex-all': setValue(this.$<HTMLInputElement>('[data-a="ex-pages"]'), ''); return;
      case 'ex-text': void c.run('Extracting text', async () => {
        const res = await pdfApi.text(d.id, this.pagesSpec());
        const ta = this.$<HTMLTextAreaElement>('.fs-pdfwb-text');
        ta.value = res.pages.map((p) => p.text).join('\n\n');
        ta.dataset.md = res.pages.map((p) => `## Page ${p.page}\n\n${p.text}`).join('\n\n');
        setHidden(ta, false);
        setHidden(this.$('.fs-pdfwb-textbtns'), false);
        if (!ta.value.trim()) toast('These pages have no selectable text. Convert > Make searchable (OCR) recognises scanned pages.');
      }); return;
      case 'text-copy': void navigator.clipboard.writeText(this.$<HTMLTextAreaElement>('.fs-pdfwb-text').value).then(() => toast('Text copied')); return;
      case 'text-txt': void c.deliver(new Blob([this.$<HTMLTextAreaElement>('.fs-pdfwb-text').value], { type: 'text/plain' }), `${stem(d.name)}.txt`); return;
      case 'text-md': void c.deliver(new Blob([`# ${stem(d.name)}\n\n${this.$<HTMLTextAreaElement>('.fs-pdfwb-text').dataset.md ?? ''}\n`], { type: 'text/markdown' }), `${stem(d.name)}.md`); return;
      case 'ex-images': void c.run('Extracting images', async () => {
        this.images = (await pdfApi.images(d.id, this.pagesSpec())).images;
        this.picked = new Set(this.images.map((i) => i.id));
        this.syncImages();
        if (!this.images.length) toast('No pictures found on these pages');
      }); return;
      case 'img-pick': { const id = t.dataset.id as string; if (this.picked.has(id)) this.picked.delete(id); else this.picked.add(id); this.syncImages(); return; }
      case 'img-all': this.picked = this.picked.size === this.images.length ? new Set() : new Set(this.images.map((i) => i.id)); this.syncImages(); return;
      case 'img-download': void c.run('Saving images', async () => { for (const img of this.images.filter((i) => this.picked.has(i.id))) await c.deliver(img.url, img.name); }); return;
      case 'ex-tables': void c.run('Finding tables', async () => {
        this.tables = (await pdfApi.tables(d.id, this.pagesSpec())).tables;
        this.syncTables();
        if (!this.tables.length) toast('No tables found on these pages');
      }); return;
      case 'tables-xlsx': void c.run('Saving spreadsheet', () => c.deliver(pdfApi.xlsxUrl(d.id, this.pagesSpec()), `${stem(d.name)} tables.xlsx`)); return;
      case 'table-copy': { const tb = this.tables[Number(t.dataset.i)]; if (tb) void navigator.clipboard.writeText(toCsv(tb)).then(() => toast('Table copied as CSV')); return; }
      case 'table-csv': { const tb = this.tables[Number(t.dataset.i)]; if (tb) void c.deliver(new Blob([toCsv(tb)], { type: 'text/csv' }), `${stem(d.name)} table ${Number(t.dataset.i) + 1}.csv`); return; }
      case 'protect': {
        const pw = this.val('pw1'), pw2 = this.val('pw2'), owner = this.val('pw-owner');
        if (!pw && !owner) { toast('Type a password'); return; }
        if (pw !== pw2) { toast('The passwords do not match', 'error'); return; }
        const permissions: Record<string, boolean> = {};
        for (const box of Array.from(this.root.querySelectorAll<HTMLInputElement>('[data-perm]'))) permissions[box.dataset.perm as string] = box.checked;
        void c.run('Protecting', async () => {
          const id = await c.flush() ?? d.id;
          const res = await pdfApi.protect(id, { password: pw, owner: owner || undefined, permissions });
          if (pw) c.remember(res.id, pw);
          for (const k of ['pw1', 'pw2', 'pw-owner']) this.$<HTMLInputElement>(`[data-a="${k}"]`).value = '';
          await c.commit(res, 'Protect with password');
          toast('Protected with AES-256. Save to keep the protected copy.');
        });
        return;
      }
      case 'unlock': void c.run('Removing protection', async () => {
        const res = await pdfApi.unlock(d.id, this.val('unlock-pw'));
        this.$<HTMLInputElement>('[data-a="unlock-pw"]').value = '';
        await c.commit(res, 'Remove password');
      }); return;
      case 'redact-tool': c.tool(c.annot.tool === 'redact' ? 'select' : 'redact'); this.syncAreas(); return;
      case 'redact-clear': c.annot.setAreas([]); return;
      case 'redact-apply': void c.run('Redacting', async () => {
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.redact(id, c.annot.areas, this.redactLook());
        c.annot.setAreas([]);
        c.tool('select');
        await c.commit(res, 'Redact');
      }); return;
      case 'meta-save': case 'meta-strip': void c.run('Updating metadata', async () => {
        const id = await c.flush() ?? d.id;
        const body = a === 'meta-strip' ? { strip: true } : { title: this.mval('title'), author: this.mval('author'), subject: this.mval('subject'), keywords: this.mval('keywords') };
        const res = await pdfApi.metadata(id, body);
        this.metaFor = '';
        await c.commit(res, a === 'meta-strip' ? 'Remove metadata' : 'Edit metadata');
      }); return;
      case 'pptx': void c.run('Exporting to PowerPoint', async () => {
        const id = await c.flush() ?? d.id;
        await c.deliver(pdfApi.pptxUrl(id, this.val('pptx-pages'), this.$<HTMLInputElement>('[data-a="pptx-text"]').checked), `${stem(d.name)}.pptx`);
      }); return;
      case 'compress': void c.run('Compressing', async () => {
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.compress(id, Number(this.val('cq')));
        await c.commit(res, 'Compress');
        const saved = (res.before ?? 0) - (res.after ?? 0);
        setText(this.$('.fs-pdfwb-cnote'), saved > 0 ? `${fmtBytes(res.before ?? 0)} to ${fmtBytes(res.after ?? 0)}, ${Math.round((saved / Math.max(1, res.before ?? 1)) * 100)}% smaller.` : `Already compact at ${fmtBytes(res.after ?? 0)}.`);
      }); return;
      case 'hf-add': void c.run('Adding the header and footer', async () => {
        const body = this.hfBody();
        const id = await c.flush() ?? d.id;
        await c.commit(await pdfApi.headerFooter(id, body), body.bates ? 'Add header, footer and Bates numbers' : 'Add header and footer');
      }); return;
      case 'crop-apply': case 'crop-auto': void c.run(a === 'crop-auto' ? 'Removing white margins' : 'Cropping', async () => {
        const [l, tp, r, b] = this.cropMargins();
        const pages = this.hfVal('crop-pages').trim() || undefined;
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.crop(id, a === 'crop-auto' ? { auto: true, pages } : { margins: { l, t: tp, r, b }, pages });
        for (const k of SIDES) this.$<HTMLInputElement>(`[data-a="crop-${k}"]`).value = '0';
        c.annot.setCrop(null);
        if (c.annot.tool === 'crop') c.tool('select');
        await c.commit(res, a === 'crop-auto' ? 'Remove white margins' : 'Crop pages');
        toast(`${res.cropped} page${res.cropped === 1 ? '' : 's'} cropped. The hidden content is still in the file.`);
      }); return;
      case 'fr-find': {
        const { mode, body } = this.findBody();
        if (!body.preset && !(body.query ?? '').trim()) { this.$<HTMLInputElement>('[data-a="fr-query"]').focus(); return; }
        void c.run('Finding', async () => {
          const res = await pdfApi.find(d.id, body);
          this.matches = res.matches;
          this.ticked = new Set(res.matches.map((_, i) => i));
          this.matchesFor = d.id;
          this.matchesKey = d.key;
          this.stale = false;
          this.syncMatches();
          if (!res.count) toast(mode === 'text' || mode === 'regex' ? 'No matches. Scanned pages have no text to search until Convert > Make searchable (OCR) recognises them.' : 'Nothing like that found in the text of this PDF.');
          else if (res.truncated) toast(`Showing the first ${res.count} matches`);
        });
        return;
      }
      case 'fr-redact': void c.run('Redacting matches', async () => {
        const areas = [...c.annot.areas, ...this.matchAreas(this.matches)];
        if (!areas.length) return;
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.redact(id, areas, this.redactLook());
        const n = this.matches.length;
        c.annot.setAreas([]);
        c.tool('select');
        await c.commit(res, `Redact ${n} match${n === 1 ? '' : 'es'}`);
        toast(`Redacted ${n} match${n === 1 ? '' : 'es'}. Undo steps back to the unredacted copy until you save.`);
      }); return;
      case 'numbers': void c.run('Numbering pages', async () => {
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.pageNumbers(id, { position: this.sval('pn-pos'), format: this.sval('pn-fmt'), start: Number(this.val('pn-start')) || 1 });
        await c.commit(res, 'Add page numbers');
      }); return;
      case 'watermark': void c.run('Adding the watermark', async () => {
        const text = this.val('wm-text').trim();
        if (!text) { toast('Type the watermark text'); return; }
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.watermark(id, { text, opacity: Number(this.val('wm-op')) / 100, angle: Number(this.val('wm-angle')) || 0, size: Number(this.val('wm-size')) || 64, color: this.val('wm-color') });
        await c.commit(res, 'Add watermark');
      }); return;
      case 'png-zip': void c.run('Rendering pages', async () => {
        const id = await c.flush() ?? d.id;
        await c.deliver(pdfApi.zipUrl(id, Number(this.sval('png-scale')) || 2, this.val('png-pages')), `${stem(d.name)} pages.zip`);
      }); return;
      case 'docx': void c.run('Converting to Word', async () => {
        const id = await c.flush() ?? d.id;
        await c.deliver(pdfApi.docxUrl(id, this.val('docx-pages')), `${stem(d.name)}.docx`);
      }); return;
      case 'hid-scan': void c.run('Looking for hidden information', async () => {
        const id = await c.flush() ?? d.id;
        const res = await pdfApi.hidden(id);
        this.hidden = res.items;
        this.hiddenFor = id;
        this.hidTicked = new Set(res.items.filter((it) => it.count > 0 && it.key !== 'hidden_text').map((it) => it.key));
        this.syncHidden();
      }); return;
      case 'hid-remove': {
        const keys = [...this.hidTicked].filter((k) => this.hidden.some((it) => it.key === k && it.count));
        if (!keys.length) return;
        void c.run('Removing hidden information', async () => {
          const id = await c.flush() ?? d.id;
          const res = await pdfApi.sanitize(id, keys);
          await c.commit(res, 'Remove hidden information');
          const next = await pdfApi.hidden(res.id);
          this.hidden = next.items;
          this.hiddenFor = res.id;
          this.hidTicked.clear();
          this.metaFor = '';
          this.syncHidden();
          this.syncDoc();
          toast(`Removed ${keys.length} kind${keys.length === 1 ? '' : 's'} of hidden information${res.flattened ? `; ${res.flattened} form field${res.flattened === 1 ? ' was' : 's were'} flattened` : ''}.`);
        });
        return;
      }
    }
  }

  private mval(m: string): string { return this.$<HTMLInputElement>(`[data-m="${m}"]`).value; }
  private sval(a: string): string { return this.$<HTMLSelectElement>(`select[data-a="${a}"]`).value; }

  private syncImages(): void {
    const grid = this.$('.fs-pdfwb-images');
    const update = (n: HTMLElement, img: ImageItem): void => { setClass(n, 'is-selected', this.picked.has(img.id)); };
    patchList(grid, this.images, {
      key: (i) => i.id,
      create: (i) => { const n = el(`<button class="fs-asset" type="button" data-a="img-pick" data-id="${escapeHtml(i.id)}" title="Page ${i.page} · ${i.w} × ${i.h}"><img alt="" loading="lazy" decoding="async" src="${escapeHtml(i.url)}"></button>`); update(n, i); return n; },
      update,
    });
    setHidden(this.$('.fs-pdfwb-imgbtns'), !this.images.length);
    setDisabled(this.$<HTMLButtonElement>('[data-a="img-download"]'), !this.picked.size);
  }

  private syncTables(): void {
    const host = this.$('.fs-pdfwb-tables');
    patchList(host, this.tables.map((t, i) => ({ t, i })), {
      key: (x) => `${x.i}|${x.t.page}|${x.t.header.join('|')}`,
      create: (x) => {
        const rows = [x.t.header, ...x.t.rows.slice(0, 8)];
        const table = `<div class="fs-pdfwb-tablewrap"><table class="fs-pdfwb-table">${rows.map((r, k) => `<tr>${r.map((cell) => (k ? `<td>${escapeHtml(cell)}</td>` : `<th>${escapeHtml(cell)}</th>`)).join('')}</tr>`).join('')}</table></div>`;
        return el(`<div class="fs-pdfwb-tableitem"><div class="fs-pdfwb-tablehead"><span>Table ${x.i + 1} · page ${x.t.page} · ${x.t.rows.length} rows</span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="table-copy" data-i="${x.i}">Copy</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="table-csv" data-i="${x.i}">CSV</button></div>${table}</div>`);
      },
      update: () => undefined,
    });
    setHidden(this.$('[data-a="tables-xlsx"]'), !this.tables.length);
  }
}
