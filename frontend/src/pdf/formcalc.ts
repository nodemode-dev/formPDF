import type { Field } from './api';

type Val = number | string | boolean | Val[];
export type Get = (name: string) => number;

export interface Rules {
  calc: Array<{ name: string; run: (get: Get) => number | null }>;
  format: Map<string, (v: string) => string>;
  keystroke: Map<string, 'number' | 'digits'>;
  validate: Map<string, (v: string) => string | null>;
  custom: number;
}

export function num(v: string): number {
  let s = String(v ?? '').trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/^[^\d.,-]+/, ''));
  s = s.replace(/[^\d.,]/g, '');
  if (s.lastIndexOf(',') > s.lastIndexOf('.') && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

function call(code: string, fn: string): Val[] | null {
  const at = code.search(new RegExp(`\\b${fn}\\s*\\(`));
  if (at < 0) return null;
  let i = code.indexOf('(', at) + 1;
  const toks: string[] = [];
  let depth = 1;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1, s = '';
      while (j < code.length && code[j] !== ch) {
        if (code[j] === '\\' && j + 1 < code.length) {
          const e = code[++j], hex = code.slice(j + 1, j + 5);
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) { s += String.fromCharCode(parseInt(hex, 16)); j += 5; continue; }
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j++;
          continue;
        }
        s += code[j]; j++;
      }
      toks.push(JSON.stringify(s));
      i = j + 1;
      continue;
    }
    if (ch === '(' || ch === '[') { depth += 1; toks.push(ch === '(' ? '(' : '['); i++; continue; }
    if (ch === ')' || ch === ']') { depth -= 1; if (depth > 0) toks.push(ch === ')' ? ')' : ']'); i++; continue; }
    if (ch === ',') { toks.push(','); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    const m = /^[A-Za-z_$][\w$]*|^-?\d+(\.\d+)?/.exec(code.slice(i));
    if (!m) { i++; continue; }
    toks.push(m[0]);
    i += m[0].length;
  }
  let p = 0;
  const value = (): Val => {
    const t = toks[p++];
    if (t === 'new' && toks[p] === 'Array') { p++; return list(')'); }
    if (t === '[') return list(']', true);
    if (t === 'true' || t === 'false') return t === 'true';
    if (t !== undefined && t.startsWith('"')) return JSON.parse(t) as string;
    return Number(t);
  };
  const list = (close: string, opened = false): Val[] => {
    if (!opened && toks[p] === '(') p++;
    const out: Val[] = [];
    while (p < toks.length && toks[p] !== close) {
      if (toks[p] === ',') { p++; continue; }
      out.push(value());
    }
    p++;
    return out;
  };
  const args: Val[] = [];
  while (p < toks.length) {
    if (toks[p] === ',') { p++; continue; }
    args.push(value());
  }
  return args;
}

function group(n: number, sep: string, dec: string, places: number): string {
  const fixed = Math.abs(n).toFixed(Math.max(0, Math.min(10, places)));
  const [whole, frac] = fixed.split('.');
  const w = sep ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : whole;
  return frac ? `${w}${dec}${frac}` : w;
}

function numberFormat(a: Val[]): (v: string) => string {
  const [nDec = 2, sepStyle = 0, negStyle = 0, , strCurrency = '', bPrepend = true] = a as [number, number, number, number, string, boolean];
  const [sep, dec] = ([[',', '.'], ['', '.'], ['.', ','], ['', ',']] as const)[Number(sepStyle)] ?? [',', '.'];
  return (v: string) => {
    if (String(v).trim() === '') return '';
    const n = num(v);
    let s = group(n, sep, dec, Number(nDec));
    if (strCurrency) s = bPrepend ? `${strCurrency}${s}` : `${s}${strCurrency}`;
    if (n < 0) s = Number(negStyle) >= 2 ? `(${s})` : `-${s}`;
    return s;
  };
}

function percentFormat(a: Val[]): (v: string) => string {
  const [nDec = 2, sepStyle = 0] = a as [number, number];
  const inner = numberFormat([nDec, sepStyle, 0, 0, '', true]);
  return (v: string) => (String(v).trim() === '' ? '' : `${inner(String(num(v) * 100))}%`);
}

function specialFormat(a: Val[]): (v: string) => string {
  const kind = Number(a[0]);
  return (v: string) => {
    const d = String(v).replace(/\D/g, '');
    if (!d) return String(v);
    if (kind === 0) return d.slice(0, 5);
    if (kind === 1) return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5, 9)}` : d;
    if (kind === 2) return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d.length === 7 ? `${d.slice(0, 3)}-${d.slice(3)}` : String(v);
    if (kind === 3) return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : String(v);
    return String(v);
  };
}

function names(v: Val): string[] {
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function simple(a: Val[]): (get: Get) => number | null {
  const op = String(a[0]).toUpperCase();
  const list = names(a[1] ?? []);
  return (get) => {
    const vals = list.map(get);
    if (!vals.length) return null;
    if (op === 'SUM') return vals.reduce((x, y) => x + y, 0);
    if (op === 'PRD') return vals.reduce((x, y) => x * y, 1);
    if (op === 'AVG') return vals.reduce((x, y) => x + y, 0) / vals.length;
    if (op === 'MIN') return Math.min(...vals);
    if (op === 'MAX') return Math.max(...vals);
    return null;
  };
}

function expression(src: string): ((get: Get) => number | null) | null {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/()'.includes(ch)) { toks.push(ch); i++; continue; }
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (m) { toks.push(m[0]); i += m[0].length; continue; }
    let name = '';
    while (i < src.length && !/[\s+\-*/()]/.test(src[i])) { if (src[i] === '\\' && i + 1 < src.length) i++; name += src[i]; i++; }
    if (!name) return null;
    toks.push(`@${name}`);
  }
  let p = 0;
  let get: Get = () => 0;
  const atom = (): number => {
    const t = toks[p++];
    if (t === '(') { const v = sum(); p++; return v; }
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (t !== undefined && t.startsWith('@')) return get(t.slice(1));
    return Number(t) || 0;
  };
  const product = (): number => {
    let v = atom();
    while (toks[p] === '*' || toks[p] === '/') { const op = toks[p++]; const r = atom(); v = op === '*' ? v * r : r === 0 ? 0 : v / r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (toks[p] === '+' || toks[p] === '-') { const op = toks[p++]; const r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  return (g) => { get = g; p = 0; return toks.length ? sum() : null; };
}

function dateFormat(fmt: string): (v: string) => string {
  return (v: string) => {
    const s = String(v).trim();
    if (!s) return '';
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    const di = fmt.indexOf('d'), dayFirst = di >= 0 && di < fmt.indexOf('m');
    const [y, mo, da] = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3] < 100 ? 2000 + +us[3] : +us[3], dayFirst ? +us[2] : +us[1], dayFirst ? +us[1] : +us[2]] : [0, 0, 0];
    const d = iso || us ? new Date(y, mo - 1, da) : null;
    if (!d || Number.isNaN(d.getTime()) || d.getMonth() !== mo - 1 || d.getDate() !== da) return s;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const pad = (n: number): string => String(n).padStart(2, '0');
    return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (t) => ({ yyyy: String(d.getFullYear()), yy: pad(d.getFullYear() % 100), mmmm: months[d.getMonth()], mmm: months[d.getMonth()].slice(0, 3),
      mm: pad(d.getMonth() + 1), m: String(d.getMonth() + 1), dd: pad(d.getDate()), d: String(d.getDate()) } as Record<string, string>)[t] ?? t);
  };
}

export function buildRules(fields: Field[]): Rules {
  const rules: Rules = { calc: [], format: new Map(), keystroke: new Map(), validate: new Map(), custom: 0 };
  const seen = new Set<string>();
  const ordered = fields.map((f, i) => ({ f, i })).sort((a, b) => (a.f.calcOrder ?? 1e6 + a.i) - (b.f.calcOrder ?? 1e6 + b.i));
  for (const { f } of ordered) {
    const s = f.scripts;
    if (!s || seen.has(f.name)) continue;
    seen.add(f.name);
    if (s.calculate) {
      const bv = /BVCALC([\s\S]*?)EVCALC/.exec(s.calculate);
      const sc = call(s.calculate, 'AFSimple_Calculate');
      const run = bv ? expression(bv[1]) : sc ? simple(sc) : null;
      if (run) rules.calc.push({ name: f.name, run }); else rules.custom += 1;
    }
    if (s.format) {
      const nf = call(s.format, 'AFNumber_Format'), pf = call(s.format, 'AFPercent_Format'), sf = call(s.format, 'AFSpecial_Format');
      const df = call(s.format, 'AFDate_FormatEx') ?? call(s.format, 'AFDate_Format');
      const fn = nf ? numberFormat(nf) : pf ? percentFormat(pf) : sf ? specialFormat(sf) : df && typeof df[0] === 'string' ? dateFormat(df[0]) : null;
      if (fn) rules.format.set(f.name, fn); else rules.custom += 1;
    }
    if (s.keystroke) {
      if (/AF(Number|Percent)_Keystroke/.test(s.keystroke)) rules.keystroke.set(f.name, 'number');
      else if (/AFSpecial_Keystroke/.test(s.keystroke)) rules.keystroke.set(f.name, 'digits');
      else if (!/AF(Date|Time)_Keystroke/.test(s.keystroke)) rules.custom += 1;
    }
    if (s.validate) {
      const rv = call(s.validate, 'AFRange_Validate');
      if (rv) {
        const [bGT, nGT, bLT, nLT] = rv as [boolean, number, boolean, number];
        rules.validate.set(f.name, (v) => {
          if (String(v).trim() === '') return null;
          const n = num(v);
          if ((bGT && n < nGT) || (bLT && n > nLT)) return bGT && bLT ? `Enter a number from ${nGT} to ${nLT}` : bGT ? `Enter a number of at least ${nGT}` : `Enter a number of at most ${nLT}`;
          return null;
        });
      } else rules.custom += 1;
    }
  }
  return rules;
}

export function asText(n: number): string {
  if (!Number.isFinite(n)) return '';
  const r = Math.round(n * 1e10) / 1e10;
  return String(r);
}
