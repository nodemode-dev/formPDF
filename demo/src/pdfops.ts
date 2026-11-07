import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

export interface PlanCard { uid: number; src: number; rot: number }
export type NumberPos = 'bl' | 'bc' | 'br' | 'tl' | 'tc' | 'tr';
export type NumberFormat = 'page-of' | 'plain' | 'slash';

const norm = (a: number): number => ((a % 360) + 360) % 360;

export async function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await loadDoc(bytes)).getPageCount();
}

export async function applyPlan(bytes: Uint8Array, plan: PlanCard[]): Promise<Uint8Array> {
  const src = await loadDoc(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, plan.map((c) => c.src));
  pages.forEach((p, i) => {
    p.setRotation(degrees(norm(p.getRotation().angle + plan[i].rot)));
    out.addPage(p);
  });
  copyInfo(src, out);
  return out.save();
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await loadDoc(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  copyInfo(src, out);
  return out.save();
}

export async function mergeInto(bytes: Uint8Array, others: Uint8Array[], at: number): Promise<Uint8Array> {
  const base = await loadDoc(bytes);
  let pos = Math.max(0, Math.min(base.getPageCount(), at));
  for (const o of others) {
    const add = await loadDoc(o);
    const pages = await base.copyPages(add, add.getPageIndices());
    for (const p of pages) { base.insertPage(pos, p); pos += 1; }
  }
  return base.save();
}

export async function numberPages(bytes: Uint8Array, format: NumberFormat, pos: NumberPos, size: number, from: number): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = doc.getPageCount();
  doc.getPages().forEach((page, i) => {
    const n = i + from;
    const label = format === 'plain' ? String(n) : format === 'slash' ? `${n} / ${total + from - 1}` : `Page ${n} of ${total + from - 1}`;
    const w = font.widthOfTextAtSize(label, size);
    const box = page.getSize();
    const rot = norm(page.getRotation().angle);
    const [bw, bh] = rot % 180 ? [box.height, box.width] : [box.width, box.height];
    const margin = 28;
    const x = pos.endsWith('l') ? margin : pos.endsWith('r') ? bw - margin - w : (bw - w) / 2;
    const y = pos.startsWith('t') ? bh - margin - size * 0.7 : margin;
    const [px, py, pr] = place(x, y, rot, box.width, box.height);
    page.drawText(label, { x: px, y: py, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(pr) });
  });
  return doc.save();
}

export async function watermark(bytes: Uint8Array, text: string, opacity: number, size: number): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = font.widthOfTextAtSize(text, size);
  for (const page of doc.getPages()) {
    const box = page.getSize();
    const rot = norm(page.getRotation().angle);
    const [bw, bh] = rot % 180 ? [box.height, box.width] : [box.width, box.height];
    const a = (Math.PI / 180) * 45;
    const cx = bw / 2 - (Math.cos(a) * w) / 2 + (Math.sin(a) * size * 0.3);
    const cy = bh / 2 - (Math.sin(a) * w) / 2 - (Math.cos(a) * size * 0.3);
    const [px, py, pr] = place(cx, cy, rot, box.width, box.height, 45);
    page.drawText(text, { x: px, y: py, size, font, color: rgb(0.8, 0.1, 0.1), opacity, rotate: degrees(pr) });
  }
  return doc.save();
}

export async function setTitle(bytes: Uint8Array, title: string): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  doc.setTitle(title);
  doc.setProducer('formpdf demo');
  return doc.save();
}

export async function readInfo(bytes: Uint8Array): Promise<{ title: string; author: string; pages: number; producer: string }> {
  const doc = await loadDoc(bytes);
  return { title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', pages: doc.getPageCount(), producer: doc.getProducer() ?? '' };
}

function place(x: number, y: number, rot: number, w: number, h: number, extra = 0): [number, number, number] {
  if (rot === 0) return [x, y, extra];
  if (rot === 90) return [w - y, x, extra + 90];
  if (rot === 180) return [w - x, h - y, extra + 180];
  return [y, h - x, extra + 270];
}

function copyInfo(src: PDFDocument, out: PDFDocument): void {
  const t = src.getTitle();
  if (t) out.setTitle(t);
  const a = src.getAuthor();
  if (a) out.setAuthor(a);
}

export function parseRange(text: string, total: number): number[] {
  const set = new Set<number>();
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= total) set.add(n - 1);
  }
  return [...set].sort((x, y) => x - y);
}
