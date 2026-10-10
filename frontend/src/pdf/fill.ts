import { api } from '../io/api';
import { el, patchList, setClass } from '../ui/dom';
import { toast } from '../ui/toast';
import { pdfApi, type Field } from './api';
import { asText, buildRules, num, type Rules } from './formcalc';
import type { PageView, Viewer } from './viewer';

const calc = (v: number): string => `calc(var(--k) * ${Math.round(v * 100) / 100}px)`;

export class Fields {
  fields: Field[] = [];
  values = new Map<string, string>();
  loadedFor = '';
  private carry: Record<string, string> = {};
  private layers = new Map<number, HTMLElement>();
  private rules: Rules | null = null;
  onChange: () => void = () => undefined;
  onSign: (f: Field) => void = () => undefined;

  constructor(private readonly viewer: Viewer) {}

  async load(id: string): Promise<void> {
    if (this.loadedFor === id) return;
    const res = await pdfApi.fields(id);
    const on = await api.settings().then((s) => s.formScripts !== false).catch(() => true);
    this.fields = res.fields;
    this.rules = on && res.fields.some((f) => f.scripts) ? buildRules(res.fields) : null;
    if (this.rules?.custom && this.loadedFor !== id) toast(`This form has ${this.rules.custom} custom script${this.rules.custom === 1 ? '' : 's'} that formpdf does not run; standard calculations and formatting work.`);
    this.loadedFor = id;
    this.values.clear();
    for (const [name, v] of Object.entries(this.carry)) if (res.fields.some((f) => f.name === name && f.value !== v)) this.values.set(name, v);
    this.carry = {};
    this.renderAll();
    this.onChange();
  }

  reset(carry: Record<string, string> = {}): void {
    this.fields = [];
    this.loadedFor = '';
    this.carry = carry;
    this.values.clear();
    this.renderAll();
  }

  get dirty(): boolean { return this.values.size > 0 || Object.keys(this.carry).length > 0; }

  pending(): Record<string, string> { return { ...this.carry, ...Object.fromEntries(this.values) }; }

  discard(): void { this.values.clear(); this.carry = {}; this.renderAll(); this.onChange(); }

  current(name: string): string | undefined { return this.values.get(name) ?? this.fields.find((f) => f.name === name)?.value; }

  setValue(name: string, v: string): void {
    const f = this.fields.find((x) => x.name === name);
    if (!f) return;
    if (v === f.value) this.values.delete(name); else this.values.set(name, v);
    this.fields.forEach((x, i) => {
      if (x.name !== name) return;
      for (const layer of this.layers.values()) {
        const n = layer.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[data-i="${i}"], textarea[data-i="${i}"]`);
        if (!n) continue;
        const shown = this.shown(f, v, n);
        if (n.value !== shown) n.value = shown;
        setClass(n.parentElement as HTMLElement, 'is-changed', this.values.has(name));
      }
    });
    this.onChange();
  }

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el('<div class="fs-pdf-fields"></div>');
      layer.addEventListener('input', (e) => this.input(e));
      layer.addEventListener('change', (e) => { this.input(e); this.check(e.target as HTMLElement); });
      layer.addEventListener('focusin', (e) => this.focus(e.target as HTMLElement, true));
      layer.addEventListener('focusout', (e) => this.focus(e.target as HTMLElement, false));
      layer.addEventListener('beforeinput', (e) => this.keystroke(e as InputEvent));
      layer.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('[data-sign]') as HTMLElement | null;
        const f = b ? this.fields[Number(b.dataset.sign)] : undefined;
        if (f) this.onSign(f);
      });
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.render(pv.index);
  }

  renderAll(): void { for (const i of this.layers.keys()) this.render(i); }

  private value(f: Field): string { return this.values.get(f.name) ?? f.value; }

  private shown(f: Field, v: string, ctl: Element | null): string {
    const fmt = this.rules?.format.get(f.name);
    return fmt && document.activeElement !== ctl ? fmt(v) : v;
  }

  private ctlField(t: HTMLElement): Field | undefined {
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? this.fields[Number(t.dataset.i)] : undefined;
  }

  private focus(t: HTMLElement, on: boolean): void {
    const f = this.ctlField(t);
    if (!f || !this.rules?.format.has(f.name) || !(t instanceof HTMLInputElement)) return;
    const v = this.value(f);
    const want = on ? v : this.shown(f, v, null);
    if (t.value !== want) t.value = want;
  }

  private keystroke(e: InputEvent): void {
    const f = this.ctlField(e.target as HTMLElement);
    const rule = f ? this.rules?.keystroke.get(f.name) : undefined;
    if (!rule || e.data == null) return;
    if (!(rule === 'number' ? /^[0-9.,\-]*$/ : /^[0-9\-() ]*$/).test(e.data)) e.preventDefault();
  }

  private check(t: HTMLElement): void {
    const f = this.ctlField(t);
    const rule = f ? this.rules?.validate.get(f.name) : undefined;
    if (!f || !rule) return;
    const msg = rule(this.value(f));
    const box = t.parentElement as HTMLElement;
    setClass(box, 'is-invalid', !!msg);
    const tip = msg ?? (f.tooltip || f.name);
    if (box.title !== tip) box.title = tip;
    if (msg) toast(`${f.tooltip || f.name}: ${msg}`, 'error');
  }

  private recalc(): void {
    const rules = this.rules;
    if (!rules?.calc.length) return;
    const get = (name: string): number => {
      let total = 0;
      const done = new Set<string>();
      for (const f of this.fields) {
        if ((f.name === name || f.name.startsWith(`${name}.`)) && !done.has(f.name)) { done.add(f.name); total += num(this.current(f.name) ?? ''); }
      }
      return total;
    };
    for (const c of rules.calc) {
      const n = c.run(get);
      if (n === null) continue;
      const v = asText(n);
      if (this.current(c.name) !== v) this.setValue(c.name, v);
    }
  }

  private render(index: number): void {
    const layer = this.layers.get(index);
    if (!layer) return;
    const list = this.fields.map((f, i) => ({ f, i })).filter((x) => x.f.page === index + 1 && x.f.type !== 'button' && !(x.f.type === 'signature' && x.f.value));
    patchList(layer, list, {
      key: (x) => `${this.loadedFor}|${x.i}`,
      create: (x) => { const n = this.create(x.f, x.i); this.update(n, x.f); return n; },
      update: (n, x) => this.update(n, x.f),
    });
  }

  private create(f: Field, i: number): HTMLElement {
    const box = el(`<div class="fs-pdf-field" data-type="${f.type}" style="left:${calc(f.x)};top:${calc(f.y)};width:${calc(f.w)};height:${calc(f.h)};font-size:${calc(Math.max(6, Math.min(f.h * 0.62, 12)))}"></div>`);
    box.title = f.tooltip || f.name;
    let ctl: HTMLElement;
    if (f.type === 'checkbox' || f.type === 'radio') {
      ctl = el(`<input type="${f.type}" data-i="${i}" ${f.type === 'radio' ? `name="fsr-${this.loadedFor}-${encodeURIComponent(f.name)}"` : ''}>`);
    } else if (f.type === 'choice') {
      const sel = el<HTMLSelectElement>(`<select data-i="${i}" data-native></select>`);
      for (const o of ['', ...(f.options ?? [])]) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; sel.appendChild(opt); }
      ctl = sel;
    } else if (f.type === 'signature') {
      ctl = el(`<button type="button" class="fs-pdf-signhere" data-sign="${i}">Sign here</button>`);
    } else if (f.multiline) {
      ctl = el(`<textarea data-i="${i}" spellcheck="true"></textarea>`);
    } else {
      ctl = el(`<input type="text" data-i="${i}" spellcheck="false">`);
      if (f.maxLen) (ctl as HTMLInputElement).maxLength = f.maxLen;
      if (f.format) (ctl as HTMLInputElement).placeholder = f.format;
    }
    if (f.readonly && ctl instanceof HTMLInputElement) ctl.disabled = true;
    if (f.required) box.classList.add('is-required');
    box.appendChild(ctl);
    return box;
  }

  private update(n: HTMLElement, f: Field): void {
    const ctl = n.firstElementChild;
    const v = this.value(f);
    if (ctl instanceof HTMLInputElement) {
      if (ctl.type === 'checkbox' || ctl.type === 'radio') { const on = v === (f.on ?? 'Yes'); if (ctl.checked !== on) ctl.checked = on; }
      else if (document.activeElement !== ctl && ctl.value !== this.shown(f, v, ctl)) ctl.value = this.shown(f, v, ctl);
    } else if ((ctl instanceof HTMLTextAreaElement || ctl instanceof HTMLSelectElement) && ctl.value !== v && document.activeElement !== ctl) ctl.value = v;
    setClass(n, 'is-changed', this.values.has(f.name));
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const f = this.fields[Number(t.dataset.i)];
    if (!f) return;
    let v: string;
    if (t instanceof HTMLInputElement && t.type === 'checkbox') v = t.checked ? f.on ?? 'Yes' : 'Off';
    else if (t instanceof HTMLInputElement && t.type === 'radio') { if (!t.checked) return; v = f.on ?? 'Yes'; }
    else v = t.value;
    if (v === f.value) this.values.delete(f.name); else this.values.set(f.name, v);
    if (f.type === 'radio') this.renderAll();
    else setClass(t.parentElement as HTMLElement, 'is-changed', this.values.has(f.name));
    this.recalc();
    this.onChange();
  }

  setActive(on: boolean): void { this.viewer.setClass('is-filling', on); }
}

function trim(canvas: HTMLCanvasElement, pad = 6): { url: string; aspect: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL('image/png'), aspect: out.width / out.height };
}

export class SignaturePad {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private strokes: Array<Array<[number, number]>> = [];
  private drawing = false;
  color = '#1E2A78';
  onChange: () => void = () => undefined;

  constructor() {
    this.root = el('<div class="fs-pdf-pad"><canvas aria-label="Draw your signature"></canvas><span class="fs-pdf-pad-hint">Sign with the mouse or a pen</span><span class="fs-pdf-pad-line"></span></div>');
    this.canvas = this.root.querySelector('canvas') as HTMLCanvasElement;
    const pos = (e: PointerEvent): [number, number] => { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.fit();
      this.drawing = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.strokes.push([pos(e)]);
      this.paint();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const s = this.strokes[this.strokes.length - 1];
      const p = pos(e), q = s[s.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.7) { s.push(p); this.paint(); }
    });
    const end = (): void => { if (!this.drawing) return; this.drawing = false; this.onChange(); };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  get empty(): boolean { return this.strokes.length === 0; }

  clear(): void { this.strokes = []; this.paint(); this.onChange(); }

  private fit(): void {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  paint(): void {
    this.fit();
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      for (let i = 1; i < s.length - 1; i++) {
        const mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2;
        ctx.quadraticCurveTo(s[i][0], s[i][1], mx, my);
      }
      if (s.length > 1) ctx.lineTo(s[s.length - 1][0], s[s.length - 1][1]);
      ctx.stroke();
    }
    setClass(this.root, 'has-ink', this.strokes.length > 0);
  }

  image(): { url: string; aspect: number } | null { return this.empty ? null : trim(this.canvas); }
}

export async function typedSignature(text: string, color: string): Promise<{ url: string; aspect: number } | null> {
  const value = text.trim();
  if (!value) return null;
  try { await document.fonts.load('96px "Caveat"', value); } catch { return null; }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.font = '96px "Caveat", cursive';
  const w = Math.ceil(ctx.measureText(value).width) + 40;
  c.width = Math.min(4000, w);
  c.height = 150;
  const g = c.getContext('2d');
  if (!g) return null;
  g.font = '96px "Caveat", cursive';
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(value, 20, 78);
  return trim(c, 8);
}
