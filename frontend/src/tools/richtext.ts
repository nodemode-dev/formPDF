import { el, escapeHtml } from '../ui/dom';
import { calc } from './overlay';

export type Align = 'left' | 'center' | 'right' | 'justify';
export type ListKind = 'none' | 'bullet' | 'number';
export interface Run { t: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; sup?: boolean; sub?: boolean; color?: string }
export interface Para { align: Align; list: ListKind; level: number; runs: Run[]; start?: number }
/** sans, serif and mono are formpdf's font kit; sys:<family name> is a family installed on this computer. */
export interface Font { family: string; size: number; color: string; lineHeight: number }
export interface Geo { x: number; y: number; w: number; h: number; rot: number }

export const FAMILY_CSS: Record<string, string> = { sans: 'FkSans', serif: 'FkSerif', mono: 'FkMono' };
export const SYS = 'sys:';
const FLAGS = ['b', 'i', 'u', 's', 'sup', 'sub'] as const;
type Flag = typeof FLAGS[number];

/** The CSS font-family for a family: the kit's web fonts, or the installed font by name (the window runs on the same computer). */
export function familyCss(family: string): string {
  if (family.startsWith(SYS)) return `"${family.slice(SYS.length).replace(/["\\]/g, '')}"`;
  return FAMILY_CSS[family] ?? FAMILY_CSS.sans;
}

export async function loadFonts(family: string): Promise<void> {
  const name = familyCss(family);
  await Promise.all(['400 16px', '700 16px', 'italic 400 16px', 'italic 700 16px'].map((w) => document.fonts.load(`${w} ${name}`).catch(() => [])));
}

function runHtml(r: Run): string {
  let h = escapeHtml(r.t);
  if (r.sup) h = `<sup>${h}</sup>`;
  if (r.sub) h = `<sub>${h}</sub>`;
  if (r.s) h = `<strike>${h}</strike>`;
  if (r.u) h = `<u>${h}</u>`;
  if (r.i) h = `<i>${h}</i>`;
  if (r.b) h = `<b>${h}</b>`;
  if (r.color) h = `<font color="${escapeHtml(r.color)}">${h}</font>`;
  return h;
}

export function parasHtml(paras: Para[]): string {
  return paras.map((p) => {
    const body = p.runs.map(runHtml).join('') || '<br>';
    const start = p.list === 'number' && p.start ? `;counter-set:n${p.level} ${p.start}" data-start="${p.start}` : '';
    return `<div class="fs-rt-p" style="text-align:${p.align === 'justify' ? 'justify' : p.align}${start}" data-list="${p.list}" data-level="${p.level}">${body}</div>`;
  }).join('');
}

function hex(rgb: string): string | undefined {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) return /^#[0-9a-f]{6}$/i.test(rgb) ? rgb.toUpperCase() : undefined;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function styleOf(node: Element, base: Partial<Record<Flag, boolean>> & { color?: string }): Partial<Record<Flag, boolean>> & { color?: string } {
  const out = { ...base };
  const tag = node.tagName;
  const st = (node as HTMLElement).style;
  if (tag === 'B' || tag === 'STRONG' || st?.fontWeight === 'bold' || Number(st?.fontWeight) >= 600) out.b = true;
  if (st?.fontWeight === 'normal' || st?.fontWeight === '400') out.b = false;
  if (tag === 'I' || tag === 'EM' || st?.fontStyle === 'italic') out.i = true;
  if (tag === 'U' || /underline/.test(st?.textDecorationLine || st?.textDecoration || '')) out.u = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(st?.textDecorationLine || st?.textDecoration || '')) out.s = true;
  if (tag === 'SUP' || st?.verticalAlign === 'super') { out.sup = true; out.sub = false; }
  if (tag === 'SUB' || st?.verticalAlign === 'sub') { out.sub = true; out.sup = false; }
  const c = tag === 'FONT' ? node.getAttribute('color') ?? '' : st?.color ?? '';
  if (c) out.color = hex(c) ?? out.color;
  return out;
}

function collect(node: Node, style: ReturnType<typeof styleOf>, runs: Run[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').replace(/ /g, ' ').replace(/[\r\n]+/g, ' ');
    if (!t) return;
    const r: Run = { t };
    for (const f of FLAGS) if (style[f]) r[f] = true;
    if (style.color) r.color = style.color;
    const last = runs[runs.length - 1];
    if (last && FLAGS.every((f) => !!last[f] === !!r[f]) && last.color === r.color) last.t += t;
    else runs.push(r);
    return;
  }
  if (!(node instanceof Element)) return;
  if (node.tagName === 'BR') return;
  const next = styleOf(node, style);
  for (const ch of Array.from(node.childNodes)) collect(ch, next, runs);
}

const BLOCK = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE']);

export function readParas(root: HTMLElement): Para[] {
  const out: Para[] = [];
  let loose: Node[] = [];
  const flush = (): void => {
    if (!loose.length) return;
    const runs: Run[] = [];
    for (const n of loose) collect(n, {}, runs);
    out.push({ align: 'left', list: 'none', level: 0, runs: runs.length ? runs : [{ t: '' }] });
    loose = [];
  };
  for (const ch of Array.from(root.childNodes)) {
    if (ch instanceof HTMLElement && BLOCK.has(ch.tagName)) {
      flush();
      const nested = Array.from(ch.children).filter((c) => BLOCK.has(c.tagName)) as HTMLElement[];
      const blocks = nested.length ? nested : [ch];
      for (const b of blocks) {
        const runs: Run[] = [];
        collect(b, {}, runs);
        const a = (b.style.textAlign || ch.style.textAlign || 'left') as string;
        const align: Align = a === 'center' || a === 'right' || a === 'justify' ? a : a === 'end' ? 'right' : 'left';
        const list = (b.dataset.list ?? ch.dataset.list ?? 'none') as ListKind;
        const start = Number(b.dataset.start ?? 0);
        out.push({ align, list: list === 'bullet' || list === 'number' ? list : 'none', level: Math.max(0, Math.min(3, Number(b.dataset.level ?? ch.dataset.level ?? 0) || 0)), runs: runs.length ? runs : [{ t: '' }], ...(list === 'number' && start > 0 ? { start } : {}) });
      }
    } else if (ch instanceof HTMLElement && ch.tagName === 'BR') {
      flush();
    } else {
      loose.push(ch);
    }
  }
  flush();
  return out.length ? out : [{ align: 'left', list: 'none', level: 0, runs: [{ t: '' }] }];
}

export function plain(paras: Para[]): string {
  return paras.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
}

export function sameParas(a: Para[], b: Para[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface EditorOpen { page: HTMLElement; geo: Geo; font: Font; paras: Para[]; under: string | null; pageW: number; pageH: number; face?: string | null }

export interface OrigFont { name: string; b?: boolean; i?: boolean }

const STANDARD_FACES: Array<[RegExp, string]> = [
  [/^(helvetica|arial)/i, 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans"'],
  [/^times/i, '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman"'],
  [/^courier/i, '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS"'],
];
const docFaces = new Map<string, Promise<string | null>>();

/** The CSS family that draws a PDF font in the editor: its embedded program served as a web font, or the installed match of a standard font. */
export function docFace(docId: string, page: number, orig: OrigFont): Promise<string | null> {
  const key = `${docId}|${orig.name}|${orig.i ? 'i' : ''}`;
  let got = docFaces.get(key);
  if (!got) {
    const family = `FpDoc${docFaces.size + 1}`;
    const face = new FontFace(family, `url("/api/pdf/${encodeURIComponent(docId)}/webfont?page=${page}&name=${encodeURIComponent(orig.name)}")`, { weight: '100 900', style: orig.i ? 'italic' : 'normal' });
    got = face.load().then((f) => { document.fonts.add(f); return `"${family}"`; }, () => STANDARD_FACES.find(([re]) => re.test(orig.name))?.[1] ?? null);
    docFaces.set(key, got);
  }
  return got;
}

export class TextEditor {
  readonly frame: HTMLElement;
  readonly area: HTMLElement;
  private readonly cover: HTMLElement;
  font: Font = { family: 'sans', size: 12, color: '#111111', lineHeight: 1.25 };
  private start: Para[] = [];
  private saved: Range | null = null;
  private face: string | null = null;
  private faceFamily = '';

  constructor() {
    this.cover = el('<div class="fs-rt-cover" hidden></div>');
    this.frame = el('<div class="fs-rt-frame"><div class="fs-rt-ed" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Page text"></div></div>');
    this.area = this.frame.firstElementChild as HTMLElement;
    this.area.addEventListener('keyup', () => this.remember());
    this.area.addEventListener('mouseup', () => this.remember());
    this.area.addEventListener('input', () => this.remember());
  }

  get open(): boolean { return this.frame.isConnected; }

  async show(o: EditorOpen): Promise<void> {
    this.font = { ...o.font };
    this.face = o.face ?? null;
    this.faceFamily = o.font.family;
    this.start = o.paras;
    this.area.innerHTML = parasHtml(o.paras);
    this.style();
    this.place(o.geo);
    await loadFonts(o.font.family);
    if (o.under) {
      const img = new Image();
      img.src = o.under;
      await img.decode().catch(() => undefined);
      const style = `left:${calc(o.geo.x - 2)};top:${calc(o.geo.y - 2)};width:${calc(o.geo.w + 4)};height:${calc(o.geo.h + 4)};background-image:url("${o.under}");background-size:${calc(o.pageW)} ${calc(o.pageH)};background-position:${calc(-(o.geo.x - 2))} ${calc(-(o.geo.y - 2))}`;
      this.cover.setAttribute('style', style);
      this.cover.hidden = o.geo.rot !== 0;
      if (o.geo.rot !== 0) {
        const r = Math.abs(o.geo.rot) * Math.PI / 180, bw = o.geo.w * Math.abs(Math.cos(r)) + o.geo.h * Math.abs(Math.sin(r)), bh = o.geo.w * Math.abs(Math.sin(r)) + o.geo.h * Math.abs(Math.cos(r));
        const bx = o.geo.x + o.geo.w / 2 - bw / 2 - 2, by = o.geo.y + o.geo.h / 2 - bh / 2 - 2;
        this.cover.setAttribute('style', `left:${calc(bx)};top:${calc(by)};width:${calc(bw + 4)};height:${calc(bh + 4)};background-image:url("${o.under}");background-size:${calc(o.pageW)} ${calc(o.pageH)};background-position:${calc(-bx)} ${calc(-by)}`);
        this.cover.hidden = false;
      }
    } else {
      this.cover.hidden = true;
    }
    o.page.append(this.cover, this.frame);
    this.area.setAttribute('contenteditable', 'true');
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand('defaultParagraphSeparator', false, 'div');
    this.area.focus();
    const sel = getSelection();
    if (sel) { const r = document.createRange(); r.selectNodeContents(this.area); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    this.remember();
  }

  place(g: Geo): void {
    const style = `left:${calc(g.x)};top:${calc(g.y)};width:${calc(g.w + this.font.size * 0.3)};min-height:${calc(g.h)};transform:rotate(${g.rot}deg)`;
    if (this.frame.getAttribute('style') !== style) this.frame.setAttribute('style', style);
  }

  style(): void {
    const f = this.font;
    const face = this.face && f.family === this.faceFamily ? `${this.face},` : '';
    const style = `font-family:${face}${familyCss(f.family)},sans-serif;font-size:${calc(f.size)};line-height:${f.lineHeight};color:${f.color}`;
    if (this.area.getAttribute('style') !== style) this.area.setAttribute('style', style);
  }

  freeze(): void { this.area.setAttribute('contenteditable', 'false'); }

  close(): void {
    this.frame.remove();
    this.cover.remove();
    this.saved = null;
  }

  value(): Para[] { return readParas(this.area); }

  changed(): boolean { return !sameParas(this.value(), this.start); }

  private remember(): void {
    const sel = getSelection();
    if (sel && sel.rangeCount && this.area.contains(sel.anchorNode)) this.saved = sel.getRangeAt(0).cloneRange();
  }

  restore(): void {
    if (!this.saved) return;
    this.area.focus();
    const sel = getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(this.saved); }
  }

  command(name: string, value?: string): void {
    this.restore();
    if (name === 'sup' || name === 'sub') {
      const other = name === 'sup' ? 'subscript' : 'superscript';
      if (document.queryCommandState(other)) document.execCommand(other);
      document.execCommand(name === 'sup' ? 'superscript' : 'subscript');
    } else {
      document.execCommand(name, false, value);
    }
    this.remember();
  }

  state(name: string): boolean {
    try { return document.queryCommandState(name); } catch { return false; }
  }

  blocks(): HTMLElement[] {
    const sel = getSelection();
    const range = this.saved ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
    const all = Array.from(this.area.querySelectorAll<HTMLElement>('.fs-rt-p, div, p')).filter((b) => b.parentElement === this.area);
    if (!range) return all.slice(0, 1);
    const hit = all.filter((b) => range.intersectsNode(b));
    return hit.length ? hit : all.slice(0, 1);
  }

  setList(kind: ListKind): void {
    const blocks = this.blocks();
    const on = blocks.every((b) => b.dataset.list === kind);
    for (const b of blocks) {
      b.classList.add('fs-rt-p');
      b.dataset.list = on ? 'none' : kind;
      if (!b.dataset.level) b.dataset.level = '0';
    }
    this.restore();
  }

  indent(dir: 1 | -1): boolean {
    const blocks = this.blocks().filter((b) => b.dataset.list && b.dataset.list !== 'none');
    if (!blocks.length) return false;
    for (const b of blocks) b.dataset.level = String(Math.max(0, Math.min(3, Number(b.dataset.level ?? 0) + dir)));
    this.restore();
    return true;
  }

  align(): Align {
    const b = this.blocks()[0];
    const a = b?.style.textAlign || 'left';
    return a === 'center' || a === 'right' || a === 'justify' ? a : 'left';
  }

  list(): ListKind {
    const v = this.blocks()[0]?.dataset.list;
    return v === 'bullet' || v === 'number' ? v : 'none';
  }
}
