import { api } from '../io/api';
import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { t } from '../ui/i18n';
import { PageLayers, place } from './overlay';

type Status = 'passed' | 'failed' | 'manual' | 'skipped';
interface Finding { page?: number | null; text: string; id?: string; box?: { x: number; y: number; w: number; h: number } | null }
interface Rule { id: string; group: string; name: string; status: Status; say: string; findings: Finding[]; more: number; fix: string | null }
interface Report { text: string; summary: Record<Status, number>; groups: Array<{ name: string; rules: Rule[] }>; tagged: boolean; pages: number; title: string; lang: string; fixes: string[] }
interface Box { x: number; y: number; w: number; h: number }
interface Region { id: string; page: number; order: number; type: string; tag: string; text: string; alt: string; weak?: boolean; box: Box | null; pw: number; ph: number }

const needsAlt = (x: Region): boolean => !x.alt || !!x.weak;
interface Structure { text: string; tagged: boolean; regions: Region[]; figures: Region[]; types: string[] }

const STATUS_ICON: Record<Status, [string, string]> = { failed: ['warning', 'is-bad'], manual: ['info', 'is-warn'], passed: ['success', 'is-ok'], skipped: ['minus', ''] };
const STATUS_WORD: Record<Status, string> = { failed: 'Failed', manual: 'Check by hand', passed: 'Passed', skipped: 'Skipped' };
const FIX_LABEL: Record<string, string> = { tag: 'Tag the PDF', title: 'Set the title', lang: 'Set the language', tabs: 'Fix tab order', annotations: 'Add to the tags',
  descriptions: 'Add descriptions', summaries: 'Add summaries', bookmarks: 'Make bookmarks', headings: 'Re-level headings by size', spans: 'Mark their language' };
const TYPE_LABEL: Record<string, string> = { P: 'Paragraph', H1: 'Heading 1', H2: 'Heading 2', H3: 'Heading 3', H4: 'Heading 4', H5: 'Heading 5', H6: 'Heading 6',
  BlockQuote: 'Quotation', Caption: 'Caption', Note: 'Note', Code: 'Code', Formula: 'Formula', Figure: 'Figure', Span: 'Text span', L: 'List', Table: 'Table',
  Link: 'Link', Form: 'Form field', Annot: 'Comment', TOC: 'Contents', LI: 'List item', TR: 'Table row', TH: 'Header cell', TD: 'Cell', Artifact: 'Background (not read)' };
const RETAG = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BlockQuote', 'Caption', 'Note', 'Code', 'Formula', 'Figure', 'Span'];
const CHECK_INTRO = 'Checks Acrobat\'s 32 accessibility rules, then whether the tags are right, and says what to fix. Nothing changes until you choose a fix.';

let hostRef: ToolHost | null = null;
let checkRoot: HTMLElement | null = null;
let tagRoot: HTMLElement | null = null;
let orderRoot: HTMLElement | null = null;
let altRoot: HTMLElement | null = null;
let report: Report | null = null;
let reportFor = '';
let checking = '';
let tagged: boolean | null = null;
let taggedFor = '';
const regions = new Map<number, Region[]>();
let regionsFor = '';
const wanted = new Set<number>();
const inflight = new Set<number>();
let fetchTimer = 0;
let selected = '';
let orderPage = 1;
let figures: Region[] = [];
let figuresFor = '';
let figuresLoading = '';
let figIndex = 0;
let watching = false;
const drafts = new Map<string, { alt: string; decorative: boolean }>();
let draftsFor = '';
let drafting = '';
let draftSay = '';
let draftAsk = '';

function docId(): string { return hostRef?.doc()?.id ?? ''; }

function onTab(): boolean { return document.querySelector<HTMLElement>('.fs-pdfwb')?.dataset.tab === 'access'; }

function label(t: string): string { return TYPE_LABEL[t] ?? t; }

const layers = new PageLayers('access', (index, layer) => {
  const show = !!orderRoot && q<HTMLInputElement>(orderRoot, '[data-o="show"]').checked && onTab();
  const page = index + 1;
  if (show && docId() && regionsFor === docId() && !regions.has(page)) want(page);
  else if (show && docId() && regionsFor !== docId()) want(page);
  const list = show && regionsFor === docId() ? (regions.get(page) ?? []).filter((r) => r.box) : [];
  patchList(layer, list, {
    key: (r) => `${regionsFor}|${r.id}`,
    create: (r) => { const n = el('<div class="fs-acc-region"><span class="fs-acc-num"></span></div>'); paintRegion(n, r); return n; },
    update: (n, r) => paintRegion(n, r),
  });
});

function paintRegion(n: HTMLElement, r: Region): void {
  const b = r.box as Box;
  place(n, b.x, b.y, Math.max(2, b.w), Math.max(2, b.h));
  setText(q(n, '.fs-acc-num'), String(r.order));
  setClass(n, 'is-selected', r.id === selected);
  setClass(n, 'is-figure', r.type === 'Figure');
  const title = `${r.order}. ${label(r.type)}${r.text ? `: ${r.text.slice(0, 80)}` : ''}`;
  if (n.title !== title) n.title = title;
}

function want(page: number): void {
  const id = docId();
  if (!id) return;
  if (regionsFor !== id) { regions.clear(); inflight.clear(); wanted.clear(); regionsFor = id; }
  if (regions.has(page) || inflight.has(page)) return;
  wanted.add(page);
  if (!fetchTimer) fetchTimer = window.setTimeout(() => void fetchRegions(), 40);
}

async function fetchRegions(): Promise<void> {
  fetchTimer = 0;
  const id = docId();
  if (!id || !wanted.size || regionsFor !== id) return;
  const pages = [...wanted].sort((a, b) => a - b).slice(0, 24);
  for (const p of pages) { wanted.delete(p); inflight.add(p); }
  try {
    const got = await pdfApi.act<Structure>(id, 'structure', { pages: pages.join(',') });
    if (regionsFor !== id) return;
    tagged = got.tagged;
    taggedFor = id;
    for (const p of pages) regions.set(p, []);
    for (const r of got.regions) regions.get(r.page)?.push(r);
  } catch {
    if (regionsFor === id) for (const p of pages) regions.set(p, []);
  } finally {
    for (const p of pages) inflight.delete(p);
  }
  layers.repaint(pages.map((p) => p - 1));
  syncOrder();
  syncTag();
  if (wanted.size && !fetchTimer) fetchTimer = window.setTimeout(() => void fetchRegions(), 40);
}

function syncCheck(): void {
  const root = checkRoot, host = hostRef;
  if (!root || !host) return;
  const id = docId();
  const fresh = !!report && reportFor === id;
  setDisabled(q<HTMLButtonElement>(root, '[data-x="run"]'), !id || checking !== '');
  setDisabled(q<HTMLButtonElement>(root, '[data-x="fixall"]'), !fresh || !report?.fixes.length || checking !== '');
  setDisabled(q<HTMLButtonElement>(root, '[data-x="report"]'), !id);
  let note = CHECK_INTRO;
  if (checking) note = 'Checking every page.';
  else if (report && !fresh) note = 'These results are for an earlier version of the PDF. Run the check again.';
  else if (report) note = report.summary.failed ? `${report.summary.failed} rule${report.summary.failed === 1 ? '' : 's'} failed. Fix them here, or follow each rule's advice.` : 'No rule failed. Check the items marked Check by hand.';
  setText(q(root, '[data-x="note"]'), note);
  for (const s of ['failed', 'manual', 'passed', 'skipped'] as Status[]) setText(q(root, `[data-x="n-${s}"]`), report ? String(report.summary[s]) : '0');
  const rules = report ? report.groups.flatMap((g) => g.rules) : [];
  patchList(q(root, '[data-x="list"]'), rules, {
    key: (r) => r.id,
    create: (r) => {
      const n = el(`<div class="fs-row fs-tool-row fs-acc-rule" data-x="pick"><span class="fs-row-icon fs-acc-ico"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-tool-acts"><button class="fs-btn fs-btn-sm fs-btn-ghost fs-acc-fix" type="button" data-x="fix">Fix</button></span></div>`);
      fillRule(n, r);
      return n;
    },
    update: (n, r) => fillRule(n, r),
  });
  setHidden(q(root, '[data-x="empty"]'), rules.length > 0);
}

function fillRule(n: HTMLElement, r: Rule): void {
  const [ic, cls] = STATUS_ICON[r.status];
  const ico = q(n, '.fs-acc-ico');
  if (ico.dataset.s !== r.status) { ico.innerHTML = icon(ic, 14); ico.dataset.s = r.status; ico.className = `fs-row-icon fs-acc-ico ${cls}`; }
  setText(q(n, '.fs-row-title'), `${r.group} · ${r.name}`);
  setText(q(n, '.fs-row-sub'), `${t(STATUS_WORD[r.status])}. ${t(r.say)}`);
  const tip = r.findings.length ? r.findings.slice(0, 12).map((f) => `${f.page ? `Page ${f.page}: ` : ''}${f.text}`).join('\n') + (r.findings.length > 12 || r.more ? '\n…' : '') : r.say;
  if (n.title !== tip) n.title = tip;
  const fix = q<HTMLButtonElement>(n, '[data-x="fix"]');
  const fl = r.fix ? FIX_LABEL[r.fix] ?? 'Fix' : 'Fix';
  if (fix.title !== fl) { fix.title = fl; fix.setAttribute('aria-label', `${fl}: ${r.name}`); }
  fix.style.visibility = r.fix ? '' : 'hidden';
  setDisabled(fix, !r.fix || reportFor !== docId());
  fix.dataset.fix = r.fix ?? '';
}

async function runCheck(): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d || checking) return;
  checking = d.id;
  syncCheck();
  await host.ctx.run('Checking accessibility', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const got = await pdfApi.act<Report>(id, 'accessibility', {});
      report = got;
      reportFor = id;
      tagged = got.tagged;
      taggedFor = id;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  checking = '';
  syncCheck();
  syncTag();
  const list = checkRoot ? q(checkRoot, '[data-x="list"]') : null;
  const bad = list?.querySelector<HTMLElement>('.fs-acc-ico[data-s="failed"]')?.closest<HTMLElement>('.fs-acc-rule');
  if (list && bad) list.scrollTop = Math.max(0, bad.offsetTop - list.offsetTop - 4);
}

async function applyFix(fixes: string[], what: string): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d || !fixes.length) return;
  const body: Record<string, unknown> = { fixes };
  if (tagRoot) {
    const lang = q<HTMLInputElement>(tagRoot, '[data-g="lang"]').value.trim();
    const title = q<HTMLInputElement>(tagRoot, '[data-g="title"]').value.trim();
    if (lang) body.lang = lang;
    if (title) body.title = title;
  }
  let ok = false;
  await host.ctx.run(what, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived & { fixed?: string[] }>(id, 'fix_accessibility', body);
      await host.ctx.commit(res, what);
      ok = true;
      const n = res.fixed?.length ?? 0;
      toast(n ? `Fixed: ${(res.fixed ?? []).map((f) => FIX_LABEL[f]?.toLowerCase() ?? f).join(', ')}.` : 'Nothing needed fixing.');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  if (ok) await runCheck();
}

async function saveReport(): Promise<void> {
  const host = hostRef, d = host?.doc();
  if (!host || !d) return;
  await host.ctx.run('Writing the accessibility report', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const got = await pdfApi.actFile(id, 'accessibility_report', { name: d.name });
      await host.ctx.deliver(got.blob, got.name);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

function syncTag(): void {
  const root = tagRoot;
  if (!root) return;
  const id = docId();
  setDisabled(q<HTMLButtonElement>(root, '[data-g="tag"]'), !id);
  const known = taggedFor === id ? tagged : null;
  setText(q(root, '[data-g="note"]'), known === true
    ? 'This PDF is tagged. Tagging again replaces the tags, including alternate text and reading order changes made here.'
    : known === false ? 'This PDF has no tags. Tagging adds headings, paragraphs, lists, tables, figures, links and form fields in reading order, worked out from the layout.'
      : 'Tagging adds the structure screen readers follow: headings, paragraphs, lists, tables, figures, links and form fields in reading order.');
}

async function runTag(): Promise<void> {
  const host = hostRef, root = tagRoot, d = host?.doc();
  if (!host || !root || !d) return;
  const body: Record<string, unknown> = {};
  const lang = q<HTMLInputElement>(root, '[data-g="lang"]').value.trim();
  const title = q<HTMLInputElement>(root, '[data-g="title"]').value.trim();
  if (lang) body.lang = lang;
  if (title) body.title = title;
  let ok = false;
  await host.ctx.run(`Tagging ${d.info.pages} page${d.info.pages === 1 ? '' : 's'}`, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived & { elements?: number; headings?: number; tables?: number; figures?: number; lists?: number }>(id, 'autotag', body);
      await host.ctx.commit(res, 'Tag for accessibility');
      ok = true;
      const n = (v: number | undefined, w: string): string => `${v ?? 0} ${w}${v === 1 ? '' : 's'}`;
      toast(`Tagged ${n(res.elements, 'region')}: ${n(res.headings, 'heading')}, ${n(res.lists, 'list')}, ${n(res.tables, 'table')}, ${n(res.figures, 'figure')}.`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  if (ok) { refreshAll(); await runCheck(); }
}

function refreshAll(): void {
  regions.clear();
  regionsFor = '';
  figures = [];
  figuresFor = '';
  selected = '';
  if (onTab()) { want(orderPage); void loadFigures(); }
  layers.repaint();
  syncOrder();
  syncAlt();
}

function syncOrder(): void {
  const root = orderRoot, host = hostRef;
  if (!root || !host) return;
  const d = host.doc();
  const n = d?.info.pages ?? 0;
  const pin = q<HTMLInputElement>(root, '[data-o="page"]');
  orderPage = Math.max(1, Math.min(n || 1, orderPage));
  if (document.activeElement !== pin && pin.value !== String(orderPage)) pin.value = String(orderPage);
  pin.max = String(Math.max(1, n));
  setText(q(root, '[data-o="pages"]'), String(n));
  const id = docId();
  const list = regionsFor === id ? regions.get(orderPage) : undefined;
  const items = list ?? [];
  if (id && onTab() && list === undefined) want(orderPage);
  const known = taggedFor === id ? tagged : null;
  setText(q(root, '[data-o="note"]'), !id ? 'Open a PDF.' : known === false ? 'This PDF has no tags yet. Tag it first, then check the order here.'
    : list === undefined ? 'Reading the tags on this page.' : items.length ? 'Screen readers read the regions in this order. Select one to change its type or move it.' : 'Nothing on this page is tagged.');
  patchList(q(root, '[data-o="list"]'), items, {
    key: (r) => `${regionsFor}|${r.id}`,
    create: (r) => { const n = el('<div class="fs-row fs-tool-row fs-acc-orow" data-o="pick"><span class="fs-badge is-count fs-acc-ord"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>'); fillOrder(n, r); return n; },
    update: (n, r) => fillOrder(n, r),
  });
  setHidden(q(root, '[data-o="empty"]'), items.length > 0 || list === undefined);
  const sel = items.find((r) => r.id === selected) ?? null;
  const tsel = q<HTMLSelectElement>(root, '[data-o="type"]');
  const opts = sel && !RETAG.includes(sel.type) ? [sel.type, ...RETAG, 'Artifact'] : [...RETAG, 'Artifact'];
  const html = opts.map((t) => `<option value="${t}"${sel && !RETAG.includes(t) && t === sel.type ? ' disabled' : ''}>${label(t)}</option>`).join('');
  if (tsel.dataset.html !== html) { tsel.innerHTML = html; tsel.dataset.html = html; }
  if (sel && tsel.value !== sel.type) tsel.value = sel.type;
  setDisabled(tsel, !sel);
  const at = sel ? items.indexOf(sel) : -1;
  setDisabled(q<HTMLButtonElement>(root, '[data-o="up"]'), !sel || at <= 0);
  setDisabled(q<HTMLButtonElement>(root, '[data-o="down"]'), !sel || at < 0 || at >= items.length - 1);
  setText(q(root, '[data-o="selnote"]'), sel ? `${sel.order}. ${label(sel.type)}${sel.tag !== sel.type ? ` (tagged ${sel.tag})` : ''}` : 'No region selected');
}

function fillOrder(n: HTMLElement, r: Region): void {
  setText(q(n, '.fs-acc-ord'), String(r.order));
  setText(q(n, '.fs-row-title'), label(r.type));
  setText(q(n, '.fs-row-sub'), r.text || (r.type === 'Figure' ? (r.alt ? `Alternate text: ${r.alt}` : 'No alternate text') : '(no text)'));
  setClass(n, 'is-selected', r.id === selected);
  n.setAttribute('aria-selected', String(r.id === selected));
}

function selectRegion(id: string, scroll: boolean): void {
  selected = id;
  syncOrder();
  layers.repaint([orderPage - 1]);
  const r = (regions.get(orderPage) ?? []).find((x) => x.id === id);
  if (scroll && r?.box && hostRef) hostRef.ctx.viewer.scrollToPoint(r.page - 1, r.box.x + r.box.w / 2, r.box.y);
}

async function editTags(changes: Array<Record<string, unknown>>, what: string): Promise<boolean> {
  const host = hostRef, d = host?.doc();
  if (!host || !d) return false;
  let ok = false;
  await host.ctx.run(what, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived>(id, 'edit_structure', { changes });
      await host.ctx.commit(res, what);
      ok = true;
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  return ok;
}

async function move(step: -1 | 1): Promise<void> {
  const items = regions.get(orderPage) ?? [];
  const r = items.find((x) => x.id === selected);
  const other = r ? items[items.indexOf(r) + step] : undefined;
  if (!r || !other) return;
  const ok = await editTags([{ id: r.id, move: step < 0 ? 'up' : 'down' }], step < 0 ? 'Move earlier in reading order' : 'Move later in reading order');
  if (!ok) return;
  const same = r.id.split('.').slice(0, -1).join('.') === other.id.split('.').slice(0, -1).join('.');
  selected = same ? other.id : '';
  refreshAll();
  selected = same ? other.id : '';
}

async function retag(type: string): Promise<void> {
  const r = (regions.get(orderPage) ?? []).find((x) => x.id === selected);
  if (!r || type === r.type) return;
  const ok = await editTags([type === 'Artifact' ? { id: r.id, decorative: true } : { id: r.id, type }], type === 'Artifact' ? 'Mark as background' : `Tag as ${label(type).toLowerCase()}`);
  if (!ok) { syncOrder(); return; }
  const keep = type === 'Artifact' ? '' : r.id;
  refreshAll();
  selected = keep;
}

async function loadFigures(): Promise<void> {
  const id = docId();
  if (!id || figuresFor === id || figuresLoading === id) return;
  figuresLoading = id;
  syncAlt();
  try {
    const got = await pdfApi.act<Structure>(id, 'structure', { only: 'figures' });
    if (docId() !== id) return;
    figures = got.figures;
    figuresFor = id;
    tagged = got.tagged;
    taggedFor = id;
    figIndex = Math.max(0, Math.min(figIndex, figures.length - 1));
  } catch { figures = []; figuresFor = id; } finally { if (figuresLoading === id) figuresLoading = ''; }
  syncAlt(true);
  syncTag();
}

function syncAlt(reset = false): void {
  const root = altRoot;
  if (!root) return;
  const id = docId();
  const ready = figuresFor === id;
  const f = ready ? figures[figIndex] : undefined;
  const known = taggedFor === id ? tagged : null;
  setText(q(root, '[data-f="note"]'), !id ? 'Open a PDF.' : known === false ? 'Tag the PDF first; figures are found while tagging.' : !ready ? 'Finding figures.'
    : !figures.length ? 'There are no tagged figures.' : 'Say what the picture shows and why it matters. Mark it decorative if it only decorates the page.');
  setText(q(root, '[data-f="pos"]'), f ? `Figure ${figIndex + 1} of ${figures.length} · page ${f.page}` : 'No figure');
  setDisabled(q<HTMLButtonElement>(root, '[data-f="prev"]'), !f || figIndex <= 0);
  setDisabled(q<HTMLButtonElement>(root, '[data-f="next"]'), !f || figIndex >= figures.length - 1);
  const ta = q<HTMLTextAreaElement>(root, '[data-f="alt"]');
  const deco = q<HTMLInputElement>(root, '[data-f="deco"]');
  setDisabled(deco, !f);
  if (draftsFor !== id) { drafts.clear(); draftsFor = id; }
  const draft = f && needsAlt(f) ? drafts.get(f.id) : undefined;
  if (reset) { ta.value = (draft ? draft.alt : f?.alt) ?? ''; deco.checked = !!draft?.decorative; }
  const fromDraft = !!draft && (deco.checked ? draft.decorative : ta.value.trim() === draft.alt);
  const missing = ready ? figures.filter((x) => needsAlt(x) && !drafts.has(x.id)).length : 0;
  setText(q(root, '[data-f="draftnote"]'), drafting === id ? draftSay : fromDraft ? (draft.decorative ? 'Drafted by AI as decorative. Check the picture, then Save, or untick to describe it.' : 'Drafted by AI. Read it against the picture, change what is wrong, then Save.') : draftSay);
  setHidden(q(root, '[data-f="draftnote"]'), !(drafting === id || fromDraft || draftSay));
  const db = q<HTMLButtonElement>(root, '[data-f="draft"]');
  setDisabled(db, !ready || drafting === id || (!missing && !(f && needsAlt(f))));
  setText(q(db, '.fs-acc-draftlabel'), drafting === id ? 'Drafting…' : missing ? `Draft alt text for ${missing} figure${missing === 1 ? '' : 's'}` : 'Draft alt text with AI');
  if (ta.disabled !== (!f || deco.checked)) ta.disabled = !f || deco.checked;
  setDisabled(q<HTMLButtonElement>(root, '[data-f="save"]'), !f || (!deco.checked && ta.value.trim() === (f?.alt ?? '')));
  const thumb = q(root, '[data-f="thumb"]');
  const pic = q(thumb, '.fs-acc-pic');
  if (!f || !f.box || !hostRef?.doc()) { pic.hidden = true; return; }
  const cw = thumb.clientWidth || 260, ch = thumb.clientHeight || 150;
  const s = Math.min((cw - 8) / Math.max(1, f.box.w), (ch - 8) / Math.max(1, f.box.h), 2);
  const scale = Math.min(3, Math.max(0.5, s * 1.5));
  const url = pdfApi.renderUrl(id, f.page, scale);
  const style = `width:${Math.round(f.box.w * s)}px;height:${Math.round(f.box.h * s)}px;background-image:url("${url}");background-size:${Math.round(f.pw * s)}px ${Math.round(f.ph * s)}px;background-position:${-Math.round(f.box.x * s)}px ${-Math.round(f.box.y * s)}px`;
  if (pic.getAttribute('style') !== style) {
    const probe = new Image();
    probe.onload = () => { if (pic.dataset.want === url) { pic.setAttribute('style', style); pic.hidden = false; } };
    pic.dataset.want = url;
    probe.src = url;
  } else pic.hidden = false;
}

async function saveAlt(): Promise<void> {
  const root = altRoot, f = figures[figIndex];
  if (!root || !f) return;
  const deco = q<HTMLInputElement>(root, '[data-f="deco"]').checked;
  const alt = q<HTMLTextAreaElement>(root, '[data-f="alt"]').value.trim();
  const ok = await editTags([deco ? { id: f.id, decorative: true } : { id: f.id, alt }], deco ? 'Mark figure as decorative' : 'Set alternate text');
  if (!ok) return;
  drafts.delete(f.id);
  draftSay = '';
  if (!deco && figIndex < figures.length - 1) figIndex += 1;
  refreshAll();
}

type Draft = { id: string; alt: string; decorative: boolean };

async function draftAlt(ids: string[] = []): Promise<Record<string, unknown>> {
  const d = hostRef?.doc();
  if (!d) throw new Error('Open a PDF first');
  const id = d.id;
  if (drafting === id) throw new Error('Alternate text is already being drafted');
  drafting = id;
  draftSay = 'Asking your AI provider to describe the figures…';
  syncAlt();
  try {
    const res = await api.post<{ waiting?: boolean; id?: string; drafts?: Draft[] }>('/api/ai/alt', { doc: id, ids });
    let got: Draft[] = res.drafts ?? [];
    if (res.waiting && res.id) {
      draftAsk = res.id;
      draftSay = 'Waiting for your agent. In Claude Code, Codex or Cursor, say: answer my formpdf question.';
      syncAlt();
      const started = Date.now();
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 2500));
        if (draftAsk !== res.id) throw new Error('Drafting was cancelled');
        if (Date.now() - started > 15 * 60_000) throw new Error('Your agent did not answer within 15 minutes');
        const q2 = await api.get<{ answer: string | null; drafts?: Draft[]; error?: string }>(`/api/ai/questions/${res.id}`);
        if (q2.error) throw new Error(q2.error);
        if (q2.answer) { got = q2.drafts ?? []; break; }
      }
    }
    if (hostRef?.doc()?.id !== id && draftsFor !== id) return { drafts: 0 };
    for (const g of got) drafts.set(g.id, { alt: g.alt, decorative: g.decorative });
    draftSay = got.length ? `${got.length} draft${got.length === 1 ? '' : 's'} ready. Each one is filled in when you reach its figure; nothing is saved until you press Save.` : 'Every figure already has alternate text.';
    const first = figures.findIndex((x) => needsAlt(x) && drafts.has(x.id));
    if (first >= 0) figIndex = first;
    return { drafts: got.length, figures: got.map((g) => g.id) };
  } catch (err) {
    draftSay = (err as Error).message;
    throw err;
  } finally {
    if (drafting === id) drafting = '';
    draftAsk = '';
    syncAlt(true);
  }
}

function watch(root: HTMLElement): void {
  if (watching) return;
  const bench = root.closest<HTMLElement>('.fs-pdfwb');
  if (!bench) return;
  watching = true;
  new MutationObserver(() => {
    if (!onTab()) { layers.repaint(); return; }
    const d = hostRef?.doc();
    if (d && !regions.size) orderPage = hostRef?.ctx.viewer.currentPage() ?? 1;
    layers.repaint();
    syncOrder();
    void loadFigures();
  }).observe(bench, { attributes: true, attributeFilter: ['data-tab'] });
}

registerTool({
  id: 'access-check',
  tab: 'access',
  title: 'Accessibility check',
  words: ['accessibility checker', 'check accessibility', 'a11y', 'pdf/ua', 'wcag', 'section 508'],
  section: () => `<p class="fs-note fs-tool-note" data-x="note">${CHECK_INTRO}</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-x="run">${icon('find', 14)}Run check</button><button class="fs-btn fs-btn-sm" type="button" data-x="fixall" disabled>${icon('magic', 14)}Fix what can be fixed</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-x="report" disabled>${icon('download', 14)}Report</button></div>
<div class="fs-acc-sum" aria-live="polite"><span class="fs-acc-count is-bad"><b data-x="n-failed">0</b> failed</span><span class="fs-acc-count is-warn"><b data-x="n-manual">0</b> by hand</span><span class="fs-acc-count is-ok"><b data-x="n-passed">0</b> passed</span><span class="fs-acc-count"><b data-x="n-skipped">0</b> skipped</span></div>
<div class="fs-tool-listbox fs-acc-listbox"><div class="fs-list fs-tool-list" data-x="list" role="list"></div><p class="fs-note fs-tool-empty" data-x="empty">Run the check to see the results.</p></div>`,
  mount: (root, host) => {
    hostRef = host;
    checkRoot = root;
    watch(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-x]');
      switch (t?.dataset.x) {
        case 'run': void runCheck(); break;
        case 'fixall': if (report) void applyFix(report.fixes, 'Fix accessibility'); break;
        case 'report': void saveReport(); break;
        case 'fix': { const f = t.dataset.fix; if (f === 'tag') void runTag(); else if (f) void applyFix([f], FIX_LABEL[f] ?? 'Fix accessibility'); break; }
        case 'pick': {
          const row = t.closest<HTMLElement>('[data-key]');
          const r = report?.groups.flatMap((g) => g.rules).find((x) => x.id === row?.dataset.key);
          const placed = r?.findings.filter((x) => x.page) ?? [];
          // Each click on a rule goes to its next finding; one with a box is outlined on the page.
          const at = row && placed.length ? (row.dataset.at === undefined ? 0 : (Number(row.dataset.at) + 1) % placed.length) : 0;
          if (row && placed.length) row.dataset.at = String(at);
          const f = placed[at];
          if (f?.page && f.box && hostRef) { hostRef.ctx.viewer.scrollToPoint(f.page - 1, f.box.x + f.box.w / 2, f.box.y); hostRef.ctx.annot.pulse(f.page, [f.box]); }
          else if (f?.page) hostRef?.ctx.viewer.goTo(f.page, true);
          if (f?.id && f.page) { orderPage = f.page; selected = f.id; syncOrder(); layers.repaint(); }
          break;
        }
      }
    });
    syncCheck();
  },
  sync: (_root, host) => { hostRef = host; syncCheck(); },
  commands: (host) => [
    { id: 'tool-access-check', label: 'Check accessibility', words: ['accessibility checker', 'a11y'], enabled: () => !!host.doc(), run: () => { host.setTab('access'); void runCheck(); } },
    { id: 'tool-access-report', label: 'Save accessibility report', words: ['accessibility report'], enabled: () => !!host.doc(), run: () => void saveReport() },
  ],
});

registerTool({
  id: 'access-tag',
  tab: 'access',
  title: 'Tags',
  words: ['autotag', 'add tags', 'tagged pdf', 'make accessible'],
  section: () => `<p class="fs-note fs-tool-note" data-g="note"></p>
<div class="fs-prop-row"><span class="fs-prop-label">Language</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-g="lang" placeholder="Your spelling language, for example en-US" spellcheck="false" aria-label="Document language"></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Title</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-g="title" placeholder="The current title, or the first heading" aria-label="Document title"></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-g="tag">${icon('layers', 14)}Tag the PDF</button></div>`,
  mount: (root, host) => {
    hostRef = host;
    tagRoot = root;
    root.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-g="tag"]')) void runTag(); });
    syncTag();
  },
  sync: (_root, host) => { hostRef = host; syncTag(); },
  commands: (host) => [
    { id: 'tool-access-tag', label: 'Tag for accessibility', words: ['autotag', 'add tags'], enabled: () => !!host.doc(), run: () => { host.setTab('access'); void runTag(); } },
  ],
});

registerTool({
  id: 'access-order',
  tab: 'access',
  title: 'Reading order',
  words: ['reading order', 'tag order', 'retag', 'touch up reading order'],
  section: () => `<label class="fs-check"><input type="checkbox" data-o="show" checked>Show tagged regions on the pages</label>
<div class="fs-acc-pagebar"><span>Page</span><input class="fs-input fs-acc-pagein" type="number" min="1" value="1" data-o="page" aria-label="Page"><span>of <span data-o="pages">0</span></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-o="here">This page</button></div>
<p class="fs-note fs-tool-note" data-o="note"></p>
<div class="fs-tool-listbox fs-acc-orderbox"><div class="fs-list fs-tool-list" data-o="list" role="listbox" aria-label="Reading order"></div><p class="fs-note fs-tool-empty" data-o="empty" hidden>Nothing on this page is tagged.</p></div>
<p class="fs-note fs-acc-selnote" data-o="selnote">No region selected</p>
<div class="fs-prop-row"><span class="fs-prop-label">Tag as</span><div class="fs-prop-ctl"><select data-o="type" aria-label="Tag the selected region as" disabled></select></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-o="up" disabled>${icon('chevronUp', 14)}Earlier</button><button class="fs-btn fs-btn-sm" type="button" data-o="down" disabled>${icon('chevronDown', 14)}Later</button></div>`,
  mount: (root, host) => {
    hostRef = host;
    orderRoot = root;
    watch(root);
    const pin = q<HTMLInputElement>(root, '[data-o="page"]');
    pin.addEventListener('change', () => { orderPage = Math.max(1, Number(pin.value) || 1); selected = ''; syncOrder(); hostRef?.ctx.viewer.goTo(orderPage, true); });
    q(root, '[data-o="show"]').addEventListener('change', () => layers.repaint());
    q<HTMLSelectElement>(root, '[data-o="type"]').addEventListener('change', (e) => void retag((e.target as HTMLSelectElement).value));
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-o]');
      switch (t?.dataset.o) {
        case 'here': orderPage = hostRef?.ctx.viewer.currentPage() ?? 1; selected = ''; syncOrder(); break;
        case 'pick': { const k = t.closest<HTMLElement>('[data-key]')?.dataset.key ?? ''; selectRegion(k.slice(k.indexOf('|') + 1), true); break; }
        case 'up': void move(-1); break;
        case 'down': void move(1); break;
      }
    });
    q(root, '[data-o="list"]').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = regions.get(orderPage) ?? [];
      const at = items.findIndex((r) => r.id === selected);
      const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      selectRegion(next.id, true);
    });
    q(root, '[data-o="list"]').tabIndex = 0;
    syncOrder();
  },
  sync: (_root, host) => { hostRef = host; if (regionsFor && regionsFor !== docId()) { selected = ''; } syncOrder(); },
  page: (pv) => layers.mount(pv),
});

registerTool({
  id: 'access-alt',
  tab: 'access',
  title: 'Alternate text',
  words: ['alt text', 'alternate text', 'describe pictures', 'figure description', 'decorative'],
  section: () => `<p class="fs-note fs-tool-note" data-f="note"></p>
<div class="fs-acc-figbar"><button class="fs-icon-btn is-sm" type="button" data-f="prev" title="Previous figure" aria-label="Previous figure" disabled>${icon('chevronLeft', 14)}</button><span class="fs-acc-figpos" data-f="pos">No figure</span><button class="fs-icon-btn is-sm" type="button" data-f="next" title="Next figure" aria-label="Next figure" disabled>${icon('chevronRight', 14)}</button></div>
<div class="fs-acc-thumb" data-f="thumb"><div class="fs-acc-pic" hidden></div></div>
<textarea class="fs-input fs-acc-alt" data-f="alt" rows="3" placeholder="What the picture shows and why it matters" aria-label="Alternate text" disabled></textarea>
<label class="fs-check"><input type="checkbox" data-f="deco" disabled>Decorative: screen readers skip it</label>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-f="save" disabled>${icon('check', 14)}Save</button><button class="fs-btn fs-btn-sm" type="button" data-f="draft" disabled>${icon('sparkle', 14)}<span class="fs-acc-draftlabel">Draft alt text with AI</span></button></div>
<p class="fs-note" data-f="draftnote" hidden></p>`,
  mount: (root, host) => {
    hostRef = host;
    altRoot = root;
    watch(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
      switch (t?.dataset.f) {
        case 'prev': figIndex = Math.max(0, figIndex - 1); syncAlt(true); break;
        case 'next': figIndex = Math.min(figures.length - 1, figIndex + 1); syncAlt(true); break;
        case 'save': void saveAlt(); break;
        case 'draft': if (!(t as HTMLButtonElement).disabled) void draftAlt().catch((err) => toast((err as Error).message, 'error')); break;
        case 'thumb': { const f = figures[figIndex]; if (f?.box) hostRef?.ctx.viewer.scrollToPoint(f.page - 1, f.box.x + f.box.w / 2, f.box.y); break; }
      }
    });
    root.addEventListener('input', () => syncAlt());
    root.addEventListener('change', () => syncAlt());
    syncAlt(true);
  },
  sync: (_root, host) => { hostRef = host; if (onTab()) void loadFigures(); syncAlt(figuresFor !== docId()); },
  commands: (host) => [
    { id: 'tool-access-alt', label: 'Add alternate text to figures', words: ['alt text', 'describe images'], enabled: () => !!host.doc(), run: () => { host.setTab('access'); void loadFigures(); } },
    { id: 'tool-access-alt-draft', label: 'Draft alternate text with AI', words: ['alt text', 'ai alt text', 'describe images'], group: 'Accessibility', when: 'Use to get draft alternate text for figures from the person\'s AI provider; the drafts wait in Accessibility > Alternate text for the person to review and save.', params: { ids: { type: 'array', description: 'figure ids; every figure without alternate text when left out' } }, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: async (p) => { host.setTab('access'); await loadFigures(); return draftAlt(Array.isArray(p?.ids) ? p.ids.map(String) : []); } },
  ],
});
