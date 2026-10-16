import { isLang, LANG_NAMES, LANG_PARENT, type Lang } from './i18n/langs';

export type { Lang } from './i18n/langs';

type Table = Record<string, string>;
const LOADERS: Record<Exclude<Lang, 'en'>, () => Promise<Table>> = {
  es: () => import('./i18n/es').then((m) => m.es), 'es-MX': () => import('./i18n/es-MX').then((m) => m.esMX),
  'pt-BR': () => import('./i18n/pt-BR').then((m) => m.ptBR), fr: () => import('./i18n/fr').then((m) => m.fr),
  'fr-CA': () => import('./i18n/fr-CA').then((m) => m.frCA), de: () => import('./i18n/de').then((m) => m.de),
  it: () => import('./i18n/it').then((m) => m.it), nl: () => import('./i18n/nl').then((m) => m.nl),
  da: () => import('./i18n/da').then((m) => m.da), fi: () => import('./i18n/fi').then((m) => m.fi),
  nb: () => import('./i18n/nb').then((m) => m.nb), sv: () => import('./i18n/sv').then((m) => m.sv),
  ru: () => import('./i18n/ru').then((m) => m.ru), pl: () => import('./i18n/pl').then((m) => m.pl),
  cs: () => import('./i18n/cs').then((m) => m.cs), hu: () => import('./i18n/hu').then((m) => m.hu),
  uk: () => import('./i18n/uk').then((m) => m.uk), tr: () => import('./i18n/tr').then((m) => m.tr),
  'zh-CN': () => import('./i18n/zh-CN').then((m) => m.zhCN), 'zh-TW': () => import('./i18n/zh-TW').then((m) => m.zhTW),
  ja: () => import('./i18n/ja').then((m) => m.ja), ko: () => import('./i18n/ko').then((m) => m.ko),
  id: () => import('./i18n/id').then((m) => m.id), th: () => import('./i18n/th').then((m) => m.th),
  vi: () => import('./i18n/vi').then((m) => m.vi),
};
const KEY = 'fs-language';
const tables = new Map<Lang, Table>([['en', {}]]);
const listeners = new Set<() => void>();

const stored = ((): Lang => { try { const v = localStorage.getItem(KEY); return isLang(v) ? v : 'en'; } catch { return 'en'; } })();
const remembered = ((): boolean => { try { return localStorage.getItem(KEY) !== null; } catch { return false; } })();
let current: Lang = 'en';
let wanted: Lang = stored;

export const languages = (): ReadonlyArray<readonly [Lang, string]> => LANG_NAMES;
export const language = (): Lang => current;

async function load(l: Lang): Promise<void> {
  for (const code of [LANG_PARENT[l], l]) {
    if (!code || code === 'en' || tables.has(code)) continue;
    tables.set(code, await LOADERS[code]());
    compiled.clear();
  }
}

interface Pattern { key: string; head: string; re: RegExp; order: number[] }
const compiled = new Map<Lang, Pattern[]>();
const HOLE = /\{(\d+)\}/g;

function look(k: string): string | undefined {
  const parent = LANG_PARENT[current];
  return tables.get(current)?.[k] ?? (parent ? tables.get(parent)?.[k] : undefined);
}

function plain(english: string): string | undefined {
  const exact = look(english);
  if (exact !== undefined) return exact;
  const tail = english.endsWith('…') ? '…' : english.endsWith('...') ? '...' : english.endsWith(':') && !english.endsWith('::') ? ':' : '';
  const found = tail ? look(english.slice(0, -tail.length).trimEnd()) : undefined;
  return found === undefined ? undefined : `${found}${tail}`;
}

function patternsFor(l: Lang): Pattern[] {
  let list = compiled.get(l);
  if (list) return list;
  const keys = new Set<string>();
  for (const code of [l, LANG_PARENT[l]]) for (const k of Object.keys((code && tables.get(code)) || {})) if (k.includes('{')) keys.add(k);
  list = [];
  for (const key of keys) {
    const order: number[] = [];
    let src = '^', last = 0;
    for (const m of key.matchAll(HOLE)) {
      src += key.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\S]*?)';
      order.push(Number(m[1]));
      last = (m.index ?? 0) + m[0].length;
    }
    if (!order.length) continue;
    src += `${key.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    list.push({ key, head: key.slice(0, key.search(HOLE)), re: new RegExp(src), order });
  }
  list.sort((a, b) => b.head.length - a.head.length);
  compiled.set(l, list);
  return list;
}

function fromPattern(text: string, depth = 0): string | undefined {
  if (!/[\d\S]/.test(text) || depth > 2) return undefined;
  for (const p of patternsFor(current)) {
    if (p.head && !text.startsWith(p.head)) continue;
    const m = p.re.exec(text);
    if (!m) continue;
    const vals = new Map<number, string>();
    p.order.forEach((n, i) => vals.set(n, m[i + 1]));
    const out = look(p.key);
    if (out === undefined) continue;
    return out.replace(HOLE, (_s, n: string) => { const v = vals.get(Number(n)) ?? ''; return plain(v) ?? fromPattern(v, depth + 1) ?? v; });
  }
  return undefined;
}

export function t(english: string): string {
  if (current === 'en') return english;
  return plain(english) ?? fromPattern(english) ?? english;
}

/** A message built from a template key with {0}, {1}... holes: the template and every value are translated on their own, so a message that wraps another one (an action name and the engine's error) reads whole in the interface language. */
export function tf(template: string, ...values: string[]): string {
  const out = current === 'en' ? template : plain(template) ?? template;
  return out.replace(HOLE, (_s, n: string) => t(values[Number(n)] ?? ''));
}

const known = (text: string): boolean => current !== 'en' && t(text) !== text;

export async function setLanguage(l: Lang): Promise<void> {
  wanted = l;
  try { localStorage.setItem(KEY, l); } catch { /* the engine setting keeps it too */ }
  try { await load(l); } catch { return; }
  if (wanted !== l || l === current) return;
  current = l;
  document.documentElement.lang = l;
  for (const fn of listeners) fn();
  translatePage();
}

/**
 * Picks the language before the first paint. This browser's remembered choice wins; when there is none (a new
 * profile or app origin), the engine's setting is asked for, briefly, so the window does not paint in English and
 * then switch, which would move everything on screen.
 */
export async function startLanguage(ask?: () => Promise<unknown>): Promise<void> {
  let lang: Lang = stored;
  if (!remembered && ask) {
    const timeout = new Promise<undefined>((done) => { window.setTimeout(() => done(undefined), 1500); });
    try { const got = await Promise.race([ask(), timeout]); if (isLang(got)) lang = got; } catch { lang = stored; }
  }
  if (lang === 'en') return;
  try { await load(lang); } catch { return; }
  if (wanted !== stored && wanted !== lang) return;
  wanted = lang;
  current = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem(KEY, lang); } catch { /* the engine setting keeps it */ }
}

export function onLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const ATTRS = ['title', 'aria-label', 'placeholder'] as const;
const SKIP = 'textarea, input, script, style, canvas, svg, [contenteditable], [data-no-i18n], .textLayer, .fs-pdf-page, .xterm, .fs-chat-msg, .fs-md, .fs-pdfwb-name, .fs-pdfwb-thread .fs-row-sub, .fs-ws-note-sub, .fs-pdfwb-outline';
const SKIP_ATTR = SKIP.replace('textarea, input, ', '');
const textEn = new WeakMap<Text, { en: string; shown: string }>();
const attrEn = new WeakMap<Element, Map<string, { en: string; shown: string }>>();
let observer: MutationObserver | null = null;

const skipped = (n: Node | null): boolean => {
  const e = n instanceof Element ? n : n?.parentElement ?? null;
  return !e || !!e.closest(SKIP);
};

function translateText(node: Text): void {
  const raw = node.data, rec = textEn.get(node);
  if (rec && raw === rec.shown) {
    const next = raw.replace(raw.trim(), t(rec.en.trim()));
    if (next !== raw) { rec.shown = next; node.data = next; }
    if (current === 'en') textEn.delete(node);
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 400 || !known(trimmed) || skipped(node)) { if (rec) textEn.delete(node); return; }
  const next = raw.replace(trimmed, t(trimmed));
  textEn.set(node, { en: raw, shown: next });
  node.data = next;
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v === null) continue;
    let recs = attrEn.get(el);
    const rec = recs?.get(a);
    if (rec && v === rec.shown) {
      const next = t(rec.en);
      if (next !== v) { rec.shown = next; el.setAttribute(a, next); }
      continue;
    }
    if (!known(v) || el.closest(SKIP_ATTR)) { recs?.delete(a); continue; }
    if (!recs) { recs = new Map(); attrEn.set(el, recs); }
    const next = t(v);
    recs.set(a, { en: v, shown: next });
    el.setAttribute(a, next);
  }
}

function walk(root: Node): void {
  if (root instanceof Text) { translateText(root); return; }
  if (!(root instanceof Element)) return;
  if (root.closest(SKIP)) { if (root.matches('input, textarea') && !root.closest(SKIP_ATTR)) translateAttrs(root); return; }
  translateAttrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!(n instanceof Element) || !n.matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
      if (n.matches('input, textarea') && !n.closest(SKIP_ATTR)) translateAttrs(n);
      return NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n instanceof Text) translateText(n);
    else if (n instanceof Element) translateAttrs(n);
  }
}

const OPTS: MutationObserverInit = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] };

function translatePage(): void {
  if (typeof document === 'undefined') return;
  observer?.disconnect();
  walk(document.body);
  observer?.observe(document.body, OPTS);
}

export function startPageTranslator(): void {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((records) => {
    if (current === 'en') return;
    observer?.disconnect();
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => walk(n));
      else if (r.type === 'characterData' && r.target instanceof Text) translateText(r.target);
      else if (r.type === 'attributes' && r.target instanceof Element) translateAttrs(r.target);
    }
    observer?.observe(document.body, OPTS);
  });
  translatePage();
}
