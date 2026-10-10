import { brandMark } from '../ui/brand';
import { comboOf, Commands } from '../ui/commands';
import { anyDialogOpen } from '../ui/dialogs';
import { delayedIndicator, el, escapeHtml, patchList, q, setClass, setDisabled, setHidden, setText, setValue } from '../ui/dom';
import { icon } from '../ui/icons';
import { MenuBar, PopupMenu, type MenuDef } from '../ui/menu';
import { toast } from '../ui/toast';
import { Annotator, DRAW_TOOLS, MARKUP_TOOLS, type Tool } from './annotate';
import { deliver, isTauri, pdfApi, type Annot, type Derived, type NewFieldType, type Opened, type PdfInfo, type RecentItem } from './api';
import { Comparer, ComparePanel } from './compare';
import { askCreate } from './create';
import { askScan } from './scan';
import { Fields } from './fill';
import { Finder } from './find';
import { FIELD_ICON, FIELD_LABEL, FIELD_TYPES, FormBuilder, FormPanel } from './form';
import type { CreateKind } from './intent';
import { Organizer, type OrgItem } from './organize';
import { LAYOUTS, Panes, type Ctx, type Doc, type Tab } from './panels';
import { recall, REFLOW_SIZES, Reflow, remember, Speaker } from './reading';
import { mountTools, pageTools, renderedTools, syncTools, TAB_WORDS, type ToolHost } from './tools';
import { Thumbs, Viewer, type Layout } from './viewer';

export interface AppHooks { home(): void; shown(): void; help(): void; shortcuts(cmds: Commands): void; preferences(): void; agents(): void; doc(state: DocState | null): void; palette(): void }
export interface WorkbenchOptions { file?: File; path?: string; recent?: string; create?: CreateKind; files?: File[]; scan?: boolean; app: AppHooks; restore?: { page: number; tab: string; dirty: boolean } }
export interface DocState { id: string; key: string; name: string; pages: number; page: number; dirty: boolean; tab: string; path: string | null; agentTurn: string | null }
export interface AgentReply { ok: boolean; text: string; data?: Record<string, unknown> }

const svg = (body: string, size = 16): string => `<span class="icon" style="width:${size}px;height:${size}px" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg></span>`;
const LOCAL = {
  print: '<path d="M7 8.5v-5h10v5"/><rect x="3.5" y="8.5" width="17" height="8" rx="1.5"/><path d="M7 13.5h10v7H7z"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  fitWidth: '<path d="M3.5 4.5v15M20.5 4.5v15M7 12h10M9.5 9.5L7 12l2.5 2.5M14.5 9.5L17 12l-2.5 2.5"/>',
  underline: '<path d="M7 4.5v6a5 5 0 0 0 10 0v-6M5.5 20h13"/>',
};
const TABS: Array<[Tab, string]> = [['view', 'View'], ['comment', 'Comment'], ['fill', 'Fill & Sign'], ['form', 'Prepare form'], ['edit', 'Edit'], ['organize', 'Organize'], ['extract', 'Extract'], ['protect', 'Protect'], ['convert', 'Convert'], ['access', 'Accessibility']];
const LAYOUT_KEY = 'fs-pdf-layout';
const SAY_KEY = 'fs-pdf-say';
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const layoutBtns = LAYOUTS.map(([v, l, ic]) => `<button class="fs-tb-btn" type="button" data-a="layout" data-v="${v}" title="${l}" aria-label="${l}">${icon(ic, 16)}</button>`).join('');
const PALETTE = ['#FFD400', '#22C55E', '#38BDF8', '#F472B6', '#E11D48', '#2563EB', '#111111'];
const TOOL_COLOR: Record<string, string> = { highlight: '#FFD400', underline: '#2563EB', strikeout: '#E11D48', note: '#FFD400', freetext: '#111111', ink: '#E11D48', rect: '#E11D48', ellipse: '#E11D48', line: '#111111', arrow: '#E11D48' };
const HINTS: Partial<Record<Tool, string>> = {
  select: 'Select text, or click a comment to move it. Double-click a text box to edit.', hand: 'Drag to move around the page.',
  highlight: 'Select text to highlight it.', underline: 'Select text to underline it.', strikeout: 'Select text to strike it through.',
  note: 'Click where the note goes.', freetext: 'Click or drag to add a text box.', ink: 'Drag to draw.', rect: 'Drag to draw a rectangle.',
  ellipse: 'Drag to draw an ellipse.', line: 'Drag to draw a line.', arrow: 'Drag to draw an arrow.', redact: 'Drag over everything that must disappear.',
  crop: 'Drag a box around what to keep. Esc ends.',
};
const toolBtn = (t: Tool, label: string, ic: string): string => `<button class="fs-tb-btn" type="button" data-tool="${t}" title="${label}" aria-label="${label}">${ic}</button>`;

interface State { id: string; annots: Annot[]; label: string; turn?: string; agent?: string }
interface BarAction { label: string; kind?: 'primary' | 'ghost' | 'danger'; run: (value: string) => void }

const SHELL = `<div class="fs-pdfwb" tabindex="-1" role="region" aria-label="PDF workbench" data-tab="view" data-tool="select" hidden>
<header class="fs-pdfwb-title">
<div class="fs-brand" role="button" tabindex="0" title="Home" data-a="home">${brandMark(20)}<span class="fs-brand-name">formpdf</span></div>
<nav class="fs-menubar fs-pdfwb-menubar" aria-label="Main menu"></nav>
<div class="fs-pdfwb-doc"><span class="fs-pdfwb-name">PDF workbench</span><span class="fs-badge fs-pdfwb-edited is-off">Edited</span></div>
<div class="fs-pdfwb-actions">
<button class="fs-icon-btn" type="button" data-a="undo" title="Undo" aria-label="Undo">${icon('undo', 16)}</button>
<button class="fs-icon-btn" type="button" data-a="redo" title="Redo" aria-label="Redo">${icon('redo', 16)}</button>
<span class="fs-sep"></span>
<button class="fs-tt-btn fs-pdfwb-openbtn" type="button" data-a="open-menu" title="Open or create a PDF" aria-label="Open or create a PDF" aria-haspopup="menu">${icon('folderOpen', 16)}${icon('chevronDown', 10)}</button>
<button class="fs-tt-btn" type="button" data-a="print" title="Print" aria-label="Print">${svg(LOCAL.print)}</button>
<button class="fs-tt-btn fs-agent-btn" type="button" data-a="agents" title="Agents" aria-label="Agents">${icon('agent', 16)}</button>
<button class="fs-share-btn" type="button" data-a="save">${icon('save', 14)}<span>Save</span></button>
<button class="fs-icon-btn fs-pdfwb-close" type="button" data-a="close" title="Close" aria-label="Close">${icon('close', 16)}</button>
</div>
</header>
<div class="fs-pdfwb-tools">
<div class="fs-pdfwb-tabs" role="tablist">${TABS.map(([t, l]) => `<button class="fs-pdfwb-tab" type="button" role="tab" data-tab="${t}">${l}</button>`).join('')}</div>
<span class="fs-sep"></span>
<div class="fs-tb fs-pdfwb-set" data-for="view">${toolBtn('select', 'Select', icon('cursor', 16))}${toolBtn('hand', 'Hand', icon('hand', 16))}<span class="fs-sep"></span><button class="fs-tb-btn" type="button" data-a="find" title="Find" aria-label="Find">${icon('search', 16)}</button><span class="fs-sep"></span>${layoutBtns}<button class="fs-tb-btn" type="button" data-a="cover-toggle" title="Show cover page in two-page view" aria-label="Show cover page in two-page view">${icon('bookCover', 16)}</button><span class="fs-sep"></span><button class="fs-tb-btn has-label" type="button" data-a="reading" title="Reading mode" aria-pressed="false">${icon('readMode', 16)}<span>Reading</span></button><button class="fs-tb-btn" type="button" data-a="rf-smaller" title="Smaller text" aria-label="Smaller text">${icon('textSmaller', 16)}</button><button class="fs-tb-btn" type="button" data-a="rf-larger" title="Larger text" aria-label="Larger text">${icon('textLarger', 16)}</button><span class="fs-sep"></span><button class="fs-tb-btn" type="button" data-a="say-page" title="Read this page aloud" aria-label="Read this page aloud">${icon('speaker', 16)}</button><button class="fs-tb-btn" type="button" data-a="say-end" title="Read from here to the end" aria-label="Read from here to the end">${icon('readAloud', 16)}</button><button class="fs-tb-btn" type="button" data-a="say-pause" title="Pause reading" aria-label="Pause reading">${icon('pause', 16)}</button><button class="fs-tb-btn" type="button" data-a="say-stop" title="Stop reading" aria-label="Stop reading">${icon('stop', 16)}</button><span class="fs-sep"></span><button class="fs-tb-btn has-label" type="button" data-a="compare" title="Compare with another PDF">${icon('compare', 16)}<span>Compare</span></button></div>
<div class="fs-tb fs-pdfwb-set" data-for="comment" hidden>${toolBtn('select', 'Select', icon('cursor', 16))}<span class="fs-sep"></span>${toolBtn('highlight', 'Highlight text', icon('highlighter', 16))}${toolBtn('underline', 'Underline text', svg(LOCAL.underline))}${toolBtn('strikeout', 'Strike through text', icon('strike', 16))}<span class="fs-sep"></span>${toolBtn('note', 'Sticky note', icon('sticky', 16))}${toolBtn('freetext', 'Text box', icon('textBox', 16))}${toolBtn('ink', 'Draw', icon('pen', 16))}${toolBtn('rect', 'Rectangle', svg(LOCAL.rect))}${toolBtn('ellipse', 'Ellipse', svg(LOCAL.ellipse))}${toolBtn('line', 'Line', icon('line', 16))}${toolBtn('arrow', 'Arrow', icon('arrow', 16))}<button class="fs-tb-btn" type="button" data-a="stamps" title="Stamps" aria-label="Stamps">${icon('stamp', 16)}</button><span class="fs-sep"></span><div class="fs-tb-group fs-pdfwb-palette">${PALETTE.map((c) => `<button class="fs-swatch" type="button" data-color="${c}" title="${c}" style="background:${c}"></button>`).join('')}<label class="fs-swatch fs-pdfwb-custom" title="Custom colour"><input type="color" data-a="custom-color" value="#E11D48"></label></div><span class="fs-sep"></span><select class="fs-pdfwb-width" aria-label="Line width" title="Line width"><option value="1">1 pt</option><option value="2" selected>2 pt</option><option value="3">3 pt</option><option value="5">5 pt</option><option value="8">8 pt</option></select><select class="fs-pdfwb-size" aria-label="Text size" title="Text size"><option value="9">9 pt</option><option value="10">10 pt</option><option value="12" selected>12 pt</option><option value="14">14 pt</option><option value="18">18 pt</option><option value="24">24 pt</option><option value="36">36 pt</option></select></div>
<div class="fs-tb fs-pdfwb-set" data-for="fill" hidden>${toolBtn('select', 'Fill fields', icon('cursor', 16))}${toolBtn('freetext', 'Add text', icon('textBox', 16))}<button class="fs-tb-btn has-label" type="button" data-a="sign" title="Place your signature">${icon('signature', 16)}<span>Sign</span></button><button class="fs-tb-btn has-label" type="button" data-a="date" title="Place today's date">${icon('stamp', 16)}<span>Date</span></button></div>
<div class="fs-tb fs-pdfwb-set" data-for="form" hidden><button class="fs-tb-btn" type="button" data-ftool="select" title="Select fields" aria-label="Select fields">${icon('cursor', 16)}</button><span class="fs-sep"></span>${FIELD_TYPES.map((t) => `<button class="fs-tb-btn" type="button" data-ftool="${t}" title="${FIELD_LABEL[t]}" aria-label="${FIELD_LABEL[t]}">${icon(FIELD_ICON[t], 16)}</button>`).join('')}<span class="fs-sep"></span><span class="fs-pdfwb-settext">Draw form fields, then apply them to the PDF.</span></div>
<div class="fs-tb fs-pdfwb-set" data-for="edit" hidden>${toolBtn('select', 'Select', icon('cursor', 16))}${toolBtn('crop', 'Draw a crop box', icon('crop', 16))}<span class="fs-sep"></span><span class="fs-pdfwb-settext">Headers and footers, Bates numbers, page numbers, watermarks and cropping.</span></div>
<div class="fs-tb fs-pdfwb-set" data-for="organize" hidden><button class="fs-tb-btn" type="button" data-a="org-left" title="Rotate left">${icon('undo', 16)}</button><button class="fs-tb-btn" type="button" data-a="org-right" title="Rotate right">${icon('redo', 16)}</button><button class="fs-tb-btn" type="button" data-a="org-delete" title="Delete pages">${icon('delete', 16)}</button><button class="fs-tb-btn" type="button" data-a="org-blank" title="Insert a blank page">${icon('pageInsert', 16)}</button><button class="fs-tb-btn" type="button" data-a="org-insert" title="Insert pages from a PDF">${icon('upload', 16)}</button><span class="fs-sep"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="org-reset">Reset</button><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-a="org-apply">Apply changes</button></div>
<div class="fs-tb fs-pdfwb-set" data-for="extract" hidden><span class="fs-pdfwb-settext">Text, pictures and tables, from all pages or a range.</span></div>
<div class="fs-tb fs-pdfwb-set" data-for="protect" hidden>${toolBtn('select', 'Select', icon('cursor', 16))}${toolBtn('redact', 'Mark areas to redact', icon('eraser', 16))}</div>
<div class="fs-tb fs-pdfwb-set" data-for="convert" hidden><span class="fs-pdfwb-settext">PowerPoint, Word, Excel, web pages, smaller files and pictures.</span></div>
<div class="fs-tb fs-pdfwb-set" data-for="access" hidden><span class="fs-pdfwb-settext">Check, tag, set the reading order and describe pictures for screen readers.</span></div>
</div>
<div class="fs-pdfwb-bar" hidden role="alert"><span class="fs-pdfwb-bar-icon">${icon('warning', 16)}</span><span class="fs-pdfwb-bar-text"></span><input class="fs-input fs-pdfwb-bar-input" hidden spellcheck="false"><div class="fs-pdfwb-bar-actions"></div></div>
<div class="fs-pdfwb-main">
<aside class="fs-pdfwb-side">
<div class="fs-pdfwb-sidehead"><div class="fs-seg is-quiet"><button type="button" data-side="pages" class="is-on">Pages</button><button type="button" data-side="outline">Bookmarks</button></div><span class="fs-strip-count fs-pdfwb-count"></span></div>
<div class="fs-pdfwb-sidebody"><div class="fs-pdfwb-outline" hidden></div></div>
</aside>
<main class="fs-pdfwb-center">
<div class="fs-pdfwb-empty">
<div class="fs-home-hero fs-pdfwb-hero"><span class="fs-home-hero-icon">${icon('filePdf', 26)}</span><div class="fs-home-hero-text"><div class="fs-home-hero-title">Open a PDF</div><div class="fs-home-hero-sub">Read, search, comment and reply, fill and sign, add headers, footers and Bates numbers, crop and reorder pages, extract text, pictures and tables, find and redact, protect, and export to Word or PowerPoint. Drop a file anywhere here.</div></div><div class="fs-home-hero-actions"><button class="fs-btn fs-btn-primary" type="button" data-a="open">${icon('folderOpen', 14)}Open PDF</button><button class="fs-btn" type="button" data-a="create-pictures">${icon('fileImage', 14)}Create from pictures</button><button class="fs-btn" type="button" data-a="create-files">${icon('merge', 14)}Combine files</button><button class="fs-btn" type="button" data-a="scan">${icon('scanner', 14)}Scan</button></div></div>
<section class="fs-home-section fs-pdfwb-recents" hidden><div class="fs-home-section-head"><h2 class="fs-home-section-title">Recent PDFs</h2></div><div class="fs-card-grid fs-pdfwb-recent-grid"></div></section>
</div>
<div class="fs-pdfwb-find" hidden><label class="fs-search">${icon('search', 14)}<input type="search" class="fs-pdfwb-findin" placeholder="Find in document" spellcheck="false" aria-label="Find in document"></label><span class="fs-pdfwb-findcount"></span><button class="fs-icon-btn is-sm" type="button" data-a="find-prev" title="Previous" aria-label="Previous match">${icon('chevronUp', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-a="find-next" title="Next" aria-label="Next match">${icon('chevronDown', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-a="find-close" title="Close" aria-label="Close search">${icon('close', 14)}</button></div>
<div class="fs-drop fs-pdfwb-drop" hidden></div>
</main>
<aside class="fs-pdfwb-panel"></aside>
</div>
<footer class="fs-status fs-pdfwb-status">
<div class="fs-status-left"><span class="fs-st fs-pdfwb-stat"></span><span class="fs-st fs-st-busy">${icon('loading', 12).replace('class="icon"', 'class="icon spin"')}<span class="fs-pdfwb-busy" role="status"></span></span><span class="fs-st-hint fs-pdfwb-hint"></span><span class="fs-st fs-st-agent fs-pdfwb-agent" hidden>${icon('agent', 12)}<span class="fs-pdfwb-agentlabel"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-a="undo-agent" title="Undo the agent's last turn">Undo turn</button></span></div>
<div class="fs-status-right">
<span class="fs-pdfwb-pagebox"><input class="fs-pdfwb-pagein" type="text" inputmode="numeric" aria-label="Page number" value="1"><span class="fs-pdfwb-pageof">of 0</span></span>
<button class="fs-icon-btn fs-pdfwb-layoutbtn" type="button" data-a="layout-menu" title="Page display" aria-label="Page display" aria-haspopup="menu">${icon('pageScroll', 14)}</button>
<button class="fs-icon-btn" type="button" data-a="zoom-out" title="Zoom out" aria-label="Zoom out">${icon('zoomOut', 14)}</button>
<input class="fs-pdfwb-zoomin" type="text" aria-label="Zoom" value="100%">
<button class="fs-icon-btn" type="button" data-a="zoom-in" title="Zoom in" aria-label="Zoom in">${icon('zoomIn', 14)}</button>
<button class="fs-icon-btn" type="button" data-a="fit-width" title="Fit width" aria-label="Fit width">${svg(LOCAL.fitWidth, 14)}</button>
<button class="fs-icon-btn" type="button" data-a="fit-page" title="Fit page" aria-label="Fit page">${icon('zoomFit', 14)}</button>
<button class="fs-icon-btn" type="button" data-a="rotate" title="Rotate view" aria-label="Rotate view">${icon('rotate', 14)}</button>
</div>
</footer>
</div>`;

class Workbench {
  private readonly root: HTMLElement;
  private readonly viewer: Viewer;
  private readonly thumbs: Thumbs;
  private readonly annot: Annotator;
  private readonly fields: Fields;
  private readonly finder: Finder;
  private readonly organizer: Organizer;
  private readonly panes: Panes;
  private readonly reflow: Reflow;
  private readonly speaker: Speaker;
  private readonly comparer: Comparer;
  private readonly cmpPanel: ComparePanel;
  private readonly forms: FormBuilder;
  private readonly formPanel: FormPanel;
  private readonly cmds = new Commands();
  private readonly openMenu: PopupMenu;
  private readonly layoutMenu: PopupMenu;
  private reading = false;
  private menuClosed = 0;
  private voicesKey = '';
  private spokenPage = 0;
  private opts: WorkbenchOptions = { app: { home: () => undefined, shown: () => undefined, help: () => undefined, shortcuts: () => undefined, preferences: () => undefined, agents: () => undefined, doc: () => undefined, palette: () => undefined } };
  private readonly menubar: MenuBar;
  private agentTimer = 0;
  private reported = '';
  private doc: Doc | null = null;
  private history: State[] = [];
  private hi = -1;
  private savedId = '';
  private tab: Tab = 'view';
  private passwords = new Map<string, string>();
  private busy = 0;
  private busyOff: (() => void) | null = null;
  private loadSeq = 0;
  private printing = false;

  constructor() {
    this.root = el(SHELL);
    (document.getElementById('overlay-root') ?? document.body).appendChild(this.root);
    const center = q(this.root, '.fs-pdfwb-center');
    this.viewer = new Viewer(center, {
      page: (n) => this.onPage(n),
      zoom: (pct) => { if (document.activeElement !== this.zoomIn) setValue(this.zoomIn, `${pct}%`); },
      mounted: (pv) => { this.annot.mount(pv); this.fields.mount(pv); this.forms.mount(pv); this.comparer.mount(pv); this.speaker.mount(pv); pageTools(pv, this.host); },
      textReady: (pv) => { this.finder.paint(pv); this.speaker.paint(pv); },
      rendered: (pv) => renderedTools(pv, this.host),
      link: (url) => this.openLink(url),
    });
    center.insertBefore(this.viewer.scroller, q(center, '.fs-pdfwb-find'));
    this.thumbs = new Thumbs(this.viewer);
    q(this.root, '.fs-pdfwb-sidebody').prepend(this.thumbs.root);
    this.thumbs.onPick = (n) => this.goPage(n);
    this.annot = new Annotator(this.viewer, {
      changed: (label) => this.pushState(label),
      select: () => { this.panes.syncAnnots(); this.syncPalette(); },
      areas: () => this.panes.syncAreas(),
      toolDone: () => this.setTool('select'),
      crop: () => this.panes.syncCrop('draw'),
    });
    this.fields = new Fields(this.viewer);
    this.fields.onChange = () => { this.panes.syncFields(); this.syncChrome(); };
    this.finder = new Finder(this.viewer);
    this.finder.onChange = () => this.syncFind();
    this.organizer = new Organizer({
      thumb: (it) => this.orgThumb(it),
      changed: () => { this.panes.syncOrganize(); this.syncChrome(); },
      drop: (files, at) => void this.insertPdfs(files, at),
    });
    center.insertBefore(this.organizer.root, q(center, '.fs-pdfwb-find'));
    setHidden(this.organizer.root, true);
    this.reflow = new Reflow();
    this.reflow.onPage = (n) => this.pageUi(n);
    center.insertBefore(this.reflow.root, q(center, '.fs-pdfwb-find'));
    this.speaker = new Speaker(this.viewer);
    this.speaker.onState = () => this.syncView();
    this.speaker.onVoices = () => this.syncView();
    this.comparer = new Comparer(this.viewer);
    this.cmpPanel = new ComparePanel(this.comparer);
    this.comparer.onChange = () => this.cmpPanel.sync();
    this.cmpPanel.onPick = () => void this.compareWith();
    this.cmpPanel.onClear = () => this.comparer.set(null);
    this.forms = new FormBuilder(this.viewer, {
      changed: () => { this.formPanel.sync(); this.syncChrome(); },
      select: () => { this.formPanel.syncSelection(); syncTools(this.host); },
      toolDone: () => this.setFormTool(null),
    });
    this.formPanel = new FormPanel(this.forms);
    this.formPanel.onApply = () => void this.applyForm();
    this.panes = new Panes(this.ctx());
    this.fields.onSign = (f) => void this.panes.placeSignature({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h });
    q(this.root, '.fs-pdfwb-panel').appendChild(this.panes.root);
    q(this.panes.root, '.fs-pdfwb-cmphost').appendChild(this.cmpPanel.root);
    q(this.panes.root, '.fs-pdfwb-pane[data-for="form"]').appendChild(this.formPanel.root);
    for (const [t, l] of TABS) {
      const pane = q(this.panes.root, `.fs-pdfwb-pane[data-for="${t}"]`);
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-label', l);
    }
    q(this.root, '.fs-pdfwb-tabs').addEventListener('keydown', (e) => {
      const tabs = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.fs-pdfwb-tab')).filter((b) => !b.disabled);
      const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      tabs[to].focus();
      this.setTab(tabs[to].dataset.tab as Tab);
    });
    this.cmds.add(
      { id: 'pdf-open', label: 'Open a PDF…', keys: ['Mod+O'], run: () => void this.pick(false).then((f) => { if (f[0]) void this.guard(() => this.openFile(f[0])); }) },
      { id: 'pdf-create-pictures', label: 'Create PDF from pictures…', run: () => void this.startCreate('pictures') },
      { id: 'pdf-create-files', label: 'Combine files into a PDF…', run: () => void this.startCreate('files') },
      { id: 'pdf-scan', label: 'Scan…', words: ['scanner', 'scan to pdf', 'paper'], run: () => void this.startScan() },
      { id: 'pdf-compare', label: 'Compare with another PDF…', enabled: () => !!this.doc, run: () => void this.compareWith() },
      ...LAYOUTS.map(([v, l]) => ({ id: `pdf-layout-${v}`, label: l, checked: () => this.viewer.layout === v, run: () => this.setLayout(v as Layout, this.viewer.cover) })),
      { id: 'pdf-cover', label: 'Show cover page in two-page view', checked: () => this.viewer.cover, run: () => this.setLayout(this.viewer.layout, !this.viewer.cover) },
      { id: 'pdf-reading', label: 'Reading mode', checked: () => this.reading, enabled: () => !!this.doc, run: () => this.setReading(!this.reading) },
      { id: 'pdf-home', label: 'Home', keys: ['Alt+Mod+H'], run: () => this.close() },
      { id: 'pdf-save', label: 'Save', keys: ['Mod+S'], enabled: () => !!this.doc, run: () => void this.save() },
      { id: 'pdf-print', label: 'Print…', keys: ['Mod+P'], enabled: () => !!this.doc, run: () => void this.print() },
      { id: 'pdf-close', label: 'Close PDF', enabled: () => !!this.doc, run: () => this.close() },
      { id: 'pdf-undo', label: () => (this.history[this.hi - 1] ? `Undo ${this.history[this.hi].label}` : 'Undo'), keys: ['Mod+Z'], enabled: () => this.hi > 0, why: () => (this.doc ? 'Nothing to undo yet' : 'Open a PDF first'), run: () => this.undo() },
      { id: 'pdf-redo', label: () => (this.history[this.hi + 1] ? `Redo ${this.history[this.hi + 1].label}` : 'Redo'), keys: ['Shift+Mod+Z', 'Mod+Y'], enabled: () => this.hi < this.history.length - 1, why: () => (this.doc ? 'Nothing to redo' : 'Open a PDF first'), run: () => this.redo() },
      { id: 'pdf-undo-agent', label: 'Undo agent turn', keys: ['Alt+Mod+Z'], enabled: () => this.agentTarget() >= 0, why: () => 'No agent change to undo', run: () => void this.undoAgent() },
      { id: 'pdf-find', label: 'Find…', keys: ['Mod+F'], enabled: () => !!this.doc, run: () => this.openFind() },
      { id: 'pdf-zoom-in', label: 'Zoom in', keys: ['Mod+='], enabled: () => !!this.doc, run: () => this.viewer.zoomStep(1) },
      { id: 'pdf-zoom-out', label: 'Zoom out', keys: ['Mod+-'], enabled: () => !!this.doc, run: () => this.viewer.zoomStep(-1) },
      { id: 'pdf-fit-width', label: 'Fit width', keys: ['Mod+0'], enabled: () => !!this.doc, run: () => this.viewer.applyFit('width') },
      { id: 'pdf-fit-page', label: 'Fit page', enabled: () => !!this.doc, run: () => this.viewer.applyFit('page') },
      { id: 'pdf-rotate', label: 'Rotate view', enabled: () => !!this.doc, run: () => this.viewer.rotateView(90) },
      ...TABS.map(([t, l]) => ({ id: `pdf-tab-${t}`, label: l, words: TAB_WORDS[t], checked: () => this.tab === t, enabled: () => !!this.doc || t === 'view', run: () => this.setTab(t) })),
      { id: 'pdf-agents', label: 'Agents and MCP…', run: () => this.opts.app.agents() },
      { id: 'pdf-help', label: 'formpdf Help', keys: ['F1'], run: () => this.opts.app.help() },
      { id: 'pdf-shortcuts', label: 'Keyboard shortcuts', keys: ['Mod+/'], run: () => this.opts.app.shortcuts(this.cmds) },
      { id: 'pdf-preferences', label: 'Preferences…', keys: ['Mod+,'], run: () => this.opts.app.preferences() },
      { id: 'pdf-palette', label: 'Find a command or tool…', keys: ['Mod+K'], words: ['palette', 'search tools', 'all tools'], run: () => this.opts.app.palette() },
    );
    this.cmds.add(...mountTools(this.panes.root, this.host));
    const menus: MenuDef[] = [
      { label: 'File', items: ['pdf-home', 'pdf-open', 'pdf-create-pictures', 'pdf-create-files', 'pdf-scan', '-', 'pdf-save', 'pdf-print', '-', 'pdf-close'] },
      { label: 'Edit', items: ['pdf-undo', 'pdf-redo', 'pdf-undo-agent', '-', 'pdf-find'] },
      { label: 'View', items: [...LAYOUTS.map(([v]) => `pdf-layout-${v}`), 'pdf-cover', '-', 'pdf-reading', '-', 'pdf-zoom-in', 'pdf-zoom-out', 'pdf-fit-width', 'pdf-fit-page', 'pdf-rotate', '-', 'pdf-compare'] },
      { label: 'Tools', items: TABS.map(([t]) => `pdf-tab-${t}`) },
      { label: 'Help', items: ['pdf-palette', 'pdf-help', 'pdf-shortcuts', '-', 'pdf-agents', 'pdf-preferences'] },
    ];
    this.menubar = new MenuBar(q(this.root, '.fs-pdfwb-menubar'), this.cmds, menus);
    this.openMenu = new PopupMenu(this.cmds, null, true);
    this.openMenu.panel.classList.add('fs-pdfwb-menu');
    this.openMenu.onClose = () => { this.menuClosed = performance.now(); };
    this.openMenu.setItems(['pdf-open', 'pdf-create-pictures', 'pdf-create-files', 'pdf-scan', '-', 'pdf-compare']);
    this.layoutMenu = new PopupMenu(this.cmds, null, true);
    this.layoutMenu.panel.classList.add('fs-pdfwb-menu');
    this.layoutMenu.onClose = () => { this.menuClosed = performance.now(); };
    this.layoutMenu.setItems([...LAYOUTS.map(([v]) => `pdf-layout-${v}`), '-', 'pdf-cover', '-', 'pdf-reading']);
    const saved = (recall(LAYOUT_KEY) ?? '').split('|');
    if (LAYOUTS.some(([v]) => v === saved[0])) this.viewer.setLayout(saved[0] as Layout, saved[1] === '1');
    const say = (recall(SAY_KEY) ?? '').split('|');
    if (say[0]) this.speaker.voiceURI = say[0];
    if (Number(say[1]) > 0) this.speaker.rate = Number(say[1]);
    this.wire();
    this.setTab('view');
    this.syncChrome();
    this.syncView();
  }

  private get zoomIn(): HTMLInputElement { return q<HTMLInputElement>(this.root, '.fs-pdfwb-zoomin'); }

  private page(): number { return this.reading ? this.reflow.currentPage() : this.viewer.currentPage(); }

  private goPage(n: number): void {
    if (this.reading) this.reflow.goTo(Math.max(1, Math.min(this.viewer.pages.length, n)));
    else this.viewer.goTo(n);
  }

  private stepPage(dir: 1 | -1): void {
    if (this.reading) this.goPage(this.reflow.currentPage() + dir);
    else this.viewer.step(dir);
  }

  private ctx(): Ctx {
    return {
      viewer: this.viewer, annot: this.annot, fields: this.fields, organizer: this.organizer,
      doc: () => this.doc,
      run: (label, fn) => this.run(label, fn),
      commit: (res, label) => this.commit(res, label),
      flush: () => this.flush(),
      deliver: (data, name) => this.deliver(data, name),
      tool: (t) => this.setTool(t),
      pickPdfs: (multiple) => this.pick(multiple),
      remember: (id, pw) => this.passwords.set(id, pw),
      insertPdfs: (files, at) => this.insertPdfs(files, at),
      applyOrganize: () => this.applyOrganize(),
      act: (name, value) => this.act(name, value),
    };
  }

  private act(name: string, value?: string): void {
    const sp = this.speaker;
    switch (name) {
      case 'layout': this.setLayout((value ?? 'continuous') as Layout, this.viewer.cover); return;
      case 'cover': this.setLayout(this.viewer.layout, !!value); return;
      case 'cover-toggle': this.setLayout(this.viewer.layout, !this.viewer.cover); return;
      case 'reading': this.setReading(!this.reading); return;
      case 'rf-smaller': this.textSize(-1); return;
      case 'rf-larger': this.textSize(1); return;
      case 'say-page': if (this.doc) sp.readPage(this.reading ? this.reflow.currentPage() : this.viewer.currentPage()); return;
      case 'say-end': if (this.doc) sp.readFrom(this.reading ? this.reflow.currentPage() : this.viewer.currentPage()); return;
      case 'say-pause': if (sp.state === 'playing') sp.pause(); else sp.resume(); return;
      case 'say-stop': sp.stop(); return;
      case 'say-voice': case 'say-rate':
        if (name === 'say-voice') sp.voiceURI = value ?? ''; else sp.rate = Number(value) || 1;
        remember(SAY_KEY, `${sp.voiceURI}|${sp.rate}`);
        return;
      case 'compare': void this.compareWith(); return;
    }
  }

  private setLayout(layout: Layout, cover: boolean): void {
    if (this.reading) this.setReading(false);
    this.viewer.setLayout(layout, cover);
    remember(LAYOUT_KEY, `${layout}|${cover ? 1 : 0}`);
    this.thumbs.setCurrent(this.viewer.currentPage());
    this.syncView();
  }

  private setReading(on: boolean): void {
    const d = this.doc;
    if (on === this.reading || (on && !d)) return;
    if (on && this.tab !== 'view') this.setTab('view');
    this.reading = on;
    if (on && d) {
      this.closeFind();
      const n = this.viewer.currentPage();
      this.viewer.park();
      setHidden(this.viewer.scroller, true);
      void this.run('Preparing reading mode', () => this.reflow.show(d.id, d.info.pages, n));
      this.reflow.root.focus({ preventScroll: true });
    } else {
      const n = this.reflow.currentPage();
      this.reflow.hide();
      setHidden(this.viewer.scroller, this.tab === 'organize' || !this.doc);
      this.viewer.unpark();
      if (this.doc) this.viewer.goTo(n);
      this.root.focus({ preventScroll: true });
    }
    this.syncView();
  }

  private textSize(dir: 1 | -1): void {
    const i = REFLOW_SIZES.indexOf(this.reflow.size);
    const next = REFLOW_SIZES[Math.max(0, Math.min(REFLOW_SIZES.length - 1, (i < 0 ? 4 : i) + dir))];
    this.reflow.setSize(next);
    this.syncView();
  }

  private pageUi(n: number): void {
    const input = q<HTMLInputElement>(this.root, '.fs-pdfwb-pagein');
    if (document.activeElement !== input) setValue(input, String(n));
    this.thumbs.setCurrent(n);
  }

  private syncView(): void {
    const r = this.root, v = this.viewer, sp = this.speaker, has = !!this.doc;
    for (const b of Array.from(r.querySelectorAll<HTMLElement>('[data-a="layout"]'))) { const on = b.dataset.v === v.layout; setClass(b, 'is-on', on); b.setAttribute('aria-checked', String(on)); }
    setClass(q(r, '[data-a="cover-toggle"]'), 'is-on', v.cover);
    const cover = q<HTMLInputElement>(this.panes.root, '[data-a="cover"]');
    if (cover.checked !== v.cover) cover.checked = v.cover;
    const icons: Record<Layout, string> = { single: 'pageSingle', continuous: 'pageScroll', two: 'pageTwo', 'two-continuous': 'pageTwoScroll' };
    const lb = q(r, '.fs-pdfwb-layoutbtn');
    if (lb.dataset.icon !== v.layout) { lb.dataset.icon = v.layout; lb.innerHTML = icon(icons[v.layout], 14); }
    for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>('[data-a="reading"]'))) { setClass(b, 'is-on', this.reading); b.setAttribute('aria-pressed', String(this.reading)); setDisabled(b, !has); }
    for (const a of ['rf-smaller', 'rf-larger']) for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>(`[data-a="${a}"]`))) setDisabled(b, !this.reading || (a === 'rf-smaller' ? this.reflow.size <= REFLOW_SIZES[0] : this.reflow.size >= REFLOW_SIZES[REFLOW_SIZES.length - 1]));
    const why = sp.supported ? '' : 'Read aloud needs speech support, which this system does not have';
    for (const a of ['say-page', 'say-end']) for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>(`[data-a="${a}"]`))) {
      setDisabled(b, !sp.supported || !has);
      const t = why || (a === 'say-page' ? 'Read this page aloud' : 'Read from here to the end');
      if (b.title !== t) b.title = t;
    }
    for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>('[data-a="say-pause"]'))) {
      setDisabled(b, sp.state === 'idle');
      setClass(b, 'is-on', sp.state === 'paused');
      const t = sp.state === 'paused' ? 'Resume reading' : 'Pause reading';
      if (b.title !== t) b.title = t;
      const label = b.querySelector('span:not(.icon)');
      if (label) setText(label, sp.state === 'paused' ? 'Resume' : 'Pause');
    }
    for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>('[data-a="say-stop"]'))) setDisabled(b, sp.state === 'idle');
    const say = this.panes.root;
    for (const s of Array.from(say.querySelectorAll<HTMLSelectElement>('[data-a="say-voice"], [data-a="say-rate"]'))) setDisabled(s, !sp.supported);
    const voices = sp.voices();
    const key = voices.map((x) => x.voiceURI).join('|');
    const sel = q<HTMLSelectElement>(say, '[data-a="say-voice"]');
    if (key !== this.voicesKey) {
      this.voicesKey = key;
      const lang = navigator.language.slice(0, 2);
      const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(lang)) - Number(a.lang.startsWith(lang)) || a.name.localeCompare(b.name));
      sel.replaceChildren(el('<option value="">Default voice</option>'), ...sorted.map((x) => { const o = document.createElement('option'); o.value = x.voiceURI; o.textContent = `${x.name} (${x.lang})`; return o; }));
    }
    setValue(sel, voices.some((x) => x.voiceURI === sp.voiceURI) ? sp.voiceURI : '');
    setValue(q<HTMLSelectElement>(say, '[data-a="say-rate"]'), String(sp.rate));
    setText(q(say, '.fs-pdfwb-saynote'), !sp.supported ? `${why}.` : sp.error ? sp.error : sp.state === 'playing' ? `Reading page ${sp.page}. The sentence being read is highlighted on the page.` : sp.state === 'paused' ? `Paused on page ${sp.page}.` : 'Reads the text of the PDF out loud, sentence by sentence.');
    if (sp.state !== 'idle' && sp.page !== this.spokenPage) {
      this.spokenPage = sp.page;
      if (this.reading) this.reflow.goTo(sp.page);
    }
    if (sp.state === 'idle') this.spokenPage = 0;
  }

  private setFormTool(t: NewFieldType | null): void {
    this.forms.setTool(t);
    this.annot.setTool(t ? 'form' : 'select');
    this.root.dataset.tool = t ? 'form' : 'select';
    this.viewer.setClass('is-drawing', !!t);
    this.viewer.setClass('is-marking', false);
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('[data-ftool]'))) setClass(b, 'is-on', b.dataset.ftool === (t ?? 'select'));
    setText(q(this.root, '.fs-pdfwb-hint'), t ? `Drag on the page to draw a ${FIELD_LABEL[t].toLowerCase()}, or click to place one. Esc cancels.` : this.tab === 'form' ? 'Click a field to select it. Drag to move it; drag its corner to resize.' : '');
  }

  private async applyForm(): Promise<void> {
    const d = this.doc;
    if (!d || !this.forms.dirty) return;
    const problem = this.forms.problems();
    if (problem) { toast(problem, 'error'); return; }
    const f = this.forms, made = f.drafts.length, renamed = f.renames.size, gone = f.deletes.size;
    await this.run('Writing the form fields', async () => {
      await this.flush();
      if (this.forms.dirty) return;
      const parts = [made ? `${made} field${made === 1 ? '' : 's'} added` : '', renamed ? `${renamed} renamed` : '', gone ? `${gone} deleted` : ''].filter(Boolean);
      toast(`${parts.join(', ') || 'Form updated'}. Fill & Sign can fill them now.`);
    });
  }

  private async compareWith(): Promise<void> {
    const d = this.doc;
    if (!d) return;
    if (this.tab !== 'view') this.setTab('view');
    const files = await this.pick(false);
    const f = files[0];
    if (!f) return;
    await this.run('Comparing', async () => {
      const other = await pdfApi.open(f, f.name);
      if (other.info.locked) { toast(`${f.name} is password protected. Open it here and unlock it first.`, 'error'); return; }
      const cur = this.doc;
      if (!cur) return;
      const res = await pdfApi.compare(cur.id, other.id, { otherIsNewer: this.cmpPanel.otherIsNewer, pictures: this.cmpPanel.pictures });
      this.comparer.set(res, cur.id, f.name);
      q(this.panes.root, '[data-part="compare"]').scrollIntoView({ block: 'start' });
      if (res.changes.length) this.comparer.go(res.changes[0].id);
      else toast('No differences found');
    });
  }

  private async startCreate(kind: CreateKind, files: File[] = []): Promise<void> {
    const got = await askCreate(kind, files);
    if (!got) { if (!this.doc) this.finishClose(); return; }
    await this.guard(() => this.run('Creating the PDF', async () => {
      const o = await pdfApi.create(got.files, got.opts);
      await this.adopt(o);
      this.savedId = '';
      this.syncChrome();
      toast(`Created ${o.name} with ${o.pages} page${o.pages === 1 ? '' : 's'}. Save to keep it.`);
    }).then(() => undefined));
  }

  private async startScan(): Promise<void> {
    const req = await askScan(this.doc?.id ?? '');
    if (!req) { if (!this.doc) this.finishClose(); return; }
    await this.guard(() => this.run(req.into ? 'Scanning into this PDF' : 'Scanning', async () => {
      if (req.into) {
        const id = await this.flush() ?? req.into;
        const res = await pdfApi.scan<Derived>({ ...req, into: id });
        await this.commit(res, 'Add scanned pages');
        toast(`Added ${res.scanned} scanned page${res.scanned === 1 ? '' : 's'}${req.ocr ? ', searchable' : ''}.`);
        return;
      }
      const o = await pdfApi.scan<Opened>(req);
      await this.adopt(o);
      this.savedId = '';
      this.syncChrome();
      toast(`Scanned ${o.scanned} page${o.scanned === 1 ? '' : 's'}${req.ocr ? ', searchable' : ''}. Save to keep it.`);
    }).then(() => undefined));
  }

  open(opts: WorkbenchOptions): void {
    this.opts = opts;
    const wasHidden = this.root.hidden;
    setHidden(this.root, false);
    if (wasHidden) { this.root.focus({ preventScroll: true }); opts.app.shown(); }
    const create = opts.create;
    if (opts.file) void this.guard(() => this.openFile(opts.file as File));
    else if (opts.path) { const path = opts.path; void this.guard(() => this.run('Opening', async () => this.adopt(await pdfApi.openPath(path)))); }
    else if (opts.recent) { const id = opts.recent; void this.guard(() => this.openRecent(id)); }
    else if (!this.doc && !create && !opts.scan) void this.loadRecents();
    if (create) void this.startCreate(create, opts.files ?? []);
    else if (opts.scan) void this.startScan();
  }

  private wire(): void {
    const r = this.root;
    r.addEventListener('click', (e) => this.click(e));
    r.addEventListener('keydown', (e) => this.key(e));
    document.addEventListener('keydown', (e) => {
      if (!r.hidden && (e.target === document.body || e.target === document.documentElement)) this.key(e);
    }, true);
    r.addEventListener('focusout', (e) => {
      if (e.relatedTarget === null && !r.hidden) requestAnimationFrame(() => { if (document.activeElement === document.body) r.focus({ preventScroll: true }); });
    });
    r.addEventListener('paste', (e) => e.stopPropagation());
    r.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      setHidden(q(r, '.fs-pdfwb-drop'), false);
    });
    r.addEventListener('dragleave', (e) => { if (!r.contains(e.relatedTarget as Node | null)) setHidden(q(r, '.fs-pdfwb-drop'), true); });
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHidden(q(r, '.fs-pdfwb-drop'), true);
      const all = Array.from(e.dataTransfer?.files ?? []);
      const files = all.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      const pictures = all.filter((f) => IMAGE_FILE.test(f.name) || (f.type.startsWith('image/') && !f.type.includes('svg')));
      if (pictures.length) { void this.startCreate(files.length ? 'files' : 'pictures', [...files, ...pictures].sort((a, b) => all.indexOf(a) - all.indexOf(b))); return; }
      if (!files.length) { toast('Drop a PDF file, or pictures to make one'); return; }
      if (this.tab === 'organize' && this.doc) { void this.insertPdfs(files, this.organizer.items.length); return; }
      void this.guard(() => this.openFile(files[0]));
    });
    this.viewer.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.viewer.setZoom(this.viewer.zoom * Math.exp(-e.deltaY * 0.0022), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    const pageIn = q<HTMLInputElement>(r, '.fs-pdfwb-pagein');
    pageIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const n = parseInt(pageIn.value, 10);
      if (n >= 1 && n <= this.viewer.pages.length) this.goPage(n); else pageIn.value = String(this.page());
      pageIn.blur();
    });
    pageIn.addEventListener('blur', () => { pageIn.value = String(this.page()); });
    this.zoomIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = parseFloat(this.zoomIn.value);
      if (v > 0) this.viewer.setZoom(v / 100);
      this.zoomIn.blur();
    });
    this.zoomIn.addEventListener('blur', () => setValue(this.zoomIn, `${Math.round(this.viewer.zoom * 100)}%`));
    const findIn = q<HTMLInputElement>(r, '.fs-pdfwb-findin');
    let findTimer = 0;
    findIn.addEventListener('input', () => { window.clearTimeout(findTimer); findTimer = window.setTimeout(() => void this.finder.search(findIn.value), 180); });
    findIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (this.finder.query !== findIn.value) void this.finder.search(findIn.value); else this.finder.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    const paneFind = q<HTMLInputElement>(this.panes.root, '.fs-pdfwb-findq');
    paneFind.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.openFind(paneFind.value); } });
    q(r, '.fs-pdfwb-width').addEventListener('change', (e) => { this.annot.style.width = Number((e.target as HTMLSelectElement).value); this.restyle({ width: this.annot.style.width }); });
    q(r, '.fs-pdfwb-size').addEventListener('change', (e) => { this.annot.style.size = Number((e.target as HTMLSelectElement).value); this.restyle({ size: this.annot.style.size }); });
    q(r, '[data-a="custom-color"]').addEventListener('change', (e) => this.pickColor((e.target as HTMLInputElement).value.toUpperCase()));
  }

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('.fs-pdfwb-panes')) return;
    const tabBtn = t.closest('.fs-pdfwb-tab') as HTMLElement | null;
    if (tabBtn?.dataset.tab) { this.setTab(tabBtn.dataset.tab as Tab); return; }
    const toolBtn = t.closest('.fs-tb-btn[data-tool]') as HTMLElement | null;
    if (toolBtn) { this.setTool(toolBtn.dataset.tool as Tool); return; }
    const fBtn = t.closest('[data-ftool]') as HTMLElement | null;
    if (fBtn?.dataset.ftool) { const ft = fBtn.dataset.ftool; this.setFormTool(ft === 'select' || this.forms.tool === ft ? null : ft as NewFieldType); return; }
    const sw = t.closest('[data-color]') as HTMLElement | null;
    if (sw?.dataset.color) { this.pickColor(sw.dataset.color); return; }
    const side = t.closest('[data-side]') as HTMLElement | null;
    if (side) { this.setSide(side.dataset.side as 'pages' | 'outline'); return; }
    const ol = t.closest('.fs-pdfwb-ol') as HTMLElement | null;
    if (ol?.dataset.page) { this.viewer.goTo(Number(ol.dataset.page)); return; }
    const rec = t.closest('.fs-pdfwb-recent') as HTMLElement | null;
    if (rec?.dataset.id) {
      if (t.closest('[data-forget]')) { void pdfApi.forget(rec.dataset.keyid ?? '').then(() => this.loadRecents()); return; }
      void this.guard(() => this.openRecent(rec.dataset.id as string));
      return;
    }
    const b = t.closest('[data-a]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const v = this.viewer;
    switch (b.dataset.a) {
      case 'home': this.close(); break;
      case 'agents': this.opts.app.agents(); break;
      case 'undo-agent': void this.undoAgent(); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'open': void this.pick(false).then((f) => { if (f[0]) void this.guard(() => this.openFile(f[0])); }); break;
      case 'open-menu': case 'layout-menu': {
        const menu = b.dataset.a === 'open-menu' ? this.openMenu : this.layoutMenu;
        if (menu.isOpen || performance.now() - this.menuClosed < 250) { menu.close(); break; }
        const rc = b.getBoundingClientRect();
        menu.openAt(b.dataset.a === 'open-menu' ? rc.left : rc.right - 240, b.dataset.a === 'open-menu' ? rc.bottom + 6 : rc.top - 6);
        break;
      }
      case 'stamps': this.setTab('fill'); q(this.panes.root, '[data-part="stamps"]').scrollIntoView({ block: 'start' }); break;
      case 'create-pictures': void this.startCreate('pictures'); break;
      case 'create-files': void this.startCreate('files'); break;
      case 'scan': void this.startScan(); break;
      case 'layout': this.act('layout', b.dataset.v); break;
      case 'cover-toggle': case 'reading': case 'rf-smaller': case 'rf-larger': case 'say-page': case 'say-end': case 'say-pause': case 'say-stop': case 'compare': this.act(b.dataset.a); break;
      case 'print': void this.print(); break;
      case 'save': void this.save(); break;
      case 'close': this.close(); break;
      case 'find': this.openFind(); break;
      case 'find-next': this.finder.step(1); break;
      case 'find-prev': this.finder.step(-1); break;
      case 'find-close': this.closeFind(); break;
      case 'zoom-in': v.zoomStep(1); break;
      case 'zoom-out': v.zoomStep(-1); break;
      case 'fit-width': v.applyFit('width'); break;
      case 'fit-page': v.applyFit('page'); break;
      case 'rotate': v.rotateView(90); break;
      case 'sign': void this.panes.placeSignature(); break;
      case 'date': this.annot.placement = { kind: 'freetext', text: new Date().toLocaleDateString(), size: 12, label: 'date' }; this.setTool('place'); break;
      case 'org-left': this.organizer.rotate(-90); break;
      case 'org-right': this.organizer.rotate(90); break;
      case 'org-delete': this.organizer.remove(); break;
      case 'org-blank': this.organizer.blank(); break;
      case 'org-insert': void this.pick(true).then((files) => (files.length ? this.insertPdfs(files, this.organizer.insertAt()) : undefined)); break;
      case 'org-reset': if (this.doc) { this.organizer.reset(this.doc.id, this.doc.info.sizes); this.panes.syncOrganize(); this.syncChrome(); } break;
      case 'org-apply': void this.applyOrganize(); break;
    }
  }

  private key(e: KeyboardEvent): void {
    if (anyDialogOpen()) return;
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
    const combo = comboOf(e);
    const v = this.viewer;
    const run = (fn: () => void): void => { e.preventDefault(); fn(); };
    if (this.openMenu.isOpen || this.layoutMenu.isOpen || this.menubar.isOpen) {
      if (combo === 'Escape') { e.preventDefault(); this.openMenu.close(); this.layoutMenu.close(); this.menubar.close(); }
      return;
    }
    if (['F1', 'Mod+/', 'Mod+,', 'Alt+Mod+H', 'Alt+Mod+Z', 'Mod+K'].includes(combo)) { const cmd = this.cmds.forCombo(combo); if (cmd) { run(() => this.cmds.run(cmd.id)); return; } }
    switch (combo) {
      case 'Mod+F': return run(() => { if (this.reading) this.setReading(false); this.openFind(); });
      case 'Mod+S': return run(() => void this.save());
      case 'Mod+P': return run(() => void this.print());
      case 'Mod+O': return run(() => void this.pick(false).then((f) => { if (f[0]) void this.guard(() => this.openFile(f[0])); }));
      case 'Mod+=': case 'Shift+Mod+=': return run(() => (this.reading ? this.textSize(1) : v.zoomStep(1)));
      case 'Mod+-': return run(() => (this.reading ? this.textSize(-1) : v.zoomStep(-1)));
      case 'Mod+0': return run(() => v.applyFit('width'));
    }
    if (typing) return;
    if (this.annot.tool === 'custom' && this.annot.custom?.key?.(e)) { e.preventDefault(); return; }
    switch (combo) {
      case 'Mod+Z': return run(() => this.undo());
      case 'Shift+Mod+Z': case 'Mod+Y': return run(() => this.redo());
      case 'Mod+A': if (this.tab === 'organize') return run(() => this.organizer.selectAll()); return;
      case 'PageDown': return run(() => this.stepPage(1));
      case 'PageUp': return run(() => this.stepPage(-1));
      case 'Home': return run(() => this.goPage(1));
      case 'End': return run(() => this.goPage(v.pages.length));
      case 'Delete': case 'Backspace':
        if (this.tab === 'organize') return run(() => this.organizer.remove());
        if (this.tab === 'form' && this.forms.selected) return run(() => void this.forms.removeSelected());
        if (this.annot.selected) return run(() => void this.annot.remove());
        return;
      case 'Escape':
        if (!q(this.root, '.fs-pdfwb-find').hidden) return run(() => this.closeFind());
        if (!q(this.root, '.fs-pdfwb-bar').hidden) return run(() => this.hideBar());
        if (this.tab === 'form' && this.forms.tool) return run(() => this.setFormTool(null));
        if (this.tab === 'form' && this.forms.selected) return run(() => this.forms.select(null));
        if (this.reading) return run(() => this.setReading(false));
        if (this.annot.tool !== 'select') return run(() => this.setTool('select'));
        if (this.annot.selected) return run(() => this.annot.select(null));
        return;
    }
    if (this.tab === 'comment' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const keys: Record<string, Tool> = { v: 'select', h: 'highlight', u: 'underline', k: 'strikeout', n: 'note', t: 'freetext', p: 'ink', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow' };
      const tool = keys[e.key.toLowerCase()];
      if (tool) run(() => this.setTool(tool));
    }
  }

  private setTab(tab: Tab): void {
    this.annot.commitEdit();
    if (tab !== 'view' && this.reading) this.setReading(false);
    this.tab = tab;
    this.root.dataset.tab = tab;
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab'))) { setClass(b, 'is-on', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); b.tabIndex = b.dataset.tab === tab ? 0 : -1; }
    for (const s of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-pdfwb-set'))) setHidden(s, s.dataset.for !== tab);
    const org = tab === 'organize';
    if (org) this.viewer.park();
    setHidden(this.organizer.root, !org || !this.doc);
    setHidden(this.viewer.scroller, org || !this.doc);
    if (!org) this.viewer.unpark();
    if (org && this.doc && this.organizer.docId !== this.doc.id && !this.organizer.dirty) this.organizer.reset(this.doc.id, this.doc.info.sizes);
    this.fields.setActive(tab === 'fill');
    if (tab === 'fill' && this.doc) void this.fields.load(this.doc.id).catch((err: unknown) => toast(`Could not read the form: ${err instanceof Error ? err.message : err}`, 'error'));
    this.forms.setActive(tab === 'form');
    if (tab === 'form' && this.doc) void this.forms.load(this.doc.id).catch((err: unknown) => toast(`Could not read the form: ${err instanceof Error ? err.message : err}`, 'error'));
    this.annot.flattenComments = tab === 'fill' ? true : q<HTMLInputElement>(this.panes.root, '[data-a="flatten-comments"]').checked;
    this.panes.show(tab);
    this.setTool('select');
    if (tab === 'form') { this.setFormTool(null); this.formPanel.syncSelection(); }
    this.panes.syncDoc();
    this.panes.syncAnnots();
    if (org) this.organizer.root.focus({ preventScroll: true });
  }

  private setTool(tool: Tool): void {
    if (tool === 'place' && !this.annot.placement) tool = 'select';
    if (tool !== 'place') this.annot.placement = null;
    if (tool === 'freetext' && this.tab === 'fill') this.annot.flattenComments = true;
    this.annot.setTool(tool);
    this.root.dataset.tool = tool;
    this.viewer.setClass('is-drawing', DRAW_TOOLS.includes(tool));
    this.viewer.setClass('is-marking', MARKUP_TOOLS.includes(tool));
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-tb-btn[data-tool]'))) setClass(b, 'is-on', b.dataset.tool === tool);
    if (TOOL_COLOR[tool]) this.annot.style.color = TOOL_COLOR[tool];
    this.syncPalette();
    const pl = this.annot.placement;
    setText(q(this.root, '.fs-pdfwb-hint'), tool === 'place' && pl ? `Click where the ${pl.label} goes. Esc cancels.` : HINTS[tool] ?? '');
    this.panes.syncAreas();
  }

  private pickColor(c: string): void {
    this.annot.style.color = c;
    const tool = this.annot.tool;
    if (TOOL_COLOR[tool]) TOOL_COLOR[tool] = c;
    this.restyle({ color: c });
    this.syncPalette();
  }

  private restyle(patch: Partial<Annot>): void {
    const id = this.annot.selected;
    const a = id ? this.annot.items.find((x) => x.id === id) : undefined;
    if (!a) return;
    const p: Partial<Annot> = {};
    if (patch.color) p.color = patch.color;
    if (patch.width && ['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(a.kind)) p.width = patch.width;
    if (patch.size && a.kind === 'freetext') p.size = patch.size;
    if (Object.keys(p).length) this.annot.update(a.id, p, 'Change style');
  }

  private syncPalette(): void {
    const id = this.annot.selected;
    const a = id ? this.annot.items.find((x) => x.id === id) : undefined;
    const c = (a?.color ?? this.annot.style.color).toUpperCase();
    for (const s of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-pdfwb-palette [data-color]'))) setClass(s, 'is-chosen', s.dataset.color === c);
  }

  private setSide(side: 'pages' | 'outline'): void {
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('[data-side]'))) setClass(b, 'is-on', b.dataset.side === side);
    setHidden(this.thumbs.root, side !== 'pages');
    setHidden(q(this.root, '.fs-pdfwb-outline'), side !== 'outline');
  }

  private onPage(n: number): void {
    if (this.reading) return;
    const input = q<HTMLInputElement>(this.root, '.fs-pdfwb-pagein');
    if (document.activeElement !== input) setValue(input, String(n));
    this.thumbs.setCurrent(n);
    if (this.tab === 'view') this.panes.syncDoc();
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    if (!this.dirty()) { await action(); return; }
    this.bar({
      text: `Save the changes to ${this.doc?.name ?? 'this PDF'} first?`,
      actions: [
        { label: 'Save', kind: 'primary', run: () => { this.hideBar(); void this.save().then((ok) => (ok ? action() : undefined)); } },
        { label: 'Discard changes', kind: 'danger', run: () => { this.hideBar(); this.discardStaged(); void action(); } },
        { label: 'Cancel', kind: 'ghost', run: () => this.hideBar() },
      ],
    });
  }

  private discardStaged(): void {
    this.annot.setItems([]);
    this.annot.setAreas([]);
    this.fields.discard();
    this.forms.discard();
    this.organizer.dirty = false;
    this.savedId = this.doc?.id ?? '';
  }

  private async pick(multiple: boolean): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,application/pdf';
      input.multiple = multiple;
      input.onchange = () => resolve(Array.from(input.files ?? []));
      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  }

  private async openFile(file: File): Promise<void> {
    await this.run(`Opening ${file.name}`, async () => this.adopt(await pdfApi.open(file, file.name)));
  }

  private async openRecent(id: string): Promise<void> {
    await this.run('Opening', async () => {
      const info = await pdfApi.info(id);
      await this.adopt({ id, name: info.name ?? 'document.pdf', pages: info.pages, info, key: info.key ?? id, path: info.path });
      const back = this.opts.restore;
      if (back && this.doc?.id === id) {
        this.opts = { ...this.opts, restore: undefined };
        if (TABS.some(([t]) => t === back.tab)) this.setTab(back.tab as Tab);
        if (back.page > 1) this.goPage(Math.min(back.page, info.pages));
        if (back.dirty) { this.savedId = ''; this.syncChrome(); }
      }
    });
  }

  private async adopt(o: Opened): Promise<void> {
    if (o.info.locked) {
      let pw = await this.askPassword(o.name, false);
      let res: Derived | null = null;
      while (pw !== null) {
        try { res = await pdfApi.unlock(o.id, pw); break; } catch { pw = await this.askPassword(o.name, true); }
      }
      if (!res) return;
      const info = await pdfApi.info(res.id);
      toast('Opened an unlocked working copy. Use Protect to add a password before saving if you need one.');
      await this.adopt({ id: res.id, name: o.name, pages: info.pages, info, key: o.key });
      return;
    }
    this.closeFind();
    this.annot.setItems([]);
    this.annot.setAreas([]);
    this.fields.reset();
    this.forms.reset();
    this.speaker.stop();
    if (this.comparer.result) this.comparer.set(null);
    this.history = [{ id: o.id, annots: [], label: 'Open' }];
    this.hi = 0;
    this.savedId = o.id;
    await this.show(o.id, o.name, o.info, false);
  }

  private async show(id: string, name: string, info: PdfInfo, keep: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    const sizes = (s: PdfInfo | undefined): string => (s ? s.sizes.map((z) => `${Math.round(z.w)}x${Math.round(z.h)}r${z.rotate}`).join(',') : '');
    const before = sizes(this.doc?.info);
    this.doc = { id, name, info, key: info.key ?? id };
    setText(q(this.root, '.fs-pdfwb-name'), name);
    setHidden(q(this.root, '.fs-pdfwb-empty'), true);
    setHidden(this.viewer.scroller, this.tab === 'organize' || this.reading);
    if (this.comparer.result && this.comparer.docId !== id && before !== sizes(info)) this.comparer.set(null);
    if (this.reading) void this.run('Preparing reading mode', () => this.reflow.show(id, info.pages, Math.min(this.reflow.currentPage(), info.pages)));
    try {
      await this.viewer.load(pdfApi.fileUrl(id), info.sizes, { password: this.passwords.get(id), keep, onPassword: (retry) => this.askPassword(name, retry) });
    } catch (err) {
      if (seq !== this.loadSeq) return;
      if (err instanceof Error && err.message === 'superseded') return;
      throw err;
    }
    if (seq !== this.loadSeq) return;
    this.thumbs.sync(info.sizes);
    this.thumbs.setCurrent(this.viewer.currentPage());
    this.renderOutline(info);
    setText(q(this.root, '.fs-pdfwb-pageof'), `of ${info.pages}`);
    setText(q(this.root, '.fs-pdfwb-count'), String(info.pages));
    setText(q(this.root, '.fs-pdfwb-stat'), `${info.pages} page${info.pages === 1 ? '' : 's'} · ${info.bytes >= 1048576 ? `${(info.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(info.bytes / 1024))} KB`}`);
    if (!this.organizer.dirty || this.organizer.docId === '') this.organizer.reset(id, info.sizes);
    if (this.tab === 'organize') { setHidden(this.organizer.root, false); setHidden(this.viewer.scroller, true); }
    if (this.fields.loadedFor && this.fields.loadedFor !== id) this.fields.reset(keep ? this.fields.pending() : {});
    if (this.tab === 'fill' || this.fields.dirty) void this.fields.load(id).catch(() => undefined);
    if (this.tab === 'form') void this.forms.load(id).catch(() => undefined);
    if (this.finder.query) void this.finder.search(this.finder.query);
    this.panes.syncDoc();
    this.syncChrome();
    this.syncView();
  }

  private renderOutline(info: PdfInfo): void {
    const host = q(this.root, '.fs-pdfwb-outline');
    const items = info.outline.map((o, i) => ({ ...o, i }));
    patchList(host, items, {
      key: (o) => `${o.i}|${o.title}|${o.page}`,
      create: (o) => el(`<button class="fs-pdfwb-ol" type="button" ${o.page ? `data-page="${o.page}"` : 'disabled'} style="padding-left:${10 + Math.min(o.level, 6) * 14}px" title="${escapeHtml(o.title)}"><span>${escapeHtml(o.title)}</span>${o.page ? `<span class="fs-pdfwb-olpage">${o.page}</span>` : ''}</button>`),
      update: () => undefined,
    });
    if (!items.length && !host.querySelector('.fs-empty')) host.appendChild(el(`<div class="fs-empty"><span class="fs-empty-title">No bookmarks</span><span class="fs-empty-note">This PDF has no outline.</span></div>`));
    else if (items.length) host.querySelector('.fs-empty')?.remove();
  }

  private async loadRecents(): Promise<void> {
    setHidden(q(this.root, '.fs-pdfwb-empty'), !!this.doc);
    setHidden(this.viewer.scroller, true);
    setHidden(this.organizer.root, true);
    let items: RecentItem[] = [];
    try { items = (await pdfApi.recent()).items; } catch { items = []; }
    const grid = q(this.root, '.fs-pdfwb-recent-grid');
    patchList(grid, items, {
      key: (it) => `${it.key}|${it.id}`,
      create: (it) => {
        const n = el(`<div class="fs-card fs-pdfwb-recent" role="button" tabindex="0" data-id="${escapeHtml(it.id)}" data-keyid="${escapeHtml(it.key)}"><span class="fs-card-preview fs-pdfwb-recent-prev"></span><span class="fs-card-body"><span class="fs-card-name"></span><span class="fs-card-meta"></span></span><button class="fs-icon-btn is-sm fs-pdfwb-forget" type="button" data-forget title="Remove from recents" aria-label="Remove from recents">${icon('close', 12)}</button></div>`);
        setText(n.querySelector('.fs-card-name'), it.name);
        setText(n.querySelector('.fs-card-meta'), `${it.pages} page${it.pages === 1 ? '' : 's'} · ${new Date(it.opened * 1000).toLocaleDateString()}`);
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => (n.querySelector('.fs-card-preview') as HTMLElement).appendChild(img);
        img.src = pdfApi.renderUrl(it.id, 1, 0.4);
        return n;
      },
      update: () => undefined,
    });
    setHidden(q(this.root, '.fs-pdfwb-recents'), !items.length);
  }

  private dirty(): boolean {
    if (!this.doc) return false;
    return this.doc.id !== this.savedId || this.annot.items.length > 0 || this.fields.dirty || this.organizer.dirty || this.annot.areas.length > 0 || this.forms.dirty;
  }

  private pushState(label: string): void {
    if (!this.doc) return;
    this.history = this.history.slice(0, this.hi + 1);
    this.history.push({ id: this.doc.id, annots: this.annot.items.slice(), label });
    if (this.history.length > 200) this.history.shift();
    this.hi = this.history.length - 1;
    this.panes.syncAnnots();
    this.syncChrome();
  }

  private async commit(res: Pick<Derived, 'id'>, label: string, turn?: string, agent?: string): Promise<void> {
    const d = this.doc;
    if (!d) return;
    const pw = this.passwords.get(d.id);
    if (pw && !this.passwords.has(res.id) && label !== 'Remove password') this.passwords.set(res.id, pw);
    const info = await pdfApi.info(res.id);
    const keep = this.annot.items.filter((a) => a.page <= info.pages);
    this.history = this.history.slice(0, this.hi + 1);
    this.history.push({ id: res.id, annots: keep, label, turn, agent });
    this.hi = this.history.length - 1;
    this.annot.setItems(keep);
    await this.show(res.id, d.name, info, true);
    this.panes.syncAnnots();
  }

  private async travel(to: number): Promise<void> {
    const target = this.history[to], d = this.doc;
    if (!target || !d) return;
    this.annot.commitEdit();
    this.hi = to;
    if (target.id !== d.id) {
      await this.run('Restoring', async () => {
        const info = await pdfApi.info(target.id);
        await this.show(target.id, d.name, info, true);
      });
    }
    this.annot.setItems(target.annots.slice());
    this.panes.syncAnnots();
    this.syncChrome();
  }

  private undo(): void {
    if (this.annot.isEditing) { this.annot.commitEdit(); return; }
    if (this.hi > 0) void this.travel(this.hi - 1);
  }

  private redo(): void { if (this.hi < this.history.length - 1) void this.travel(this.hi + 1); }

  private agentTarget(): number {
    const turn = this.history[this.hi]?.turn;
    if (!turn) return -1;
    let j = this.hi;
    while (j > 0 && this.history[j - 1].turn === turn) j -= 1;
    return j - 1;
  }

  async undoAgent(): Promise<AgentReply> {
    const to = this.agentTarget();
    if (to < 0) return { ok: false, text: this.history[this.hi]?.label ? `The last change in the window (${this.history[this.hi].label}) was made by the person, so there is no agent turn to undo.` : 'There is no agent turn to undo.' };
    const steps = this.hi - to;
    const label = this.history[this.hi].label;
    await this.travel(to);
    setHidden(q(this.root, '.fs-pdfwb-agent'), true);
    toast(`Undid the agent's turn (${steps} change${steps === 1 ? '' : 's'})`);
    return { ok: true, text: `Undid the last agent turn (${steps} change${steps === 1 ? '' : 's'}, last was ${label}). The window shows ${this.history[to].label === 'Open' ? 'the PDF as opened' : `the state after ${this.history[to].label}`}.`, data: { id: this.history[to].id, steps } };
  }

  async agentCommit(from: string, id: string, label: string, turn: string, agent: string): Promise<AgentReply> {
    const d = this.doc;
    if (!d) return { ok: false, text: 'No PDF is open in the formpdf window any more.' };
    if (d.id !== from) return { ok: false, text: `The PDF in the window changed while you worked (it is now ${d.name} at a newer version). Call get_context and retry.` };
    await this.run(label, () => this.commit({ id }, label, turn, agent));
    if (this.doc?.id !== id) return { ok: false, text: 'The window could not show the changed PDF.' };
    setText(q(this.root, '.fs-pdfwb-agentlabel'), `${agent} · ${label.replace(/^Agent:\s*/, '')}`);
    setHidden(q(this.root, '.fs-pdfwb-agent'), false);
    window.clearTimeout(this.agentTimer);
    this.agentTimer = window.setTimeout(() => setHidden(q(this.root, '.fs-pdfwb-agent'), true), 15000);
    this.syncChrome();
    return { ok: true, text: `The window now shows ${d.name} with ${label.replace(/^Agent:\s*/, '').toLowerCase()} (${this.doc?.info.pages ?? 0} pages). The person can undo your turn with Edit, Undo agent turn.`, data: { id, pages: this.doc?.info.pages ?? 0 } };
  }

  async agentOpen(id: string): Promise<AgentReply> {
    if (this.dirty()) return { ok: false, text: `The person has unsaved changes in ${this.doc?.name ?? 'the open PDF'}. Ask them to save or discard them first.` };
    const info = await pdfApi.info(id);
    const wasHidden = this.root.hidden;
    setHidden(this.root, false);
    if (wasHidden) this.opts.app.shown();
    await this.adopt({ id, name: info.name ?? 'document.pdf', pages: info.pages, info, key: info.key ?? id, path: info.path });
    return { ok: true, text: `Opened ${info.name ?? id} in the window (${info.pages} pages).`, data: { id, pages: info.pages } };
  }

  setApp(app: AppHooks): void { this.opts = { ...this.opts, app }; }

  get isOpen(): boolean { return !this.root.hidden; }

  get commands(): Commands { return this.cmds; }

  get hasDoc(): boolean { return !!this.doc; }

  private toolHost: ToolHost | null = null;
  private get host(): ToolHost {
    return (this.toolHost ??= {
      ctx: this.ctx(),
      forms: this.forms,
      doc: () => this.doc,
      setTab: (t) => this.setTab(t),
      useTool: (t) => {
        const prev = this.annot.custom;
        if (prev && prev !== t) { prev.cancel?.(); this.annot.custom = null; }
        this.annot.custom = t;
        this.setTool(t ? 'custom' : 'select');
        if (t) setText(q(this.root, '.fs-pdfwb-hint'), t.hint);
      },
      activeTool: () => (this.annot.tool === 'custom' ? this.annot.custom : null),
      bar: (text, choices) => this.bar({ text, tone: 'info', actions: choices.map((c) => ({ label: c.label, kind: c.kind, run: () => c.run() })) }),
      hideBar: () => this.hideBar(),
    });
  }

  agentSaved(id: string): void {
    if (this.doc?.id === id) { this.savedId = id; this.syncChrome(); }
  }

  state(): DocState | null {
    const d = this.doc;
    if (!d || this.root.hidden) return null;
    return { id: d.id, key: d.key, name: d.name, pages: d.info.pages, page: this.page(), dirty: this.dirty(), tab: this.tab, path: d.info.path ?? null, agentTurn: this.history[this.hi]?.turn ?? null };
  }

  private report(): void {
    const s = this.state();
    const key = JSON.stringify(s && { ...s, page: 0 });
    if (key === this.reported) return;
    this.reported = key;
    this.opts.app.doc(s);
  }

  private async flush(): Promise<string | null> {
    const d = this.doc;
    if (!d) return null;
    this.annot.commitEdit();
    if (this.annot.items.length) {
      const res = await pdfApi.annotate(d.id, this.annot.items, false);
      this.annot.select(null);
      this.annot.setItems([]);
      await this.commit(res, 'Apply comments');
    }
    if (this.fields.dirty && this.doc) {
      const res = await pdfApi.fill(this.doc.id, this.fields.pending(), false);
      this.fields.discard();
      await this.commit(res, 'Fill form');
    }
    if (this.forms.dirty && this.doc) {
      const problem = this.forms.problems();
      if (problem) throw new Error(problem);
      const res = await pdfApi.form(this.doc.id, this.forms.payload());
      this.forms.reset();
      await this.commit(res, 'Prepare form');
    }
    return this.doc?.id ?? null;
  }

  private async applyOrganize(): Promise<void> {
    const d = this.doc;
    if (!d || !this.organizer.dirty) return;
    if (!this.organizer.items.length) { toast('A PDF needs at least one page', 'error'); return; }
    await this.run('Applying page changes', async () => {
      const before = this.organizer.docId;
      const id = await this.flush() ?? d.id;
      const pages = this.organizer.payload().map((p) => ('src' in p && p.src === before ? { ...p, src: id } : p));
      const res = await pdfApi.organize(id, pages);
      this.organizer.dirty = false;
      await this.commit(res, 'Organize pages');
      this.organizer.reset(res.id, this.doc?.info.sizes ?? []);
      this.panes.syncOrganize();
    });
  }

  private async insertPdfs(files: File[], at: number): Promise<void> {
    if (!this.doc) { if (files[0]) await this.guard(() => this.openFile(files[0])); return; }
    await this.run('Adding pages', async () => {
      const made: Array<Omit<OrgItem, 'key'>> = [];
      for (const f of files) {
        const o = await pdfApi.open(f, f.name);
        if (o.info.locked) { toast(`${f.name} is password protected; unlock it first`, 'error'); continue; }
        o.info.sizes.forEach((s, i) => made.push({ src: o.id, page: i + 1, rotate: 0, w: s.w, h: s.h, base: s.rotate, from: f.name.replace(/\.pdf$/i, '') }));
      }
      if (made.length) {
        if (this.tab !== 'organize') this.setTab('organize');
        this.organizer.insert(made, at);
        toast(`${made.length} page${made.length === 1 ? '' : 's'} added. Apply changes to keep them.`);
      }
    });
  }

  private orgThumb(it: OrgItem): Promise<HTMLCanvasElement | string> {
    if (it.src === this.doc?.id && this.viewer.doc) return this.viewer.thumb(it.page - 1, 150);
    const scale = (160 / Math.max(it.w, it.h)) * Math.min(2, window.devicePixelRatio || 1);
    return Promise.resolve(pdfApi.renderUrl(it.src, it.page, scale));
  }

  private async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.busy += 1;
    if (this.busy === 1) {
      setText(q(this.root, '.fs-pdfwb-busy'), `${label}…`);
      const node = q(this.root, '.fs-st-busy');
      this.busyOff = delayedIndicator(() => node.classList.add('is-shown'), () => node.classList.remove('is-shown'));
    }
    try { return await fn(); } catch (err) {
      if (!(err instanceof Error && err.message === 'superseded')) toast(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return undefined;
    } finally {
      this.busy -= 1;
      if (this.busy === 0) { this.busyOff?.(); this.busyOff = null; }
    }
  }

  private async deliver(data: Blob | string, name: string): Promise<void> {
    const path = await deliver(data, name);
    if (path) toast(`Saved to ${path}`);
  }

  private async save(): Promise<boolean> {
    if (!this.doc) return false;
    const id = await this.run('Saving', () => this.flush());
    if (!id || !this.doc) return false;
    const d = this.doc;
    if (isTauri()) {
      let info: PdfInfo | null = null;
      try { info = await pdfApi.info(id); } catch { info = null; }
      const fallback = `~/Formpdf/Exports/${d.name}`;
      return new Promise((resolve) => {
        this.bar({
          text: 'Save as', tone: 'info',
          input: { type: 'text', value: info?.savePath || info?.path || fallback },
          actions: [
            { label: 'Save', kind: 'primary', run: (path) => {
              void this.run('Saving', async () => {
                const res = await pdfApi.save(id, path.trim() || fallback);
                this.hideBar();
                this.savedId = id;
                this.syncChrome();
                toast(`Saved to ${res.path}`);
                resolve(true);
              }).then((v) => { if (v === undefined) resolve(false); });
            } },
            { label: 'Cancel', kind: 'ghost', run: () => { this.hideBar(); resolve(false); } },
          ],
        });
      });
    }
    await deliver(pdfApi.fileUrl(id, true), d.name);
    this.savedId = id;
    this.syncChrome();
    return true;
  }

  private async print(): Promise<void> {
    if (!this.doc || this.printing) return;
    this.printing = true;
    const urls: string[] = [];
    const host = el('<div class="fs-pdf-print" aria-hidden="true"></div>');
    try {
      await this.run('Preparing to print', async () => {
        await this.flush();
        const doc = this.viewer.doc;
        if (!doc) return;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(150 / 72, 2400 / Math.max(base.width, base.height)) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, viewport, intent: 'print' }).promise;
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
          canvas.width = 0;
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const img = el<HTMLImageElement>(`<img alt="" src="${url}">`);
          if (viewport.width > viewport.height) img.classList.add('is-wide');
          host.appendChild(img);
        }
        document.body.appendChild(host);
        await Promise.all(Array.from(host.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)));
      });
      if (!host.isConnected) return;
      document.body.classList.add('fs-printing-pdf');
      if (isTauri()) {
        const done = new Promise<void>((r) => { window.addEventListener('afterprint', () => r(), { once: true }); window.setTimeout(r, 30000); });
        const core = await import('@tauri-apps/api/core');
        await core.invoke('print_window', { label: 'main' }).catch(() => window.print());
        await done;
      } else window.print();
    } finally {
      document.body.classList.remove('fs-printing-pdf');
      host.remove();
      for (const u of urls) URL.revokeObjectURL(u);
      this.printing = false;
    }
  }

  private close(): void {
    this.annot.commitEdit();
    if (!this.dirty()) { this.finishClose(); return; }
    this.bar({
      text: `Save the changes to ${this.doc?.name ?? 'this PDF'} before closing?`,
      actions: [
        { label: 'Save', kind: 'primary', run: () => { this.hideBar(); void this.save().then((ok) => { if (ok) this.finishClose(); }); } },
        { label: 'Close without saving', kind: 'danger', run: () => { this.hideBar(); this.finishClose(); } },
        { label: 'Cancel', kind: 'ghost', run: () => this.hideBar() },
      ],
    });
  }

  private finishClose(notify = true): void {
    this.hideBar();
    if (this.reading) this.setReading(false);
    this.speaker.stop();
    this.comparer.set(null);
    this.forms.reset();
    this.reflow.reset();
    this.closeFind();
    this.annot.setItems([]);
    this.annot.setAreas([]);
    this.annot.setCrop(null);
    this.fields.reset();
    this.viewer.close();
    this.thumbs.sync([]);
    this.organizer.reset('', []);
    this.doc = null;
    this.history = [];
    this.hi = -1;
    this.savedId = '';
    setText(q(this.root, '.fs-pdfwb-name'), 'PDF workbench');
    setText(q(this.root, '.fs-pdfwb-stat'), '');
    setHidden(q(this.root, '.fs-pdfwb-empty'), false);
    setHidden(this.root, true);
    this.setTab('view');
    this.syncChrome();
    if (notify) this.opts.app.home();
  }

  private openFind(query?: string): void {
    if (!this.doc) return;
    if (this.tab === 'organize') this.setTab('view');
    const box = q(this.root, '.fs-pdfwb-find'), input = q<HTMLInputElement>(box, 'input');
    setHidden(box, false);
    if (query !== undefined) { input.value = query; void this.finder.search(query); }
    input.focus();
    input.select();
  }

  private closeFind(): void {
    const box = q(this.root, '.fs-pdfwb-find');
    if (!box.hidden) { setHidden(box, true); this.root.focus({ preventScroll: true }); }
    if (this.finder.query) this.finder.clear();
  }

  private syncFind(): void {
    const f = this.finder;
    setText(q(this.root, '.fs-pdfwb-findcount'), !f.query.trim() ? '' : f.hits.length ? `${f.index + 1} of ${f.hits.length}${f.done ? '' : '+'}` : f.done ? 'No matches' : 'Searching…');
    for (const a of ['find-next', 'find-prev']) setDisabled(q<HTMLButtonElement>(this.root, `[data-a="${a}"]`), f.hits.length < 1);
  }

  private askPassword(name: string, retry: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      this.bar({
        text: retry ? 'That password did not work. Try again.' : `${name} is password protected. Enter its password to open it.`,
        input: { type: 'password', value: '' },
        actions: [
          { label: 'Open', kind: 'primary', run: (v) => { this.hideBar(); resolve(v); } },
          { label: 'Cancel', kind: 'ghost', run: () => { this.hideBar(); resolve(null); } },
        ],
      });
    });
  }

  private bar(o: { text: string; tone?: 'warn' | 'info'; input?: { type: 'text' | 'password'; value?: string }; actions: BarAction[] }): void {
    const bar = q(this.root, '.fs-pdfwb-bar');
    setText(q(bar, '.fs-pdfwb-bar-text'), o.text);
    setClass(bar, 'is-info', o.tone === 'info');
    const input = q<HTMLInputElement>(bar, '.fs-pdfwb-bar-input');
    setHidden(input, !o.input);
    if (o.input) { input.type = o.input.type; input.value = o.input.value ?? ''; }
    const acts = q(bar, '.fs-pdfwb-bar-actions');
    acts.replaceChildren(...o.actions.map((a) => {
      const b = el<HTMLButtonElement>(`<button class="fs-btn fs-btn-sm${a.kind ? ` fs-btn-${a.kind}` : ''}" type="button"></button>`);
      b.textContent = a.label;
      b.addEventListener('click', () => a.run(input.value));
      return b;
    }));
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); o.actions[0]?.run(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.actions[o.actions.length - 1]?.run(input.value); }
    };
    setHidden(bar, false);
    if (o.input) { input.focus(); input.select(); } else (acts.firstElementChild as HTMLElement | null)?.focus();
  }

  private hideBar(): void { setHidden(q(this.root, '.fs-pdfwb-bar'), true); }

  private openLink(url: string): void {
    let u: URL | null = null;
    try { u = new URL(url); } catch { u = null; }
    if (!u || !['http:', 'https:', 'mailto:'].includes(u.protocol) || (u.protocol === 'mailto:' && /[?&](attach|attachment)=/i.test(u.search))) {
      toast(`Not opened: ${url.slice(0, 80)} is not a web or email address formpdf opens.`, 'error');
      return;
    }
    const target = u;
    const host = target.protocol === 'mailto:' ? target.pathname.split('@').pop() ?? '' : target.hostname;
    const odd = /(^|\.)xn--/i.test(host);
    this.bar({
      text: odd ? `This address uses look-alike letters (${host}). Open ${target.href.slice(0, 100)} anyway?` : `Open ${target.href.slice(0, 120)}?`,
      tone: odd ? 'warn' : 'info',
      actions: [
        { label: target.protocol === 'mailto:' ? 'Write email' : 'Open', kind: 'primary', run: () => { this.hideBar(); window.open(target.href, '_blank', 'noopener,noreferrer'); } },
        { label: 'Copy address', run: () => { this.hideBar(); void navigator.clipboard?.writeText(target.href).then(() => toast('Copied the address')).catch(() => undefined); } },
        { label: 'Cancel', kind: 'ghost', run: () => this.hideBar() },
      ],
    });
  }

  private syncChrome(): void {
    syncTools(this.host);
    const has = !!this.doc;
    setClass(this.root, 'has-doc', has);
    const can = this.history[this.hi - 1], next = this.history[this.hi + 1];
    const undo = q<HTMLButtonElement>(this.root, '[data-a="undo"]'), redo = q<HTMLButtonElement>(this.root, '[data-a="redo"]');
    setDisabled(undo, !can);
    setDisabled(redo, !next);
    undo.title = this.history[this.hi] && can ? `Undo ${this.history[this.hi].label}` : 'Undo';
    redo.title = next ? `Redo ${next.label}` : 'Redo';
    for (const a of ['print', 'save']) setDisabled(q<HTMLButtonElement>(this.root, `.fs-pdfwb-actions [data-a="${a}"]`), !has);
    setClass(q(this.root, '.fs-pdfwb-edited'), 'is-off', !this.dirty());
    for (const s of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.fs-pdfwb-tab'))) setDisabled(s, !has && s.dataset.tab !== 'view');
    setDisabled(q<HTMLButtonElement>(this.root, '[data-a="org-apply"]'), !this.organizer.dirty);
    setDisabled(q<HTMLButtonElement>(this.root, '[data-a="org-reset"]'), !this.organizer.dirty);
    for (const a of ['org-delete']) setDisabled(q<HTMLButtonElement>(this.root, `.fs-pdfwb-tools [data-a="${a}"]`), !this.organizer.selected.size);
    setClass(q(this.root, '.fs-pdfwb-tab[data-tab="organize"]'), 'has-dot', this.organizer.dirty);
    setClass(q(this.root, '.fs-pdfwb-tab[data-tab="comment"]'), 'has-dot', this.annot.items.some((a) => !a.flatten));
    setClass(q(this.root, '.fs-pdfwb-tab[data-tab="fill"]'), 'has-dot', this.fields.dirty);
    setClass(q(this.root, '.fs-pdfwb-tab[data-tab="form"]'), 'has-dot', this.forms.dirty);
    setDisabled(q<HTMLButtonElement>(this.root, '.fs-pdfwb-tools [data-a="compare"]'), !has);
    this.report();
  }
}

let bench: Workbench | null = null;

export function openWorkbench(opts: WorkbenchOptions): Workbench {
  bench ??= new Workbench();
  bench.open(opts);
  return bench;
}

export function ensureWorkbench(app: AppHooks): Workbench {
  bench ??= new Workbench();
  bench.setApp(app);
  return bench;
}

export type { Workbench };
