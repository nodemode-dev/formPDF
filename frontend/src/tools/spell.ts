import { api } from '../io/api';
import { pdfApi, type Derived, type Rect } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { el, patchList, q, setClass, setHidden, setText } from '../ui/dom';
import { reveal } from '../pdf/sections';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

interface Found { where: 'text' | 'comment' | 'field'; id?: string; page?: number; index?: number; nm?: string; name?: string; kind?: string; rect?: Rect; word: string; offset: number; context: string; suggestions?: string[] }
interface Issue extends Found { key: string; label: string }

const CHIPS = 6;
let issues: Issue[] = [];
let picked = '';
let checkedFor = '';
let seq = 0;
const ignored = new Set<string>();

const src = (i: Issue): string => (i.where === 'comment' ? `c|${i.page}|${i.index}` : i.where === 'field' ? `f|${i.name}` : `t|${i.id}`);

function swap(text: string, word: string, offset: number, to: string): { text: string; at: number } | null {
  let at = text.substr(offset, word.length) === word ? offset : -1;
  if (at < 0) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}'])`, 'gu');
    let best = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) if (best < 0 || Math.abs(m.index - offset) < Math.abs(best - offset)) best = m.index;
    at = best;
  }
  return at < 0 ? null : { text: text.slice(0, at) + to + text.slice(at + word.length), at };
}

function label(f: Found, host: ToolHost): string {
  if (f.where === 'comment') return `${f.kind === 'freetext' ? 'Text box' : 'Comment'} · page ${f.page}`;
  if (f.where === 'field') return `Form field ${f.name} · page ${f.page}`;
  const id = f.id ?? '';
  if (id.startsWith('f:')) {
    const fd = host.ctx.fields.fields.find((x) => x.name === id.slice(2));
    return `Form field ${id.slice(2)}${fd ? ` · page ${fd.page}` : ''}`;
  }
  const a = host.ctx.annot.items.find((x) => x.id === id.slice(2));
  return `${a?.kind === 'freetext' ? 'Text box' : 'Note'} not applied yet${a ? ` · page ${a.page}` : ''}`;
}

function render(root: HTMLElement, host: ToolHost): void {
  const fill = (n: HTMLElement, r: Issue): void => { setText(q(n, '.fs-row-title'), r.word); setText(q(n, '.fs-row-sub'), r.label); setClass(n, 'is-selected', r.key === picked); };
  patchList(q(root, '[data-t="list"]'), issues, {
    key: (r) => r.key,
    create: (r) => { const n = el(`<div class="fs-row fs-tool-row" data-t="pick"><span class="fs-row-icon">${icon('find', 14)}</span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>`); fill(n, r); return n; },
    update: fill,
  });
  setText(q(root, '[data-t="count"]'), String(issues.length));
  setHidden(q(root, '[data-t="empty"]'), issues.length > 0);
  const cur = issues.find((i) => i.key === picked) ?? null;
  setText(q(root, '[data-t="word"]'), cur ? cur.word : '');
  setText(q(root, '[data-t="ctx"]'), cur ? cur.context : '');
  const sugs = cur?.suggestions ?? [];
  q(root, '[data-t="sugs"]').querySelectorAll<HTMLButtonElement>('button').forEach((b, k) => {
    setClass(b, 'is-off', k >= sugs.length);
    b.disabled = k >= sugs.length;
    b.tabIndex = k >= sugs.length ? -1 : 0;
    if (k < sugs.length) { setText(b, sugs[k]); b.dataset.v = sugs[k]; b.title = sugs[k]; }
  });
  setText(q(root, '[data-t="nosugs"]'), cur && !sugs.length ? 'No suggestions. Type the correction.' : '');
  const to = q<HTMLInputElement>(root, '[data-t="to"]');
  if (to.dataset.for !== picked) { to.value = sugs[0] ?? ''; to.dataset.for = picked; }
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-need]'))) b.disabled = !cur || !host.doc();
}

function status(root: HTMLElement, text: string): void { setText(q(root, '[data-t="status"]'), text); }

function pick(root: HTMLElement, host: ToolHost, key: string, reveal: boolean): void {
  picked = key;
  render(root, host);
  const cur = issues.find((i) => i.key === key);
  if (!cur || !reveal) return;
  if (cur.where === 'text' && cur.id?.startsWith('a:')) { host.ctx.annot.reveal(cur.id.slice(2)); return; }
  const fd = cur.where === 'text' && cur.id?.startsWith('f:') ? host.ctx.fields.fields.find((x) => x.name === cur.id?.slice(2)) : null;
  const page = fd ? fd.page : cur.page;
  const r = fd ? { x: fd.x, y: fd.y, w: fd.w, h: fd.h } : cur.rect;
  if (!page || !r) return;
  host.ctx.viewer.scrollToPoint(page - 1, r.x + r.w / 2, r.y);
  host.ctx.annot.pulse(page, [r]);
}

function drop(root: HTMLElement, host: ToolHost, gone: Issue[]): void {
  const keys = new Set(gone.map((g) => g.key));
  const at = issues.findIndex((i) => i.key === picked);
  issues = issues.filter((i) => !keys.has(i.key));
  if (keys.has(picked)) picked = issues[Math.min(Math.max(0, at), issues.length - 1)]?.key ?? '';
  status(root, issues.length ? `${issues.length} left to review.` : 'Done. No more possible misspellings.');
  pick(root, host, picked, !!picked);
}

function shift(changed: Array<{ at: number; delta: number; src: string }>): void {
  for (const i of issues) {
    const s = src(i);
    for (const c of changed) if (c.src === s && i.offset > c.at) i.offset += c.delta;
  }
}

async function check(root: HTMLElement, host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.run('Checking spelling', async () => {
    try {
      await host.ctx.fields.load(d.id).catch(() => undefined);
      const texts = [
        ...host.ctx.annot.items.filter((a) => (a.kind === 'note' || a.kind === 'freetext') && (a.text ?? '').trim()).map((a) => ({ id: `a:${a.id}`, text: a.text ?? '' })),
        ...host.ctx.fields.fields.filter((f) => f.type === 'text' && !f.readonly).map((f) => ({ id: `f:${f.name}`, text: host.ctx.fields.current(f.name) ?? '' })).filter((t) => t.text.trim()),
      ].filter((t, k, all) => all.findIndex((x) => x.id === t.id) === k);
      const res = await pdfApi.act<{ issues: Found[]; count: number; words: number; lang: string }>(d.id, 'spell', { texts, scope: ['comments'], ignore: [...ignored] });
      if (host.doc()?.key !== d.key) return;
      issues = res.issues.map((f) => ({ ...f, key: `s${++seq}`, label: label(f, host) }));
      checkedFor = d.key;
      picked = issues[0]?.key ?? '';
      status(root, issues.length ? `${issues.length} possible misspelling${issues.length === 1 ? '' : 's'} in ${res.words} words.` : `No spelling mistakes in ${res.words} words.`);
      pick(root, host, picked, !!picked);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

async function change(root: HTMLElement, host: ToolHost, all: boolean): Promise<void> {
  const d = host.doc();
  const cur = issues.find((i) => i.key === picked);
  const to = q<HTMLInputElement>(root, '[data-t="to"]').value;
  if (!d || !cur || !to.trim() || to === cur.word) return;
  const group = all ? issues.filter((i) => i.word === cur.word) : [cur];
  const bySrc = new Map<string, Issue[]>();
  for (const g of group) bySrc.set(src(g), [...(bySrc.get(src(g)) ?? []), g]);
  const done: Issue[] = [];
  const changed: Array<{ at: number; delta: number; src: string }> = [];
  const fixes: Array<Record<string, unknown>> = [];
  const pending: Issue[] = [];
  const later: Array<{ at: number; delta: number; src: string }> = [];
  await host.ctx.run('Fixing spelling', async () => {
    try {
      for (const [s, list] of bySrc) {
        list.sort((a, b) => b.offset - a.offset);
        const first = list[0];
        if (first.where === 'comment') {
          for (const i of list) { fixes.push({ where: 'comment', page: i.page, index: i.index, nm: i.nm, offset: i.offset, word: i.word, to }); later.push({ at: i.offset, delta: to.length - i.word.length, src: s }); pending.push(i); }
          continue;
        }
        const id = first.where === 'field' ? `f:${first.name}` : first.id ?? '';
        const isField = id.startsWith('f:');
        const annot = isField ? null : host.ctx.annot.items.find((a) => a.id === id.slice(2));
        let text = isField ? host.ctx.fields.current(id.slice(2)) ?? '' : annot?.text ?? '';
        for (const i of list) {
          const got = swap(text, i.word, i.offset, to);
          if (!got) continue;
          text = got.text;
          changed.push({ at: got.at, delta: to.length - i.word.length, src: s });
          done.push(i);
        }
        if (isField) host.ctx.fields.setValue(id.slice(2), text);
        else if (annot) host.ctx.annot.update(annot.id, { text }, 'Fix spelling');
      }
      if (fixes.length) {
        await host.ctx.commit(await pdfApi.act<Derived>(d.id, 'spell_fix', { fixes }), 'Fix spelling');
        done.push(...pending);
        changed.push(...later);
      }
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  if (!done.length) return;
  shift(changed);
  drop(root, host, done);
}

async function addWord(root: HTMLElement, host: ToolHost): Promise<void> {
  const cur = issues.find((i) => i.key === picked);
  if (!cur) return;
  try {
    const s = await api.settings();
    const words = Array.isArray(s.dictionary) ? (s.dictionary as unknown[]).map(String) : [];
    if (!words.includes(cur.word)) await api.setSettings({ dictionary: [...words, cur.word] });
    toast(`Added "${cur.word}" to your dictionary.`);
  } catch (err) { toast((err as Error).message, 'error'); return; }
  drop(root, host, issues.filter((i) => i.word.toLowerCase() === cur.word.toLowerCase()));
}

registerTool({
  id: 'spell',
  tab: 'comment',
  title: 'Check spelling',
  words: ['spelling', 'spell check', 'typos', 'proofread', 'dictionary'],
  section: () => `<p class="fs-note">Checks comments, text boxes and form field text, including ones not applied yet. Words in all capitals, web and email addresses are skipped.</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-t="check">${icon('find', 14)}Check spelling</button></div>
<p class="fs-note fs-tool-note" data-t="status">Not checked yet.</p>
<div class="fs-pdfwb-subhead">Possible misspellings <span class="fs-badge is-count" data-t="count">0</span></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-t="list"></div><p class="fs-note fs-tool-empty" data-t="empty">Nothing to review.</p></div>
<div class="fs-spell-card">
<div class="fs-spell-head"><strong class="fs-spell-word" data-t="word"></strong><span class="fs-note fs-spell-ctx" data-t="ctx"></span></div>
<div class="fs-spell-sugs" data-t="sugs">${Array.from({ length: CHIPS }, () => '<button class="fs-btn fs-btn-sm fs-btn-ghost is-off" type="button" data-t="sug" disabled tabindex="-1"></button>').join('')}<span class="fs-note" data-t="nosugs"></span></div>
<div class="fs-tool-cal"><input class="fs-input" type="text" data-t="to" placeholder="Change to" aria-label="Change to" spellcheck="false"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-t="change" data-need>Change</button></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="changeall" data-need>Change all</button><button class="fs-btn fs-btn-sm" type="button" data-t="ignore" data-need>Ignore</button><button class="fs-btn fs-btn-sm" type="button" data-t="ignoreall" data-need>Ignore all</button><button class="fs-btn fs-btn-sm" type="button" data-t="add" data-need>Add to dictionary</button></div>
</div>`,
  mount: (root, host) => {
    render(root, host);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
      if (!t) return;
      const cur = issues.find((i) => i.key === picked);
      switch (t.dataset.t) {
        case 'check': void check(root, host); break;
        case 'pick': { const k = t.closest<HTMLElement>('[data-key]')?.dataset.key; if (k) pick(root, host, k, true); break; }
        case 'sug': { const to = q<HTMLInputElement>(root, '[data-t="to"]'); to.value = t.dataset.v ?? ''; to.focus(); break; }
        case 'change': void change(root, host, false); break;
        case 'changeall': void change(root, host, true); break;
        case 'ignore': if (cur) drop(root, host, [cur]); break;
        case 'ignoreall': if (cur) { ignored.add(cur.word); drop(root, host, issues.filter((i) => i.word.toLowerCase() === cur.word.toLowerCase())); } break;
        case 'add': void addWord(root, host); break;
      }
    });
    root.addEventListener('dblclick', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t="sug"]');
      if (b) void change(root, host, false);
    });
    q<HTMLInputElement>(root, '[data-t="to"]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void change(root, host, false); } });
  },
  sync: (root, host) => {
    const d = host.doc();
    if ((d?.key ?? '') !== checkedFor && (issues.length || checkedFor)) {
      issues = [];
      picked = '';
      checkedFor = '';
      status(root, 'Not checked yet.');
    }
    render(root, host);
  },
  commands: (host) => [
    {
      id: 'tool-spell', label: 'Check spelling', keys: ['F7'], words: ['spell check', 'typos'], enabled: () => !!host.doc(),
      run: () => {
        host.setTab('comment');
        const root = document.querySelector<HTMLElement>('[data-section="spell"]');
        if (root) { reveal(root); root.scrollIntoView({ block: 'nearest' }); void check(root, host); }
      },
    },
  ],
});
