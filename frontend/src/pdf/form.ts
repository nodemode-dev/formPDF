import { el, escapeHtml, patchList, q, setClass, setDisabled, setHidden, setText, setValue } from '../ui/dom';
import { icon } from '../ui/icons';
import { pdfApi, type Field, type NewField, type NewFieldType } from './api';
import { uid } from './annotate';
import type { PageView, Viewer } from './viewer';

export const FIELD_LABEL: Record<NewFieldType, string> = {
  text: 'Text field', multiline: 'Multi-line text', checkbox: 'Check box', radio: 'Radio button', dropdown: 'Dropdown', listbox: 'List box', date: 'Date field', signature: 'Signature field',
};
const EXISTING_LABEL: Record<string, string> = { text: 'Text field', checkbox: 'Check box', radio: 'Radio button', choice: 'Choice', button: 'Button', signature: 'Signature field' };
const PREFIX: Record<NewFieldType, string> = { text: 'Text', multiline: 'Text', checkbox: 'Check Box', radio: 'Group', dropdown: 'Dropdown', listbox: 'List Box', date: 'Date', signature: 'Signature' };
const SIZE: Record<NewFieldType, [number, number]> = { text: [160, 22], multiline: [220, 64], checkbox: [14, 14], radio: [14, 14], dropdown: [140, 22], listbox: [140, 64], date: [110, 22], signature: [180, 40] };
export const FIELD_TYPES: NewFieldType[] = ['text', 'multiline', 'checkbox', 'radio', 'dropdown', 'listbox', 'date', 'signature'];
export const FIELD_ICON: Record<NewFieldType, string> = { text: 'fieldText', multiline: 'fieldMulti', checkbox: 'fieldCheck', radio: 'fieldRadio', dropdown: 'fieldDropdown', listbox: 'fieldList', date: 'fieldDate', signature: 'signature' };
const DATE_FORMATS = ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'd mmmm yyyy', 'mmm d, yyyy'];
const TEXTY = new Set<NewFieldType>(['text', 'multiline', 'date', 'dropdown', 'listbox']);
const calc = (v: number): string => `calc(var(--k) * ${Math.round(v * 100) / 100}px)`;

export interface FormHooks { changed(): void; select(): void; toolDone(): void }
interface Drag { kind: 'draw' | 'move' | 'resize'; pv: PageView; x0: number; y0: number; id?: string; base?: { x: number; y: number; w: number; h: number }; node: HTMLElement; moved: boolean }
interface Item { key: string; draft?: NewField; field?: Field }

export class FormBuilder {
  drafts: NewField[] = [];
  existing: Field[] = [];
  renames = new Map<string, string>();
  deletes = new Set<string>();
  loadedFor = '';
  selected: string | null = null;
  readonly group = new Set<string>();
  tool: NewFieldType | null = null;
  active = false;
  private layers = new Map<number, HTMLElement>();
  private drag: Drag | null = null;
  private lastRadio = '';

  constructor(private readonly viewer: Viewer, private readonly hooks: FormHooks) {
    const host = viewer.host;
    host.addEventListener('pointerdown', (e) => this.down(e));
    host.addEventListener('pointermove', (e) => this.move(e));
    host.addEventListener('pointerup', (e) => this.up(e));
    host.addEventListener('pointercancel', () => this.cancel());
  }

  get dirty(): boolean { return this.drafts.length > 0 || this.renames.size > 0 || this.deletes.size > 0; }

  async load(id: string): Promise<void> {
    if (this.loadedFor === id) return;
    const res = await pdfApi.fields(id);
    if (this.loadedFor && this.loadedFor !== id) { this.renames.clear(); this.deletes.clear(); }
    this.existing = res.fields.filter((f) => f.type !== 'button');
    this.loadedFor = id;
    if (this.selected?.startsWith('x:') && !this.existing.some((f) => `x:${f.name}` === this.selected)) this.selected = null;
    this.renderAll();
    this.hooks.changed();
    this.hooks.select();
  }

  reset(): void {
    this.drafts = [];
    this.existing = [];
    this.renames.clear();
    this.deletes.clear();
    this.loadedFor = '';
    this.selected = null;
    this.lastRadio = '';
    this.renderAll();
  }

  discard(): void {
    this.drafts = [];
    this.renames.clear();
    this.deletes.clear();
    this.selected = null;
    this.lastRadio = '';
    this.renderAll();
    this.hooks.changed();
    this.hooks.select();
  }

  setActive(on: boolean): void {
    this.active = on;
    this.viewer.setClass('is-forming', on);
    if (!on) { this.tool = null; this.cancel(); }
  }

  setTool(t: NewFieldType | null): void { this.tool = t; if (t) this.select(null); }

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el('<div class="fs-pdf-forms"></div>');
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.render(pv.index);
  }

  renderAll(): void { for (const i of this.layers.keys()) this.render(i); }

  get draft(): NewField | undefined { return this.drafts.find((d) => d.id === this.selected); }
  get field(): Field | undefined { return this.selected?.startsWith('x:') ? this.existing.find((f) => `x:${f.name}` === this.selected) : undefined; }

  liveNames(except?: string): Set<string> {
    const out = new Set<string>();
    for (const f of this.existing) if (!this.deletes.has(f.name)) out.add(this.renames.get(f.name) ?? f.name);
    for (const d of this.drafts) if (d.id !== except) out.add(d.name);
    return out;
  }

  private suggest(type: NewFieldType): string {
    const names = this.liveNames();
    for (let n = 1; ; n++) { const cand = `${PREFIX[type]}${n}`; if (!names.has(cand)) return cand; }
  }

  chosen(): NewField[] {
    return this.drafts.filter((d) => d.id === this.selected || this.group.has(d.id));
  }

  select(key: string | null): void {
    if (!key && this.group.size) { this.group.clear(); this.renderAll(); }
    if (this.selected === key) return;
    const prev = this.selected;
    this.selected = key;
    for (const k of [prev, key]) { const p = this.pageOf(k); if (p) this.render(p - 1); }
    this.hooks.select();
  }

  private pageOf(key: string | null): number {
    if (!key) return 0;
    if (key.startsWith('x:')) return this.existing.find((f) => `x:${f.name}` === key)?.page ?? 0;
    return this.drafts.find((d) => d.id === key)?.page ?? 0;
  }

  add(type: NewFieldType, page: number, box: { x: number; y: number; w: number; h: number }): NewField {
    let name = this.suggest(type), exp = 'Choice1';
    if (type === 'radio' && this.lastRadio && this.drafts.some((d) => d.type === 'radio' && d.name === this.lastRadio)) {
      name = this.lastRadio;
      const used = new Set(this.drafts.filter((d) => d.type === 'radio' && d.name === name).map((d) => d.export));
      for (let n = 1; ; n++) if (!used.has(`Choice${n}`)) { exp = `Choice${n}`; break; }
    }
    this.lastRadio = type === 'radio' ? name : '';
    const f: NewField = {
      id: uid('f'), type, page, ...box, name, tooltip: '', required: false, readonly: false, value: '', checked: false,
      options: type === 'dropdown' || type === 'listbox' ? ['Option 1', 'Option 2', 'Option 3'] : [], export: exp, dateFormat: 'dd/mm/yyyy', fontSize: 0, align: 'left',
    };
    this.drafts = [...this.drafts, f];
    this.selected = f.id;
    this.render(page - 1);
    this.hooks.changed();
    this.hooks.select();
    return f;
  }

  update(id: string, patch: Partial<NewField>): void {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return;
    const next = { ...d, ...patch };
    if (d.type === 'radio' && patch.checked) this.drafts = this.drafts.map((x) => (x.type === 'radio' && x.name === d.name && x.id !== id ? { ...x, checked: false } : x));
    this.drafts = this.drafts.map((x) => (x.id === id ? next : x));
    if (d.type === 'radio' && patch.name !== undefined) this.lastRadio = next.name;
    for (const p of new Set([d.page, next.page])) this.render(p - 1);
    this.hooks.changed();
  }

  remove(id: string): void {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return;
    this.drafts = this.drafts.filter((x) => x.id !== id);
    if (this.selected === id) this.selected = null;
    this.render(d.page - 1);
    this.hooks.changed();
    this.hooks.select();
  }

  rename(name: string, next: string): void {
    const v = next.trim();
    if (!v || v === name) this.renames.delete(name); else this.renames.set(name, v);
    for (const f of this.existing.filter((x) => x.name === name)) this.render(f.page - 1);
    this.hooks.changed();
  }

  toggleDelete(name: string): void {
    if (this.deletes.has(name)) this.deletes.delete(name); else this.deletes.add(name);
    for (const f of this.existing.filter((x) => x.name === name)) this.render(f.page - 1);
    this.hooks.changed();
    this.hooks.select();
  }

  removeSelected(): boolean {
    const d = this.draft;
    if (d) { this.remove(d.id); return true; }
    const f = this.field;
    if (f) { this.toggleDelete(f.name); return true; }
    return false;
  }

  reveal(key: string): void {
    const p = this.pageOf(key);
    if (!p) return;
    const box = key.startsWith('x:') ? this.existing.find((f) => `x:${f.name}` === key) : this.drafts.find((d) => d.id === key);
    if (box) this.viewer.scrollToPoint(p - 1, box.x + box.w / 2, box.y);
    this.select(key);
  }

  problems(): string | null {
    const seen = new Map<string, NewFieldType>();
    for (const d of this.drafts) {
      if (!d.name.trim() || d.name.includes('.')) { this.reveal(d.id); return 'Every field needs a name without dots.'; }
      const prev = seen.get(d.name);
      if (prev && !(prev === 'radio' && d.type === 'radio')) { this.reveal(d.id); return `Two fields are called ${d.name}. Give each a different name.`; }
      seen.set(d.name, d.type);
      if ((d.type === 'dropdown' || d.type === 'listbox') && !d.options.length) { this.reveal(d.id); return `${d.name} needs at least one option.`; }
    }
    for (const f of this.existing) {
      if (this.deletes.has(f.name)) continue;
      const shown = this.renames.get(f.name) ?? f.name;
      const clash = this.drafts.find((x) => x.name === shown);
      if (clash) { this.reveal(clash.id); return `A field called ${shown} is already in this PDF.`; }
    }
    return null;
  }

  payload(): { create: Array<Omit<NewField, 'id'>>; rename: Record<string, string>; delete: string[] } {
    const rename: Record<string, string> = {};
    for (const [k, v] of this.renames) if (!this.deletes.has(k)) rename[k] = v;
    return { create: this.drafts.map(({ id: _id, ...rest }) => rest), rename, delete: [...this.deletes] };
  }

  private render(index: number): void {
    const layer = this.layers.get(index);
    if (!layer) return;
    const list: Item[] = [
      ...this.existing.map((f, i) => ({ f, i })).filter((x) => x.f.page === index + 1).map((x) => ({ key: `x${this.loadedFor}|${x.i}`, field: x.f })),
      ...this.drafts.filter((d) => d.page === index + 1).map((d) => ({ key: d.id, draft: d })),
    ];
    patchList(layer, list, {
      key: (it) => it.key,
      create: (it) => { const n = el('<div class="fs-pdf-fbox"><span class="fs-pdf-fname"></span></div>'); this.paint(n, it); return n; },
      update: (n, it) => this.paint(n, it),
    });
  }

  private paint(n: HTMLElement, it: Item): void {
    const b = it.draft ?? (it.field as Field);
    const css = `left:${calc(b.x)};top:${calc(b.y)};width:${calc(b.w)};height:${calc(b.h)}`;
    if (n.getAttribute('style') !== css && !(this.drag && this.drag.node === n)) n.setAttribute('style', css);
    const type = it.draft ? it.draft.type : (it.field as Field).type;
    if (n.dataset.type !== type) n.dataset.type = type;
    const key = it.draft ? it.draft.id : `x:${(it.field as Field).name}`;
    if (n.dataset.id !== key) n.dataset.id = key;
    setClass(n, 'is-existing', !!it.field);
    setClass(n, 'is-deleted', !!it.field && this.deletes.has(it.field.name));
    setClass(n, 'is-selected', this.selected === key || this.group.has(key));
    const label = it.draft ? (it.draft.type === 'radio' ? `${it.draft.name} · ${it.draft.export}` : it.draft.name) : (this.renames.get((it.field as Field).name) ?? (it.field as Field).name);
    setText(n.firstElementChild, label);
    if (n.title !== label) n.title = label;
    const handle = n.querySelector('.fs-pdf-fhandle');
    if (it.draft && this.selected === key && !handle) n.appendChild(el('<span class="fs-pdf-fhandle"></span>'));
    else if ((!it.draft || this.selected !== key) && handle) handle.remove();
  }

  private clampBox(pv: PageView, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
    const W = pv.size.w, H = pv.size.h;
    const ww = Math.min(w, W), hh = Math.min(h, H);
    return { x: Math.max(0, Math.min(W - ww, x)), y: Math.max(0, Math.min(H - hh, y)), w: ww, h: hh };
  }

  private down(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    const t = e.target as HTMLElement;
    const node = t.closest('.fs-pdf-fbox') as HTMLElement | null;
    const pv = this.viewer.pageAtClient(e.clientX, e.clientY);
    if (!this.tool && node?.dataset.id) {
      e.preventDefault();
      const id = node.dataset.id;
      if (e.shiftKey && !id.startsWith('x:')) {
        if (this.selected && !this.selected.startsWith('x:')) this.group.add(this.selected);
        if (this.group.has(id)) this.group.delete(id); else this.group.add(id);
        if (!this.selected || this.selected.startsWith('x:') || !this.group.has(this.selected)) this.selected = [...this.group][0] ?? null;
        this.renderAll();
        this.hooks.select();
        return;
      }
      if (!this.group.has(id) && this.group.size) { this.group.clear(); this.renderAll(); }
      this.select(id);
      const d = this.drafts.find((x) => x.id === id);
      if (d && pv) {
        const p = this.viewer.toPage(pv, e.clientX, e.clientY);
        this.drag = { kind: t.closest('.fs-pdf-fhandle') ? 'resize' : 'move', pv, x0: p.x, y0: p.y, id, base: { x: d.x, y: d.y, w: d.w, h: d.h }, node, moved: false };
        this.viewer.host.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (!this.tool) { if (this.selected && !t.closest('.fs-pdf-annot')) this.select(null); return; }
    if (!pv) return;
    e.preventDefault();
    const p = this.viewer.toPage(pv, e.clientX, e.clientY);
    const layer = this.layers.get(pv.index);
    if (!layer) return;
    const draft = el(`<div class="fs-pdf-fbox is-draft" data-type="${this.tool}"></div>`);
    layer.appendChild(draft);
    this.drag = { kind: 'draw', pv, x0: p.x, y0: p.y, node: draft, moved: false };
    this.viewer.host.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.viewer.toPage(d.pv, e.clientX, e.clientY);
    const dx = p.x - d.x0, dy = p.y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 1.5) return;
    d.moved = true;
    let box: { x: number; y: number; w: number; h: number };
    if (d.kind === 'draw') box = { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(dx), h: Math.abs(dy) };
    else if (d.kind === 'move' && d.base) box = this.clampBox(d.pv, d.base.x + dx, d.base.y + dy, d.base.w, d.base.h);
    else if (d.base) box = { x: d.base.x, y: d.base.y, w: Math.max(8, d.base.w + dx), h: Math.max(8, d.base.h + dy) };
    else return;
    d.node.setAttribute('style', `left:${calc(box.x)};top:${calc(box.y)};width:${calc(box.w)};height:${calc(box.h)}`);
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.viewer.host.hasPointerCapture(e.pointerId)) this.viewer.host.releasePointerCapture(e.pointerId);
    const p = this.viewer.toPage(d.pv, e.clientX, e.clientY);
    const dx = p.x - d.x0, dy = p.y - d.y0;
    if (d.kind === 'draw') {
      d.node.remove();
      const type = this.tool;
      if (!type) return;
      const [dw, dh] = SIZE[type];
      const small = Math.abs(dx) < 4 || Math.abs(dy) < 4;
      const box = small ? this.clampBox(d.pv, d.x0 - dw / 2, d.y0 - dh / 2, dw, dh) : this.clampBox(d.pv, Math.min(d.x0, p.x), Math.min(d.y0, p.y), Math.abs(dx), Math.abs(dy));
      this.add(type, d.pv.index + 1, box);
      this.tool = null;
      this.hooks.toolDone();
      return;
    }
    if (!d.moved || !d.id || !d.base) return;
    if (d.kind === 'move') this.update(d.id, this.clampBox(d.pv, d.base.x + dx, d.base.y + dy, d.base.w, d.base.h));
    else this.update(d.id, { w: Math.max(8, d.base.w + dx), h: Math.max(8, d.base.h + dy) });
  }

  private cancel(): void {
    if (this.drag?.kind === 'draw') this.drag.node.remove();
    this.drag = null;
  }
}

const row = (label: string, ctl: string, part: string): string => `<div class="fs-prop-row" data-part="${part}"><span class="fs-prop-label">${label}</span><div class="fs-prop-ctl">${ctl}</div></div>`;
const sec = (title: string, body: string, extra = ''): string => `<section class="fs-pdfwb-sec" ${extra}><h3 class="fs-pdfwb-sec-title">${title}</h3>${body}</section>`;

export class FormPanel {
  readonly root: HTMLElement;
  onApply: () => void = () => undefined;

  constructor(private readonly forms: FormBuilder) {
    this.root = el(`<div class="fs-pdfwb-formpane">
${sec('Prepare form', `<p class="fs-note">Choose a field type in the toolbar, then drag a box on the page or click to place one. Drag a field to move it and its corner to resize it. Delete removes the selected field.</p><p class="fs-note fs-pdfwb-fcount"></p><div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-f="apply">${icon('check', 14)}Apply to PDF</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-f="discard">Discard</button></div>`)}
${sec('Field properties', `<p class="fs-note fs-pdfwb-fnone">Select a field to see its properties.</p><div class="fs-pdfwb-fprops" hidden>
${row('Type', '<span class="fs-pdfwb-ftype"></span>', 'type')}
${row('Name', '<input class="fs-input" type="text" data-f="name" spellcheck="false" aria-label="Field name">', 'name')}
${row('Tooltip', '<input class="fs-input" type="text" data-f="tooltip" spellcheck="false" aria-label="Tooltip">', 'tooltip')}
${row('Value', '<input class="fs-input" type="text" data-f="export" spellcheck="false" aria-label="Export value">', 'export')}
${row('Options', '<textarea class="fs-input fs-pdfwb-fopts" data-f="options" rows="4" spellcheck="false" aria-label="Options, one per line"></textarea>', 'options')}
${row('Default', '<input class="fs-input" type="text" data-f="value" spellcheck="false" aria-label="Default value">', 'value')}
${row('Default', '<select data-f="pick" aria-label="Default choice"></select>', 'pick')}
${row('Format', `<select data-f="dateFormat" aria-label="Date format">${DATE_FORMATS.map((f) => `<option value="${f}">${f}</option>`).join('')}</select>`, 'format')}
${row('Font size', `<select data-f="fontSize" aria-label="Font size"><option value="0">Auto</option>${[8, 9, 10, 11, 12, 14, 16, 18, 24].map((s) => `<option value="${s}">${s} pt</option>`).join('')}</select>`, 'size')}
${row('Align', '<div class="fs-seg is-quiet fs-pdfwb-falign"><button type="button" data-f="align" data-v="left">Left</button><button type="button" data-f="align" data-v="center">Centre</button><button type="button" data-f="align" data-v="right">Right</button></div>', 'align')}
<div class="fs-pdfwb-fchecks" data-part="flags"><label class="fs-check" data-part="checked"><input type="checkbox" data-f="checked">Checked by default</label><label class="fs-check"><input type="checkbox" data-f="required">Required</label><label class="fs-check"><input type="checkbox" data-f="readonly">Read-only</label></div>
<p class="fs-note fs-pdfwb-fhint"></p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-f="delete">${icon('delete', 14)}<span>Delete field</span></button></div>
</div>`)}
${sec('New fields <span class="fs-badge is-count fs-pdfwb-fnew">0</span>', '<div class="fs-pdfwb-fdrafts-box"><div class="fs-list fs-pdfwb-fdrafts"></div><p class="fs-note fs-pdfwb-fdrafts-empty">None yet.</p></div>')}
${sec('Fields in this PDF <span class="fs-badge is-count fs-pdfwb-fold">0</span>', '<div class="fs-list fs-pdfwb-fexist"></div><p class="fs-note fs-pdfwb-fexist-empty">This PDF has no form fields yet.</p>')}
</div>`);
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.input(e));
    this.root.addEventListener('click', (e) => this.click(e));
  }

  private $<T extends HTMLElement = HTMLElement>(sel: string): T { return q<T>(this.root, sel); }

  sync(): void {
    const f = this.forms;
    const nd = f.drafts.length;
    const parts = [nd ? (nd === 1 ? `${nd} new field` : `${nd} new fields`) : '', f.renames.size ? `${f.renames.size} renamed` : '', f.deletes.size ? `${f.deletes.size} to delete` : ''].filter(Boolean);
    const list = parts.join(' · ');  // a value of its own, so the sentence is a key and the parts translate inside it
    setText(this.$('.fs-pdfwb-fcount'), parts.length ? `${list}. Apply writes them into the PDF as real form fields.` : 'No changes yet.');
    setDisabled(this.$<HTMLButtonElement>('[data-f="apply"]'), !f.dirty);
    setDisabled(this.$<HTMLButtonElement>('[data-f="discard"]'), !f.dirty);
    setText(this.$('.fs-pdfwb-fnew'), String(f.drafts.length));
    setHidden(this.$('.fs-pdfwb-fdrafts-empty'), f.drafts.length > 0);
    const uniq = [...new Map(f.existing.map((x) => [x.name, x])).values()];
    setText(this.$('.fs-pdfwb-fold'), String(uniq.length));
    setHidden(this.$('.fs-pdfwb-fexist-empty'), uniq.length > 0);
    const rowUpdate = (n: HTMLElement, title: string, sub: string, selected: boolean, gone = false): void => {
      setText(n.querySelector('.fs-row-title'), title);
      setText(n.querySelector('.fs-row-sub'), sub);
      setClass(n, 'is-selected', selected);
      setClass(n, 'is-gone', gone);
    };
    patchList(this.$('.fs-pdfwb-fdrafts'), f.drafts, {
      key: (d) => d.id,
      create: (d) => { const n = el(`<div class="fs-row fs-pdfwb-frow" data-f="pick-row" data-id="${d.id}"><span class="fs-row-icon">${icon(FIELD_ICON[d.type], 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>`); rowUpdate(n, d.name, `${FIELD_LABEL[d.type]} · page ${d.page}`, f.selected === d.id); return n; },
      update: (n, d) => rowUpdate(n, d.type === 'radio' ? `${d.name} · ${d.export}` : d.name, `${FIELD_LABEL[d.type]} · page ${d.page}`, f.selected === d.id),
    });
    patchList(this.$('.fs-pdfwb-fexist'), uniq, {
      key: (x) => `${f.loadedFor}|${x.name}`,
      create: (x) => {
        const n = el(`<div class="fs-row fs-pdfwb-frow" data-f="pick-row" data-id="x:${escapeHtml(x.name)}"><span class="fs-row-icon">${icon(x.type === 'checkbox' ? 'fieldCheck' : x.type === 'radio' ? 'fieldRadio' : x.type === 'choice' ? 'fieldDropdown' : x.type === 'signature' ? 'signature' : 'fieldText', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><button class="fs-icon-btn is-sm" type="button" data-f="toggle-del" title="Delete or keep this field" aria-label="Delete or keep this field">${icon('delete', 14)}</button></div>`);
        rowUpdate(n, f.renames.get(x.name) ?? x.name, `${EXISTING_LABEL[x.type] ?? 'Field'} · page ${x.page}`, f.selected === `x:${x.name}`, f.deletes.has(x.name));
        return n;
      },
      update: (n, x) => rowUpdate(n, f.renames.get(x.name) ?? x.name, `${f.deletes.has(x.name) ? 'Will be deleted · ' : f.renames.has(x.name) ? `Renamed from ${x.name} · ` : ''}${EXISTING_LABEL[x.type] ?? 'Field'} · page ${x.page}`, f.selected === `x:${x.name}`, f.deletes.has(x.name)),
    });
  }

  syncSelection(): void {
    const f = this.forms, d = f.draft, x = f.field;
    setHidden(this.$('.fs-pdfwb-fnone'), !!(d || x));
    setHidden(this.$('.fs-pdfwb-fprops'), !(d || x));
    this.sync();
    if (!d && !x) return;
    const type = d?.type;
    const show = (part: string, on: boolean): void => setHidden(this.$(`[data-part="${part}"]`), !on);
    setText(this.$('.fs-pdfwb-ftype'), d ? FIELD_LABEL[d.type] : `${EXISTING_LABEL[(x as Field).type] ?? 'Field'} in this PDF`);
    show('tooltip', !!d);
    show('export', type === 'radio');
    show('options', type === 'dropdown' || type === 'listbox');
    show('value', type === 'text' || type === 'multiline' || type === 'date');
    show('pick', type === 'dropdown' || type === 'listbox');
    show('format', type === 'date');
    show('size', !!type && TEXTY.has(type));
    show('align', type === 'text' || type === 'multiline' || type === 'date' || type === 'dropdown');
    show('flags', !!d);
    show('checked', type === 'checkbox' || type === 'radio');
    const nameIn = this.$<HTMLInputElement>('[data-f="name"]');
    setValue(nameIn, d ? d.name : f.renames.get((x as Field).name) ?? (x as Field).name);
    setText(this.$('.fs-pdfwb-fhint'), type === 'radio' ? 'Radio buttons with the same name form one group; only one in the group can be chosen. Draw more radio buttons straight after this one to add them to the group.' : type === 'date' ? 'A text field that formats what people type as a date in Acrobat and other readers that run form scripts.' : x ? 'Rename the field here, or delete it. Apply writes the change.' : '');
    const delBtn = this.$('[data-f="delete"]');
    setText(delBtn.querySelector('span:not(.icon)'), x && f.deletes.has(x.name) ? 'Keep field' : 'Delete field');
    if (!d) return;
    setValue(this.$<HTMLInputElement>('[data-f="tooltip"]'), d.tooltip);
    setValue(this.$<HTMLInputElement>('[data-f="export"]'), d.export);
    const opts = this.$<HTMLTextAreaElement>('[data-f="options"]');
    if (document.activeElement !== opts && opts.value !== d.options.join('\n')) opts.value = d.options.join('\n');
    setValue(this.$<HTMLInputElement>('[data-f="value"]'), d.value);
    const pick = this.$<HTMLSelectElement>('[data-f="pick"]');
    const want = ['', ...d.options];
    if (Array.from(pick.options).map((o) => o.value).join('\n') !== want.join('\n')) {
      pick.replaceChildren(...want.map((o) => { const n = document.createElement('option'); n.value = o; n.textContent = o || 'None'; return n; }));
    }
    setValue(pick, d.options.includes(d.value) ? d.value : '');
    setValue(this.$<HTMLSelectElement>('[data-f="dateFormat"]'), d.dateFormat);
    setValue(this.$<HTMLSelectElement>('[data-f="fontSize"]'), String(d.fontSize));
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>('[data-f="align"]'))) setClass(b, 'is-on', b.dataset.v === d.align);
    for (const k of ['checked', 'required', 'readonly'] as const) { const box = this.$<HTMLInputElement>(`[data-f="${k}"]`); if (box.checked !== d[k]) box.checked = d[k]; }
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement;
    const k = t.dataset.f;
    const f = this.forms, d = f.draft, x = f.field;
    if (!k) return;
    if (x && k === 'name') { f.rename(x.name, t.value); return; }
    if (!d) return;
    if (k === 'name') f.update(d.id, { name: t.value.replace(/\./g, '') });
    else if (k === 'tooltip') f.update(d.id, { tooltip: t.value });
    else if (k === 'export') f.update(d.id, { export: t.value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) });
    else if (k === 'options') { f.update(d.id, { options: t.value.split('\n').map((s) => s.trim()).filter(Boolean) }); this.syncSelection(); }
    else if (k === 'value') f.update(d.id, { value: t.value });
    else if (k === 'pick') f.update(d.id, { value: t.value });
    else if (k === 'dateFormat') f.update(d.id, { dateFormat: t.value });
    else if (k === 'fontSize') f.update(d.id, { fontSize: Number(t.value) || 0 });
    else if (k === 'checked' || k === 'required' || k === 'readonly') f.update(d.id, { [k]: t.checked });
    this.sync();
  }

  private click(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-f]') as HTMLElement | null;
    if (!t || (t as HTMLButtonElement).disabled) return;
    const f = this.forms;
    switch (t.dataset.f) {
      case 'apply': f.select(null); this.onApply(); return;
      case 'discard': f.discard(); return;
      case 'align': { const d = f.draft; if (d) { f.update(d.id, { align: (t.dataset.v ?? 'left') as NewField['align'] }); this.syncSelection(); } return; }
      case 'delete': f.removeSelected(); this.syncSelection(); return;
      case 'toggle-del': { e.stopPropagation(); const id = (t.closest('[data-id]') as HTMLElement | null)?.dataset.id ?? ''; f.toggleDelete(id.slice(2)); this.sync(); return; }
      case 'pick-row': { const id = t.dataset.id; if (id) f.reveal(id); return; }
    }
  }
}
