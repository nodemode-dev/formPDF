import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { api } from '../io/api';
import { events } from '../io/events';
import { ChatPane } from './chat-pane';
import { el, escapeHtml, isMac, q, setDisabled, setHidden, setText } from './dom';
import { icon } from './icons';

export interface TermInfo { id: string; title: string; kind?: string; alive?: boolean }

interface Tab {
  id: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  tab: HTMLElement;
  socket: WebSocket | null;
  kind: string;
}

const HEIGHT_KEY = 'fs-dock-h';
const LAST_KEY = 'fs-dock-last';
const MIN_H = 160;
const mod = isMac ? 'Cmd' : 'Ctrl';

function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function isDockCombo(e: KeyboardEvent): boolean {
  return (isMac ? e.metaKey : e.ctrlKey) && e.code === 'KeyJ';
}

function storedHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_H ? v : 300;
  } catch {
    return 300;
  }
}

type DockKind = 'claude' | 'shell' | 'chat';

function lastKind(): DockKind | null {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return v === 'claude' || v === 'shell' || v === 'chat' ? v : null;
  } catch {
    return null;
  }
}

function rememberKind(kind: DockKind): void {
  try { localStorage.setItem(LAST_KEY, kind); } catch { return; }
}

export class TerminalDock {
  readonly root: HTMLElement;
  onFail: (err: unknown) => void = () => undefined;
  onPage: (page: number) => void = () => undefined;
  context: () => string = () => '';
  note: () => string = () => '';
  private readonly tabsEl: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly ask: HTMLInputElement;
  private readonly tabs = new Map<string, Tab>();
  private active: string | null = null;
  private chatPane: ChatPane | null = null;
  private chatTab: HTMLElement | null = null;
  private height = storedHeight();
  private ensured = false;

  constructor() {
    this.root = el(`<section class="fs-dock" aria-label="Agent dock" hidden>
<div class="fs-dock-rsz" role="separator" aria-orientation="horizontal" aria-label="Resize the agent dock"></div>
<div class="fs-dock-head">
<div class="fs-dock-tabs" role="tablist" aria-label="Terminals and chat"></div>
<span class="fs-dock-spacer"></span>
<button type="button" class="fs-icon-btn is-sm fs-dock-new" title="New terminal" aria-label="New terminal">${icon('plus', 15)}</button>
<button type="button" class="fs-icon-btn is-sm fs-dock-chat" title="Chat with Claude about the open PDF (Alt+${mod}+J)" aria-label="Chat">${icon('agentChat', 15)}</button>
<button type="button" class="fs-icon-btn is-sm fs-dock-claude" title="Claude Code (Shift+${mod}+J)" aria-label="Claude Code">${icon('agent', 15)}</button>
<button type="button" class="fs-icon-btn is-sm fs-dock-restart" title="Restart this tab" aria-label="Restart this tab">${icon('refresh', 15)}</button>
<button type="button" class="fs-icon-btn is-sm fs-dock-hide" title="Hide the agent dock (${mod}+J); programs keep running" aria-label="Hide the agent dock">${icon('close', 15)}</button>
</div>
<div class="fs-dock-stage"><p class="fs-dock-empty fs-note" hidden>Nothing is open. Start a shell with the plus button, Claude Code with the agent button, or Chat with the speech bubble.</p></div>
<form class="fs-dock-ask" autocomplete="off">
<span class="fs-dock-ask-mark">${icon('agent', 15)}</span>
<input class="fs-input fs-dock-ask-input" type="text" spellcheck="false" placeholder="Ask Claude Code to work on the open PDF" aria-label="Ask Claude Code">
<button type="submit" class="fs-icon-btn is-sm" title="Send" aria-label="Send">${icon('send', 14)}</button>
</form>
</section>`);
    this.tabsEl = q(this.root, '.fs-dock-tabs');
    this.stage = q(this.root, '.fs-dock-stage');
    this.empty = q(this.root, '.fs-dock-empty');
    this.ask = q<HTMLInputElement>(this.root, '.fs-dock-ask-input');
    q(this.root, '.fs-dock-new').addEventListener('click', () => void this.open());
    q(this.root, '.fs-dock-claude').addEventListener('click', () => void this.claude());
    q(this.root, '.fs-dock-chat').addEventListener('click', () => void this.showChat());
    q(this.root, '.fs-dock-restart').addEventListener('click', () => void this.restart());
    q(this.root, '.fs-dock-hide').addEventListener('click', () => this.setOpen(false));
    q(this.root, '.fs-dock-ask').addEventListener('submit', (e) => { e.preventDefault(); void this.send(); });
    this.root.addEventListener('keydown', (e) => { if (!isDockCombo(e)) e.stopPropagation(); });
    this.resizer(q(this.root, '.fs-dock-rsz'));
    new ResizeObserver(() => this.fitActive()).observe(this.stage);
    events.on('terminal.exited', (e) => {
      const info = e.terminal as TermInfo | undefined;
      const t = info ? this.tabs.get(info.id) : undefined;
      if (t) t.tab.classList.add('is-exited');
    });
    events.on('terminal.restarted', (e) => {
      const info = e.terminal as TermInfo | undefined;
      const t = info ? this.tabs.get(info.id) : undefined;
      if (t) t.tab.classList.remove('is-exited');
    });
    events.on('terminal.opened', (e) => {
      const info = e.terminal as TermInfo | undefined;
      if (info && this.ensured && !this.tabs.has(info.id)) this.mount(info, false);
    });
    document.body.appendChild(this.root);
    this.applyHeight();
  }

  get isOpen(): boolean { return !this.root.hidden; }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.applyHeight();
    setHidden(this.root, !open);
    document.documentElement.classList.toggle('is-dock-open', open);
    if (open) void this.ensure();
  }

  async toggle(): Promise<void> {
    this.setOpen(!this.isOpen);
  }

  private applyHeight(): void {
    const max = Math.max(MIN_H, Math.round(window.innerHeight * 0.75));
    const h = Math.min(max, Math.max(MIN_H, this.height));
    document.documentElement.style.setProperty('--fs-dock-h', `${h}px`);
  }

  private resizer(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      const startY = e.clientY;
      const startH = this.root.getBoundingClientRect().height;
      const move = (ev: PointerEvent): void => { this.height = startH + (startY - ev.clientY); this.applyHeight(); };
      const up = (): void => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try { localStorage.setItem(HEIGHT_KEY, String(Math.round(this.height))); } catch { return; }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  async ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = true;
      const listed = await api.get<{ terminals: TermInfo[] }>('/api/terminals').catch(() => ({ terminals: [] as TermInfo[] }));
      for (const t of listed.terminals) if (!this.tabs.has(t.id)) this.mount(t, false);
    }
    if (!this.tabs.size && !this.chatTab) await this.openFresh();
    else if (!this.active) this.select([...this.tabs.keys()][0] ?? 'chat');
    else this.fitActive();
    this.focus();
  }

  private async openFresh(): Promise<void> {
    const last = lastKind();
    if (last === 'chat') { await this.showChat(); return; }
    const installed = last === 'shell' ? false : await api.get<{ installed?: boolean }>('/api/claude/status').then((s) => !!s.installed, () => false);
    if (installed) await this.claude();
    else await this.terminal();
  }

  async terminal(): Promise<void> {
    const shell = [...this.tabs.values()].find((t) => t.kind !== 'claude');
    if (!shell) { await this.open(); return; }
    this.setOpenQuiet();
    this.select(shell.id);
    rememberKind('shell');
  }

  async chat(): Promise<void> {
    await this.showChat();
  }

  focus(): void {
    if (this.active === 'chat') this.ask.focus();
    else if (this.active) this.tabs.get(this.active)?.term.focus();
  }

  async showChat(): Promise<void> {
    this.setOpenQuiet();
    if (!this.chatPane) {
      const chat = new ChatPane();
      chat.onFail = (err) => this.onFail(err);
      chat.onHandoff = (session) => void this.claude(undefined, session);
      chat.onPage = (p) => this.onPage(p);
      this.chatPane = chat;
      this.stage.appendChild(chat.root);
    }
    if (!this.chatTab) {
      const tab = el(`<button type="button" class="fs-dock-tab is-chat" role="tab" aria-selected="false">${icon('agentChat', 13)}<span class="fs-dock-tab-title">Chat</span><span class="fs-dock-tab-x" role="button" aria-label="Close the Chat tab">${icon('close', 11)}</span></button>`);
      tab.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.fs-dock-tab-x')) this.closeChat();
        else this.select('chat');
      });
      this.tabsEl.prepend(tab);
      this.chatTab = tab;
    }
    setHidden(this.empty, true);
    this.select('chat');
    rememberKind('chat');
    await this.chatPane.load();
  }

  private setOpenQuiet(): void {
    if (this.isOpen) return;
    this.applyHeight();
    setHidden(this.root, false);
    document.documentElement.classList.add('is-dock-open');
  }

  private closeChat(): void {
    this.chatTab?.remove();
    this.chatTab = null;
    if (this.chatPane) setHidden(this.chatPane.root, true);
    if (this.active === 'chat') {
      this.active = null;
      const next = [...this.tabs.keys()].pop();
      if (next) this.select(next);
      else setHidden(this.empty, false);
    }
    this.syncAsk();
  }

  private syncAsk(): void {
    this.ask.placeholder = this.active === 'chat' ? 'Ask Claude about the open PDF (Enter to send)' : 'Ask Claude Code to work on the open PDF';
  }

  async open(): Promise<void> {
    this.setOpenQuiet();
    try {
      const info = await api.post<TermInfo>('/api/terminals', { cols: 100, rows: 20 });
      if (!this.tabs.has(info.id)) this.mount(info, true);
      else this.select(info.id);
      rememberKind('shell');
    } catch (err) { this.onFail(err); }
  }

  async claude(prompt?: string, resume?: string): Promise<void> {
    this.setOpenQuiet();
    const size = this.size();
    try {
      const info = await api.post<TermInfo>('/api/claude/open', { prompt: prompt || undefined, cols: size.cols, rows: size.rows, resume: resume || undefined });
      if (this.tabs.has(info.id)) this.select(info.id);
      else this.mount(info, true);
      rememberKind('claude');
    } catch (err) { this.onFail(err); }
  }

  private async send(): Promise<void> {
    const text = this.ask.value.trim();
    if (!text) return;
    const extra = this.context();
    if (this.active === 'chat' && this.chatPane?.isBusy()) return;
    this.ask.value = '';
    if (this.active === 'chat' && this.chatPane) await this.chatPane.send(text, extra, this.note());
    else await this.claude(extra ? `${text} (${extra})` : text);
  }

  private size(): { cols: number; rows: number } {
    const t = this.active ? this.tabs.get(this.active) : null;
    return t ? { cols: t.term.cols, rows: t.term.rows } : { cols: 100, rows: 20 };
  }

  private theme() {
    return {
      background: token('--surface-0', '#111111'),
      foreground: token('--text-primary', '#f7f7f7'),
      cursor: token('--accent-color', '#f97316'),
      cursorAccent: token('--surface-0', '#111111'),
      selectionBackground: token('--accent-color-dim', '#f9731633'),
    };
  }

  private mount(info: TermInfo, show: boolean): void {
    const kind = info.kind ?? 'shell';
    const term = new Terminal({
      fontFamily: token('--font-mono', 'monospace'), fontSize: 12, lineHeight: 1.2, cursorBlink: true,
      scrollback: 5000, allowProposedApi: false, theme: this.theme(), overviewRuler: { width: 0 },
    });
    term.attachCustomKeyEventHandler((e) => !isDockCombo(e));
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = el(`<div class="fs-term" data-id="${escapeHtml(info.id)}" hidden></div>`);
    const tab = el(`<button type="button" class="fs-dock-tab${kind === 'claude' ? ' is-claude' : ''}${info.alive === false ? ' is-exited' : ''}" role="tab" aria-selected="false">${icon(kind === 'claude' ? 'agent' : 'terminal', 13)}<span class="fs-dock-tab-title"></span><span class="fs-dock-tab-x" role="button" aria-label="Close this tab">${icon('close', 11)}</span></button>`);
    setText(q(tab, '.fs-dock-tab-title'), info.title);
    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.fs-dock-tab-x')) void this.close(info.id);
      else this.select(info.id);
    });
    this.stage.appendChild(host);
    this.tabsEl.appendChild(tab);
    const t: Tab = { id: info.id, term, fit, host, tab, socket: null, kind };
    this.tabs.set(info.id, t);
    setHidden(this.empty, true);
    term.open(host);
    if (show || !this.active) this.select(info.id);
    this.connect(t);
  }

  private connect(t: Tab): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/api/terminal/${encodeURIComponent(t.id)}`);
    t.socket = socket;
    socket.addEventListener('open', () => this.sendSize(t));
    socket.addEventListener('message', (msg) => {
      const data = String(msg.data);
      if (data === '{"type": "exit"}') {
        t.term.write(`\r\n\x1b[2m[${t.kind === 'claude' ? 'Claude Code' : 'shell'} exited · Restart runs it again]\x1b[0m\r\n`);
        return;
      }
      t.term.write(data);
    });
    t.term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
  }

  private sendSize(t: Tab): void {
    if (t.socket?.readyState === WebSocket.OPEN) t.socket.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
  }

  fitActive(): void {
    const t = this.active ? this.tabs.get(this.active) : null;
    if (!t || t.host.hidden || this.stage.clientHeight < 20) return;
    const before = `${t.term.cols}x${t.term.rows}`;
    t.fit.fit();
    if (`${t.term.cols}x${t.term.rows}` !== before) this.sendSize(t);
  }

  private select(id: string): void {
    this.active = id;
    for (const [tid, t] of this.tabs) {
      const on = tid === id;
      setHidden(t.host, !on);
      t.tab.classList.toggle('is-on', on);
      t.tab.setAttribute('aria-selected', String(on));
    }
    if (this.chatPane) setHidden(this.chatPane.root, id !== 'chat');
    if (this.chatTab) { this.chatTab.classList.toggle('is-on', id === 'chat'); this.chatTab.setAttribute('aria-selected', String(id === 'chat')); }
    this.syncAsk();
    setDisabled(q<HTMLButtonElement>(this.root, '.fs-dock-restart'), id === 'chat');
    this.fitActive();
    this.focus();
  }

  private async restart(): Promise<void> {
    const t = this.active ? this.tabs.get(this.active) : null;
    if (!t) return;
    try {
      await api.post(`/api/terminals/${encodeURIComponent(t.id)}/restart`);
      this.sendSize(t);
      t.term.focus();
    } catch (err) { this.onFail(err); }
  }

  private async close(id: string): Promise<void> {
    const t = this.tabs.get(id);
    if (!t) return;
    t.socket?.close();
    t.term.dispose();
    t.host.remove();
    t.tab.remove();
    this.tabs.delete(id);
    await api.post(`/api/terminals/${encodeURIComponent(id)}/close`).catch(() => undefined);
    if (this.active === id) {
      this.active = null;
      const next = [...this.tabs.keys()].pop() ?? (this.chatTab ? 'chat' : undefined);
      if (next) this.select(next);
      else setDisabled(q<HTMLButtonElement>(this.root, '.fs-dock-restart'), true);
    }
    setHidden(this.empty, this.tabs.size > 0 || !!this.chatTab);
  }
}
