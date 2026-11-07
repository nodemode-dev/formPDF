import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, StandardFonts, setCharacterSqueeze, type PDFObject } from 'pdf-lib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { isTextItem, openDocument } from '../../../frontend/src/pdf/viewer';
import serifUrl from '../../../backend/app/fonts/LiberationSerif-Regular.ttf?url';
import serifBoldUrl from '../../../backend/app/fonts/LiberationSerif-Bold.ttf?url';
import sansUrl from '../../../backend/app/fonts/LiberationSans-Regular.ttf?url';
import sansBoldUrl from '../../../backend/app/fonts/LiberationSans-Bold.ttf?url';
import type { CompareChange, CompareResult, HiddenItem, Match, Rect } from '../../../frontend/src/pdf/api';

export interface Run { str: string; x: number; top: number; w: number; h: number; base: number; fs: number; start: number; fam: string }

const metric = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
const FACES: Array<[string, string, string]> = [['PtSerif', serifUrl, '400'], ['PtSerifB', serifBoldUrl, '700'], ['PtSans', sansUrl, '400'], ['PtSansB', sansBoldUrl, '700']];
const fontsReady = Promise.all(FACES.map(async ([fam, url, weight]) => {
  const face = new FontFace(fam, `url(${url})`, { weight });
  await face.load();
  document.fonts.add(face);
})).catch(() => undefined);

const pickFamily = (r: Run): string => {
  let best = 'PtSans', gap = Infinity;
  for (const [fam] of FACES) {
    metric.font = `${r.fs}px ${fam}`;
    const d = Math.abs(metric.measureText(r.str).width - r.w);
    if (d < gap) { gap = d; best = fam; }
  }
  return best;
};

export const cx = (r: Run, i: number): number => {
  if (!r.fam) r.fam = pickFamily(r);
  if (i <= 0) return r.x;
  if (i >= r.str.length) return r.x + r.w;
  metric.font = `${r.fs}px ${r.fam}`;
  const whole = metric.measureText(r.str).width;
  return r.x + (whole > 0 ? (r.w * metric.measureText(r.str.slice(0, i)).width) / whole : (r.w * i) / r.str.length);
};
export interface PageRuns { page: number; w: number; h: number; text: string; runs: Run[] }
export interface FindBody { query?: string; regex?: boolean; preset?: 'email' | 'phone' | 'card' | 'date'; caseSensitive?: boolean; wholeWord?: boolean }
export interface Area extends Rect { page: number; label: string }
export interface Block { kind: 'h1' | 'h2' | 'p' | 'table' | 'image'; text?: string; rows?: string[][]; image?: number; page: number }
export interface Pic { page: number; name: string; w: number; h: number; bytes: Uint8Array }

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const PRESETS: Record<string, RegExp> = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  phone: /(?:\+\d{1,2}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{4}\b/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
  date: new RegExp(`\\b\\d{1,2} (?:${MONTHS}) \\d{4}\\b|\\b(?:${MONTHS}) \\d{1,2}, \\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`, 'g'),
};

const luhn = (s: string): boolean => {
  const d = s.replace(/\D/g, '');
  if (d.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
};

export async function pageRuns(bytes: Uint8Array): Promise<PageRuns[]> {
  await fontsReady;
  const doc = await openDocument(bytes.slice());
  const out: PageRuns[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const H = page.view[3] - page.view[1];
    const W = page.view[2] - page.view[0];
    const tc = await page.getTextContent();
    const runs: Run[] = [];
    let text = '';
    let prev: Run | null = null;
    for (const it of tc.items) {
      if (!isTextItem(it) || !it.str) continue;
      const t = it.transform;
      const fs = Math.abs(it.height || t[3]) || 10;
      const run: Run = { str: it.str, x: t[4], top: H - t[5] - fs * 0.82, w: it.width, h: fs * 1.06, base: t[5], fs, start: 0, fam: '' };
      if (prev) {
        if (Math.abs(prev.base - run.base) > 2) text += '\n';
        else if (run.x - (prev.x + prev.w) > fs * 0.25) text += ' ';
      }
      run.start = text.length;
      text += it.str;
      runs.push(run);
      prev = run;
    }
    out.push({ page: p, w: W, h: H, text, runs });
  }
  void doc.loadingTask.destroy();
  return out;
}

const rectsFor = (pr: PageRuns, s: number, e: number): Rect[] => {
  const out: Rect[] = [];
  for (const r of pr.runs) {
    const a = Math.max(s, r.start), b = Math.min(e, r.start + r.str.length);
    if (b <= a) continue;
    const x0 = cx(r, a - r.start), x1 = cx(r, b - r.start);
    out.push({ x: x0, y: r.top, w: x1 - x0, h: r.h });
  }
  return out;
};

export function findIn(pages: PageRuns[], body: FindBody): Match[] {
  let re: RegExp;
  if (body.preset) re = new RegExp(PRESETS[body.preset].source, PRESETS[body.preset].flags);
  else {
    const q = (body.query ?? '').trim();
    if (!q) return [];
    let src = body.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (body.wholeWord) src = `\\b${src}\\b`;
    try { re = new RegExp(src, body.caseSensitive ? 'g' : 'gi'); } catch { return []; }
  }
  const out: Match[] = [];
  for (const pr of pages) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pr.text)) && out.length < 500) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      if (body.preset === 'card' && !luhn(m[0])) continue;
      const s = m.index, e = s + m[0].length;
      const flat = (t: string): string => t.replace(/\s+/g, ' ');
      const before = flat(pr.text.slice(Math.max(0, s - 28), s));
      const after = flat(pr.text.slice(e, e + 28));
      out.push({ page: pr.page, text: m[0], before, after, context: before + m[0] + after, rects: rectsFor(pr, s, e) });
    }
  }
  return out;
}

const hit = (a: Rect, b: Rect): boolean => a.x < b.x + b.w + 1 && a.x + a.w > b.x - 1 && a.y < b.y + b.h && a.y + a.h > b.y;

export function gc(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const ti = ctx.trailerInfo;
  for (const r of [ti.Root, ti.Info, ti.Encrypt]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop() as PDFObject;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFStream) stack.push(o.dict);
    else if (o instanceof PDFDict) for (const v of o.values()) stack.push(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v);
  }
  const drop: PDFRef[] = [];
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) drop.push(ref);
  for (const r of drop) ctx.delete(r);
  return drop.length;
}

export interface Redaction { bytes: Uint8Array; pages: number[]; items: number; log: Array<{ page: number; text: string }> }

export async function redact(bytes: Uint8Array, areas: Area[]): Promise<Redaction> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const runs = await pageRuns(bytes);
  const pdf = await openDocument(bytes.slice());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const byPage = new Map<number, Area[]>();
  for (const a of areas) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a]);
  const SCALE = 2.4;
  for (const [p, list] of byPage) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    ctx.fillStyle = '#000';
    for (const a of list) ctx.fillRect(a.x * SCALE, a.y * SCALE, a.w * SCALE, a.h * SCALE);
    const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b as Blob), 'image/jpeg', 0.9));
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    await img.embed();
    const flat = doc.context.lookup(img.ref);
    if (flat instanceof PDFRawStream) flat.dict.set(PDFName.of('FormpdfDemoFlat'), PDFBool.True);
    const leaf = doc.getPage(p - 1);
    const node = leaf.node;
    for (const k of ['Contents', 'Annots', 'Thumb', 'PieceInfo', 'AA']) node.delete(PDFName.of(k));
    node.set(PDFName.of('Resources'), doc.context.obj({}));
    const { width, height } = leaf.getSize();
    leaf.drawImage(img, { x: 0, y: 0, width, height });
    const pr = runs[p - 1];
    for (const r of pr.runs) {
      const n = r.str.length;
      let i = 0;
      while (i < n) {
        const box = (k: number): Rect => ({ x: cx(r, k), y: r.top, w: cx(r, k + 1) - cx(r, k), h: r.h });
        if (list.some((a) => hit(box(i), a))) { i += 1; continue; }
        let j = i;
        while (j < n && !list.some((a) => hit(box(j), a))) j += 1;
        const seg = r.str.slice(i, j).replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
        if (seg.trim()) {
          const want = cx(r, j) - cx(r, i), have = font.widthOfTextAtSize(seg, r.fs);
          leaf.pushOperators(setCharacterSqueeze(have > 0 ? (want / have) * 100 : 100));
          leaf.drawText(seg, { x: cx(r, i), y: r.base, size: r.fs, font, opacity: 0 });
          leaf.pushOperators(setCharacterSqueeze(100));
        }
        i = j;
      }
    }
  }
  void pdf.loadingTask.destroy();
  gc(doc);
  const out = await doc.save({ useObjectStreams: false });
  return { bytes: out, pages: [...byPage.keys()].sort((a, b) => a - b), items: areas.length, log: areas.map((a) => ({ page: a.page, text: a.label })) };
}

const dictOf = (doc: PDFDocument, o: PDFObject | undefined): PDFDict | undefined => {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
};
const arrOf = (doc: PDFDocument, o: PDFObject | undefined): PDFArray | undefined => {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFArray ? v : undefined;
};
const nameIs = (o: PDFObject | undefined, n: string): boolean => o instanceof PDFName && o.decodeText() === n;
const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'];

function annotsOf(doc: PDFDocument): Array<{ page: number; ref: PDFObject; dict: PDFDict; sub: string }> {
  const out: Array<{ page: number; ref: PDFObject; dict: PDFDict; sub: string }> = [];
  doc.getPages().forEach((pg, i) => {
    const arr = arrOf(doc, pg.node.get(PDFName.of('Annots')));
    if (!arr) return;
    for (const ref of arr.asArray()) {
      const d = dictOf(doc, ref);
      const st = d?.get(PDFName.of('Subtype'));
      if (d) out.push({ page: i + 1, ref, dict: d, sub: st instanceof PDFName ? st.decodeText() : '' });
    }
  });
  return out;
}

function countOutline(doc: PDFDocument): number {
  const root = dictOf(doc, doc.catalog.get(PDFName.of('Outlines')));
  let n = 0;
  let cur = dictOf(doc, root?.get(PDFName.of('First')));
  while (cur && n < 500) { n += 1; cur = dictOf(doc, cur.get(PDFName.of('Next'))); }
  return n;
}

export async function hiddenScan(bytes: Uint8Array): Promise<HiddenItem[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const cat = doc.catalog;
  const info = dictOf(doc, doc.context.trailerInfo.Info);
  const keys = INFO_KEYS.filter((k) => {
    const v = info?.get(PDFName.of(k));
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText().trim() !== '' : false;
  });
  const xmp = cat.get(PDFName.of('Metadata'));
  const names = dictOf(doc, cat.get(PDFName.of('Names')));
  const open = dictOf(doc, cat.get(PDFName.of('OpenAction')));
  const jsNames = names?.get(PDFName.of('JavaScript'));
  const emb = dictOf(doc, names?.get(PDFName.of('EmbeddedFiles')));
  const embNames = arrOf(doc, emb?.get(PDFName.of('Names')));
  const an = annotsOf(doc);
  const att = (embNames ? embNames.size() / 2 : 0) + an.filter((a) => a.sub === 'FileAttachment').length;
  const js = (open && nameIs(open.get(PDFName.of('S')), 'JavaScript') ? 1 : 0) + (jsNames ? 1 : 0);
  const notes = an.filter((a) => !['Link', 'Widget', 'Popup'].includes(a.sub));
  const form = dictOf(doc, cat.get(PDFName.of('AcroForm')));
  const fields = arrOf(doc, form?.get(PDFName.of('Fields')))?.size() ?? 0;
  const thumbs = doc.getPages().filter((p) => p.node.has(PDFName.of('Thumb'))).length;
  const priv = (cat.has(PDFName.of('PieceInfo')) ? 1 : 0) + doc.getPages().filter((p) => p.node.has(PDFName.of('PieceInfo'))).length;
  return [
    { key: 'metadata', label: 'Metadata', count: keys.length + (xmp ? 1 : 0), note: [...keys, xmp ? 'XMP' : ''].filter(Boolean).join(', ') },
    { key: 'javascript', label: 'JavaScript and actions', count: js, note: js ? 'runs when the file opens' : '' },
    { key: 'attachments', label: 'Attached files', count: att, note: att ? 'office-notes.txt' : '' },
    { key: 'comments', label: 'Comments and markups', count: notes.length, note: notes.length ? `page ${notes[0].page}` : '' },
    { key: 'fields', label: 'Form fields', count: fields, note: '' },
    { key: 'layers', label: 'Hidden layers', count: cat.has(PDFName.of('OCProperties')) ? 1 : 0, note: '' },
    { key: 'links', label: 'Links', count: an.filter((a) => a.sub === 'Link').length, note: '' },
    { key: 'bookmarks', label: 'Bookmarks', count: countOutline(doc), note: '' },
    { key: 'thumbnails', label: 'Page thumbnails', count: thumbs, note: '' },
    { key: 'private', label: 'Private application data', count: priv, note: '' },
  ];
}

export async function sanitize(bytes: Uint8Array, remove: string[]): Promise<{ bytes: Uint8Array; freed: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const cat = doc.catalog;
  const has = (k: string): boolean => remove.includes(k);
  if (has('metadata')) {
    const info = dictOf(doc, doc.context.trailerInfo.Info);
    if (info) for (const k of [...INFO_KEYS, 'CreationDate', 'ModDate']) info.delete(PDFName.of(k));
    cat.delete(PDFName.of('Metadata'));
  }
  if (has('javascript')) {
    const open = dictOf(doc, cat.get(PDFName.of('OpenAction')));
    if (open && nameIs(open.get(PDFName.of('S')), 'JavaScript')) cat.delete(PDFName.of('OpenAction'));
    dictOf(doc, cat.get(PDFName.of('Names')))?.delete(PDFName.of('JavaScript'));
    cat.delete(PDFName.of('AA'));
  }
  if (has('attachments')) dictOf(doc, cat.get(PDFName.of('Names')))?.delete(PDFName.of('EmbeddedFiles'));
  const drop = new Set<string>();
  if (has('attachments')) drop.add('FileAttachment');
  if (has('comments')) for (const s of ['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'Ink', 'Stamp', 'Caret', 'Redact', 'Polygon', 'PolyLine']) drop.add(s);
  if (has('links')) drop.add('Link');
  if (drop.size) {
    doc.getPages().forEach((pg) => {
      const arr = arrOf(doc, pg.node.get(PDFName.of('Annots')));
      if (!arr) return;
      const keep = arr.asArray().filter((r) => { const st = dictOf(doc, r)?.get(PDFName.of('Subtype')); return !(st instanceof PDFName && drop.has(st.decodeText())); });
      if (keep.length) pg.node.set(PDFName.of('Annots'), doc.context.obj(keep)); else pg.node.delete(PDFName.of('Annots'));
    });
  }
  if (has('layers')) cat.delete(PDFName.of('OCProperties'));
  if (has('bookmarks')) { cat.delete(PDFName.of('Outlines')); cat.delete(PDFName.of('PageMode')); }
  if (has('thumbnails')) doc.getPages().forEach((p) => p.node.delete(PDFName.of('Thumb')));
  if (has('private')) { cat.delete(PDFName.of('PieceInfo')); doc.getPages().forEach((p) => p.node.delete(PDFName.of('PieceInfo'))); }
  const freed = gc(doc);
  return { bytes: await doc.save({ useObjectStreams: false }), freed };
}

export async function setMeta(bytes: Uint8Array, m: { title: string; author: string; subject: string; keywords: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.setTitle(m.title);
  doc.setAuthor(m.author);
  doc.setSubject(m.subject);
  doc.setKeywords(m.keywords ? m.keywords.split(/\s*,\s*/) : []);
  doc.catalog.delete(PDFName.of('Metadata'));
  gc(doc);
  return doc.save({ useObjectStreams: false });
}

export async function readMeta(bytes: Uint8Array): Promise<{ title: string; author: string; subject: string; keywords: string; creator: string; producer: string; pages: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return { title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', subject: doc.getSubject() ?? '', keywords: doc.getKeywords() ?? '', creator: doc.getCreator() ?? '', producer: doc.getProducer() ?? '', pages: doc.getPageCount() };
}

interface Word { w: string; rect: Rect }

const wordsOf = (pr: PageRuns): Word[] => {
  const out: Word[] = [];
  for (const r of pr.runs) {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.str))) { const x0 = cx(r, m.index), x1 = cx(r, m.index + m[0].length); out.push({ w: m[0], rect: { x: x0, y: r.top, w: x1 - x0, h: r.h } }); }
  }
  return out;
};

const joinRects = (ws: Word[]): Rect[] => {
  const out: Rect[] = [];
  for (const w of ws) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - w.rect.y) < 2 && w.rect.x - (last.x + last.w) < 14) { last.w = w.rect.x + w.rect.w - last.x; }
    else out.push({ ...w.rect });
  }
  return out;
};

export function compareRuns(mine: PageRuns[], other: PageRuns[], otherIsNewer: boolean): CompareResult {
  const changes: CompareChange[] = [];
  const sum = { inserted: 0, deleted: 0, changed: 0 };
  let changedPages = 0, same = 0, added = 0, removed = 0;
  const n = Math.max(mine.length, other.length);
  let id = 1;
  for (let p = 0; p < n; p++) {
    if (p >= mine.length) { removed += 1; changes.push({ id: id++, kind: otherIsNewer ? 'page-added' : 'page-removed', page: null, other: p + 1, at: mine.length, before: '', after: '', rects: [] }); continue; }
    if (p >= other.length) { added += 1; changes.push({ id: id++, kind: otherIsNewer ? 'page-removed' : 'page-added', page: p + 1, other: null, before: '', after: '', rects: [{ x: 0, y: 0, w: mine[p].w, h: mine[p].h }] }); continue; }
    const A = wordsOf(mine[p]), B = wordsOf(other[p]);
    const old = otherIsNewer ? A : B, now = otherIsNewer ? B : A;
    const dp: Uint16Array[] = Array.from({ length: old.length + 1 }, () => new Uint16Array(now.length + 1));
    for (let i = old.length - 1; i >= 0; i--) for (let j = now.length - 1; j >= 0; j--) dp[i][j] = old[i].w === now[j].w ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0, any = false;
    const segs: Array<{ o: Word[]; n: Word[]; at: number }> = [];
    while (i < old.length || j < now.length) {
      if (i < old.length && j < now.length && old[i].w === now[j].w) { i++; j++; continue; }
      const seg = { o: [] as Word[], n: [] as Word[], at: otherIsNewer ? i : j };
      while ((i < old.length || j < now.length) && !(i < old.length && j < now.length && old[i].w === now[j].w)) {
        if (j < now.length && (i >= old.length || dp[i][j + 1] >= dp[i + 1][j])) seg.n.push(now[j++]); else seg.o.push(old[i++]);
      }
      segs.push(seg);
    }
    for (const s of segs) {
      any = true;
      const kind = s.o.length && s.n.length ? 'changed' : s.n.length ? 'inserted' : 'deleted';
      sum[kind] += Math.max(s.o.length, s.n.length);
      const mineSide = otherIsNewer ? s.o : s.n;
      let rects: Rect[];
      if (mineSide.length) rects = joinRects(mineSide);
      else {
        const anchor = A[Math.max(0, s.at - 1)] ?? A[0];
        rects = anchor ? [{ x: anchor.rect.x + anchor.rect.w, y: anchor.rect.y, w: 3, h: anchor.rect.h }] : [];
      }
      changes.push({ id: id++, kind, page: p + 1, other: p + 1, before: s.o.map((w) => w.w).join(' '), after: s.n.map((w) => w.w).join(' '), rects });
    }
    if (any) changedPages += 1; else same += 1;
  }
  return { summary: { pages: mine.length, otherPages: other.length, added, removed, changed: changedPages, same, pictures: 0, words: sum }, changes, truncated: false };
}

export async function listPics(bytes: Uint8Array): Promise<Pic[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: Pic[] = [];
  const seen = new Set<string>();
  doc.getPages().forEach((pg, i) => {
    const res = dictOf(doc, pg.node.get(PDFName.of('Resources')));
    const xo = dictOf(doc, res?.get(PDFName.of('XObject')));
    if (!xo) return;
    for (const [, ref] of xo.entries()) {
      if (!(ref instanceof PDFRef) || seen.has(ref.tag)) continue;
      const st = doc.context.lookup(ref);
      if (!(st instanceof PDFRawStream)) continue;
      if (!nameIs(st.dict.get(PDFName.of('Subtype')), 'Image')) continue;
      const f = st.dict.get(PDFName.of('Filter'));
      const lone = f instanceof PDFArray && f.size() === 1 ? f.get(0) : f;
      if (!nameIs(lone, 'DCTDecode') || st.dict.has(PDFName.of('FormpdfDemoFlat'))) continue;
      seen.add(ref.tag);
      const num = (k: string): number => { const v = st.dict.get(PDFName.of(k)); return v && 'asNumber' in v ? (v as { asNumber(): number }).asNumber() : 0; };
      out.push({ page: i + 1, name: `page${i + 1}-picture${out.length + 1}.jpg`, w: num('Width'), h: num('Height'), bytes: st.contents });
    }
  });
  return out;
}

interface Line { top: number; fs: number; cells: Run[]; text: string; page: number; x: number }

export async function blocksOf(bytes: Uint8Array, pics: Pic[]): Promise<Block[]> {
  const pr = await pageRuns(bytes);
  const pdf = await openDocument(bytes.slice());
  const lines: Line[] = [];
  for (const p of pr) {
    const rows = new Map<number, Run[]>();
    for (const r of p.runs) {
      const key = [...rows.keys()].find((k) => Math.abs(k - r.base) < 2) ?? r.base;
      rows.set(key, [...(rows.get(key) ?? []), r]);
    }
    for (const [, cells] of rows) {
      cells.sort((a, b) => a.x - b.x);
      lines.push({ top: cells[0].top, fs: Math.max(...cells.map((c) => c.fs)), cells, text: cells.map((c) => c.str).join(' ').trim(), page: p.page, x: cells[0].x });
    }
  }
  const norm = (t: string): string => t.replace(/\d+/g, '#');
  const pageCount = pr.length;
  const freq = new Map<string, Set<number>>();
  for (const l of lines) freq.set(norm(l.text), (freq.get(norm(l.text)) ?? new Set()).add(l.page));
  const body = lines.filter((l) => !(pageCount > 1 && (freq.get(norm(l.text))?.size ?? 0) >= Math.min(pageCount, 3)) && l.top > 56);
  type Item = { page: number; top: number; line?: Line; image?: number };
  const items: Item[] = body.map((l) => ({ page: l.page, top: l.top, line: l }));
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const H = page.view[3] - page.view[1];
    const ops = await page.getOperatorList();
    const stack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
    const mine = pics.filter((x) => x.page === p);
    let k = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ops.argsArray[i] as number[], ctm);
      else if (fn === OPS.paintImageXObject && mine[k]) { items.push({ page: p, top: H - (ctm[5] + ctm[3]), image: pics.indexOf(mine[k]) }); k += 1; }
    }
  }
  void pdf.loadingTask.destroy();
  items.sort((a, b) => a.page - b.page || a.top - b.top);
  const out: Block[] = [];
  let prev: Line | null = null;
  for (const it of items) {
    if (it.image !== undefined) { out.push({ kind: 'image', image: it.image, page: it.page }); prev = null; continue; }
    const l = it.line as Line;
    const short = l.cells.every((c) => c.str.length <= 24);
    const tabular = (l.cells.length >= 3 && short) || (l.cells.length === 2 && short && /^[\d.,]+$/.test(l.cells[1].str.trim()));
    if (tabular) {
      const row = l.cells.map((c) => c.str);
      const last = out[out.length - 1];
      if (last && last.kind === 'table' && last.page === l.page) (last.rows as string[][]).push(row); else out.push({ kind: 'table', rows: [row], page: l.page });
      prev = null;
      continue;
    }
    if (l.fs >= 16) { out.push({ kind: l.fs >= 22 ? 'h1' : 'h2', text: l.text, page: l.page }); prev = null; continue; }
    const last = out[out.length - 1];
    if (prev && last && last.kind === 'p' && prev.page === l.page && Math.abs(prev.fs - l.fs) < 0.5 && l.top - prev.top < l.fs * 1.9 && Math.abs(prev.x - l.x) < 6) last.text += ` ${l.text}`;
    else out.push({ kind: 'p', text: l.text, page: l.page });
    prev = l;
  }
  return out.map((b) => (b.kind === 'table' && (b.rows?.length ?? 0) < 2 ? { kind: 'p', text: (b.rows ?? []).map((r) => r.join(' ')).join(' '), page: b.page } as Block : b));
}
