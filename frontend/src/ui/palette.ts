import { formatKeys, type Command } from './commands';
import { Dialog } from './dialogs';
import { el, patchList, q, setClass, setHidden, setText } from './dom';
import { icon } from './icons';

export interface PaletteSource {
  commands(): Command[];
  enabled(cmd: Command): boolean;
  why(cmd: Command): string;
  run(cmd: Command): void;
}

interface Entry { cmd: Command; label: string; keys: string; on: boolean; why: string; score: number }

const RECENT_KEY = 'fs-palette-recent';
const LIMIT = 60;

function recentIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}

function rememberId(id: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 12))); } catch { return; }
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i += 1;
  return i === needle.length;
}

export function scoreCommand(query: string, label: string, words: string[]): number {
  const qy = query.trim().toLowerCase();
  if (!qy) return 0;
  const l = label.toLowerCase();
  if (l === qy) return 100;
  if (l.startsWith(qy)) return 80;
  if (new RegExp(`\\b${qy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l)) return 64;
  if (l.includes(qy)) return 50;
  const w = words.map((x) => x.toLowerCase());
  if (w.some((x) => x === qy)) return 46;
  if (w.some((x) => x.startsWith(qy))) return 40;
  if (w.some((x) => x.includes(qy))) return 30;
  if (qy.length > 1 && subsequence(qy.replace(/\s+/g, ''), l)) return 10;
  return -1;
}

export class Palette extends Dialog {
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly none: HTMLElement;
  private entries: Entry[] = [];
  private focus = 0;

  constructor(private readonly source: PaletteSource) {
    super('Find a command or tool', 560);
    this.scrim.classList.add('fs-palette-scrim');
    q<HTMLElement>(this.scrim, '.fs-dialog').classList.add('fs-palette');
    this.body.appendChild(el(`<div class="fs-palette-body">
<label class="fs-search fs-palette-search">${icon('search', 16)}<input type="search" placeholder="Type a command, a tool or what you want to do" aria-label="Find a command or tool" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="fs-palette-list"></label>
<div class="fs-palette-list" id="fs-palette-list" role="listbox" aria-label="Commands"></div>
<div class="fs-palette-none" hidden>Nothing matches. Try a word like crop, sign, redact or PowerPoint.</div>
<div class="fs-palette-foot"><span>Enter runs</span><span>Up and Down move</span><span>Esc closes</span></div>
</div>`));
    this.input = q<HTMLInputElement>(this.body, 'input');
    this.list = q(this.body, '.fs-palette-list');
    this.none = q(this.body, '.fs-palette-none');
    this.input.addEventListener('input', () => { this.focus = 0; this.refresh(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.move(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.choose(this.entries[this.focus]); }
    });
    this.list.addEventListener('pointermove', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      const i = row ? this.entries.findIndex((x) => x.cmd.id === row.dataset.key) : -1;
      if (i >= 0 && i !== this.focus) { this.focus = i; this.paintFocus(false); }
    });
    this.list.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
      if (row) this.choose(this.entries.find((x) => x.cmd.id === row.dataset.key));
    });
  }

  show(): void {
    if (this.isOpen) return;
    this.input.value = '';
    this.focus = 0;
    this.refresh();
    this.open(this.input);
  }

  private label(cmd: Command): string { return typeof cmd.label === 'function' ? cmd.label() : cmd.label; }

  private refresh(): void {
    const query = this.input.value;
    const recent = recentIds();
    const out: Entry[] = [];
    for (const cmd of this.source.commands()) {
      const label = this.label(cmd).replace(/…$/, '');
      const s = query.trim() ? scoreCommand(query, label, cmd.words ?? []) : 1;
      if (s < 0) continue;
      const on = this.source.enabled(cmd);
      const qy = query.trim().toLowerCase();
      const hit = s > 10 && s <= 46 ? (cmd.words ?? []).find((w) => w.toLowerCase().includes(qy)) ?? '' : '';
      out.push({ cmd, label, keys: cmd.keys?.[0] ? formatKeys(cmd.keys[0]) : '', on, why: on ? hit : this.source.why(cmd), score: s });
    }
    const rank = (e: Entry): number => { const r = recent.indexOf(e.cmd.id); return r < 0 ? 0 : 12 - r; };
    out.sort((a, b) => Number(b.on) - Number(a.on) || b.score - a.score || rank(b) - rank(a) || a.label.localeCompare(b.label));
    this.entries = out.slice(0, LIMIT);
    patchList(this.list, this.entries, {
      key: (x) => x.cmd.id,
      create: () => el(`<div class="fs-palette-item" role="option"><span class="fs-palette-label"></span><span class="fs-palette-why"></span><span class="fs-palette-keys"></span></div>`),
      update: (n, x) => {
        setText(q(n, '.fs-palette-label'), x.label);
        setText(q(n, '.fs-palette-why'), x.why);
        setText(q(n, '.fs-palette-keys'), x.keys);
        setClass(n, 'is-off', !x.on);
        n.setAttribute('aria-disabled', String(!x.on));
      },
    });
    setHidden(this.none, this.entries.length > 0);
    this.paintFocus(true);
  }

  private move(step: number): void {
    if (!this.entries.length) return;
    this.focus = (this.focus + step + this.entries.length) % this.entries.length;
    this.paintFocus(true);
  }

  private paintFocus(scroll: boolean): void {
    const rows = Array.from(this.list.children) as HTMLElement[];
    rows.forEach((r, i) => { setClass(r, 'is-focus', i === this.focus); r.setAttribute('aria-selected', String(i === this.focus)); });
    const row = rows[this.focus];
    if (row) this.input.setAttribute('aria-activedescendant', row.id || (row.id = `fs-pal-${this.focus}-${Math.random().toString(36).slice(2, 7)}`));
    if (scroll && row) row.scrollIntoView({ block: 'nearest' });
  }

  private choose(x: Entry | undefined): void {
    if (!x || !x.on) return;
    this.close();
    rememberId(x.cmd.id);
    this.source.run(x.cmd);
  }
}
