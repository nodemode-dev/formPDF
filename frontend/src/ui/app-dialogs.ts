import { api } from '../io/api';
import { VERSION } from '../version';
import { brandMark } from './brand';
import { formatKeys, type Command, type Commands } from './commands';
import { Dialog } from './dialogs';
import { el, escapeHtml, patchList, q, setChecked, setClass, setHidden, setHtml, setText, setValue } from './dom';
import { icon } from './icons';
import { THEMES, readChoice, setAccent, setTheme, themeSwatchesHtml } from './themes';
import { toast } from './toast';

type Settings = Record<string, unknown>;

export function langName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace('_', '-')) ?? code; } catch { return code; }
}

export function applyLang(code: string): void {
  const tag = (code || 'en_US').replace('_', '-');
  if (document.documentElement.lang !== tag) document.documentElement.lang = tag;
}
interface AgentHooks { agentsAllowed: () => boolean; setAgents: (on: boolean) => void }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const setAttr = (node: Element, name: string, value: string): void => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const ACCENTS = ['#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#3b82f6', '#14b8a6', '#22c55e', '#eab308'];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

let capsP: Promise<Settings> | null = null;
function caps(): Promise<Settings> {
  capsP ??= api.capabilities().catch((): Settings => { capsP = null; return {}; });
  return capsP;
}

function segSet(seg: HTMLElement, v: string): void {
  for (const b of Array.from(seg.querySelectorAll<HTMLElement>('button[data-v]'))) {
    setClass(b, 'is-on', b.dataset.v === v);
    setAttr(b, 'aria-pressed', String(b.dataset.v === v));
  }
}

function segOn(seg: HTMLElement, fn: (v: string) => void): void {
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-v]');
    if (!b?.dataset.v || (b as HTMLButtonElement).disabled) return;
    segSet(seg, b.dataset.v);
    fn(b.dataset.v);
  });
}

function flashCopied(btn: HTMLElement, ok: boolean): void {
  const label = btn.querySelector('.fs-dlg-copy-label');
  if (!ok) { toast('Could not copy. Select the text and copy it yourself.', 'error'); return; }
  setText(label, 'Copied');
  setClass(btn, 'is-done', true);
  window.clearTimeout(Number(btn.dataset.timer || 0));
  btn.dataset.timer = String(window.setTimeout(() => { setText(label, 'Copy'); setClass(btn, 'is-done', false); }, 1600));
}

const copyBtn = (): string => `<button class="fs-btn fs-btn-sm fs-btn-ghost fs-dlg-copy" type="button" data-copy>${icon('duplicate', 14)}<span class="fs-dlg-copy-label">Copy</span></button>`;

class PreferencesDialog extends Dialog {
  private h: AgentHooks | null = null;
  private readonly themes: HTMLElement;
  private readonly themeName: HTMLElement;
  private readonly accents: HTMLElement;
  private readonly color: HTMLInputElement;
  private readonly author: HTMLInputElement;
  private readonly units: HTMLElement;
  private readonly agents: HTMLInputElement;
  private readonly lang: HTMLSelectElement;
  private readonly words: HTMLTextAreaElement;
  private readonly tsa: HTMLInputElement;

  constructor() {
    super('Preferences', 560);
    const c = readChoice();
    const box = el(`<div class="fs-dlg-stack">
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Appearance</div>
<div class="fs-field is-top"><span>Theme</span><div><div class="nm-theme-grid fs-dlg-themes">${themeSwatchesHtml(c.theme, c.accentColor)}</div><div class="fs-note fs-dlg-theme-name"></div></div></div>
<div class="fs-field"><span>Accent</span><div class="fs-dlg-accents">${ACCENTS.map((a) => `<button class="fs-swatch" type="button" data-accent="${a}" style="--swatch:${a}" aria-label="Accent ${a}" title="${a}"></button>`).join('')}<label class="fs-dlg-color" title="Custom accent">${icon('palette', 14)}<input type="color" aria-label="Custom accent colour"></label></div></div>
</section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Comments and stamps</div>
<label class="fs-field"><span>Author</span><input class="fs-input fs-dlg-pref-author" type="text" spellcheck="false" placeholder="Your name, written on comments you apply"></label>
<div class="fs-field"><span>Units</span><div class="fs-seg is-quiet" data-seg="units"><button type="button" data-v="pt">Points</button><button type="button" data-v="in">Inches</button><button type="button" data-v="cm">Centimetres</button></div></div>
</section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Spelling</div>
<label class="fs-field"><span>Language</span><select class="fs-input fs-dlg-pref-lang"><option value="en_US">${langName('en_US')}</option></select></label>
<label class="fs-field is-top"><span>Your words</span><textarea class="fs-input fs-dlg-pref-words" rows="4" spellcheck="false" placeholder="One word per line. Check spelling accepts these, and Add to dictionary puts words here."></textarea></label>
</section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Signing</div>
<label class="fs-field"><span>Timestamp server</span><input class="fs-input fs-dlg-pref-tsa" type="url" spellcheck="false" placeholder="https://… (optional; used only when you tick Add a timestamp)"></label>
</section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Agents</div>
<div class="fs-field"><span>Access</span><label class="fs-check"><input type="checkbox" data-f="agents"><span>Let Claude Code, Codex and Cursor read and edit PDFs</span></label></div>
</section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Network</div>
<p class="fs-note">Everything formpdf could connect to, and whether it does. No account, no telemetry.</p>
<div class="fs-dlg-net"></div>
</section>
</div>`);
    this.body.appendChild(box);
    this.themes = q(box, '.fs-dlg-themes');
    this.themeName = q(box, '.fs-dlg-theme-name');
    this.accents = q(box, '.fs-dlg-accents');
    this.color = q<HTMLInputElement>(box, 'input[type="color"]');
    this.author = q<HTMLInputElement>(box, '.fs-dlg-pref-author');
    this.units = q(box, '[data-seg="units"]');
    this.agents = q<HTMLInputElement>(box, '[data-f="agents"]');
    this.lang = q<HTMLSelectElement>(box, '.fs-dlg-pref-lang');
    this.words = q<HTMLTextAreaElement>(box, '.fs-dlg-pref-words');
    this.tsa = q<HTMLInputElement>(box, '.fs-dlg-pref-tsa');
    for (const b of Array.from(this.themes.querySelectorAll<HTMLElement>('[data-theme-id]'))) { b.setAttribute('type', 'button'); b.setAttribute('aria-label', b.title); }
    this.button('Done', 'primary', () => this.close());
    this.themes.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-theme-id]')?.dataset.themeId;
      if (id && THEMES[id]) { setTheme(id); this.syncLook(); }
    });
    this.accents.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-accent]')?.dataset.accent;
      if (a) { setAccent(a); this.syncLook(); }
    });
    this.color.addEventListener('input', () => { setAccent(this.color.value); this.syncLook(); });
    this.author.addEventListener('change', () => this.persist({ author: this.author.value.trim() }));
    segOn(this.units, (v) => this.persist({ units: v }));
    this.lang.addEventListener('change', () => { this.persist({ spellLang: this.lang.value }); applyLang(this.lang.value); });
    this.words.addEventListener('change', () => this.persist({ dictionary: this.words.value.split(/\s*\n\s*/).filter(Boolean) }));
    this.agents.addEventListener('change', () => this.h?.setAgents(this.agents.checked));
    this.tsa.addEventListener('change', () => this.persist({ timestampUrl: this.tsa.value.trim() }));
  }

  private persist(patch: Settings): void {
    void api.setSettings(patch).catch((e) => toast(`Could not save the preference: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }

  private syncLook(): void {
    const c = readChoice();
    for (const b of Array.from(this.themes.querySelectorAll<HTMLElement>('[data-theme-id]'))) {
      const id = b.dataset.themeId ?? '';
      const on = id === c.theme;
      setClass(b, 'is-active', on);
      setAttr(b, 'aria-pressed', String(on));
      const border = on ? c.accentColor : THEMES[id]?.vars['--border-color'] ?? '';
      if (b.style.borderColor !== border) b.style.borderColor = border;
    }
    setText(this.themeName, THEMES[c.theme]?.label ?? '');
    for (const b of Array.from(this.accents.querySelectorAll<HTMLElement>('[data-accent]'))) setClass(b, 'is-chosen', b.dataset.accent?.toLowerCase() === c.accentColor.toLowerCase());
    if (/^#[0-9a-f]{6}$/i.test(c.accentColor)) setValue(this.color, c.accentColor);
  }

  show(h: AgentHooks): void {
    this.h = h;
    this.syncLook();
    setChecked(this.agents, h.agentsAllowed());
    this.open(this.themes.querySelector<HTMLElement>('.is-active'));
    void api.settings().catch((): Settings => ({})).then((s) => {
      setValue(this.author, str(s.author));
      setValue(this.tsa, str(s.timestampUrl));
      segSet(this.units, str(s.units) || 'pt');
      const words = Array.isArray(s.dictionary) ? (s.dictionary as unknown[]).map(String).join('\n') : '';
      if (this.words.value !== words) this.words.value = words;
      if (str(s.spellLang)) { this.lang.dataset.want = str(s.spellLang); setValue(this.lang, str(s.spellLang)); }
    });
    void api.capabilities().then((c) => {
      const langs = (c.spellLanguages as string[] | undefined) ?? [];
      for (const code of langs) {
        if (!this.lang.querySelector(`option[value="${CSS.escape(code)}"]`)) {
          const o = document.createElement('option');
          o.value = code;
          o.textContent = langName(code);
          this.lang.appendChild(o);
        }
      }
      if (this.lang.dataset.want) setValue(this.lang, this.lang.dataset.want);
      const rows = (c.network as Array<{ id: string; name: string; state: string; note: string }> | undefined) ?? [];
      const fill = (n: HTMLElement, r: { name: string; state: string; note: string }): void => { setText(q(n, '.fs-dlg-net-name'), r.name); setText(q(n, '.fs-dlg-net-state'), r.state); setText(q(n, '.fs-dlg-net-note'), r.note); };
      patchList(q(this.body, '.fs-dlg-net'), rows, {
        key: (r) => r.id,
        create: (r) => { const n = el('<div class="fs-dlg-net-row"><span class="fs-dlg-net-name"></span><span class="fs-badge fs-dlg-net-state"></span><span class="fs-note fs-dlg-net-note"></span></div>'); fill(n, r); return n; },
        update: fill,
      });
    }).catch(() => undefined);
  }
}

let prefsDlg: PreferencesDialog | null = null;
export function preferencesDialog(h: AgentHooks): void {
  prefsDlg ??= new PreferencesDialog();
  prefsDlg.show(h);
}

const SETUP: Array<{ id: string; tab: string; title: string; note: string; text: (url: string) => string }> = [
  { id: 'install', tab: 'All at once', title: 'In the formpdf folder', note: 'Writes the Claude Code, Codex and Cursor configs and installs the formpdf skills, so agents know the tools and the PDF actions.', text: () => './formpdf agents install' },
  { id: 'claude', tab: 'Claude Code', title: 'In a terminal', note: 'Run once. Then ask Claude Code to do PDF work with formpdf.', text: (u) => `claude mcp add --transport http formpdf ${u}` },
  { id: 'codex', tab: 'Codex', title: '~/.codex/config.toml', note: 'Add this table, then restart Codex.', text: (u) => `[mcp_servers.formpdf]\nurl = "${u}"` },
  { id: 'cursor', tab: 'Cursor', title: '~/.cursor/mcp.json', note: 'Or .cursor/mcp.json inside a project. Cursor picks it up on the next chat.', text: (u) => `{\n  "mcpServers": {\n    "formpdf": { "url": "${u}" }\n  }\n}` },
  { id: 'desktop', tab: 'Claude Desktop', title: 'claude_desktop_config.json', note: 'Claude Desktop starts local servers over stdio: ./formpdf mcp runs the same tools. Use the full path to your formpdf folder.', text: () => '{\n  "mcpServers": {\n    "formpdf": { "command": "/path/to/formpdf/formpdf", "args": ["mcp"] }\n  }\n}' },
];

class AgentsDialog extends Dialog {
  private h: AgentHooks | null = null;
  private port = location.port && location.port !== '5198' ? location.port : '8198';
  private tab = 'install';
  private readonly allow: HTMLInputElement;
  private readonly badge: HTMLElement;
  private readonly url: HTMLElement;
  private readonly engine: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly blocks: HTMLElement[] = [];

  constructor() {
    super('Agents', 640);
    const card = el(`<div class="fs-dlg-card">
<div class="fs-dlg-card-row"><label class="fs-check"><input type="checkbox" data-f="allow"><span>Let agents read and edit PDFs</span></label><span class="fs-badge fs-dlg-agent-badge"></span></div>
<dl class="fs-kv"><dt>MCP server</dt><dd class="fs-dlg-mcp-url"></dd><dt>Engine</dt><dd class="fs-dlg-engine"></dd></dl>
</div>`);
    this.tabs = el(`<div class="fs-seg is-quiet fs-dlg-tabs" role="group" aria-label="Set up">${SETUP.map((s) => `<button type="button" data-v="${s.id}">${s.tab}</button>`).join('')}</div>`);
    const blocks = SETUP.map((s) => {
      const b = el(`<div class="fs-dlg-code" hidden><div class="fs-dlg-code-head"><span class="fs-dlg-code-title"></span>${copyBtn()}</div><pre class="fs-dlg-code-text"></pre><p class="fs-note"></p></div>`);
      b.dataset.tab = s.id;
      setText(q(b, '.fs-dlg-code-title'), s.title);
      setText(q(b, '.fs-note'), s.note);
      this.blocks.push(b);
      return b;
    });
    const promptBtn = el<HTMLButtonElement>(`<button class="fs-btn fs-dlg-prompt-btn" type="button">${icon('agent', 14)}<span>Copy a starter prompt</span></button>`);
    const how = el(`<div class="fs-dlg-section"><div class="fs-dlg-section-title">How agents work here</div><ul class="fs-dlg-steps is-bullets">
<li>Agents see the PDF you have open. When they change it, the window switches to the result as it happens.</li>
<li>Every agent turn undoes as one step: Edit &gt; Undo agent turn, or Undo turn in the status bar.</li>
<li>Agents ask once before their first change or file. You can turn access off here or in Preferences.</li>
<li>The MCP server listens on 127.0.0.1 only. Nothing leaves this computer unless your agent sends it.</li>
</ul></div>`);
    this.body.append(card, this.tabs, ...blocks, promptBtn, how);
    this.allow = q<HTMLInputElement>(card, '[data-f="allow"]');
    this.badge = q(card, '.fs-dlg-agent-badge');
    this.url = q(card, '.fs-dlg-mcp-url');
    this.engine = q(card, '.fs-dlg-engine');
    this.button('Done', 'primary', () => this.close());
    this.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
      const pre = b?.closest('.fs-dlg-code')?.querySelector('.fs-dlg-code-text');
      if (b && pre) void copyText(pre.textContent ?? '').then((ok) => flashCopied(b, ok));
    });
    segOn(this.tabs, (v) => { this.tab = v; this.syncTabs(); });
    this.allow.addEventListener('change', () => { this.h?.setAgents(this.allow.checked); this.syncAllow(); });
    promptBtn.addEventListener('click', () => {
      const text = ['Use the formpdf MCP server for this PDF work.', 'Call get_context first, open the PDF with open_pdf if it is not open, do the job with the pdf tool, then render_pages on the pages you changed and check them before you tell me it is done.', 'My request: '].join('\n');
      void copyText(text).then((ok) => toast(ok ? 'Prompt copied' : 'Could not copy the prompt', ok ? 'info' : 'error'));
    });
  }

  show(h: AgentHooks): void {
    this.h = h;
    setChecked(this.allow, h.agentsAllowed());
    this.syncAllow();
    this.syncPort();
    this.syncTabs();
    this.open(this.allow);
    void caps().then((c) => {
      if (typeof c.port === 'number' || typeof c.port === 'string') { this.port = String(c.port); this.syncPort(); }
      const dir = str(c.dataDir);
      setText(this.engine, `formpdf ${VERSION} on port ${this.port}${dir ? ` · data in ${dir}` : ''}`);
      if (dir) this.engine.title = dir;
    });
  }

  private syncAllow(): void {
    const on = this.allow.checked;
    setText(this.badge, on ? 'Allowed' : 'Off');
    setClass(this.badge, 'is-approved', on);
    setClass(this.badge, 'is-draft', !on);
  }

  private syncPort(): void {
    const url = `http://127.0.0.1:${this.port}/mcp`;
    setText(this.url, url);
    setText(this.engine, `formpdf ${VERSION} on port ${this.port}`);
    SETUP.forEach((s, i) => setText(q(this.blocks[i], '.fs-dlg-code-text'), s.text(url)));
  }

  private syncTabs(): void {
    segSet(this.tabs, this.tab);
    for (const b of this.blocks) setHidden(b, b.dataset.tab !== this.tab);
  }
}

let agentsDlg: AgentsDialog | null = null;
export function agentsDialog(h: AgentHooks): void {
  agentsDlg ??= new AgentsDialog();
  agentsDlg.show(h);
}

class HelpDialog extends Dialog {
  constructor() {
    super('formpdf Help', 560);
    this.body.appendChild(el(`<div class="fs-dlg-stack">
<div class="fs-dlg-about">${brandMark(36)}<div><div class="fs-dlg-about-name">formpdf</div><div class="fs-note">Version ${escapeHtml(VERSION)} · a PDF editor in the form family</div></div></div>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Quick start</div><ol class="fs-dlg-steps">
<li><strong>Open a PDF.</strong> Drop it on Home, choose Open PDF, open one by path, or pick a recent one.</li>
<li><strong>Pick a tab.</strong> View, Comment, Fill &amp; Sign, Prepare form, Edit, Organize, Extract, Protect and Convert each have their tools above the page and their settings on the right.</li>
<li><strong>Changes build up in a working copy.</strong> Undo steps back through them; Save writes the PDF.</li>
<li><strong>Bring in your agent.</strong> Connect Claude Code, Codex or Cursor from Help &gt; Agents and MCP. Its changes show live and every turn undoes as one step.</li>
</ol></section>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Learn more</div>
<p class="fs-dlg-text">The full manual is docs/MANUAL.md in your formpdf folder.</p>
<p class="fs-dlg-text">Working copies, recents and exports stay on this computer, in the Formpdf folder in your home folder.</p>
<p class="fs-dlg-text">Press <kbd class="fs-key">${escapeHtml(formatKeys('Mod+/'))}</kbd> to see every keyboard shortcut.</p>
</section>
</div>`));
    this.button('Close', 'primary', () => this.close());
  }
}

let helpDlg: HelpDialog | null = null;
export function helpDialog(): void {
  helpDlg ??= new HelpDialog();
  helpDlg.open();
}

const KEY_GROUPS: Array<[string, RegExp]> = [
  ['File', /^pdf-(home|open|create-.+|save|print|close)$/],
  ['Edit', /^pdf-(undo|redo|undo-agent|find)$/],
  ['View', /^pdf-(layout-.+|cover|reading|zoom-.+|fit-.+|rotate|compare)$/],
  ['Tools', /^pdf-tab-.+$/],
  ['Help', /^pdf-(help|shortcuts|agents|preferences)$/],
];
const groupOf = (id: string): string => KEY_GROUPS.find(([, re]) => re.test(id))?.[0] ?? 'Other';
const EXTRA: Array<[string, string, string[]]> = [
  ['Page', 'Next page, previous page', ['PageDown', 'PageUp']],
  ['Page', 'First page, last page', ['Home', 'End']],
  ['Page', 'Delete the selected comment, field or pages', ['Delete']],
  ['Page', 'Cancel the tool or close search', ['Escape']],
  ['Page', 'Comment tools: select, highlight, underline, strike, note, text, draw, rectangle, ellipse, line, arrow', ['V', 'H', 'U', 'K', 'N', 'T', 'P', 'R', 'E', 'L', 'A']],
];

type KeyItem = { key: string; group: string; cmd: Command | null; extra?: [string, string[]] };

class ShortcutsDialog extends Dialog {
  private commands: Commands | null = null;
  private readonly search: HTMLInputElement;
  private readonly table: HTMLElement;
  private readonly empty: HTMLElement;

  constructor() {
    super('Keyboard shortcuts', 620);
    q(this.scrim, '.fs-dialog').classList.add('fs-dlg-keys-dialog');
    const bar = el(`<label class="fs-search">${icon('search', 14)}<input type="search" placeholder="Search commands and keys" aria-label="Search shortcuts" spellcheck="false"></label>`);
    this.table = el('<div class="fs-dlg-keys" role="table" aria-label="Keyboard shortcuts"></div>');
    this.empty = el('<p class="fs-note fs-dlg-keys-empty" hidden>No command matches that search.</p>');
    this.body.append(bar, this.table, this.empty);
    this.search = q<HTMLInputElement>(bar, 'input');
    this.search.addEventListener('input', () => this.filter());
    this.button('Close', 'primary', () => this.close());
  }

  show(commands: Commands): void {
    this.commands = commands;
    const cmds = commands.all();
    const items: KeyItem[] = [];
    for (const g of [...KEY_GROUPS.map(([n]) => n), 'Other']) {
      const inGroup = cmds.filter((c) => groupOf(c.id) === g);
      if (!inGroup.length) continue;
      items.push({ key: `g:${g}`, group: g, cmd: null });
      for (const c of inGroup) items.push({ key: `c:${c.id}`, group: g, cmd: c });
    }
    items.push({ key: 'g:Page', group: 'Page', cmd: null });
    EXTRA.forEach(([g, label, keys], i) => items.push({ key: `x:${i}`, group: g, cmd: null, extra: [label, keys] }));
    patchList(this.table, items, {
      key: (i) => i.key,
      create: (i) => {
        const n = i.cmd || i.extra ? el('<div class="fs-dlg-key-row" role="row"><span class="fs-dlg-key-icon" role="cell"></span><span class="fs-dlg-key-label" role="cell"></span><span class="fs-dlg-key-combos" role="cell"></span></div>') : el('<div class="fs-dlg-key-head" role="row"></div>');
        this.fillRow(n, i);
        return n;
      },
      update: (n, i) => this.fillRow(n, i),
    });
    this.search.value = '';
    this.filter();
    this.open(this.search);
  }

  private fillRow(n: HTMLElement, i: KeyItem): void {
    n.dataset.group = i.group;
    if (!i.cmd && !i.extra) { setText(n, i.group); return; }
    const label = i.cmd ? (this.commands?.label(i.cmd) ?? i.cmd.id) : i.extra?.[0] ?? '';
    const keys = i.cmd ? i.cmd.keys ?? [] : i.extra?.[1] ?? [];
    const shown = keys.map(formatKeys);
    setText(q(n, '.fs-dlg-key-label'), label.replace(/…$/, ''));
    setHtml(q(n, '.fs-dlg-key-combos'), shown.map((k) => `<kbd class="fs-key">${escapeHtml(k)}</kbd>`).join(''), shown.join('|'));
    setClass(n, 'is-unbound', !keys.length);
    n.dataset.search = `${label} ${i.group} ${shown.join(' ')}`.toLowerCase();
  }

  private filter(): void {
    const qy = this.search.value.trim().toLowerCase();
    const visible = new Map<string, number>();
    for (const n of Array.from(this.table.children) as HTMLElement[]) {
      if (!n.classList.contains('fs-dlg-key-row')) continue;
      const ok = !qy || (n.dataset.search ?? '').includes(qy);
      setHidden(n, !ok);
      if (ok) visible.set(n.dataset.group ?? '', (visible.get(n.dataset.group ?? '') ?? 0) + 1);
    }
    for (const n of Array.from(this.table.children) as HTMLElement[]) if (n.classList.contains('fs-dlg-key-head')) setHidden(n, !visible.get(n.dataset.group ?? ''));
    setHidden(this.empty, visible.size > 0);
  }
}

let keysDlg: ShortcutsDialog | null = null;
export function shortcutsDialog(commands: Commands): void {
  keysDlg ??= new ShortcutsDialog();
  keysDlg.show(commands);
}
