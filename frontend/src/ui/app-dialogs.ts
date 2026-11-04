import { api } from '../io/api';
import { loadPlugins, type PluginInfo } from '../pdf/plugins';
import { VERSION } from '../version';
import { brandMark } from './brand';
import { formatKeys, type Command, type Commands } from './commands';
import { confirmAction, Dialog } from './dialogs';
import { language, languages, setLanguage } from './i18n';
import { isLang } from './i18n/langs';
import { el, escapeHtml, patchList, q, setChecked, setClass, setDisabled, setHidden, setHtml, setText, setValue } from './dom';
import { icon } from './icons';
import { STORAGE_KEY, THEMES, readChoice, setAccent, setTheme, themeSwatchesHtml } from './themes';
import { toast } from './toast';

interface NetRow { id: string; name: string; state: string; note: string }
interface AiInfo { provider: string; model: string; base: string; imageModel: string; imageBase: string; keys: Record<string, boolean>; defaults: Record<string, Record<string, string>> }

type Settings = Record<string, unknown>;

export function langName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace('_', '-')) ?? code; } catch { return code; }
}

export function applyLang(code: string): void {
  const tag = (code || 'en_US').replace('_', '-');
  if (document.documentElement.dataset.spellLang !== tag) document.documentElement.dataset.spellLang = tag;
}
interface AgentHooks { agentAccess: () => string; setAccess: (mode: string) => void }
interface SeenAgent { name: string; channel: string; calls: number; last: number }

const ACCESS_OPTIONS = '<option value="ask">Ask each time</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option>';
const ACCESS_LABEL: Record<string, string> = { ask: 'Ask', allowed: 'Allowed', blocked: 'Blocked' };
const CHANNEL_LABEL: Record<string, string> = { inapp: 'Built in', stdio: 'Command line', http: 'HTTP' };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const setAttr = (node: Element, name: string, value: string): void => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
const RAIL_KEY = 'formpdf.prefsRailCollapsed';
const KEY_PREFIXES = ['formpdf.', 'fs-'];
const RAIL_ICONS: Record<string, string> = { General: 'pfGeneral', Interface: 'pfInterface', 'Units & Rulers': 'pfUnits', Type: 'pfType', 'File Handling': 'pfFile', Plugins: 'pfPlugins', AI: 'pfAssistant' };
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
  private readonly access: HTMLSelectElement;
  private readonly lang: HTMLSelectElement;
  private readonly words: HTMLTextAreaElement;
  private readonly tsa: HTMLInputElement;
  private readonly formScripts: HTMLInputElement;
  private readonly nav = el('<nav class="fs-prefs-nav" role="tablist" aria-label="Sections"></nav>');
  private readonly sections = new Map<string, HTMLElement>();
  private readonly dataDir = el('<code class="fs-prefs-code"></code>');
  private pages!: HTMLElement;
  private shell: { frame: HTMLElement; rail: HTMLElement; port: HTMLElement; shade: SVGPathElement; line: SVGPathElement } | null = null;
  private current = '';
  private spyRaf = 0;
  private wireRaf = 0;
  private spyMuted = 0;
  private wireD = '';
  private portY = -1;

  constructor() {
    super('Preferences', 560);
    const c = readChoice();
    const box = el(`<div class="fs-prefs"><div class="fs-prefs-pages">
<section class="fs-prefs-group" data-in="Interface"><h3 class="fs-prefs-label">Language</h3>
<label class="fs-field"><span>Interface</span><select class="fs-input fs-dlg-pref-ui" data-no-i18n>${languages().map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></label>
</section>
<section class="fs-prefs-group" data-in="Interface"><h3 class="fs-prefs-label">Theme</h3>
<div class="fs-field is-stack"><span>Theme</span><div><div class="nm-theme-grid fs-dlg-themes">${themeSwatchesHtml(c.theme, c.accentColor)}</div><div class="fs-note fs-dlg-theme-name"></div></div></div>
<div class="fs-field"><span>Accent</span><div class="fs-dlg-accents">${ACCENTS.map((a) => `<button class="fs-swatch" type="button" data-accent="${a}" style="--swatch:${a}" aria-label="Accent ${a}" title="${a}"></button>`).join('')}<label class="fs-dlg-color" title="Custom accent">${icon('palette', 14)}<input type="color" aria-label="Custom accent colour"></label></div></div>
</section>
<section class="fs-prefs-group" data-in="General"><h3 class="fs-prefs-label">Comments and stamps</h3>
<label class="fs-field"><span>Author</span><input class="fs-input fs-dlg-pref-author" type="text" spellcheck="false" placeholder="Your name, written on comments you apply"></label>
</section>
<section class="fs-prefs-group" data-in="Units &amp; Rulers"><h3 class="fs-prefs-label">Measurements</h3>
<div class="fs-field"><span>Units</span><div class="fs-seg is-quiet" data-seg="units"><button type="button" data-v="pt">Points</button><button type="button" data-v="in">Inches</button><button type="button" data-v="cm">Centimetres</button></div></div>
</section>
<section class="fs-prefs-group" data-in="Type"><h3 class="fs-prefs-label">Spelling</h3>
<label class="fs-field"><span>Language</span><select class="fs-input fs-dlg-pref-lang"><option value="en_US">${langName('en_US')}</option></select></label>
<label class="fs-field is-stack"><span>Your words</span><textarea class="fs-input fs-dlg-pref-words" rows="4" spellcheck="false" placeholder="One word per line. Check spelling accepts these, and Add to dictionary puts words here."></textarea></label>
</section>
<section class="fs-prefs-group" data-in="File Handling"><h3 class="fs-prefs-label">Signing</h3>
<label class="fs-field"><span>Timestamp server</span><input class="fs-input fs-dlg-pref-tsa" type="url" spellcheck="false" placeholder="https://… (optional; used only when you tick Add a timestamp)"></label>
</section>
<section class="fs-prefs-group" data-in="File Handling"><h3 class="fs-prefs-label">Forms</h3>
<div class="fs-field"><span>Scripts</span><label class="fs-check"><input type="checkbox" data-f="formscripts"><span>Run form calculations, formatting and checks (the standard AcroForm ones only; other scripts never run)</span></label></div>
</section>
<section class="fs-prefs-group" data-in="Plugins"><h3 class="fs-prefs-label">Plug-ins</h3>
<p class="fs-note fs-dlg-plug-note">Plug-ins are folders in the Formpdf plugins folder. A plug-in runs code on this computer with formpdf's access to your files, so it stays off until you allow it, and asks again if it changes.</p>
<div class="fs-dlg-plugs"></div>
</section>
<section class="fs-prefs-group" data-in="AI"><h3 class="fs-prefs-label">AI</h3>
<p class="fs-note fs-dlg-ai-note">The Assistant tab asks questions, summarises, drafts presentations and makes pictures with the provider you choose. Nothing is sent anywhere until you choose one and use it.</p>
<label class="fs-field"><span>Provider</span><select class="fs-input fs-dlg-ai-provider"><option value="off">Off</option><option value="agent">Your agent (Claude Code, Codex or Cursor)</option><option value="anthropic">Anthropic, with your API key</option><option value="openai">OpenAI, with your API key</option><option value="local">A model on this computer (Ollama, LM Studio or similar)</option></select></label>
<label class="fs-field"><span>Model</span><input class="fs-input fs-dlg-ai-model" type="text" spellcheck="false"></label>
<label class="fs-field"><span>Server</span><input class="fs-input fs-dlg-ai-base" type="url" spellcheck="false"></label>
<label class="fs-field"><span>API key</span><input class="fs-input fs-dlg-ai-key" type="password" autocomplete="off" spellcheck="false"></label>
<label class="fs-field"><span>Picture server</span><input class="fs-input fs-dlg-ai-imgbase" type="url" spellcheck="false" placeholder="AUTOMATIC1111 or compatible, for pictures"></label>
<div class="fs-field"><span></span><div class="fs-dlg-ai-test"><button class="fs-btn fs-btn-sm" type="button" data-f="aitest">Test the connection</button><span class="fs-note fs-dlg-ai-say" aria-live="polite"></span></div></div>
</section>
<section class="fs-prefs-group" data-in="Plugins"><h3 class="fs-prefs-label">Outside Agents</h3>
<label class="fs-field"><span>Agent access</span><select class="fs-input fs-dlg-pref-access">${ACCESS_OPTIONS}</select></label>
<div class="fs-field is-stack"><span>Agents seen</span><div><p class="fs-note fs-dlg-seen-none">No agent has called since formpdf started.</p><div class="fs-dlg-seen"></div></div></div>
<label class="fs-field"><span>Claude Code program</span><input class="fs-input fs-dlg-pref-claudebin" type="text" spellcheck="false" placeholder="Leave empty to find it automatically"></label>
<label class="fs-field"><span>Claude Code folder</span><input class="fs-input fs-dlg-pref-claudefolder" type="text" spellcheck="false" placeholder="Leave empty to use the Agent folder in Formpdf"></label>
<label class="fs-field"><span>First message</span><input class="fs-input fs-dlg-pref-claudefirst" type="text" spellcheck="false" placeholder="Optional; sent when Claude Code starts"></label>
<div class="fs-field"><span></span><span class="fs-note fs-dlg-claude-say" aria-live="polite"></span></div>
</section>
<section class="fs-prefs-group" data-in="General"><h3 class="fs-prefs-label">Network</h3>
<p class="fs-note">Everything formpdf could connect to, and whether it does. No account, no telemetry.</p>
<div class="fs-dlg-net"></div>
</section>
</div></div>`);
    this.body.appendChild(box);
    this.pages = q(box, '.fs-prefs-pages');
    const inSection = (name: string): HTMLElement[] => Array.from(this.pages.querySelectorAll<HTMLElement>(`:scope > [data-in="${name}"]`));
    this.add('General', ...inSection('General'), this.storageGroup(), this.resetGroup());
    this.add('Interface', ...inSection('Interface'));
    this.add('Units & Rulers', ...inSection('Units & Rulers'));
    this.add('Type', ...inSection('Type'));
    this.add('File Handling', ...inSection('File Handling'));
    this.add('Plugins', ...inSection('Plugins'));
    this.add('AI', ...inSection('AI'));
    this.buildShell();
    this.themes = q(box, '.fs-dlg-themes');
    this.themeName = q(box, '.fs-dlg-theme-name');
    this.accents = q(box, '.fs-dlg-accents');
    this.color = q<HTMLInputElement>(box, 'input[type="color"]');
    this.author = q<HTMLInputElement>(box, '.fs-dlg-pref-author');
    this.units = q(box, '[data-seg="units"]');
    this.access = q<HTMLSelectElement>(box, '.fs-dlg-pref-access');
    this.lang = q<HTMLSelectElement>(box, '.fs-dlg-pref-lang');
    this.words = q<HTMLTextAreaElement>(box, '.fs-dlg-pref-words');
    this.tsa = q<HTMLInputElement>(box, '.fs-dlg-pref-tsa');
    this.formScripts = q<HTMLInputElement>(box, '[data-f="formscripts"]');
    this.formScripts.addEventListener('change', () => this.persist({ formScripts: this.formScripts.checked }));
    q(box, '.fs-dlg-plugs').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const id = t.closest<HTMLElement>('[data-key]')?.dataset.key;
      if (id && t.matches('[data-plug]')) void this.allowPlugin(id, t.checked);
    });
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
    const ui = q<HTMLSelectElement>(box, '.fs-dlg-pref-ui');
    setValue(ui, language());
    ui.addEventListener('change', () => { if (isLang(ui.value)) { this.persist({ language: ui.value }); void setLanguage(ui.value); } });
    this.words.addEventListener('change', () => this.persist({ dictionary: this.words.value.split(/\s*\n\s*/).filter(Boolean) }));
    this.access.addEventListener('change', () => this.h?.setAccess(this.access.value));
    for (const [k, key] of [['claudebin', 'claudeBin'], ['claudefolder', 'claudeFolder'], ['claudefirst', 'claudeFirstMessage']] as const) {
      const f = q<HTMLInputElement>(box, `.fs-dlg-pref-${k}`);
      f.addEventListener('change', () => { this.persist({ [key]: f.value.trim() }); window.setTimeout(() => void this.loadClaude(), 300); });
    }
    this.tsa.addEventListener('change', () => this.persist({ timestampUrl: this.tsa.value.trim() }));
    const ai = (k: string): HTMLInputElement => q<HTMLInputElement>(box, `.fs-dlg-ai-${k}`);
    ai('provider').addEventListener('change', () => void this.saveAi({ provider: ai('provider').value }));
    ai('model').addEventListener('change', () => void this.saveAi({ model: ai('model').value.trim() }));
    ai('base').addEventListener('change', () => void this.saveAi({ base: ai('base').value.trim() }));
    ai('imgbase').addEventListener('change', () => void this.saveAi({ imageBase: ai('imgbase').value.trim() }));
    ai('key').addEventListener('change', () => { const v = ai('key').value.trim(); ai('key').value = ''; void this.saveAi({ key: v }); });
    q(box, '[data-f="aitest"]').addEventListener('click', () => void this.testAi());
  }

  private add(name: string, ...content: HTMLElement[]): void {
    const ic = RAIL_ICONS[name] ?? 'pfGeneral';
    const tab = el<HTMLButtonElement>(`<button class="fs-prefs-railtab" type="button" role="tab"><span class="fs-prefs-tabicon">${icon(ic, 18)}</span><span class="fs-prefs-tablabel"></span></button>`);
    tab.dataset.section = name;
    setText(q(tab, '.fs-prefs-tablabel'), name);
    tab.title = name;
    tab.addEventListener('click', () => this.showSection(name, 'smooth'));
    this.nav.appendChild(tab);
    const page = el(`<section class="fs-prefs-sec" role="tabpanel"><button class="fs-prefs-sechead" type="button" aria-expanded="true"><span class="fs-prefs-secicon">${icon(ic, 16)}</span><span class="fs-prefs-seclabel"></span><span class="fs-prefs-chev">${icon('chevronDown', 16)}</span></button><div class="fs-prefs-secbody"></div></section>`);
    page.dataset.section = name;
    setText(q(page, '.fs-prefs-seclabel'), name);
    q(page, '.fs-prefs-sechead').addEventListener('click', () => this.foldSection(name));
    q(page, '.fs-prefs-secbody').append(...content);
    this.pages.appendChild(page);
    this.sections.set(name, page);
  }

  private buildShell(): void {
    const frame = q<HTMLElement>(this.scrim, '.fs-dialog');
    frame.classList.add('fs-prefs-dlg');
    q<HTMLElement>(this.scrim, '.fs-dialog-head').prepend(el(`<span class="fs-prefs-headicon">${icon('settings', 16)}</span>`));
    let collapsed = false;
    try { collapsed = localStorage.getItem(RAIL_KEY) === '1'; } catch { collapsed = false; }
    const fold = el<HTMLButtonElement>(`<button class="fs-prefs-fold" type="button">${icon('pfFold', 16)}</button>`);
    const paintRail = (): void => {
      setClass(frame, 'is-rail-collapsed', collapsed);
      const label = collapsed ? 'Expand tabs' : 'Collapse tabs';
      if (fold.title !== label) fold.title = label;
      setAttr(fold, 'aria-label', label);
      setAttr(fold, 'aria-expanded', String(!collapsed));
    };
    fold.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { }
      paintRail();
      this.queueWire();
    });
    paintRail();
    const rail = el('<div class="fs-prefs-rail"></div>');
    rail.append(this.nav, fold);
    const wire = el<HTMLElement>('<svg class="fs-prefs-wire" aria-hidden="true"><path class="fs-prefs-wire-shade"></path><path class="fs-prefs-wire-line"></path></svg>') as unknown as SVGSVGElement;
    const port = el('<span class="fs-prefs-port" aria-hidden="true"></span>');
    frame.append(rail, wire, port);
    this.shell = { frame, rail, port, shade: q<SVGPathElement>(wire, '.fs-prefs-wire-shade'), line: q<SVGPathElement>(wire, '.fs-prefs-wire-line') };
    this.pages.addEventListener('scroll', () => this.queueSpy(), { passive: true });
    new ResizeObserver(() => this.queueWire()).observe(frame);
    window.addEventListener('resize', () => this.queueWire());
  }

  private storageGroup(): HTMLElement {
    const g = el('<section class="fs-prefs-group"><h3 class="fs-prefs-label">Settings Storage</h3><div class="fs-prefs-line"></div><p class="fs-note">Documents, batch results and the engine’s stores live in this folder. The window’s own preferences stay in the browser or app storage.</p></section>');
    q(g, '.fs-prefs-line').appendChild(this.dataDir);
    return g;
  }

  private resetGroup(): HTMLElement {
    const g = el('<section class="fs-prefs-group"><h3 class="fs-prefs-label">Reset</h3><button class="fs-btn fs-btn-danger fs-prefs-reset" type="button">Reset All Preferences...</button></section>');
    q(g, '.fs-prefs-reset').addEventListener('click', () => void confirmAction('Reset all preferences?', 'The theme, language, panel layout and every setting kept in this window go back to how formpdf comes; your documents are kept. formpdf reloads.', 'Reset', true).then((ok) => {
      if (!ok) return;
      try {
        for (const k of Object.keys(localStorage)) if (KEY_PREFIXES.some((p) => k.startsWith(p)) || k === STORAGE_KEY) localStorage.removeItem(k);
      } catch { }
      location.reload();
    }));
    return g;
  }

  private showSection(name: string, scroll: ScrollBehavior | null = null): void {
    if (!this.sections.has(name)) return;
    this.markSection(name);
    if (scroll) this.scrollToSection(name, scroll);
  }

  private markSection(name: string): void {
    if (this.current === name) return;
    this.current = name;
    for (const [n, page] of this.sections) setClass(page, 'is-current', n === name);
    for (const tab of Array.from(this.nav.children) as HTMLElement[]) { const on = tab.dataset.section === name; setClass(tab, 'is-active', on); setAttr(tab, 'aria-selected', String(on)); }
    this.queueWire();
  }

  private scrollToSection(name: string, behavior: ScrollBehavior): void {
    const sec = this.sections.get(name);
    if (!sec) return;
    if (sec.classList.contains('is-folded')) this.foldSection(name);
    const top = sec.getBoundingClientRect().top - this.pages.getBoundingClientRect().top + this.pages.scrollTop - 12;
    this.spyMuted = performance.now() + 700;
    this.pages.scrollTo({ top, behavior });
  }

  private foldSection(name: string): void {
    const sec = this.sections.get(name);
    if (!sec) return;
    const folded = !sec.classList.contains('is-folded');
    setClass(sec, 'is-folded', folded);
    setHidden(q(sec, '.fs-prefs-secbody'), folded);
    setAttr(q(sec, '.fs-prefs-sechead'), 'aria-expanded', String(!folded));
    this.queueWire();
    this.queueSpy();
  }

  private queueSpy(): void {
    if (this.spyRaf) return;
    this.spyRaf = requestAnimationFrame(() => {
      this.spyRaf = 0;
      const pages = this.pages;
      if (!pages.clientHeight || performance.now() < this.spyMuted) return;
      const edge = pages.getBoundingClientRect().top + 24;
      const names = Array.from(this.sections.keys());
      let best = '', bestD = Infinity;
      if (pages.scrollHeight > pages.clientHeight + 4 && pages.scrollTop + pages.clientHeight >= pages.scrollHeight - 2) best = names[names.length - 1] ?? '';
      else for (const [n, sec] of this.sections) {
        const top = sec.getBoundingClientRect().top, d = top <= edge ? edge - top : top - edge + 100000;
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best) this.markSection(best);
    });
  }

  private queueWire(): void {
    if (this.wireRaf) return;
    this.wireRaf = requestAnimationFrame(() => { this.wireRaf = 0; this.drawWire(); });
  }

  private drawWire(): void {
    const s = this.shell;
    if (!s || !this.isOpen) return;
    const F = s.frame.getBoundingClientRect();
    const tab = this.nav.querySelector<HTMLElement>('.fs-prefs-railtab.is-active');
    const head = s.frame.querySelector<HTMLElement>('.fs-dialog-head');
    if (!F.width || !tab || !head) return;
    const N = this.nav.getBoundingClientRect();
    let T = tab.getBoundingClientRect();
    if (T.top < N.top || T.bottom > N.bottom) {
      this.nav.scrollTop += T.top < N.top ? T.top - N.top - 6 : T.bottom - N.bottom + 6;
      T = tab.getBoundingClientRect();
    }
    const R = s.rail.getBoundingClientRect(), H = head.getBoundingClientRect();
    const portY = Math.round(H.bottom - F.top), sx = Math.round(T.right - F.left), ty = Math.round(T.top - F.top + T.height / 2);
    const rr = R.right - F.left, trunk = Math.round(rr - rr * 0.45), dy = portY - ty, r = 10, dir = dy > 0 ? 1 : -1;
    const d = Math.abs(dy) < 2 * r ? `M ${sx} ${ty} H ${trunk} V ${portY} H -7` : `M ${sx} ${ty} H ${trunk - r} a ${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${r} ${dir * r} V ${portY - dir * r} a ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${r} ${dir * r} H -7`;
    if (d !== this.wireD) { this.wireD = d; s.shade.setAttribute('d', d); s.line.setAttribute('d', d); }
    if (portY !== this.portY) { this.portY = portY; s.port.style.transform = `translateY(${portY}px)`; }
  }

  private fillAi(s: AiInfo): void {
    const ai = (k: string): HTMLInputElement => q<HTMLInputElement>(this.body, `.fs-dlg-ai-${k}`);
    setValue(ai('provider'), s.provider);
    const d = s.defaults[s.provider] ?? {};
    setValue(ai('model'), s.model);
    ai('model').placeholder = d.model ?? '';
    setValue(ai('base'), s.base);
    ai('base').placeholder = d.base ?? '';
    setValue(ai('imgbase'), s.provider === 'local' ? s.imageBase : '');
    const keyed = s.provider === 'anthropic' || s.provider === 'openai' || s.provider === 'local';
    const has = keyed && s.keys[s.provider];
    ai('key').placeholder = !keyed ? 'Not needed' : has ? 'Saved on this computer; type a new one to replace it' : s.provider === 'local' ? 'Only if your server needs one' : 'Paste your key; it stays on this computer';
    setDisabled(ai('model'), s.provider === 'off' || s.provider === 'agent');
    setDisabled(ai('base'), s.provider === 'off' || s.provider === 'agent');
    setDisabled(ai('key'), !keyed);
    setDisabled(ai('imgbase'), s.provider !== 'local');
    setDisabled(q<HTMLButtonElement>(this.body, '[data-f="aitest"]'), s.provider === 'off' || s.provider === 'agent');
  }

  private async saveAi(patch: Record<string, unknown>): Promise<void> {
    const say = q(this.body, '.fs-dlg-ai-say');
    try {
      const s = await api.post<AiInfo>('/api/ai/settings', patch);
      this.fillAi(s);
      setText(say, 'key' in patch ? (patch.key ? 'Key saved.' : 'Key removed.') : 'Saved.');
      window.dispatchEvent(new CustomEvent('fs-ai-settings'));
      void api.capabilities().then((c) => this.fillNet((c.network as NetRow[] | undefined) ?? [])).catch(() => undefined);
    } catch (e) { setText(say, e instanceof Error ? e.message : String(e)); }
  }

  private async testAi(): Promise<void> {
    const say = q(this.body, '.fs-dlg-ai-say');
    setText(say, 'Testing.');
    try {
      const r = await api.post<{ text: string; ms: number }>('/api/ai/test', {});
      setText(say, `Connected: answered "${r.text.slice(0, 40)}" in ${(r.ms / 1000).toFixed(1)} s.`);
    } catch (e) { setText(say, e instanceof Error ? e.message : String(e)); }
  }

  private fillNet(rows: NetRow[]): void {
    const fill = (n: HTMLElement, r: NetRow): void => { setText(q(n, '.fs-dlg-net-name'), r.name); setText(q(n, '.fs-dlg-net-state'), r.state); setText(q(n, '.fs-dlg-net-note'), r.note); };
    patchList(q(this.body, '.fs-dlg-net'), rows, {
      key: (r) => r.id,
      create: (r) => { const n = el('<div class="fs-dlg-net-row"><span class="fs-dlg-net-name"></span><span class="fs-badge fs-dlg-net-state"></span><span class="fs-note fs-dlg-net-note"></span></div>'); fill(n, r); return n; },
      update: fill,
    });
  }

  private async allowPlugin(id: string, allowed: boolean): Promise<void> {
    try {
      const p = await api.post<PluginInfo>(`/api/plugins/${encodeURIComponent(id)}`, { allowed });
      toast(allowed ? (p.error ? `${p.name} did not start: ${p.error}` : `${p.name} is on.${p.window ? ' Its window part loads now.' : ''}`) : `${p.name} is off. Its window part leaves at the next start.`, p.error ? 'error' : 'info');
      if (allowed && !p.error) void loadPlugins();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    void this.loadPlugs();
  }

  private async loadPlugs(): Promise<void> {
    let got: { plugins: PluginInfo[]; folder: string } = { plugins: [], folder: '' };
    try { got = await api.get('/api/plugins'); } catch { return; }
    const say = (p: PluginInfo): string => `${p.version ? `${p.version} · ` : ''}${p.state === 'new' ? 'New, not allowed yet' : p.state === 'changed' ? 'Changed since you allowed it; allow it again' : p.state === 'on' ? (p.error ? `Did not start: ${p.error}` : `On${p.actions.length ? ` · actions ${p.actions.join(', ')}` : ''}`) : 'Off'}${p.description ? ` · ${p.description}` : ''}`;
    const fill = (n: HTMLElement, p: PluginInfo): void => {
      setText(q(n, '.fs-dlg-plug-name'), p.name);
      setText(q(n, '.fs-dlg-plug-say'), say(p));
      setChecked(q<HTMLInputElement>(n, '[data-plug]'), p.state === 'on');
    };
    patchList(q(this.body, '.fs-dlg-plugs'), got.plugins, {
      key: (p) => p.id,
      create: (p) => { const n = el('<label class="fs-check fs-dlg-plug"><input type="checkbox" data-plug><span class="fs-dlg-plug-main"><span class="fs-dlg-plug-name"></span><span class="fs-note fs-dlg-plug-say"></span></span></label>'); fill(n, p); return n; },
      update: fill,
    });
    setText(q(this.body, '.fs-dlg-plug-note'), `Plug-ins are folders in ${got.folder}. A plug-in runs code on this computer with formpdf's access to your files, so it stays off until you allow it, and asks again if it changes.${got.plugins.length ? '' : ' There are none yet.'}`);
  }

  private fillSeen(rows: SeenAgent[]): void {
    const fill = (n: HTMLElement, r: SeenAgent): void => {
      setText(q(n, '.fs-dlg-net-name'), r.name);
      setText(q(n, '.fs-dlg-net-state'), CHANNEL_LABEL[r.channel] ?? r.channel);
      setText(q(n, '.fs-dlg-net-note'), `Calls: ${r.calls} · last ${new Date(r.last * 1000).toLocaleTimeString()}`);
    };
    setHidden(q(this.body, '.fs-dlg-seen-none'), rows.length > 0);
    patchList(q(this.body, '.fs-dlg-seen'), rows, {
      key: (r) => r.name,
      create: (r) => { const n = el('<div class="fs-dlg-net-row"><span class="fs-dlg-net-name"></span><span class="fs-badge fs-dlg-net-state"></span><span class="fs-note fs-dlg-net-note"></span></div>'); fill(n, r); return n; },
      update: fill,
    });
  }

  private async loadClaude(): Promise<void> {
    try {
      const s = await api.get<{ installed: boolean; path: string | null; version: string | null; folder: string; binNote: string }>('/api/claude/status');
      const bin = q<HTMLInputElement>(this.body, '.fs-dlg-pref-claudebin');
      const folder = q<HTMLInputElement>(this.body, '.fs-dlg-pref-claudefolder');
      if (s.path && bin.placeholder !== s.path) bin.placeholder = s.path;
      if (folder.placeholder !== s.folder) folder.placeholder = s.folder;
      setText(q(this.body, '.fs-dlg-claude-say'), s.binNote || (s.installed ? `Claude Code${s.version ? ` ${s.version}` : ''} found at ${s.path}` : 'Claude Code was not found on this computer.'));
    } catch { return; }
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
    setValue(this.access, h.agentAccess());
    this.open(this.nav.querySelector<HTMLElement>('.is-active') ?? this.nav.querySelector<HTMLElement>('.fs-prefs-railtab'));
    this.markSection(this.current || 'General');
    this.queueWire();
    void this.loadPlugs();
    void this.loadClaude();
    void api.get<{ clients: SeenAgent[] }>('/api/mcp/status').then((s) => this.fillSeen(s.clients)).catch(() => undefined);
    void api.settings().catch((): Settings => ({})).then((s) => {
      setValue(this.author, str(s.author));
      setValue(q<HTMLInputElement>(this.body, '.fs-dlg-pref-claudebin'), str(s.claudeBin));
      setValue(q<HTMLInputElement>(this.body, '.fs-dlg-pref-claudefolder'), str(s.claudeFolder));
      setValue(q<HTMLInputElement>(this.body, '.fs-dlg-pref-claudefirst'), str(s.claudeFirstMessage));
      setValue(this.tsa, str(s.timestampUrl));
      setChecked(this.formScripts, s.formScripts !== false);
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
      this.fillNet((c.network as NetRow[] | undefined) ?? []);
      setText(this.dataDir, str(c.dataDir) || 'Starts with the engine');
    }).catch(() => undefined);
    void api.get<AiInfo>('/api/ai/settings').then((s) => this.fillAi(s)).catch(() => undefined);
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
  private readonly allow: HTMLSelectElement;
  private readonly badge: HTMLElement;
  private readonly url: HTMLElement;
  private readonly engine: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly blocks: HTMLElement[] = [];

  constructor() {
    super('Agents', 640);
    const card = el(`<div class="fs-dlg-card">
<div class="fs-dlg-card-row"><label class="fs-check"><span>Agent access</span><select class="fs-input" data-f="allow">${ACCESS_OPTIONS}</select></label><span class="fs-badge fs-dlg-agent-badge"></span></div>
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
    this.allow = q<HTMLSelectElement>(card, '[data-f="allow"]');
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
    this.allow.addEventListener('change', () => { this.h?.setAccess(this.allow.value); this.syncAllow(); });
    promptBtn.addEventListener('click', () => {
      const text = ['Use the formpdf MCP server for this PDF work.', 'Call get_context first, open the PDF with open_pdf if it is not open, do the job with the pdf tool, then render_pages on the pages you changed and check them before you tell me it is done.', 'My request: '].join('\n');
      void copyText(text).then((ok) => toast(ok ? 'Prompt copied' : 'Could not copy the prompt', ok ? 'info' : 'error'));
    });
  }

  show(h: AgentHooks): void {
    this.h = h;
    setValue(this.allow, h.agentAccess());
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
    const mode = this.allow.value;
    setText(this.badge, ACCESS_LABEL[mode] ?? mode);
    setClass(this.badge, 'is-approved', mode === 'allowed');
    setClass(this.badge, 'is-draft', mode !== 'allowed');
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
<div class="fs-dlg-about">${brandMark(36)}<div><div class="fs-dlg-about-name">formpdf</div><div class="fs-note">Version ${escapeHtml(VERSION)} · a PDF editor in the form family</div><div class="fs-note">Copyright 2026 NodeAgentc, Inc. · <a href="https://github.com/nodemode-dev/formpdf/blob/main/LICENSE" target="_blank" rel="noopener">Apache License 2.0</a></div></div></div>
<section class="fs-dlg-section"><div class="fs-dlg-section-title">Quick start</div><ol class="fs-dlg-steps">
<li><strong>Open a PDF.</strong> Drop it on Home, choose Open PDF, open one by path, or pick a recent one.</li>
<li><strong>Pick a tab.</strong> View, Comment, Fill Forms and Sign, Prepare form, Edit, Organize, Extract, Protect and Convert each have their tools above the page and their settings on the right.</li>
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
