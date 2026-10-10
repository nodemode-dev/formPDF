import { pdfApi, type Derived } from '../pdf/api';
import { printBlob } from '../pdf/printjob';
import { registerTool, type ToolHost } from '../pdf/tools';
import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

interface Box { x: number; y: number; w: number; h: number }
interface Cell { page: number; x: number; y: number; w: number; h: number; rot: number; clip: Box; scale: number }
interface Sheet { w: number; h: number; cells: Cell[]; label: string | null; marks: number[][] }
interface Layout { text: string; sheets: Sheet[]; count: number; border: boolean }
interface Issue { id: string; clause: string; text: string; pages: number[]; count: number; fixable: boolean }
interface PdfaReport { text: string; level: string; conforms: boolean; issues: Issue[]; claims: { part: string; conformance: string; pdfx: string } }
type PStatus = 'fail' | 'warn' | 'info' | 'pass';
interface PCheck { id: string; name: string; status: PStatus; say: string; findings: Array<{ page?: number | null; text: string }>; fix: string | null }
interface PReport { text: string; profile: string; checks: PCheck[]; summary: Record<PStatus, number>; fixes: string[] }

const PREVIEW_H = 250;
const PICON: Record<PStatus, [string, string]> = { fail: ['warning', 'is-bad'], warn: ['info', 'is-warn'], info: ['info', ''], pass: ['success', 'is-ok'] };
const PWORD: Record<PStatus, string> = { fail: 'Failed', warn: 'Warning', info: 'Note', pass: 'Passed' };
const FIXWORD: Record<string, string> = { embed_fonts: 'Embed fonts', hairlines: 'Thicken hairlines', trim_box: 'Set trim boxes', scripts: 'Remove scripts', downsample: 'Downsample pictures', gray: 'Convert to gray' };

let hostRef: ToolHost | null = null;
let layRoot: HTMLElement | null = null;
let stdRoot: HTMLElement | null = null;
let pfRoot: HTMLElement | null = null;
let layout: Layout | null = null;
let layoutFor = '';
let layoutKey = '';
let seq = 0;
let timer = 0;
let sheetAt = 0;
let pdfa: PdfaReport | null = null;
let pdfaFor = '';
let pf: PReport | null = null;
let pfFor = '';

function docId(): string { return hostRef?.doc()?.id ?? ''; }

function val(root: HTMLElement, k: string, attr = 'p'): string { return q<HTMLInputElement | HTMLSelectElement>(root, `[data-${attr}="${k}"]`).value; }
function on(root: HTMLElement, k: string): boolean { return q<HTMLInputElement>(root, `[data-p="${k}"]`).checked; }

function body(): Record<string, unknown> {
  const r = layRoot as HTMLElement;
  const lay = val(r, 'layout');
  const b: Record<string, unknown> = { layout: lay, nup: Number(val(r, 'nup')) || 1, order: val(r, 'order'), border: on(r, 'border'), mode: val(r, 'mode'),
    percent: Number(val(r, 'percent')) || 100, paper: val(r, 'paper'), orientation: val(r, 'orient'), content: val(r, 'content'), gray: on(r, 'gray'),
    binding: val(r, 'binding'), poster: { scale: Number(val(r, 'tile')) || 200, overlap: Number(val(r, 'overlap')) || 0, marks: on(r, 'marks'), labels: on(r, 'labels') } };
  const m = val(r, 'margin').trim();
  if (m) b.margin = Number(m);
  const pages = val(r, 'pages').trim();
  if (pages) b.pages = pages;
  return b;
}

function syncLayoutForm(): void {
  const r = layRoot;
  if (!r) return;
  const lay = val(r, 'layout');
  for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>('[data-lay]'))) { setClass(b, 'is-on', b.dataset.lay === lay); b.setAttribute('aria-pressed', String(b.dataset.lay === lay)); }
  const pages = lay === 'pages';
  for (const k of ['nup', 'order', 'border']) setDisabled(q<HTMLInputElement>(r, `[data-p="${k}"]`), !pages);
  setDisabled(q<HTMLInputElement>(r, '[data-p="order"]'), !pages || val(r, 'nup') === '1');
  setDisabled(q<HTMLInputElement>(r, '[data-p="binding"]'), lay !== 'booklet');
  for (const k of ['tile', 'overlap', 'marks', 'labels']) setDisabled(q<HTMLInputElement>(r, `[data-p="${k}"]`), lay !== 'poster');
  setDisabled(q<HTMLInputElement>(r, '[data-p="mode"]'), lay === 'poster');
  setDisabled(q<HTMLInputElement>(r, '[data-p="percent"]'), lay === 'poster' || val(r, 'mode') !== 'custom');
  const id = docId();
  setDisabled(q<HTMLButtonElement>(r, '[data-p="print"]'), !id);
  setDisabled(q<HTMLButtonElement>(r, '[data-p="save"]'), !id);
}

function schedule(): void {
  syncLayoutForm();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void loadLayout(), 220);
}

async function loadLayout(force = false): Promise<void> {
  const id = docId();
  if (!id || !layRoot) return;
  const b = body();
  const key = `${id}|${JSON.stringify(b)}`;
  if (!force && key === layoutKey) return;
  layoutKey = key;
  const mine = ++seq;
  try {
    const got = await pdfApi.act<Layout>(id, 'print_layout', b);
    if (mine !== seq) return;
    layout = got;
    layoutFor = id;
    sheetAt = Math.min(sheetAt, Math.max(0, got.sheets.length - 1));
    setText(q(layRoot, '[data-p="note"]'), describe(got));
  } catch (err) {
    if (mine !== seq) return;
    layout = null;
    setText(q(layRoot, '[data-p="note"]'), (err as Error).message);
  }
  paintPreview();
}

function describe(l: Layout): string {
  const s = l.sheets[0];
  if (!s) return 'Nothing to print.';
  const inch = (v: number): string => (v / 72).toFixed(2).replace(/\.?0+$/, '');
  return `${l.count} sheet${l.count === 1 ? '' : 's'}, ${inch(s.w)} x ${inch(s.h)} in (${Math.round(s.w * 25.4 / 72)} x ${Math.round(s.h * 25.4 / 72)} mm)${l.count > l.sheets.length ? '; the preview shows the first 400' : ''}.`;
}

function paintPreview(): void {
  const r = layRoot;
  if (!r) return;
  const box = q(r, '[data-p="preview"]');
  let sheetEl = q(box, '.fs-prt-sheet');
  const s = layout && layoutFor === docId() ? layout.sheets[sheetAt] : undefined;
  setText(q(r, '[data-p="pos"]'), s && layout ? `Sheet ${sheetAt + 1} of ${layout.count}` : 'No sheet');
  setDisabled(q<HTMLButtonElement>(r, '[data-p="prev"]'), !s || sheetAt <= 0);
  setDisabled(q<HTMLButtonElement>(r, '[data-p="next"]'), !s || !layout || sheetAt >= layout.sheets.length - 1);
  if (!s) { sheetEl.hidden = true; return; }
  const cw = box.clientWidth - 16 || 260;
  const k = Math.min(cw / s.w, (PREVIEW_H - 16) / s.h);
  const sw = Math.round(s.w * k), sh = Math.round(s.h * k);
  const st = `width:${sw}px;height:${sh}px`;
  if (sheetEl.getAttribute('style') !== st) {
    const fresh = el(`<div class="fs-prt-sheet" style="${st}"><div class="fs-prt-cells"></div><div class="fs-prt-marks"></div></div>`);
    sheetEl.replaceWith(fresh);
    sheetEl = fresh;
  }
  sheetEl.hidden = false;
  const id = docId();
  const scale = Math.min(1.5, Math.max(0.25, k * 1.5 * (s.cells[0]?.scale ?? 1)));
  const gen = `${layoutKey}|${sheetAt}`;
  patchList(q(sheetEl, '.fs-prt-cells'), s.cells.map((c, i) => ({ c, i })), {
    key: (x) => `${gen}|${x.i}`,
    create: (x) => { const n = el('<div class="fs-prt-clip"><div class="fs-prt-page"></div></div>'); fillCell(n, x.c, k, id, scale); return n; },
    update: (n, x) => fillCell(n, x.c, k, id, scale),
  });
  patchList(q(sheetEl, '.fs-prt-marks'), s.marks.map((m, i) => ({ m, i })), {
    key: (x) => `${gen}|${x.i}`,
    create: (x) => { const n = el('<i class="fs-prt-mark"></i>'); fillMark(n, x.m, k); return n; },
    update: (n, x) => fillMark(n, x.m, k),
  });
  setClass(sheetEl, 'has-border', !!layout?.border);
}

function fillCell(n: HTMLElement, c: Cell, k: number, id: string, scale: number): void {
  const clip = `left:${(c.clip.x * k).toFixed(1)}px;top:${(c.clip.y * k).toFixed(1)}px;width:${(c.clip.w * k).toFixed(1)}px;height:${(c.clip.h * k).toFixed(1)}px`;
  if (n.getAttribute('style') !== clip) n.setAttribute('style', clip);
  const pg = n.firstElementChild as HTMLElement;
  const w = c.w * k, h = c.h * k;
  const pw = c.rot ? h : w, ph = c.rot ? w : h;
  const left = (c.x - c.clip.x) * k + (w - pw) / 2, top = (c.y - c.clip.y) * k + (h - ph) / 2;
  const url = pdfApi.renderUrl(id, c.page, scale);
  const geo = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${pw.toFixed(1)}px;height:${ph.toFixed(1)}px;transform:rotate(${c.rot ? -90 : 0}deg)`;
  pg.dataset.geo = geo;
  const style = (): string => (pg.dataset.geo ?? '') + (pg.dataset.url ? `;background-image:url("${pg.dataset.url}")` : '');
  if (pg.getAttribute('style') !== style()) pg.setAttribute('style', style());
  if (pg.dataset.want !== url) {
    pg.dataset.want = url;
    const probe = new Image();
    probe.onload = () => { if (pg.dataset.want === url) { pg.dataset.url = url; pg.setAttribute('style', style()); } };
    probe.src = url;
  }
  pg.title = `Page ${c.page}`;
}

function fillMark(n: HTMLElement, m: number[], k: number): void {
  const [x0, y0, x1, y1] = m.map((v) => v * k);
  const st = `left:${Math.min(x0, x1).toFixed(1)}px;top:${Math.min(y0, y1).toFixed(1)}px;width:${Math.max(1, Math.abs(x1 - x0)).toFixed(1)}px;height:${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}px`;
  if (n.getAttribute('style') !== st) n.setAttribute('style', st);
}

async function doPrint(save: boolean): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d) return;
  await host.ctx.run(save ? 'Making the print PDF' : 'Laying out the sheets', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const got = await pdfApi.actFile(id, 'print_pdf', body());
      if (save) await host.ctx.deliver(got.blob, got.name.replace(/\.pdf$/i, '') + ' (print).pdf');
      else void printBlob(got.blob, host.ctx.run.bind(host.ctx));
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

function syncStd(): void {
  const r = stdRoot;
  if (!r) return;
  const id = docId();
  const fresh = !!pdfa && pdfaFor === id;
  setDisabled(q<HTMLButtonElement>(r, '[data-s="check"]'), !id);
  setDisabled(q<HTMLButtonElement>(r, '[data-s="convert"]'), !id);
  setDisabled(q<HTMLButtonElement>(r, '[data-s="pdfx"]'), !id || !q<HTMLInputElement>(r, '[data-s="profile"]').value.trim());
  setText(q(r, '[data-s="note"]'), !pdfa ? 'PDF/A is the archive standard: everything the file needs to look the same in decades is inside it. Check first, then convert.'
    : !fresh ? 'These results are for an earlier version. Check again.'
      : pdfa.conforms ? `Conforms to PDF/A-${pdfa.level} in every check formpdf runs.` : `${pdfa.issues.length} kind${pdfa.issues.length === 1 ? '' : 's'} of problem for PDF/A-${pdfa.level}; ${pdfa.issues.filter((x) => x.fixable).length} can be fixed by converting.`);
  const items = pdfa && fresh ? pdfa.issues : [];
  patchList(q(r, '[data-s="list"]'), items, {
    key: (x) => x.id,
    create: (x) => { const n = el(`<div class="fs-row fs-tool-row"><span class="fs-row-icon fs-acc-ico"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>`); fillIssue(n, x); return n; },
    update: fillIssue,
  });
  setHidden(q(r, '[data-s="empty"]'), items.length > 0);
  setText(q(r, '[data-s="empty"]'), fresh && pdfa?.conforms ? 'No problems found.' : 'Run a check to list problems with their clause in ISO 19005.');
}

function fillIssue(n: HTMLElement, x: Issue): void {
  const ico = q(n, '.fs-acc-ico');
  const s = x.fixable ? 'fix' : 'stuck';
  if (ico.dataset.s !== s) { ico.innerHTML = icon(x.fixable ? 'info' : 'warning', 14); ico.dataset.s = s; ico.className = `fs-row-icon fs-acc-ico ${x.fixable ? 'is-warn' : 'is-bad'}`; }
  setText(q(n, '.fs-row-title'), `${x.clause} · ${x.text}`);
  setText(q(n, '.fs-row-sub'), `${x.fixable ? 'Fixed by converting' : 'Cannot be fixed here'}${x.pages.length ? ` · page${x.pages.length === 1 ? '' : 's'} ${x.pages.slice(0, 12).join(', ')}${x.pages.length > 12 ? '…' : ''}` : ''}`);
  n.title = `${x.clause} ${x.text}`;
}

async function checkPdfa(): Promise<void> {
  const host = hostRef, d = host?.doc(), r = stdRoot;
  if (!host || !d || !r) return;
  await host.ctx.run('Checking PDF/A', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      pdfa = await pdfApi.act<PdfaReport>(id, 'pdfa_check', { level: val(r, 'level', 's') });
      pdfaFor = id;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  syncStd();
}

async function convertPdfa(): Promise<void> {
  const host = hostRef, d = host?.doc(), r = stdRoot;
  if (!host || !d || !r) return;
  const level = val(r, 'level', 's');
  let ok = false;
  await host.ctx.run(`Converting to PDF/A-${level}`, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived & { conforms?: boolean; remaining?: Issue[]; fonts?: string[] }>(id, 'pdfa', { level });
      await host.ctx.commit(res, `Convert to PDF/A-${level}`);
      ok = true;
      toast(res.conforms ? `Converted to PDF/A-${level}.${res.fonts?.length ? ` Embedded ${res.fonts.join(', ')}.` : ''}` : `Converted, but ${res.remaining?.length ?? 0} kind${res.remaining?.length === 1 ? '' : 's'} of problem remain; see the list.`, res.conforms ? undefined : 'error');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  if (ok) await checkPdfa();
}

async function convertPdfx(): Promise<void> {
  const host = hostRef, d = host?.doc(), r = stdRoot;
  if (!host || !d || !r) return;
  await host.ctx.run('Converting to PDF/X-4', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived & { condition?: string }>(id, 'pdfx', { profile: val(r, 'profile', 's').trim(), condition: val(r, 'condition', 's').trim() || undefined });
      await host.ctx.commit(res, 'Convert to PDF/X-4');
      toast(`Converted to PDF/X-4 for ${res.condition ?? 'the printing condition'}.`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

function syncPf(): void {
  const r = pfRoot;
  if (!r) return;
  const id = docId();
  const fresh = !!pf && pfFor === id;
  setDisabled(q<HTMLButtonElement>(r, '[data-f="run"]'), !id);
  setDisabled(q<HTMLButtonElement>(r, '[data-f="fix"]'), !fresh || !pf?.fixes.filter((f) => f !== 'gray').length);
  setDisabled(q<HTMLButtonElement>(r, '[data-f="report"]'), !id);
  setText(q(r, '[data-f="note"]'), !pf ? 'Checks fonts, picture resolution, colour, transparency, hairlines and scripts for where the PDF is going.'
    : !fresh ? 'These results are for an earlier version. Run preflight again.'
      : `${pf.summary.fail} failed, ${pf.summary.warn} warning${pf.summary.warn === 1 ? '' : 's'}, ${pf.summary.info} note${pf.summary.info === 1 ? '' : 's'}.`);
  const items = pf && fresh ? pf.checks : [];
  patchList(q(r, '[data-f="list"]'), items, {
    key: (x) => x.id,
    create: (x) => { const n = el(`<div class="fs-row fs-tool-row fs-acc-rule"><span class="fs-row-icon fs-acc-ico"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-tool-acts"><button class="fs-btn fs-btn-sm fs-btn-ghost fs-acc-fix" type="button" data-f="one">Fix</button></span></div>`); fillCheck(n, x); return n; },
    update: fillCheck,
  });
  setHidden(q(r, '[data-f="empty"]'), items.length > 0);
}

function fillCheck(n: HTMLElement, x: PCheck): void {
  const [ic, cls] = PICON[x.status];
  const ico = q(n, '.fs-acc-ico');
  if (ico.dataset.s !== x.status) { ico.innerHTML = icon(ic, 14); ico.dataset.s = x.status; ico.className = `fs-row-icon fs-acc-ico ${cls}`; }
  setText(q(n, '.fs-row-title'), x.name);
  setText(q(n, '.fs-row-sub'), `${PWORD[x.status]}. ${x.say}`);
  n.title = x.findings.length ? x.findings.slice(0, 12).map((f) => `${f.page ? `Page ${f.page}: ` : ''}${f.text}`).join('\n') : x.say;
  const b = q<HTMLButtonElement>(n, '[data-f="one"]');
  b.style.visibility = x.fix ? '' : 'hidden';
  b.dataset.fix = x.fix ?? '';
  const label = x.fix ? FIXWORD[x.fix] ?? 'Fix' : 'Fix';
  if (b.title !== label) { b.title = label; b.setAttribute('aria-label', `${label}: ${x.name}`); }
  setDisabled(b, !x.fix);
}

async function runPf(): Promise<void> {
  const host = hostRef, d = host?.doc(), r = pfRoot;
  if (!host || !d || !r) return;
  await host.ctx.run('Preflighting', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      pf = await pdfApi.act<PReport>(id, 'preflight', { profile: val(r, 'profile', 'f') });
      pfFor = id;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  syncPf();
}

async function fixPf(fixes: string[]): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d || !fixes.length) return;
  let ok = false;
  await host.ctx.run('Applying fixups', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived>(id, 'preflight_fix', { fixes });
      await host.ctx.commit(res, fixes.length === 1 ? FIXWORD[fixes[0]] ?? 'Preflight fixup' : 'Preflight fixups');
      ok = true;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  if (ok) await runPf();
}

async function pfReport(): Promise<void> {
  const host = hostRef, d = host?.doc(), r = pfRoot;
  if (!host || !d || !r) return;
  await host.ctx.run('Writing the preflight report', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const got = await pdfApi.actFile(id, 'preflight_report', { profile: val(r, 'profile', 'f'), name: d.name });
      await host.ctx.deliver(got.blob, got.name);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

const sel = (k: string, label: string, opts: Array<[string, string]>, value?: string): string =>
  `<div class="fs-prop-row"><span class="fs-prop-label">${label}</span><div class="fs-prop-ctl"><select data-p="${k}" aria-label="${label}">${opts.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>`;
const num = (k: string, label: string, value: string, unit: string, ph = ''): string =>
  `<div class="fs-prop-row"><span class="fs-prop-label">${label}</span><div class="fs-prop-ctl"><div class="fs-num"><input type="number" data-p="${k}" value="${value}" placeholder="${ph}" aria-label="${label}"><span class="fs-unit">${unit}</span></div></div></div>`;

registerTool({
  id: 'print-layout',
  tab: 'print',
  title: 'Print',
  words: ['print', 'booklet', 'n-up', 'pages per sheet', 'poster', 'tile', 'grayscale', 'print preview'],
  section: () => `<input type="hidden" data-p="layout" value="pages">
<div class="fs-tool-seg fs-prt-seg" role="group" aria-label="Layout"><button type="button" class="fs-btn fs-btn-sm" data-lay="pages">Pages</button><button type="button" class="fs-btn fs-btn-sm" data-lay="booklet">Booklet</button><button type="button" class="fs-btn fs-btn-sm" data-lay="poster">Poster</button></div>
<div class="fs-prt-preview" data-p="preview"><div class="fs-prt-sheet" hidden><div class="fs-prt-cells"></div><div class="fs-prt-marks"></div></div></div>
<div class="fs-acc-figbar"><button class="fs-icon-btn is-sm" type="button" data-p="prev" title="Previous sheet" aria-label="Previous sheet" disabled>${icon('chevronLeft', 14)}</button><span class="fs-acc-figpos" data-p="pos">No sheet</span><button class="fs-icon-btn is-sm" type="button" data-p="next" title="Next sheet" aria-label="Next sheet" disabled>${icon('chevronRight', 14)}</button></div>
<p class="fs-note fs-prt-note" data-p="note" aria-live="polite"></p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-p="print">${icon('pdf', 14)}Print…</button><button class="fs-btn fs-btn-sm" type="button" data-p="save">${icon('download', 14)}Save print PDF</button></div>
<div class="fs-prop-row"><span class="fs-prop-label">Pages</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-p="pages" placeholder="All pages, or 1-4, 7" aria-label="Pages"></div></div>
${sel('nup', 'Per sheet', [['1', '1'], ['2', '2'], ['4', '4'], ['6', '6'], ['9', '9'], ['16', '16']])}
${sel('order', 'Order', [['horizontal', 'Across, then down'], ['horizontal-reversed', 'Across from the right'], ['vertical', 'Down, then across'], ['vertical-reversed', 'Down from the right']])}
<label class="fs-check"><input type="checkbox" data-p="border">Border around each page</label>
${sel('binding', 'Binding', [['left', 'Left edge'], ['right', 'Right edge']])}
${num('tile', 'Tile scale', '200', '%')}
${num('overlap', 'Overlap', '18', 'pt')}
<label class="fs-check"><input type="checkbox" data-p="marks" checked>Cut marks</label>
<label class="fs-check"><input type="checkbox" data-p="labels" checked>Tile labels</label>
${sel('mode', 'Size', [['fit', 'Fit to the sheet'], ['shrink', 'Shrink oversized pages'], ['actual', 'Actual size'], ['custom', 'Custom scale']])}
${num('percent', 'Scale', '100', '%')}
${sel('paper', 'Paper', [['auto', 'Same as the pages'], ['letter', 'Letter'], ['legal', 'Legal'], ['tabloid', 'Tabloid'], ['a4', 'A4'], ['a3', 'A3'], ['a5', 'A5']])}
${sel('orient', 'Orientation', [['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']])}
${num('margin', 'Margin', '', 'pt', 'Auto')}
${sel('content', 'Comments', [['markups', 'Document and markups'], ['document', 'Document only'], ['stamps', 'Document and stamps'], ['fields', 'Form fields only']])}
<label class="fs-check"><input type="checkbox" data-p="gray">Grayscale (converted here, not by the printer)</label>`,
  mount: (root, host) => {
    hostRef = host;
    layRoot = root;
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-lay], [data-p]');
      if (!t) return;
      if (t.dataset.lay) { q<HTMLInputElement>(root, '[data-p="layout"]').value = t.dataset.lay; sheetAt = 0; schedule(); return; }
      switch (t.dataset.p) {
        case 'print': void doPrint(false); break;
        case 'save': void doPrint(true); break;
        case 'prev': sheetAt = Math.max(0, sheetAt - 1); paintPreview(); break;
        case 'next': sheetAt = Math.min((layout?.sheets.length ?? 1) - 1, sheetAt + 1); paintPreview(); break;
      }
    });
    root.addEventListener('change', () => schedule());
    const bench = root.closest<HTMLElement>('.fs-pdfwb');
    if (bench) new MutationObserver(() => { if (bench.dataset.tab === 'print') { syncLayoutForm(); void loadLayout(); } }).observe(bench, { attributes: true, attributeFilter: ['data-tab'] });
    root.addEventListener('input', (e) => { if ((e.target as HTMLElement).matches('input[type="text"], input[type="number"]')) schedule(); });
    syncLayoutForm();
  },
  sync: (_root, host) => { hostRef = host; syncLayoutForm(); if (document.querySelector<HTMLElement>('.fs-pdfwb')?.dataset.tab === 'print' && layoutFor !== docId()) void loadLayout(true); },
  commands: (host) => [
    { id: 'tool-print-booklet', label: 'Print a booklet…', words: ['booklet', 'saddle stitch'], enabled: () => !!host.doc(), run: () => { host.setTab('print'); if (layRoot) { q<HTMLInputElement>(layRoot, '[data-p="layout"]').value = 'booklet'; schedule(); } } },
    { id: 'tool-print-save', label: 'Save a print PDF', words: ['imposition', 'n-up pdf'], enabled: () => !!host.doc(), run: () => void doPrint(true) },
  ],
});

registerTool({
  id: 'print-standards',
  tab: 'print',
  title: 'PDF/A and PDF/X',
  words: ['pdf/a', 'archive', 'pdf/x', 'press', 'iso 19005', 'output intent'],
  section: () => `<p class="fs-note fs-tool-note" data-s="note"></p>
<div class="fs-prop-row"><span class="fs-prop-label">Level</span><div class="fs-prop-ctl"><select data-s="level" aria-label="PDF/A level"><option value="2b">PDF/A-2b (looks the same)</option><option value="2u" selected>PDF/A-2u (and text can be copied)</option><option value="3b">PDF/A-3b (keeps attached files)</option></select></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-s="check">${icon('find', 14)}Check</button><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-s="convert">Convert to PDF/A</button></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-s="list"></div><p class="fs-note fs-tool-empty" data-s="empty"></p></div>
<div class="fs-pdfwb-subhead">PDF/X-4 for a press</div>
<div class="fs-prop-row"><span class="fs-prop-label">Profile</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-s="profile" placeholder="Path to the printer's .icc profile" spellcheck="false" aria-label="ICC profile path"></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Condition</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-s="condition" placeholder="For example FOGRA39" spellcheck="false" aria-label="Printing condition"></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-s="pdfx" disabled>Convert to PDF/X-4</button></div>`,
  mount: (root, host) => {
    hostRef = host;
    stdRoot = root;
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-s]');
      if (!t || t.disabled) return;
      if (t.dataset.s === 'check') void checkPdfa();
      else if (t.dataset.s === 'convert') void convertPdfa();
      else if (t.dataset.s === 'pdfx') void convertPdfx();
    });
    root.addEventListener('input', () => syncStd());
    syncStd();
  },
  sync: (_root, host) => { hostRef = host; syncStd(); },
  commands: (host) => [
    { id: 'tool-pdfa', label: 'Convert to PDF/A', words: ['archive', 'pdf/a'], enabled: () => !!host.doc(), run: () => { host.setTab('print'); void convertPdfa(); } },
  ],
});

registerTool({
  id: 'print-preflight',
  tab: 'print',
  title: 'Preflight',
  words: ['preflight', 'press check', 'resolution', 'fonts embedded'],
  section: () => `<p class="fs-note fs-tool-note" data-f="note"></p>
<div class="fs-prop-row"><span class="fs-prop-label">For</span><div class="fs-prop-ctl"><select data-f="profile" aria-label="Preflight profile"><option value="print">Commercial print</option><option value="office">Office printer</option><option value="screen">Screen and email</option></select></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-f="run">${icon('find', 14)}Run preflight</button><button class="fs-btn fs-btn-sm" type="button" data-f="fix" disabled>${icon('magic', 14)}Apply fixups</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-f="report" disabled>${icon('download', 14)}Report</button></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-f="list"></div><p class="fs-note fs-tool-empty" data-f="empty">Run preflight to see the results.</p></div>`,
  mount: (root, host) => {
    hostRef = host;
    pfRoot = root;
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-f]');
      if (!t || t.disabled) return;
      if (t.dataset.f === 'run') void runPf();
      else if (t.dataset.f === 'fix' && pf) void fixPf(pf.fixes.filter((f) => f !== 'gray'));
      else if (t.dataset.f === 'one' && t.dataset.fix) void fixPf([t.dataset.fix]);
      else if (t.dataset.f === 'report') void pfReport();
    });
    syncPf();
  },
  sync: (_root, host) => { hostRef = host; syncPf(); },
});
