import type { Catalogue } from '../automation/catalogue';
import { api } from '../io/api';
import { chooseSave, pdfApi, writeTo } from '../pdf/api';
import type { Tab } from '../pdf/panels';
import { reveal } from '../pdf/sections';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { Command, Commands } from '../ui/commands';
import { Dialog, promptName } from '../ui/dialogs';
import { el, patchList, q, setClass, setHidden, setText, setTitle } from '../ui/dom';
import { icon } from '../ui/icons';
import type { MenuItem } from '../ui/menu';
import { tf } from '../ui/i18n';
import { toast } from '../ui/toast';
import { VERSION } from '../version';
import { ERR, ExtensionHost, HostError, PERMISSION_WORDS, themeTokens, type ExtensionRecord, type Frame, type Permission, type Theme } from './host-bridge';

interface DocNow { id: string; key: string; name: string; pages: number; page: number; dirty: boolean; tab: string; path: string | null }
export interface ExtBench { commands: Commands; isOpen: boolean; state(): DocNow | null; openTab(tab: Tab): void; refreshMenus(): void; onView: (() => void) | null }
export interface ExtWiring { bench: () => ExtBench; showBench: () => void; catalogue: () => Catalogue }
export interface ExtReply { ok: boolean; text: string; data?: Record<string, unknown> }
interface Listing { root: string; stamp: number[]; extensions: ExtensionRecord[] }
interface ActionRow { name: string; kind: 'read' | 'change' | 'export'; label: string; fields: Array<{ name: string; type: string; hint: string }> }
interface Open { key: string; ext: ExtensionRecord; panel: string; frame: Frame; box: HTMLElement; title: HTMLElement; section?: HTMLElement; dialog?: PanelDialog }

const PRODUCT = 'formpdf';
const FIXED = ['ext-panel', 'ext-reload', 'ext-manage'];
const SOURCE: Record<string, string> = { catalogue: 'Catalogue', sideload: 'File', development: 'Development' };
const KEPT_OUT = new Set(['merge', 'protect', 'unlock']);
const OPEN_MAX = 200 * 1024 * 1024;
const DOCK_H = 320;

const LIST_HTML = `<div class="fs-ext-foot"><button class="fs-btn fs-btn-sm" type="button" data-ext="manage">Manage in FormPortal</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-ext="reload">${icon('refresh', 14)}<span>Reload Extensions</span></button></div>
<p class="fs-note fs-ext-root"></p>
<div class="fs-ext-empty" hidden><p class="fs-note">No extensions yet. Find them in FormPortal or make one with form.ext.</p></div>
<div class="fs-ext-list" role="list" aria-label="Extensions"></div>`;

const ROW_HTML = `<div class="fs-ext-row" role="listitem">
<div class="fs-ext-head"><span class="fs-ext-name"></span><span class="fs-ext-ver"></span><span class="fs-badge fs-ext-src"></span></div>
<p class="fs-note fs-ext-desc"></p>
<div class="fs-ext-chips"></div>
<div class="fs-ext-state"><span class="fs-badge fs-ext-st"></span><span class="fs-note fs-ext-why"></span></div>
<p class="fs-note fs-ext-path" hidden></p>
<div class="fs-ext-acts"></div>
</div>`;

let current: Extensions | null = null;
let listRoot: HTMLElement | null = null;
let toolHost: ToolHost | null = null;
let menuIds: string[] = [];

export function extensionMenu(): MenuItem[] {
  return [...menuIds, ...(menuIds.length ? ['-'] : []), ...FIXED];
}

registerTool({
  id: 'extensions-list',
  tab: 'extensions',
  title: 'Extensions',
  first: true,
  words: ['extensions', 'add-ons'],
  section: () => LIST_HTML,
  mount: (root, host) => { listRoot = root; toolHost = host; current?.attach(); },
  sync: () => current?.docSync(),
});

const b64 = {
  from: (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  to: (data: string): Uint8Array => Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
};

class ConsentDialog extends Dialog {
  private readonly lead = el('<p class="fs-note"></p>');
  private readonly list = el('<ul class="fs-ext-perms"></ul>');
  private readonly allowBtn: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;
  constructor() {
    super('', 440);
    this.body.append(this.lead, this.list, el('<p class="fs-note">You are asked again when a new version asks for more. Extensions run in a sandbox and reach formpdf only through what you allow here.</p>'));
    this.button('Not Now', 'ghost', () => this.finish(false));
    this.allowBtn = this.button('Allow', 'primary', () => this.finish(true));
    this.onClose = () => this.finish(false);
  }
  ask(ext: ExtensionRecord): Promise<boolean> {
    this.setTitle(`Allow ${ext.name}?`);
    setText(this.lead, `${ext.name} ${ext.version} asks to:`);
    patchList(this.list, ext.permissions, {
      key: (p) => p,
      create: (p) => { const li = el('<li></li>'); setText(li, PERMISSION_WORDS[p]); return li; },
      update: (li, p) => setText(li, PERMISSION_WORDS[p]),
    });
    this.open(this.allowBtn);
    return new Promise((r) => { this.resolve = r; });
  }
  private finish(v: boolean): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

class PanelDialog extends Dialog {
  readonly box = el('<div class="fs-ext-frame is-dialog"></div>');
  constructor(title: string, onClose: () => void) {
    super(title, 560);
    this.scrim.classList.add('fs-ext-dialog');
    this.body.appendChild(this.box);
    this.button('Close', 'primary', () => this.close());
    this.onClose = () => { onClose(); this.scrim.remove(); };
  }
}

function theme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string): string => s.getPropertyValue(n).trim();
  return {
    mode: document.body.classList.contains('theme-light') ? 'light' : 'dark',
    tokens: {
      '--bg': v('--bg-primary'), '--panel': v('--bg-secondary'), '--text': v('--text-primary'), '--muted': v('--text-secondary'),
      '--accent': v('--accent-color'), '--border': v('--border-color'), '--radius': v('--radius'),
      ...themeTokens(['--bg-primary', '--bg-secondary', '--bg-tertiary', '--text-primary', '--text-secondary', '--border-color', '--accent-color']),
    },
  };
}

function refused(message: string): HostError { return new HostError(ERR.REFUSED, message); }

export class Extensions {
  private list: ExtensionRecord[] = [];
  private root = '';
  private sig = '';
  private loaded = false;
  private readonly host: ExtensionHost;
  private readonly registered = new Map<string, string>();
  private readonly open = new Map<string, Open>();
  private readonly hidden = el('<div class="fs-ext-hidden" aria-hidden="true"></div>');
  private consentDlg: ConsentDialog | null = null;
  private actions: ActionRow[] | null = null;
  private docSig = '';
  private viewSig = '';
  private loading: Promise<void> | null = null;

  constructor(private readonly w: ExtWiring) {
    current = this;
    document.body.appendChild(this.hidden);
    this.host = new ExtensionHost({
      product: PRODUCT, app: 'formpdf', appVersion: VERSION,
      theme,
      notify: (_ext, message, level) => toast(message, level === 'error' ? 'error' : 'info'),
      setTitle: (ext, frame, title) => { for (const o of this.open.values()) if (o.frame.frame === frame) setText(o.title, title ? `${ext.name}: ${title}` : this.titleOf(ext, o.panel)); },
      readDocument: (_ext, params) => this.read(params as { what?: string; pages?: string }),
      applyDocument: (ext, label, ops) => this.apply(ext, label, ops),
      commands: () => this.catalogue(),
      run: (ext, command, args) => this.run(ext, command, args),
      openFiles: (_ext, accept, multiple) => this.pick(accept, multiple),
      saveFile: async (_ext, name, type, data) => {
        const clean = (n: string): string => n.trim().replace(/[\\/]/g, '_').slice(0, 120);
        const target = await chooseSave(clean(name));
        const file = target?.kind === 'download' ? await promptName('Save in your Downloads folder as', clean(name), 'Save') : clean(name);
        if (!target || !file || !clean(file)) throw new HostError(ERR.CANCELLED, 'The save was cancelled');
        return { saved: true, name: await writeTo(target, new Blob([b64.to(data) as BlobPart], { type }), clean(file)) };
      },
      consent: (ext) => (this.consentDlg ??= new ConsentDialog()).ask(ext),
    });
    const bench = w.bench();
    bench.commands.add(
      { id: 'ext-panel', label: 'Extensions Panel', group: 'Extensions', words: ['extensions', 'add-ons', 'plug-ins', 'formportal'], run: () => this.showPanel() },
      { id: 'ext-reload', label: 'Reload Extensions', group: 'Extensions', words: ['extensions', 'refresh', 'form.ext', 'development'], run: () => void this.load(true) },
      { id: 'ext-manage', label: 'Manage in FormPortal', group: 'Extensions', words: ['extensions', 'formportal', 'install', 'catalogue'], run: () => void this.manage() },
    );
    bench.onView = () => this.viewSync();
    document.addEventListener('nm:ui-settings-changed', () => requestAnimationFrame(() => this.host.setTheme(theme())));
    this.attach();
    void this.load(false);
    window.setInterval(() => { if (document.hasFocus() && !document.hidden) void this.load(false); }, 2000);
  }

  attach(): void {
    if (!listRoot || listRoot.dataset.wired) return;
    listRoot.dataset.wired = '1';
    listRoot.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-ext]');
      if (!t) return;
      const act = t.dataset.ext;
      if (act === 'reload') void this.load(true);
      else if (act === 'manage') void this.manage();
      else if (act === 'open') {
        const ext = this.list.find((x) => x.id === t.closest<HTMLElement>('.fs-ext-row')?.dataset.key);
        if (ext && t.dataset.panel) this.openPanel(ext, t.dataset.panel).catch(() => undefined);
      }
    });
    this.render();
  }

  private load(reload: boolean): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const got = await api.get<Listing>('/api/extensions');
        const sig = JSON.stringify(got.extensions);
        this.root = got.root;
        if (sig !== this.sig || !this.loaded) this.update(got.extensions);
        this.sig = sig;
        this.loaded = true;
        if (reload) {
          for (const o of [...this.open.values()]) if (o.ext.source === 'development') this.remount(o);
          toast(tf('Extensions reloaded: {0} found', String(this.list.length)));
        }
        this.render();
      } catch {
        if (reload) toast('The formpdf engine did not list the extensions', 'error');
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private update(next: ExtensionRecord[]): void {
    const before = new Map(this.list.map((e) => [e.id, e]));
    const at = new Map(this.list.map((e, i) => [e.id, i]));
    this.list = [...next].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity));
    for (const o of [...this.open.values()]) {
      const now = next.find((e) => e.id === o.ext.id);
      if (!now || now.state !== 'ready' || now.version !== o.ext.version || !now.panels.some((p) => p.id === o.panel)) this.close(o.key);
      else o.ext = now;
    }
    for (const [id, old] of before) if (!next.some((e) => e.id === id && e.version === old.version)) this.host.disposeExtension(id);
    this.syncCommands();
  }

  private syncCommands(): void {
    const bench = this.w.bench();
    const want = new Map<string, Command>();
    for (const ext of this.list) {
      if (ext.state !== 'ready') continue;
      for (const c of ext.commands) {
        const id = `ext-${ext.id}-${c.id}`;
        want.set(id, {
          id, label: `${ext.name}: ${c.title}`, group: 'Extensions', words: ['extension', ext.name, ext.id],
          description: `${c.title}, from the extension ${ext.name} ${ext.version}.`, mutates: ext.permissions.includes('document'),
          run: () => this.command(ext.id, c.id, {}).then((r) => { if (!r.ok) toast(r.text, 'error'); }),
        });
      }
    }
    let changed = false;
    for (const [id, label] of [...this.registered]) {
      const w = want.get(id);
      if (!w || w.label !== label) { bench.commands.remove(id); this.registered.delete(id); changed = true; }
    }
    for (const [id, cmd] of want) if (!this.registered.has(id)) { bench.commands.add(cmd); this.registered.set(id, String(cmd.label)); changed = true; }
    menuIds = [...want.keys()];
    if (changed) bench.refreshMenus();
  }

  private stateOf(ext: ExtensionRecord): { label: string; cls: string } {
    if (ext.state === 'refused') return { label: 'Refused', cls: 'is-changes' };
    return this.host.isGranted(ext) ? { label: 'Ready', cls: 'is-approved' } : { label: 'Needs Permission', cls: 'is-review' };
  }

  private render(): void {
    const root = listRoot;
    if (!root || !this.loaded) return;
    const box = q(root, '.fs-ext-list');
    patchList(box, this.list, { key: (e) => e.id, create: (e) => { const row = el(ROW_HTML); this.fill(row, e); return row; }, update: (row, e) => this.fill(row, e) });
    setHidden(q(root, '.fs-ext-empty'), this.list.length > 0);
    const where = this.root ? `${this.root}/extensions/${PRODUCT}` : '';
    setText(q(root, '.fs-ext-root'), where);
    setTitle(q(root, '.fs-ext-root'), where);
  }

  private fill(row: HTMLElement, e: ExtensionRecord): void {
    setText(q(row, '.fs-ext-name'), e.name);
    setText(q(row, '.fs-ext-ver'), e.version);
    setText(q(row, '.fs-ext-src'), SOURCE[e.source] ?? e.source);
    setText(q(row, '.fs-ext-desc'), e.description ?? '');
    setHidden(q(row, '.fs-ext-desc'), !e.description);
    patchList(q(row, '.fs-ext-chips'), e.permissions, {
      key: (p) => p,
      create: (p) => { const c = el('<span class="fs-badge fs-ext-chip"></span>'); setText(c, p); setTitle(c, PERMISSION_WORDS[p as Permission] ?? p); return c; },
      update: () => undefined,
    });
    const st = this.stateOf(e);
    const badge = q(row, '.fs-ext-st');
    setText(badge, st.label);
    for (const c of ['is-changes', 'is-approved', 'is-review']) setClass(badge, c, c === st.cls);
    setText(q(row, '.fs-ext-why'), e.state === 'refused' ? e.reason ?? '' : '');
    const path = q(row, '.fs-ext-path');
    setText(path, e.path ?? '');
    setTitle(path, e.path ?? '');
    setHidden(path, e.source !== 'development' || !e.path);
    const panels = e.state === 'ready' ? e.panels : [];
    patchList(q(row, '.fs-ext-acts'), panels, {
      key: (p) => p.id,
      create: (p) => { const b = el<HTMLButtonElement>(`<button class="fs-btn fs-btn-sm" type="button" data-ext="open"></button>`); b.dataset.panel = p.id; setText(b, panels.length > 1 ? `Open ${p.title}` : 'Open'); return b; },
      update: (b, p) => setText(b, panels.length > 1 ? `Open ${p.title}` : 'Open'),
    });
  }

  private titleOf(ext: ExtensionRecord, panel: string): string {
    const p = ext.panels.find((x) => x.id === panel);
    return !p || p.title === ext.name ? ext.name : `${ext.name}: ${p.title}`;
  }

  private showPanel(section: Element | null = listRoot): void {
    if (!this.w.bench().isOpen) this.w.showBench();
    this.w.bench().openTab('extensions');
    reveal(section);
  }

  private async manage(): Promise<void> {
    try { await api.post('/api/extensions/manage'); } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); }
  }

  async openPanel(ext: ExtensionRecord, panel: string, activation?: { command: string; args: unknown }): Promise<unknown> {
    const def = ext.panels.find((p) => p.id === panel);
    if (!def) throw new HostError(ERR.NOT_FOUND, `${ext.name} has no panel ${panel}`);
    if (ext.state !== 'ready') { toast(`${ext.name} cannot run: ${ext.reason ?? 'refused'}`, 'error'); throw refused(`${ext.name} cannot run: ${ext.reason ?? 'refused'}`); }
    const key = `${ext.id}/${panel}`;
    let o = this.open.get(key) ?? null;
    if (!o) o = def.location === 'dialog' ? await this.mountDialog(ext, panel, key) : await this.mountDock(ext, panel, key);
    this.render();
    if (!o) throw new HostError(ERR.PERMISSION, `${ext.name} was not allowed to run`);
    if (o.section) this.showPanel(o.section);
    else o.dialog?.open();
    return o.frame.activate(activation ? { reason: 'command', panel, command: activation.command, args: activation.args } : { reason: 'panel', panel });
  }

  private async mountDock(ext: ExtensionRecord, panel: string, key: string): Promise<Open | null> {
    const pane = listRoot?.parentElement;
    if (!pane) throw refused('No PDF is open in formpdf');
    const section = el(`<section class="fs-pdfwb-sec fs-ext-dock"><h3 class="fs-pdfwb-sec-title"><span class="fs-ext-dock-title"></span><button class="fs-icon-btn is-sm fs-ext-close" type="button" title="Close" aria-label="Close">${icon('close', 14)}</button></h3><div class="fs-ext-frame"></div></section>`);
    section.dataset.section = `ext-${key}`;
    const box = q(section, '.fs-ext-frame');
    box.style.height = `${DOCK_H}px`;
    const title = q(section, '.fs-ext-dock-title');
    setText(title, this.titleOf(ext, panel));
    const frame = await this.host.open(ext, box, { onResize: (h) => { box.style.height = `${Math.max(80, Math.round(h))}px`; } });
    if (!frame) return null;
    const raced = this.open.get(key);
    if (raced) { frame.dispose(); return raced; }
    pane.appendChild(section);
    const o: Open = { key, ext, panel, frame, box, title, section };
    q(section, '.fs-ext-close').addEventListener('click', () => this.close(key));
    this.open.set(key, o);
    return o;
  }

  private async mountDialog(ext: ExtensionRecord, panel: string, key: string): Promise<Open | null> {
    if (!(await this.host.ensureConsent(ext))) return null;
    const raced = this.open.get(key);
    if (raced) return raced;
    const dialog = new PanelDialog(this.titleOf(ext, panel), () => { const o = this.open.get(key); if (o) { o.frame.dispose(); this.open.delete(key); } });
    dialog.box.style.height = '360px';
    const frame = await this.host.open(ext, dialog.box, { onResize: (h) => { dialog.box.style.height = `${Math.max(80, Math.min(640, Math.round(h)))}px`; } });
    if (!frame) return null;
    const o: Open = { key, ext, panel, frame, box: dialog.box, title: q(dialog.scrim, '.fs-dialog-title'), dialog };
    this.open.set(key, o);
    return o;
  }

  private remount(o: Open): void {
    o.frame.dispose();
    o.frame = this.host.mount(o.ext, o.box, { onResize: (h) => { o.box.style.height = `${Math.max(80, Math.round(h))}px`; } });
    void o.frame.activate({ reason: 'panel', panel: o.panel }).catch(() => undefined);
  }

  private close(key: string): void {
    const o = this.open.get(key);
    if (!o) return;
    this.open.delete(key);
    o.frame.dispose();
    o.section?.remove();
    if (o.dialog?.isOpen) o.dialog.close();
  }

  async command(id: string, commandId: string, args: unknown): Promise<ExtReply> {
    const ext = this.list.find((e) => e.id === id);
    const cmd = ext?.commands.find((c) => c.id === commandId);
    if (!ext || !cmd) return { ok: false, text: `There is no extension command ${id} ${commandId}; extensions_list gives them.` };
    if (ext.state !== 'ready') return { ok: false, text: `${ext.name} cannot run: ${ext.reason ?? ''}` };
    try {
      const result = cmd.panel
        ? await this.openPanel(ext, cmd.panel, { command: cmd.id, args })
        : await this.host.runCommand(ext, cmd.id, args, this.hidden).finally(() => this.render());
      return { ok: true, text: `Ran ${ext.name}: ${cmd.title}.`, data: { result: (result ?? null) as unknown } };
    } catch (err) {
      return { ok: false, text: `${ext.name}: ${cmd.title} did not run: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  agentList(): ExtReply {
    const rows = this.list.map((e) => ({ id: e.id, name: e.name, version: e.version, source: e.source, state: e.state === 'refused' ? 'refused' : this.host.isGranted(e) ? 'ready' : 'needs-permission', reason: e.reason || undefined, permissions: e.permissions, commands: e.commands.map((c) => ({ id: c.id, title: c.title })) }));
    const text = rows.length ? rows.map((r) => `${r.id} ${r.version} · ${r.name} · ${r.source} · ${r.state}${r.reason ? ` (${r.reason})` : ''}${r.commands.length ? ` · commands: ${r.commands.map((c) => c.id).join(', ')}` : ''}`).join('\n') : 'No extensions are installed for formpdf.';
    return { ok: true, text, data: { extensions: rows } };
  }

  private doc(): DocNow {
    const s = this.w.bench().state();
    if (!s) throw refused('No PDF is open in formpdf');
    return s;
  }

  private async summary(): Promise<Record<string, unknown>> {
    const s = this.w.bench().state();
    if (!s) return { open: false };
    const { id: _i, name: _n, key: _k, path: _p, protected: _pr, savePath: _s, ...info } = await pdfApi.info(s.id) as unknown as Record<string, unknown>;
    return { open: true, id: s.id, key: s.key, name: s.name, path: s.path, pages: s.pages, page: s.page, tab: s.tab, dirty: s.dirty, info };
  }

  private async read(params: { what?: string; pages?: string }): Promise<unknown> {
    const what = params.what ?? 'summary';
    if (what === 'summary') return this.summary();
    const s = this.doc();
    if (what === 'text') return pdfApi.text(s.id, typeof params.pages === 'string' ? params.pages : undefined);
    if (what === 'fields') return pdfApi.fields(s.id);
    if (what === 'comments') return pdfApi.comments(s.id);
    if (what === 'selection') return { page: s.page, tab: s.tab, pages: s.pages };
    if (what === 'file') {
      const blob = await (await fetch(pdfApi.fileUrl(s.id))).blob();
      if (blob.size > OPEN_MAX) throw refused('The files are larger than 200 MB together');
      return { name: s.name, type: 'application/pdf', size: blob.size, data: b64.from(await blob.arrayBuffer()) };
    }
    throw new HostError(ERR.INVALID, 'what is summary, text, fields, comments, selection or file');
  }

  private async apply(ext: ExtensionRecord, label: string, ops: { command: string; args?: unknown }[]): Promise<{ applied: number; results: unknown[] }> {
    const h = toolHost, d = h?.doc();
    if (!h || !d) throw refused('No PDF is open in formpdf');
    let out: { applied: number; results: unknown[]; id: string; pages: number } | null = null;
    let failed: unknown = null;
    const name = label.slice(0, 80) || ext.name;
    await h.ctx.run(name, async () => {
      try {
        const id = (await h.ctx.flush()) ?? d.id;
        out = await api.post<{ applied: number; results: unknown[]; id: string; pages: number }>('/api/extensions/apply', { doc: id, ops, by: ext.name });
        await h.ctx.commit({ id: out.id, pages: out.pages, bytes: 0 }, name);
      } catch (err) { failed = err; }
    });
    if (failed || !out) throw refused(failed instanceof Error ? failed.message : 'formpdf did not make the change');
    return out;
  }

  private async engineActions(): Promise<ActionRow[]> {
    this.actions ??= (await api.get<{ actions: ActionRow[] }>('/api/pdf/actions')).actions;
    return this.actions;
  }

  private async catalogue(): Promise<unknown[]> {
    const win = this.w.catalogue().list().filter((e) => !e.id.startsWith('ext-')).map((e) => ({ id: e.id, title: e.label, kind: 'window', ...(Object.keys(e.params).length ? { args: e.params } : {}) }));
    const acts = (await this.engineActions()).filter((a) => a.kind !== 'export' && !KEPT_OUT.has(a.name)).map((a) => ({ id: a.name, title: a.label, kind: a.kind, ...(a.fields.length ? { args: Object.fromEntries(a.fields.map((f) => [f.name, { type: f.type, description: f.hint }])) } : {}) }));
    return [...win, ...acts];
  }

  private async run(ext: ExtensionRecord, command: string, args: unknown): Promise<unknown> {
    const a = (await this.engineActions()).find((x) => x.name === command);
    const params = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
    if (a) {
      if (a.kind === 'export' || KEPT_OUT.has(a.name)) throw refused(`${a.label} is not available to extensions`);
      if (a.kind === 'change') return this.apply(ext, a.label, [{ command, args: params }]);
      try { return await api.post('/api/extensions/read', { doc: this.doc().id, action: command, args: params }); } catch (err) { throw refused(err instanceof Error ? err.message : String(err)); }
    }
    if (command.startsWith('ext-')) throw refused('Extensions cannot run other extensions\' commands');
    const r = await this.w.catalogue().run(command, params);
    if (!r.ok) throw refused(r.error ?? `${command} did not run`);
    return r.result ?? null;
  }

  private pick(accept: string[], multiple: boolean): Promise<{ name: string; type: string; size: number; data: string }[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept.filter((x) => /^(\.[a-z0-9]{1,12}|[a-z]+\/[a-z0-9.+*-]+)$/i.test(x)).join(',');
      input.multiple = multiple;
      input.addEventListener('cancel', () => reject(new HostError(ERR.CANCELLED, 'No file was chosen')));
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        if (!files.length) { reject(new HostError(ERR.CANCELLED, 'No file was chosen')); return; }
        if (files.reduce((n, f) => n + f.size, 0) > OPEN_MAX) { reject(refused('The files are larger than 200 MB together')); return; }
        resolve(await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, data: b64.from(await f.arrayBuffer()) }))));
      };
      input.click();
    });
  }

  docSync(): void {
    const s = this.w.bench().state();
    const sig = s ? `${s.id}|${s.dirty}|${s.pages}` : '';
    if (sig !== this.docSig) {
      this.docSig = sig;
      if (this.open.size) void this.summary().then((d) => this.host.broadcast('document.changed', d), () => undefined);
    }
    this.viewSync();
  }

  private viewSync(): void {
    const s = this.w.bench().state();
    const sig = s ? `${s.page}|${s.tab}` : '';
    if (sig === this.viewSig) return;
    this.viewSig = sig;
    if (s && this.open.size) this.host.broadcast('selection.changed', { page: s.page, tab: s.tab, pages: s.pages });
  }
}
