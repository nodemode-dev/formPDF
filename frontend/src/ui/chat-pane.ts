import { api } from '../io/api';
import { events, type EngineEvent } from '../io/events';
import { Dialog } from './dialogs';
import { el, q, setClass, setHidden, setText } from './dom';
import { icon } from './icons';
import { MarkdownStream } from './markdown';

interface Part { kind: 'text' | 'tool'; text?: string; id?: string; name?: string; input?: string; status?: string; pages?: number[]; images?: string[] }
interface Meta { seconds?: number; turns?: number | null; costUsd?: number | null; inputTokens?: number; outputTokens?: number }
interface Message { role: 'user' | 'assistant'; text?: string; note?: string; parts?: Part[]; error?: string; meta?: Meta }
interface Usage { input: number; output: number; costUsd: number; context: number; window: number; model: string }
interface State { busy: boolean; messages: Message[]; turn: number; session: string; usage?: Usage }
interface Listed { id: string; title: string; modified: number; current: boolean }

const BLANK: Usage = { input: 0, output: 0, costUsd: 0, context: 0, window: 0, model: '' };

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

class AdoptDialog extends Dialog {
  private readonly select = el<HTMLSelectElement>('<select class="fs-input" aria-label="Conversation"></select>');
  private readonly go: HTMLButtonElement;
  private resolve: ((v: string | null) => void) | null = null;
  constructor() {
    super('Continue from Claude Code', 480);
    this.body.append(el('<p class="fs-note">Brings a conversation from a Claude Code tab into this chat: its messages show here and your next message continues it.</p>'), this.select);
    this.button('Cancel', 'ghost', () => this.finish(null));
    this.go = this.button('Continue here', 'primary', () => this.finish(this.select.value));
    this.onClose = () => this.finish(null);
  }
  ask(items: Listed[]): Promise<string | null> {
    const when = (t: number): string => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    this.select.replaceChildren(...items.map((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${when(s.modified)} · ${s.title || 'untitled'}${s.current ? ' (this chat)' : ''}`;
      return o;
    }));
    this.open(this.go);
    return new Promise((r) => { this.resolve = r; });
  }
  private finish(v: string | null): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

export class ChatPane {
  readonly root: HTMLElement;
  onFail: (err: unknown) => void = () => undefined;
  onHandoff: (session: string) => void = () => undefined;
  onPage: (page: number) => void = () => undefined;
  private readonly log: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly meter: HTMLElement;
  private reply: HTMLElement | null = null;
  private md: MarkdownStream | null = null;
  private usage: Usage = { ...BLANK };
  private readonly chips = new Map<string, HTMLElement>();
  private busy = false;
  private loaded = false;
  private adoptDlg: AdoptDialog | null = null;

  constructor() {
    this.root = el(`<div class="fs-chat" hidden>
<div class="fs-chat-bar"><span class="fs-chat-status"></span><span class="fs-chat-usage" title="Memory: how much of Claude's working memory this conversation uses. Reply: tokens written so far. Chat: everything sent and written in this conversation."></span><span class="fs-dock-spacer"></span>
<button type="button" class="fs-btn fs-btn-sm fs-btn-ghost fs-chat-stop" hidden>Stop</button>
<button type="button" class="fs-btn fs-btn-sm fs-btn-ghost fs-chat-adopt" title="Bring a conversation you had in a Claude Code tab into this chat">From Claude Code...</button>
<button type="button" class="fs-btn fs-btn-sm fs-btn-ghost fs-chat-handoff" title="Continue this conversation in a Claude Code terminal tab">Open in Claude Code</button>
<button type="button" class="fs-btn fs-btn-sm fs-chat-new">New Chat</button></div>
<div class="fs-chat-log" role="log" aria-live="polite"><p class="fs-chat-empty fs-note">Ask Claude about the open PDF in the line below: summarise it, find and redact, fill a form, fix headers, prepare it for print. It works through formpdf's tools, every change shows in the window, and each turn can be undone.</p></div>
</div>`);
    this.log = q(this.root, '.fs-chat-log');
    this.empty = q(this.root, '.fs-chat-empty');
    this.meter = q(this.root, '.fs-chat-usage');
    q(this.root, '.fs-chat-stop').addEventListener('click', () => void api.post('/api/chat/cancel').catch((e) => this.onFail(e)));
    q(this.root, '.fs-chat-new').addEventListener('click', () => void api.post('/api/chat/reset').catch((e) => this.onFail(e)));
    q(this.root, '.fs-chat-handoff').addEventListener('click', () => void this.handoff());
    q(this.root, '.fs-chat-adopt').addEventListener('click', () => void this.adopt());
    this.log.addEventListener('click', (e) => {
      const page = (e.target as HTMLElement).closest<HTMLElement>('.fs-chat-page');
      if (page?.dataset.page) this.onPage(Number(page.dataset.page));
    });
    events.on('chat.usage', (e) => this.showUsage({ ...this.usage, context: Number(e.context ?? 0), window: Number(e.window ?? 0) || this.usage.window, model: String(e.model ?? this.usage.model) }, Number(e.output ?? 0)));
    events.on('chat.adopted', () => { this.loaded = false; this.clear(); void this.load(); });
    events.on('chat.start', (e) => { this.user(String(e.text ?? ''), String(e.note ?? '')); this.begin(); });
    events.on('chat.delta', (e) => this.delta(String(e.text ?? '')));
    events.on('chat.tool', (e) => this.tool({ kind: 'tool', id: String(e.id ?? ''), name: String(e.name ?? ''), input: String(e.input ?? ''), status: 'running', pages: Array.isArray(e.pages) ? (e.pages as number[]) : [] }));
    events.on('chat.toolDone', (e) => {
      const c = this.chips.get(String(e.id ?? ''));
      if (!c) return;
      this.status(c, String(e.status ?? 'done'));
      if (Array.isArray(e.images) && e.images.length) this.images(c, e.images as string[]);
    });
    events.on('chat.done', (e) => { this.finish(e); if (e.usage) this.showUsage(e.usage as Usage, -1); });
    events.on('chat.reset', () => { this.clear(); this.setBusy(false); this.showUsage({ ...BLANK }, -1); });
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const s = await api.get<State>('/api/chat/state');
      for (const m of s.messages) {
        if (m.role === 'user') { this.user(m.text ?? '', m.note ?? ''); continue; }
        this.begin();
        for (const p of m.parts ?? []) {
          if (p.kind === 'text') this.delta(p.text ?? '');
          else this.tool(p);
        }
        this.close(m.error ?? '', m.meta ?? {});
      }
      if (s.usage) this.showUsage(s.usage, -1);
      if (s.busy) { this.begin(); this.setBusy(true); }
    } catch (err) { this.onFail(err); }
  }

  async send(text: string, context = '', note = ''): Promise<void> {
    try { await api.post('/api/chat/send', { text, context, note }); } catch (err) { this.onFail(err); }
  }

  isBusy(): boolean { return this.busy; }

  private clear(): void {
    for (const n of Array.from(this.log.children)) if (n !== this.empty) n.remove();
    setHidden(this.empty, false);
    this.reply = null;
    this.md = null;
    this.chips.clear();
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    setHidden(q(this.root, '.fs-chat-stop'), !on);
    setText(q(this.root, '.fs-chat-status'), on ? 'Claude is working...' : '');
  }

  private scroll(): void {
    const l = this.log;
    if (l.scrollHeight - l.scrollTop - l.clientHeight < 80) l.scrollTop = l.scrollHeight;
  }

  private user(text: string, note = ''): void {
    setHidden(this.empty, true);
    const n = el('<div class="fs-chat-msg is-user"><span class="fs-chat-said"></span></div>');
    setText(q(n, '.fs-chat-said'), text);
    if (note) { const m = el('<span class="fs-chat-note"></span>'); setText(m, note); n.appendChild(m); }
    this.log.appendChild(n);
    this.scroll();
  }

  private begin(): void {
    setHidden(this.empty, true);
    this.endText();
    this.reply = el('<div class="fs-chat-msg is-claude"></div>');
    this.log.appendChild(this.reply);
    this.setBusy(true);
    this.scroll();
  }

  private delta(text: string): void {
    if (!this.reply) this.begin();
    if (!this.md) { this.md = new MarkdownStream('fs-chat-text fs-md'); this.reply?.appendChild(this.md.root); }
    this.md.push(text);
    this.scroll();
  }

  private endText(): void {
    this.md?.end();
    this.md = null;
  }

  private images(after: HTMLElement, names: string[]): void {
    const row = el('<div class="fs-chat-images"></div>');
    for (const name of names.slice(0, 6)) {
      const img = el<HTMLImageElement>('<img alt="What Claude looked at" decoding="async" draggable="false" width="260" height="180">');
      img.src = `/api/chat/image/${encodeURIComponent(name)}`;
      row.appendChild(img);
    }
    after.after(row);
    this.scroll();
  }

  private showUsage(u: Usage, reply: number): void {
    this.usage = u;
    if (!u.context && !u.input && reply < 0) { setText(this.meter, ''); return; }
    const parts: string[] = [];
    if (u.context) parts.push(`Memory ${tokens(u.context)}${u.window ? ` of ${tokens(u.window)}` : ''}`);
    if (reply >= 0) parts.push(`Reply ${tokens(reply)} tokens`);
    if (u.input || u.output) parts.push(`Chat ${tokens(u.input + u.output)} tokens`);
    setText(this.meter, parts.join(' · '));
    setClass(this.meter, 'is-high', !!u.window && u.context / u.window > 0.8);
  }

  private async handoff(): Promise<void> {
    try {
      const s = await api.get<State>('/api/chat/state');
      if (!s.session) { this.onFail(new Error('Start a conversation here first; then it can continue in Claude Code')); return; }
      if (s.busy) { this.onFail(new Error('Wait for Claude to finish, or press Stop, before moving the conversation')); return; }
      this.onHandoff(s.session);
    } catch (err) { this.onFail(err); }
  }

  private async adopt(): Promise<void> {
    try {
      const r = await api.get<{ sessions: Listed[] }>('/api/chat/sessions');
      if (!r.sessions.length) { this.onFail(new Error('No Claude Code conversation in formpdf yet: open one with the agent button first')); return; }
      this.adoptDlg ??= new AdoptDialog();
      const pick = await this.adoptDlg.ask(r.sessions);
      if (pick) await api.post('/api/chat/adopt', { session: pick });
    } catch (err) { this.onFail(err); }
  }

  private tool(p: Part): void {
    if (!this.reply) this.begin();
    this.endText();
    const chip = el(`<div class="fs-chat-tool"><span class="fs-chat-tool-mark">${icon('terminal', 11)}</span><span class="fs-chat-tool-name"></span><span class="fs-chat-tool-input"></span></div>`);
    setText(q(chip, '.fs-chat-tool-name'), p.name ?? '');
    setText(q(chip, '.fs-chat-tool-input'), p.input ?? '');
    chip.title = p.input ?? '';
    this.status(chip, p.status ?? 'running');
    if (p.id) this.chips.set(p.id, chip);
    this.reply?.appendChild(chip);
    for (const page of (p.pages ?? []).slice(0, 8)) {
      const b = el<HTMLButtonElement>('<button type="button" class="fs-chat-page"></button>');
      b.dataset.page = String(page);
      setText(b, `p. ${page}`);
      chip.appendChild(b);
    }
    if (p.images?.length) this.images(chip, p.images);
    this.scroll();
  }

  private status(chip: HTMLElement, s: string): void {
    for (const k of ['running', 'done', 'error']) setClass(chip, `is-${k}`, s === k);
  }

  private finish(e: EngineEvent): void {
    this.close(String(e.error ?? ''), (e.meta ?? {}) as Meta);
  }

  private close(error: string, meta: Meta): void {
    if (!this.reply) this.begin();
    this.endText();
    for (const c of Array.from(this.reply?.querySelectorAll<HTMLElement>('.fs-chat-tool.is-running') ?? [])) this.status(c, 'done');
    if (error) {
      const n = el('<div class="fs-chat-error"></div>');
      setText(n, error);
      this.reply?.appendChild(n);
    }
    if (meta.seconds !== undefined) {
      const n = el('<div class="fs-chat-meta"></div>');
      const used = meta.inputTokens || meta.outputTokens ? ` · ${tokens((meta.inputTokens ?? 0) + (meta.outputTokens ?? 0))} tokens` : '';
      setText(n, `${meta.seconds} s${meta.turns ? ` · ${meta.turns} steps` : ''}${used}`);
      this.reply?.appendChild(n);
    }
    this.reply = null;
    this.setBusy(false);
    this.scroll();
  }
}
