import type { Command } from '../ui/commands';
import { el, patchList, q, setClass, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import type { MenuItem } from '../ui/menu';
import type { Panes, Tab, ThreadView } from './panels';
import { recall, remember } from './reading';

export interface Layout {
  side: 'left' | 'right'; sideOpen: boolean; sideW: number;
  panel: 'left' | 'right' | 'bottom' | 'float'; panelOpen: boolean; panelW: number; panelH: number;
  fx: number; fy: number; fh: number;
  notes: boolean; labels: boolean;
  tabs: Tab[] | null; sections: string[] | null; tab: Tab;
  /** Sections floating on their own over the pages, by section id: [left, top, width] in pixels. */
  floats?: Record<string, [number, number, number]>;
}
interface Store { current: string; edits: Record<string, Layout>; mine: Record<string, Layout> }
export interface WsHost { root: HTMLElement; panes: Panes; tab(): Tab; setTab(t: Tab): void; goPage(n: number): void; ask(text: string, value: string, done: (name: string) => void): void }

const KEY = 'fs-workspaces';
const SPLIT = 5;
const BASE: Layout = { side: 'left', sideOpen: true, sideW: 196, panel: 'right', panelOpen: true, panelW: 320, panelH: 280, fx: -1, fy: 120, fh: 560, notes: false, labels: false, tabs: null, sections: null, tab: 'view' };
export const BUILT_IN: Array<[string, string, Partial<Layout>]> = [
  ['all', 'All tools', {}],
  ['read', 'Read', { tabs: ['view'], panelOpen: false, tab: 'view' }],
  ['review', 'Review', { tabs: ['view', 'comment'], tab: 'comment', notes: true }],
  ['prepress', 'Prepress', { tabs: ['print'], tab: 'print', sections: ['print-preflight', 'output-preview', 'page-boxes'], panelW: 360 }],
  ['forms', 'Forms', { tabs: ['view', 'fill', 'form'], tab: 'form' }],
  ['access', 'Accessibility', { tabs: ['view', 'access'], tab: 'access' }],
];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

function read(): Store {
  try {
    const s = JSON.parse(recall(KEY) ?? '') as Store;
    if (s && typeof s.current === 'string' && s.edits && s.mine) return s;
  } catch { /* first run */ }
  return { current: 'all', edits: {}, mine: {} };
}

export class Workspaces {
  private store = read();
  private lay: Layout;
  private readonly main: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private drag: { kind: 'a' | 'b' | 'grip' | 'sec'; x: number; y: number; w: number; h: number; fx: number; fy: number; sec?: string } | null = null;
  private threads: ThreadView[] = [];
  onChange: (() => void) | null = null;

  constructor(private readonly host: WsHost) {
    this.lay = this.layoutOf(this.store.current);
    this.main = q(host.root, '.fs-pdfwb-main');
    const side = q(this.main, '.fs-pdfwb-side');
    const panel = q(this.main, '.fs-pdfwb-panel');
    side.after(el(`<div class="fs-ws-split" data-split="a" role="separator" aria-orientation="vertical" aria-label="Resize the page list" title="Drag to resize, double-click to hide or show"></div>`));
    panel.before(el(`<div class="fs-ws-split" data-split="b" role="separator" aria-label="Resize the panel" title="Drag to resize, double-click to hide or show"></div>`));
    panel.prepend(el(`<div class="fs-ws-grip"><span class="fs-ws-grip-name"></span><button class="fs-icon-btn is-sm" type="button" data-ws="dock" title="Dock on the right" aria-label="Dock on the right">${icon('panelProps', 12)}</button></div>`));
    this.notes = el(`<section class="fs-ws-notes" aria-label="Comments"><div class="fs-ws-notes-head"><span>Comments</span><span class="fs-strip-count fs-ws-notes-count"></span></div><div class="fs-ws-notes-list"></div><p class="fs-note fs-ws-notes-empty">No comments in this PDF.</p></section>`);
    side.appendChild(this.notes);
    this.btn = el<HTMLButtonElement>(`<button class="fs-tt-btn fs-ws-btn" type="button" data-a="ws-menu" title="Workspace" aria-haspopup="menu">${icon('layout', 14)}<span class="fs-ws-btn-name"></span>${icon('chevronDown', 10)}</button>`);
    q(host.root, '.fs-pdfwb-tools').appendChild(this.btn);
    host.panes.onThreads = (list) => { this.threads = list; this.syncNotes(); };
    this.wire();
    this.apply();
  }

  get button(): HTMLButtonElement { return this.btn; }
  get current(): string { return this.store.current; }

  private layoutOf(id: string): Layout {
    const edit = this.store.edits[id];
    if (edit) return { ...BASE, ...edit };
    if (id.startsWith('u:') && this.store.mine[id]) return { ...BASE, ...this.store.mine[id] };
    const b = BUILT_IN.find(([k]) => k === id);
    return { ...BASE, ...(b ? b[2] : {}) };
  }

  name(id = this.store.current): string {
    return id.startsWith('u:') ? id.slice(2) : BUILT_IN.find(([k]) => k === id)?.[1] ?? 'All tools';
  }

  private save(): void {
    if (this.store.current.startsWith('u:')) this.store.mine[this.store.current] = this.lay;
    else this.store.edits[this.store.current] = this.lay;
    remember(KEY, JSON.stringify(this.store));
  }

  private set(patch: Partial<Layout>, keep = true): void {
    this.lay = { ...this.lay, ...patch };
    this.apply();
    if (keep) this.save();
  }

  use(id: string): Record<string, unknown> {
    const known = BUILT_IN.some(([k]) => k === id) || !!this.store.mine[id];
    if (!known) throw new Error(`no workspace ${id}; workspaces: ${this.ids().map((i) => this.name(i)).join(', ')}`);
    this.store.current = id;
    this.lay = this.layoutOf(id);
    remember(KEY, JSON.stringify(this.store));
    this.apply();
    if (this.lay.tabs && !this.lay.tabs.includes(this.host.tab())) this.host.setTab(this.lay.tab);
    else if (id !== 'all') this.host.setTab(this.lay.tab);
    return { workspace: this.name(id), tabs: this.lay.tabs ?? 'all' };
  }

  ids(): string[] { return [...BUILT_IN.map(([k]) => k), ...Object.keys(this.store.mine)]; }

  saveAs(name: string): Record<string, unknown> {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('A workspace needs a name');
    if (BUILT_IN.some(([, l]) => l.toLowerCase() === clean.toLowerCase())) throw new Error(`${clean} is a built-in workspace; choose another name`);
    const id = `u:${clean}`;
    this.store.mine[id] = { ...this.lay, tab: this.host.tab() };
    this.store.current = id;
    remember(KEY, JSON.stringify(this.store));
    this.apply();
    this.onChange?.();
    return { workspace: clean, id: slug(clean) };
  }

  reset(): void {
    const id = this.store.current;
    if (id.startsWith('u:')) return;
    delete this.store.edits[id];
    remember(KEY, JSON.stringify(this.store));
    this.lay = this.layoutOf(id);
    this.apply();
  }

  remove(): void {
    const id = this.store.current;
    if (!id.startsWith('u:')) return;
    delete this.store.mine[id];
    delete this.store.edits[id];
    this.use('all');
    this.onChange?.();
  }

  menuItems(): MenuItem[] {
    const mine = Object.keys(this.store.mine).map((id) => `ws-u-${slug(id.slice(2))}`);
    return [...BUILT_IN.map(([k]) => `ws-${k}`), ...(mine.length ? ['-' as const, ...mine] : []), '-', 'ws-save', 'ws-reset', 'ws-delete', '-',
      'ws-side', 'ws-panel', 'ws-notes', 'ws-labels', '-', { label: 'Panel position', items: ['ws-panel-right', 'ws-panel-left', 'ws-panel-bottom', 'ws-panel-float'] }, { label: 'Page list position', items: ['ws-side-left', 'ws-side-right'] }];
  }

  commands(): Command[] {
    const g = 'Workspace';
    return [
      ...BUILT_IN.map(([k, l]): Command => ({ id: `ws-${k}`, label: `${l} workspace`, group: g, words: ['workspace', 'layout', l.toLowerCase()], checked: () => this.store.current === k, run: () => this.use(k) })),
      { id: 'ws-use', label: 'Switch workspace…', group: g, words: ['workspace', 'layout'], when: 'Use to arrange the window for a task: All tools, Read, Review, Prepress, Forms, Accessibility or a saved workspace.', params: { name: { type: 'string', required: true, description: 'workspace name' } }, run: (p) => { const want = String(p?.name ?? '').toLowerCase(); const id = this.ids().find((i) => this.name(i).toLowerCase() === want || i === want); if (!id) throw new Error(`no workspace ${p?.name}; workspaces: ${this.ids().map((i) => this.name(i)).join(', ')}`); return this.use(id); } },
      { id: 'ws-save', label: 'Save workspace as…', group: g, words: ['save layout', 'custom workspace'], params: { name: { type: 'string', description: 'name for the new workspace; asked for when left out' } }, run: (p) => { if (typeof p?.name === 'string') return this.saveAs(p.name); this.host.ask('Name for this workspace', this.store.current.startsWith('u:') ? this.name() : '', (n) => { this.saveAs(n); }); return null; } },
      { id: 'ws-reset', label: 'Reset this workspace', group: g, enabled: () => !this.store.current.startsWith('u:') && !!this.store.edits[this.store.current], why: () => 'Nothing changed in this workspace', run: () => this.reset() },
      { id: 'ws-delete', label: 'Delete this workspace', group: g, risky: true, enabled: () => this.store.current.startsWith('u:'), why: () => 'Built-in workspaces cannot be deleted', run: () => this.remove() },
      { id: 'ws-side', label: 'Page list', group: g, words: ['thumbnails', 'sidebar', 'page thumbnails'], checked: () => this.lay.sideOpen, run: () => this.set({ sideOpen: !this.lay.sideOpen }) },
      { id: 'ws-panel', label: 'Panel', group: g, words: ['properties', 'tool panel', 'right panel'], checked: () => this.lay.panelOpen, run: () => this.set({ panelOpen: !this.lay.panelOpen }) },
      { id: 'ws-notes', label: 'Comments under the page list', group: g, words: ['comments and thumbnails', 'comment list'], checked: () => this.lay.notes, run: () => this.set({ notes: !this.lay.notes, sideOpen: true }) },
      { id: 'ws-labels', label: 'Labels on toolbar buttons', group: g, words: ['icon labels', 'button text'], checked: () => this.lay.labels, run: () => this.set({ labels: !this.lay.labels }) },
      ...(['right', 'left', 'bottom', 'float'] as const).map((w): Command => ({ id: `ws-panel-${w}`, label: w === 'float' ? 'Floating' : w === 'bottom' ? 'Bottom' : w === 'left' ? 'Left' : 'Right', group: g, words: ['panel position', 'dock panel'], checked: () => this.lay.panel === w, run: () => this.set({ panel: w, panelOpen: true }) })),
      ...(['left', 'right'] as const).map((w): Command => ({ id: `ws-side-${w}`, label: w === 'left' ? 'Left' : 'Right', group: g, words: ['page list position'], checked: () => this.lay.side === w, run: () => this.set({ side: w, sideOpen: true }) })),
    ];
  }

  customCommands(): Command[] {
    return Object.keys(this.store.mine).map((id): Command => ({ id: `ws-u-${slug(id.slice(2))}`, label: `${id.slice(2)} workspace`, group: 'Workspace', words: ['workspace'], checked: () => this.store.current === id, enabled: () => !!this.store.mine[id], run: () => this.use(id) }));
  }

  refresh(): void {
    const l = this.lay;
    const panes = this.host.panes.root;
    for (const pane of Array.from(panes.querySelectorAll<HTMLElement>('.fs-pdfwb-pane'))) {
      const secs = Array.from(pane.querySelectorAll<HTMLElement>(':scope > .fs-pdfwb-sec'));
      const listed = l.sections && secs.some((s) => l.sections!.includes(s.dataset.section ?? ''));
      for (const s of secs) setClass(s, 'is-ws-off', !!listed && !l.sections!.includes(s.dataset.section ?? ''));
    }
    for (const b of Array.from(this.host.root.querySelectorAll<HTMLElement>('.fs-pdfwb-tab'))) setClass(b, 'is-ws-off', !!l.tabs && !l.tabs.includes(b.dataset.tab as Tab));
    this.syncFloats();
  }

  /**
   * A section with an id can float on its own: it stays where it is in the panel's DOM (so its tool's listeners keep
   * working) and is placed with position: fixed, which escapes the panel's scrolling. It shows while its tab is open.
   */
  private syncFloats(): void {
    const floats = this.lay.floats ?? {};
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const s of Array.from(this.host.panes.root.querySelectorAll<HTMLElement>('.fs-pdfwb-sec[data-section]'))) {
      const id = s.dataset.section ?? '';
      const head = s.querySelector<HTMLElement>(':scope > .fs-pdfwb-sec-title');
      if (head && !head.querySelector('[data-ws="pop"]')) {
        head.appendChild(el(`<button class="fs-icon-btn is-sm fs-ws-pop" type="button" data-ws="pop" title="Float this section over the pages" aria-label="Float this section over the pages">${icon('maximize', 12)}</button>`));
      }
      const f = floats[id];
      setClass(s, 'is-ws-float', !!f);
      const style = f ? `--sec-x:${clamp(f[0], 0, Math.max(0, vw - 160))}px;--sec-y:${clamp(f[1], 0, Math.max(0, vh - 60))}px;--sec-w:${clamp(f[2], 240, 640)}px` : '';
      if ((s.getAttribute('style') ?? '') !== style) { if (style) s.setAttribute('style', style); else s.removeAttribute('style'); }
      const pop = head?.querySelector<HTMLElement>('[data-ws="pop"]');
      const label = f ? 'Put this section back in the panel' : 'Float this section over the pages';
      if (pop && pop.title !== label) { pop.title = label; pop.setAttribute('aria-label', label); pop.innerHTML = icon(f ? 'panelProps' : 'maximize', 12); }
    }
  }

  private toggleFloat(s: HTMLElement): void {
    const id = s.dataset.section ?? '';
    const floats = { ...(this.lay.floats ?? {}) };
    if (floats[id]) delete floats[id];
    else {
      const r = s.getBoundingClientRect();
      floats[id] = [Math.round(r.left - Math.min(r.width, 360) - 24), Math.round(r.top), Math.round(Math.min(Math.max(r.width, 280), 420))];
    }
    this.set({ floats });
  }

  private apply(): void {
    const l = this.lay;
    const vw = Math.max(640, window.innerWidth);
    const sw = l.sideOpen ? clamp(l.sideW, 120, Math.min(560, vw / 3)) : 0;
    const pw = l.panelOpen ? clamp(l.panelW, 240, Math.min(760, vw / 2)) : 0;
    const docked = l.panel !== 'float' && l.panel !== 'bottom';
    const left: Array<[string, string]> = [], right: Array<[string, string]> = [];
    if (l.side === 'left') left.push(['ws-s', `${sw}px`], ['ws-a', `${SPLIT}px`]);
    if (docked && l.panel === 'left') left.push(['ws-p', `${pw}px`], ['ws-b', `${SPLIT}px`]);
    if (docked && l.panel === 'right') right.push(['ws-b', `${SPLIT}px`], ['ws-p', `${pw}px`]);
    if (l.side === 'right') right.push(['ws-a', `${SPLIT}px`], ['ws-s', `${sw}px`]);
    const colsList = [...left, ['ws-c', 'minmax(0, 1fr)'] as [string, string], ...right];
    const bottom = l.panel === 'bottom';
    const ph = l.panelOpen ? clamp(l.panelH, 160, 640) : 0;
    const rows = bottom ? ['ws-c', 'ws-b', 'ws-p'] : ['ws-c'];
    const areas = rows.map((r) => `"${colsList.map(([n]) => (n === 'ws-c' ? r : n)).join(' ')}"`).join(' ');
    const fw = clamp(pw || l.panelW, 240, 760), fh = clamp(l.fh, 200, Math.max(200, window.innerHeight - 80));
    const fx = l.fx < 0 ? vw - fw - 24 : clamp(l.fx, 0, Math.max(0, vw - 120)), fy = clamp(l.fy, 0, Math.max(0, window.innerHeight - 80));
    const style = `--ws-cols:${colsList.map(([, s]) => s).join(' ')};--ws-rows:${bottom ? `minmax(0, 1fr) ${SPLIT}px ${ph}px` : 'minmax(0, 1fr)'};--ws-areas:${areas};--ws-fx:${fx}px;--ws-fy:${fy}px;--ws-fw:${fw}px;--ws-fh:${fh}px`;
    if (this.main.getAttribute('style') !== style) this.main.setAttribute('style', style);
    const data: Record<string, string> = { ws: this.store.current.startsWith('u:') ? 'mine' : this.store.current, wsSide: l.side, wsPanel: l.panel };
    for (const [k, v] of Object.entries(data)) if (this.main.dataset[k] !== v) this.main.dataset[k] = v;
    setClass(this.main, 'is-side-off', !l.sideOpen);
    setClass(this.main, 'is-panel-off', !l.panelOpen);
    setClass(this.main, 'has-notes', l.notes);
    if (l.labels) { if (this.host.root.dataset.labels !== '1') this.host.root.dataset.labels = '1'; } else if (this.host.root.dataset.labels) delete this.host.root.dataset.labels;
    setText(q(this.btn, '.fs-ws-btn-name'), this.name());
    setText(q(this.main, '.fs-ws-grip-name'), this.name());
    this.host.panes.wantComments = l.notes;
    if (l.notes) this.host.panes.comments();
    this.refresh();
    this.syncNotes();
  }

  private syncNotes(): void {
    setHidden(this.notes, !this.lay.notes);
    if (!this.lay.notes) return;
    setText(q(this.notes, '.fs-ws-notes-count'), this.threads.length ? String(this.threads.length) : '');
    setHidden(q(this.notes, '.fs-ws-notes-empty'), this.threads.length > 0);
    patchList(q(this.notes, '.fs-ws-notes-list'), this.threads, {
      key: (t) => t.key,
      create: (t) => this.note(el(`<button class="fs-ws-note" type="button"><span class="fs-pdfwb-dot"></span><span class="fs-ws-note-text"><span class="fs-ws-note-title"></span><span class="fs-ws-note-sub"></span></span></button>`), t),
      update: (n, t) => { this.note(n, t); },
    });
  }

  private note(n: HTMLElement, t: ThreadView): HTMLElement {
    if (n.dataset.page !== String(t.page)) n.dataset.page = String(t.page);
    const dot = q(n, '.fs-pdfwb-dot');
    if (dot.style.background !== t.color) dot.style.background = t.color;
    setText(q(n, '.fs-ws-note-title'), t.title);
    setText(q(n, '.fs-ws-note-sub'), t.sub);
    setClass(n, 'is-selected', t.open);
    return n;
  }

  private wire(): void {
    this.notes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.fs-ws-note');
      if (b?.dataset.page) this.host.goPage(Number(b.dataset.page));
    });
    this.main.addEventListener('dblclick', (e) => {
      const s = (e.target as HTMLElement).closest<HTMLElement>('.fs-ws-split');
      if (!s) return;
      if (s.dataset.split === 'a') this.set({ sideOpen: !this.lay.sideOpen });
      else this.set({ panelOpen: !this.lay.panelOpen });
    });
    this.main.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-ws="dock"]')) this.set({ panel: 'right', panelOpen: true });
      const pop = (e.target as HTMLElement).closest<HTMLElement>('[data-ws="pop"]');
      const sec = pop?.closest<HTMLElement>('.fs-pdfwb-sec[data-section]');
      if (sec) this.toggleFloat(sec);
    });
    this.main.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      const head = !t.closest('button') ? t.closest<HTMLElement>('.fs-pdfwb-sec.is-ws-float > .fs-pdfwb-sec-title') : null;
      const fs = head?.parentElement;
      if (head && fs && e.button === 0) {
        const id = fs.dataset.section ?? '';
        const f = this.lay.floats?.[id];
        if (!f) return;
        this.drag = { kind: 'sec', x: e.clientX, y: e.clientY, w: f[2], h: 0, fx: f[0], fy: f[1], sec: id };
        head.setPointerCapture(e.pointerId);
        this.main.classList.add('is-sizing');
        e.preventDefault();
        return;
      }
      const s = t.closest<HTMLElement>('.fs-ws-split');
      const grip = !s && !t.closest('button') ? t.closest<HTMLElement>('.fs-ws-grip') : null;
      if ((!s && !grip) || e.button !== 0) return;
      const kind = s ? (s.dataset.split as 'a' | 'b') : 'grip';
      const cs = getComputedStyle(this.main);
      this.drag = { kind, x: e.clientX, y: e.clientY, w: kind === 'a' ? this.lay.sideW : this.lay.panelW, h: this.lay.panelH, fx: parseFloat(cs.getPropertyValue('--ws-fx')), fy: parseFloat(cs.getPropertyValue('--ws-fy')) };
      if (kind === 'a' && !this.lay.sideOpen) this.drag.w = 0;
      if (kind === 'b' && !this.lay.panelOpen) { this.drag.w = 0; this.drag.h = 0; }
      (s ?? grip)!.setPointerCapture(e.pointerId);
      this.main.classList.add('is-sizing');
      e.preventDefault();
    });
    this.main.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (d.kind === 'sec' && d.sec) { this.set({ floats: { ...(this.lay.floats ?? {}), [d.sec]: [d.fx + dx, d.fy + dy, d.w] } }, false); return; }
      if (d.kind === 'grip') { this.set({ fx: d.fx + dx, fy: d.fy + dy }, false); return; }
      if (d.kind === 'a') { const w = d.w + (this.lay.side === 'left' ? dx : -dx); this.set(w < 80 ? { sideOpen: false } : { sideOpen: true, sideW: w }, false); return; }
      if (this.lay.panel === 'bottom') { const h = d.h - dy; this.set(h < 100 ? { panelOpen: false } : { panelOpen: true, panelH: h }, false); return; }
      const w = d.w + (this.lay.panel === 'left' ? dx : -dx);
      this.set(w < 140 ? { panelOpen: false } : { panelOpen: true, panelW: w }, false);
    });
    const end = (): void => { if (!this.drag) return; this.drag = null; this.main.classList.remove('is-sizing'); this.save(); };
    this.main.addEventListener('pointerup', end);
    this.main.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.apply());
  }
}
