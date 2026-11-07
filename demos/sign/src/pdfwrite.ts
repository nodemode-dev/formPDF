import { PDFDict, PDFDocument, PDFDropdown, PDFCheckBox, PDFHexString, PDFName, PDFOptionList, PDFPage, PDFRadioGroup, PDFRef, PDFSignature, PDFString, PDFTextField, PDFWidgetAnnotation, StandardFonts, drawObject, popGraphicsState, pushGraphicsState, rgb, type PDFFont } from 'pdf-lib';
import type { Annot, Field, Rect } from '../../../frontend/src/pdf/api';
import { stampSvg } from '../../../frontend/src/pdf/stamps';

export interface WriteOptions { flatten: boolean; flattenFields: boolean; author: string }

const NOTE = 20;
const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const v = m ? parseInt(m[1], 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
const n = (v: number): string => (Math.round(v * 100) / 100).toString();
const rgbOps = (c: string, stroke: boolean): string => `${hex(c).map(n).join(' ')} ${stroke ? 'RG' : 'rg'}`;

export async function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function pageIndexOf(doc: PDFDocument, w: PDFWidgetAnnotation): number {
  const pages = doc.getPages();
  const p = w.P();
  const byRef = p instanceof PDFRef ? pages.findIndex((x) => x.ref === p) : -1;
  if (byRef >= 0) return byRef;
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) if (annots.lookup(k) === w.dict) return i;
  }
  return -1;
}

export async function readFields(bytes: Uint8Array, labels: Record<string, string> = {}): Promise<Field[]> {
  const doc = await loadDoc(bytes);
  const pages = doc.getPages();
  const out: Field[] = [];
  for (const f of doc.getForm().getFields()) {
    for (const w of f.acroField.getWidgets()) {
      const pi = pageIndexOf(doc, w);
      if (pi < 0) continue;
      const r = w.getRectangle();
      const base = { name: f.getName(), page: pi + 1, x: r.x, y: pages[pi].getHeight() - r.y - r.height, w: r.width, h: r.height, readonly: f.isReadOnly(), required: f.isRequired(), multiline: false, tooltip: labels[f.getName()] ?? f.getName().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) };
      if (f instanceof PDFTextField) out.push({ ...base, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline(), maxLen: f.getMaxLength() });
      else if (f instanceof PDFCheckBox) out.push({ ...base, type: 'checkbox', value: f.isChecked() ? w.getOnValue()?.decodeText() ?? 'Yes' : 'Off', on: w.getOnValue()?.decodeText() ?? 'Yes' });
      else if (f instanceof PDFRadioGroup) out.push({ ...base, type: 'radio', value: f.getSelected() ?? 'Off', on: w.getOnValue()?.decodeText() ?? 'Yes' });
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) out.push({ ...base, type: 'choice', value: f.getSelected()[0] ?? '', options: f.getOptions() });
      else if (f instanceof PDFSignature) out.push({ ...base, type: 'signature', value: '' });
    }
  }
  return out;
}

function applyValues(doc: PDFDocument, values: Record<string, string>): void {
  const form = doc.getForm();
  for (const [name, v] of Object.entries(values)) {
    let f;
    try { f = form.getField(name); } catch { continue; }
    if (f instanceof PDFTextField) f.setText(v || undefined);
    else if (f instanceof PDFCheckBox) { if (v && v !== 'Off') f.check(); else f.uncheck(); }
    else if (f instanceof PDFRadioGroup) { if (v && v !== 'Off') f.select(v); else f.clear(); }
    else if (f instanceof PDFDropdown) { if (v) f.select(v); else f.clear(); }
  }
}

function bounds(a: Annot): Rect {
  const pad = (a.width ?? 2) / 2 + 1;
  if (a.rects?.length) {
    const x0 = Math.min(...a.rects.map((r) => r.x)), y0 = Math.min(...a.rects.map((r) => r.y));
    const x1 = Math.max(...a.rects.map((r) => r.x + r.w)), y1 = Math.max(...a.rects.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const pts = a.paths?.flat() ?? a.points ?? [];
  if (pts.length) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const arrow = a.kind === 'arrow' ? 10 : 0;
    return { x: Math.min(...xs) - pad - arrow, y: Math.min(...ys) - pad - arrow, w: Math.max(...xs) - Math.min(...xs) + 2 * (pad + arrow), h: Math.max(...ys) - Math.min(...ys) + 2 * (pad + arrow) };
  }
  if (a.kind === 'note') return { x: a.x ?? 0, y: a.y ?? 0, w: NOTE, h: NOTE };
  return { x: (a.x ?? 0) - pad, y: (a.y ?? 0) - pad, w: (a.w ?? 0) + 2 * pad, h: (a.h ?? 0) + 2 * pad };
}

function kappaEllipse(cx: number, cy: number, rx: number, ry: number): string {
  const k = 0.5522847498;
  const c = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): string => `${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} c`;
  return `${n(cx + rx)} ${n(cy)} m ${c(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry)} ${c(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy)} ${c(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry)} ${c(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy)}`;
}

interface Built { ops: string; subtype: string; extra: Record<string, unknown>; blend: boolean; opacity: number }

function build(a: Annot, H: number): Built | null {
  const op = a.opacity ?? 1;
  const w = a.width ?? 2;
  const col = a.color;
  const Y = (y: number): number => H - y;
  switch (a.kind) {
    case 'highlight': {
      const rs = a.rects ?? [];
      const ops = `${rgbOps(col, false)} ${rs.map((r) => `${n(r.x)} ${n(Y(r.y + r.h))} ${n(r.w)} ${n(r.h)} re f`).join(' ')}`;
      return { ops, subtype: 'Highlight', extra: { QuadPoints: rs.flatMap((r) => [r.x, Y(r.y), r.x + r.w, Y(r.y), r.x, Y(r.y + r.h), r.x + r.w, Y(r.y + r.h)]) }, blend: true, opacity: op };
    }
    case 'underline': case 'strikeout': case 'squiggly': {
      const rs = a.rects ?? [];
      const lines = rs.map((r) => {
        if (a.kind === 'squiggly') {
          const y0 = Y(r.y + r.h) + 1, step = 2.5;
          let d = `${n(r.x)} ${n(y0)} m`;
          for (let x = r.x + step, up = true; x < r.x + r.w + step; x += step, up = !up) d += ` ${n(Math.min(x, r.x + r.w))} ${n(y0 + (up ? 1.6 : 0))} l`;
          return `${d} S`;
        }
        const y = a.kind === 'underline' ? Y(r.y + r.h) + 1 : Y(r.y + r.h / 2);
        return `${n(r.x)} ${n(y)} m ${n(r.x + r.w)} ${n(y)} l S`;
      }).join(' ');
      return { ops: `${rgbOps(col, true)} 1 w ${lines}`, subtype: a.kind === 'strikeout' ? 'StrikeOut' : a.kind === 'underline' ? 'Underline' : 'Squiggly', extra: { QuadPoints: rs.flatMap((r) => [r.x, Y(r.y), r.x + r.w, Y(r.y), r.x, Y(r.y + r.h), r.x + r.w, Y(r.y + r.h)]) }, blend: false, opacity: op };
    }
    case 'note': {
      const x = a.x ?? 0, y = Y((a.y ?? 0) + NOTE);
      const ops = `${rgbOps(col, false)} ${n(x)} ${n(y)} ${NOTE} ${NOTE} re f 0.35 0.3 0.05 RG 0.9 w ${n(x + 0.5)} ${n(y + 0.5)} ${NOTE - 1} ${NOTE - 1} re S 0.35 0.3 0.05 RG ${n(x + 4)} ${n(y + 14)} m ${n(x + 16)} ${n(y + 14)} l S ${n(x + 4)} ${n(y + 10)} m ${n(x + 16)} ${n(y + 10)} l S ${n(x + 4)} ${n(y + 6)} m ${n(x + 11)} ${n(y + 6)} l S`;
      return { ops, subtype: 'Text', extra: { Name: 'Comment', F: 28 }, blend: false, opacity: 1 };
    }
    case 'ink': {
      const ops = `${rgbOps(col, true)} ${n(w)} w 1 J 1 j ${(a.paths ?? []).map((p) => p.map((pt, i) => `${n(pt[0])} ${n(Y(pt[1]))} ${i ? 'l' : 'm'}`).join(' ') + ' S').join(' ')}`;
      return { ops, subtype: 'Ink', extra: { InkList: (a.paths ?? []).map((p) => p.flatMap((pt) => [pt[0], Y(pt[1])])), BS: { W: w } }, blend: false, opacity: op };
    }
    case 'rect': {
      const x = a.x ?? 0, y = Y((a.y ?? 0) + (a.h ?? 0));
      return { ops: `${rgbOps(col, true)} ${n(w)} w ${n(x)} ${n(y)} ${n(a.w ?? 0)} ${n(a.h ?? 0)} re S`, subtype: 'Square', extra: { BS: { W: w } }, blend: false, opacity: op };
    }
    case 'ellipse': {
      const rx = (a.w ?? 0) / 2, ry = (a.h ?? 0) / 2, cx = (a.x ?? 0) + rx, cy = Y((a.y ?? 0) + ry);
      return { ops: `${rgbOps(col, true)} ${n(w)} w ${kappaEllipse(cx, cy, rx, ry)} S`, subtype: 'Circle', extra: { BS: { W: w } }, blend: false, opacity: op };
    }
    case 'line': case 'arrow': {
      const [p, q] = a.points ?? [[0, 0], [0, 0]];
      const x1 = p[0], y1 = Y(p[1]), x2 = q[0], y2 = Y(q[1]);
      let ops = `${rgbOps(col, true)} ${n(w)} w 1 J 1 j ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`;
      if (a.kind === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1), len = 6 + w * 2;
        const l = [x2 - len * Math.cos(ang - 0.45), y2 - len * Math.sin(ang - 0.45)], r = [x2 - len * Math.cos(ang + 0.45), y2 - len * Math.sin(ang + 0.45)];
        ops += ` ${n(l[0])} ${n(l[1])} m ${n(x2)} ${n(y2)} l ${n(r[0])} ${n(r[1])} l S`;
      }
      return { ops, subtype: 'Line', extra: { L: [x1, y1, x2, y2], LE: [PDFName.of('None'), PDFName.of(a.kind === 'arrow' ? 'OpenArrow' : 'None')], BS: { W: w } }, blend: false, opacity: op };
    }
    default: return null;
  }
}

function wrapLines(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && font.widthOfTextAtSize(next, size) > max) { out.push(cur); cur = word; } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

const toBytes = (dataUrl: string): Uint8Array => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function stampPng(a: Annot): Promise<Uint8Array> {
  const spec = a.stamp;
  if (!spec) return Promise.reject(new Error('stamp without a design'));
  const w = a.w ?? 100, h = a.h ?? 40, k = 4;
  const svg = stampSvg(spec, a.color, w, h).replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * k)}" height="${Math.round(h * k)}" `);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      resolve(toBytes(c.toDataURL('image/png')));
    };
    img.onerror = () => reject(new Error('stamp could not be drawn'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

function dateText(): string {
  const d = new Date();
  const p = (v: number): string => String(v).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function attach(doc: PDFDocument, page: PDFPage, a: Annot, built: Built, author: string, flatten: boolean): void {
  const ctx = doc.context;
  const H = page.getHeight();
  const b = bounds(a);
  const rect = [b.x, H - b.y - b.h, b.x + b.w, H - b.y];
  const gs = ctx.obj({ Type: 'ExtGState', CA: built.opacity, ca: built.opacity, ...(built.blend ? { BM: 'Multiply' } : {}) });
  const ap = ctx.stream(`/GS gs ${built.ops}`);
  for (const [k, v] of Object.entries({ Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: { ExtGState: { GS: gs } } })) ap.dict.set(PDFName.of(k), ctx.obj(v));
  const apRef = ctx.register(ap);
  if (flatten) {
    const name = page.node.newXObject('FsAp', apRef);
    page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
    return;
  }
  const text = a.text || a.quote || '';
  const dict = ctx.obj({
    Type: 'Annot', Subtype: built.subtype, Rect: rect, C: hex(a.color), CA: built.opacity, F: 4,
    T: PDFHexString.fromText(author), M: PDFString.of(dateText()), NM: PDFString.of(a.id), AP: { N: apRef },
    ...(text ? { Contents: PDFHexString.fromText(text) } : {}), ...built.extra,
  });
  page.node.addAnnot(ctx.register(dict));
}

export async function writePdf(bytes: Uint8Array, annots: Annot[], values: Record<string, string>, opts: WriteOptions): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (Object.keys(values).length) applyValues(doc, values);
  const form = doc.getForm();
  if (form.getFields().length) form.updateFieldAppearances(font);
  for (const a of annots) {
    const page = doc.getPage(a.page - 1);
    const H = page.getHeight();
    const built = build(a, H);
    if (built) { attach(doc, page, a, built, opts.author, opts.flatten); continue; }
    if (a.kind === 'freetext' || a.kind === 'callout') {
      const size = a.size ?? 12, [r, g, bl] = hex(a.color);
      wrapLines(a.text ?? '', font, size, Math.max(10, (a.w ?? 180) - 4)).forEach((line, i) => page.drawText(line, { x: (a.x ?? 0) + 2, y: H - (a.y ?? 0) - size - 2 - i * size * 1.2, size, font, color: rgb(r, g, bl) }));
    } else if (a.kind === 'image' && a.image) {
      const img = await doc.embedPng(toBytes(a.image));
      page.drawImage(img, { x: a.x ?? 0, y: H - (a.y ?? 0) - (a.h ?? 0), width: a.w ?? 0, height: a.h ?? 0 });
    } else if (a.kind === 'stamp') {
      const img = await doc.embedPng(await stampPng(a));
      page.drawImage(img, { x: a.x ?? 0, y: H - (a.y ?? 0) - (a.h ?? 0), width: a.w ?? 0, height: a.h ?? 0 });
    }
  }
  if (opts.flattenFields) {
    try {
      for (const f of form.getFields()) if (f instanceof PDFSignature) form.removeField(f);
      form.flatten();
      for (const page of doc.getPages()) {
        const list = page.node.Annots();
        if (!list) continue;
        for (let i = list.size() - 1; i >= 0; i--) {
          const ref = list.get(i);
          if (ref instanceof PDFRef && !doc.context.lookup(ref)) list.remove(i);
        }
      }
    } catch {
      form.updateFieldAppearances(font);
    }
  }
  doc.setModificationDate(new Date());
  return doc.save();
}

export interface Info { title: string; author: string; producer: string; fields: number; annots: number }

export async function readInfo(bytes: Uint8Array): Promise<Info> {
  const doc = await loadDoc(bytes);
  let annots = 0;
  for (const p of doc.getPages()) {
    const list = p.node.Annots();
    if (!list) continue;
    for (let i = 0; i < list.size(); i++) {
      const d = list.lookup(i);
      if (d instanceof PDFDict && d.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) annots += 1;
    }
  }
  return { title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', producer: doc.getProducer() ?? '', fields: doc.getForm().getFields().length, annots };
}
