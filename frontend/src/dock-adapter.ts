import type { ConsentChoice, ConsentRequest, DockAdapter, DockAgentStatus, DockChannel, DockErrorKind, DockKind, DockLegacy, DockState, DockTerminal, PtyKind, StoredChoice, StoredChoiceState } from './dock/adapter';
import { api } from './io/api';
import { keyHeaders, windowKey } from './io/window-key';
import type { LiveClient } from './live/socket';
import { ChatPane } from './ui/chat-pane';
import { isMac } from './ui/dom';

export const DOCK_KEY = 'formpdf.dock';
export const DOCK_OLD_KEYS = ['fs-dock-h', 'fs-dock-last'];
export const CONSENT_WAITING = 'formpdf.consentWaiting';
export const DOCK_SIZES = { minHeight: 160, maxHeightShare: 0.75, defaultHeight: 300, minWidth: 320, maxWidthShare: 0.6, defaultWidth: 440 };
const mod = isMac ? 'Cmd' : 'Ctrl';
const NOTES = [
  'Agents edit live: the open PDF switches to each result as it happens, and files they write are named in their answer.',
  'Every agent turn can be undone at once with Edit, Undo agent turn.',
  'You can turn this off any time in Agents or Preferences.',
];

export class DockError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface DockHooks {
  live: LiveClient;
  context(): string;
  note(): string;
  fail(err: unknown): void;
  page(n: number): void;
  handoff(session: string): void;
  settings(): void;
  layerOpen(): boolean;
  setAccess(mode: string): void;
}

export interface ConsentDesk { arrive(id: string, args: Record<string, unknown>): void; gone(id: string): void }

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...keyHeaders() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) {
    const said = await res.json().catch(() => ({})) as { detail?: unknown };
    throw new DockError(typeof said.detail === 'string' ? said.detail : res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export function errorKind(err: unknown): DockErrorKind | null {
  if (err instanceof TypeError) return 'unreachable';
  if (!(err instanceof DockError)) return null;
  if (err.status === 403) return 'refused';
  if ((err.status === 404 || err.status === 405) && /^(Not Found|Method Not Allowed)$/i.test(err.message)) return 'oldEngine';
  if (/not installed/i.test(err.message)) return 'notInstalled';
  return err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504 ? 'unreachable' : null;
}

export const dockLegacy: DockLegacy = {
  keys: DOCK_OLD_KEYS,
  read: (store) => {
    const out: Partial<DockState> & { seen?: boolean } = { seen: true };
    const h = Number(store.getItem('fs-dock-h'));
    const last = store.getItem('fs-dock-last');
    if (Number.isFinite(h) && h >= DOCK_SIZES.minHeight) out.h = Math.round(h);
    if (last === 'chat' || last === 'shell' || last === 'claude') out.tab = last;
    return out;
  },
};

export function isDockCombo(e: KeyboardEvent): boolean {
  return (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.code === 'KeyJ';
}

function record(raw: { id: string; title: string; alive?: boolean; kind?: string }): DockTerminal {
  const kind = raw.kind === 'claude' || raw.kind === 'codex' || raw.kind === 'cursor' ? raw.kind : 'shell';
  return { id: raw.id, title: raw.title, alive: raw.alive !== false, kind: kind as PtyKind };
}

function channel(id: string): DockChannel {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}/api/terminal/${encodeURIComponent(id)}`);
  const held: string[] = [];
  let data = (_chunk: string | Uint8Array): void => undefined;
  let exit = (): void => undefined;
  let closed = (): void => undefined;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'key', key: windowKey(), control: 'binary' }));
    for (const text of held.splice(0)) socket.send(text);
  });
  socket.addEventListener('message', (msg) => {
    if (typeof msg.data === 'string') { data(msg.data); return; }
    try {
      const said = JSON.parse(new TextDecoder().decode(msg.data as ArrayBuffer)) as { type?: string; alive?: boolean };
      if (said.type === 'exit' || (said.type === 'hello' && said.alive === false)) exit();
    } catch { return; }
  });
  socket.addEventListener('close', () => closed());
  const send = (text: string): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
    else if (socket.readyState === WebSocket.CONNECTING) held.push(text);
  };
  return {
    send: (chunk) => send(JSON.stringify({ type: 'input', data: chunk })),
    resize: (cols, rows) => send(JSON.stringify({ type: 'resize', cols, rows })),
    onData: (handler) => { data = handler; },
    onExit: (handler) => { exit = handler; },
    onClose: (handler) => { closed = handler; },
    close: () => socket.close(),
  };
}

function request(id: string, args: Record<string, unknown>): ConsentRequest {
  const offered = Array.isArray(args.answers) ? args.answers.filter((x): x is ConsentChoice => x === 'deny' || x === 'once' || x === 'always') : [];
  const expires = Number(args.expiresAt);
  return {
    id,
    agent: typeof args.agent === 'string' && args.agent !== 'agent' ? args.agent : '',
    what: typeof args.what === 'string' && args.what ? args.what : 'change PDFs and write files for you',
    offers: offered.length ? offered : ['deny', 'always'],
    always: args.alwaysCovers === 'agent' ? 'agent' : 'all',
    escape: 'deny',
    notes: NOTES,
    ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
  };
}

export function formpdfDock(o: DockHooks): { adapter: DockAdapter; desk: ConsentDesk } {
  const open = new Map<string, ConsentRequest>();
  const early: ConsentRequest[] = [];
  let add: ((r: ConsentRequest) => void) | null = null;
  let withdraw: ((id: string) => void) | null = null;
  const keep = (): void => { try { sessionStorage.setItem(CONSENT_WAITING, JSON.stringify([...open.values()])); } catch { return; } };
  const show = (r: ConsentRequest): void => {
    if (open.has(r.id)) return;
    open.set(r.id, r);
    keep();
    if (add) add(r); else early.push(r);
  };
  const kept = (): ConsentRequest[] => {
    try {
      const list: unknown = JSON.parse(sessionStorage.getItem(CONSENT_WAITING) ?? '[]');
      return Array.isArray(list) ? (list as ConsentRequest[]).filter((r) => typeof r?.id === 'string' && typeof r.expires === 'number' && r.expires > Date.now()) : [];
    } catch { return []; }
  };
  const desk: ConsentDesk = {
    arrive: (id, args) => show(request(id, args)),
    gone: (id) => { if (open.delete(id)) { keep(); withdraw?.(id); } },
  };
  const adapter: DockAdapter = {
    words: {
      app: 'formpdf', noun: 'PDF', example: 'find and redact every phone number', start: './formpdf boot',
      lead: "Ask Claude about the open PDF in the line below: summarise it, find and redact, fill a form, fix headers, prepare it for print. It works through formpdf's tools, every change shows in the window, and each turn can be undone.",
    },
    strings: {
      terminal: 'Agent dock',
      resize: 'Resize the agent dock',
      terminals: 'Terminals and chat',
      newTerminal: 'New terminal',
      chatAbout: `Chat with Claude about the open PDF (Alt+${mod}+J)`,
      hide: 'Hide the agent dock',
      hideTitle: 'Hide the agent dock ({chord}); programs keep running',
      toRight: 'Move the agent dock to the right',
      toBottom: 'Move the agent dock to the bottom',
      empty: 'Nothing is open. Start a shell with the plus button, Claude Code with the agent button, or Chat with the speech bubble.',
      askPlaceholder: 'Ask Claude Code to work on the open PDF',
      chatPlaceholder: 'Ask Claude about the open PDF (Enter to send)',
    },
    placement: { mode: 'own', storage: { key: DOCK_KEY, legacy: dockLegacy }, sizes: DOCK_SIZES },
    isDockChord: (e) => isDockCombo(e) && !e.shiftKey && !e.altKey && !o.layerOpen(),
    chordLabel: () => `${mod}+J`,
    passKey: (e) => isDockCombo(e) && (e.shiftKey || e.altKey),
    tabs: () => ({ builtin: ['chat', 'shell', 'claude', 'codex', 'cursor'] as DockKind[] }),
    classes: { iconButton: 'fs-icon-btn is-sm', button: 'fs-btn fs-btn-sm', primaryButton: 'fs-btn-primary', input: 'fs-input', select: 'fs-input', note: 'fs-note' },
    t: (_key, english) => english,
    onTheme: (handler) => { document.addEventListener('nm:ui-settings-changed', handler); },
    keyHeaders,
    errors: { message: (err) => (err instanceof DockError ? err.message : null), kind: errorKind },
    terminal: {
      list: async () => (await call<{ terminals: Array<{ id: string; title: string; alive?: boolean; kind?: string }> }>('GET', '/api/terminals')).terminals.map(record),
      open: async (kind, size) => {
        if (kind === 'shell') return record(await call('POST', '/api/terminals', { cols: size.cols, rows: size.rows }));
        if (kind === 'codex' || kind === 'cursor') return record(await call('POST', '/api/agents/open', { kind, cols: size.cols, rows: size.rows }));
        const extra = size.prompt ? o.context() : '';
        return record(await call('POST', '/api/claude/open', { prompt: size.prompt ? (extra ? `${size.prompt} (${extra})` : size.prompt) : undefined, resume: size.resume || undefined, cols: size.cols, rows: size.rows }));
      },
      restart: async (id) => { await call('POST', `/api/terminals/${encodeURIComponent(id)}/restart`, {}); },
      close: async (id) => { await call('POST', `/api/terminals/${encodeURIComponent(id)}/close`, {}); },
      channel,
      scrollback: 5000,
    },
    agentStatus: async () => {
      const now = await call<DockAgentStatus>('GET', '/api/agents/status');
      const out: DockAgentStatus = {};
      for (const kind of ['claude', 'codex', 'cursor'] as const) {
        const s = now[kind];
        if (s) out[kind] = { installed: s.installed === true, version: s.version ?? null, install: s.install ?? '', signedIn: s.signedIn ?? null };
      }
      return out;
    },
    chat: {
      pane: (host) => {
        const chat = new ChatPane();
        chat.onFail = o.fail;
        chat.onPage = o.page;
        chat.onHandoff = o.handoff;
        chat.context = o.context;
        chat.note = o.note;
        host.appendChild(chat.root);
        return { send: (text) => chat.ask(text), busy: () => chat.isBusy(), shown: () => chat.shown(), hidden: () => chat.hidden(), closed: () => chat.closed() };
      },
      ask: 'line',
    },
    consent: {
      subscribe: (onAdd, onWithdraw) => {
        add = onAdd;
        withdraw = onWithdraw;
        for (const r of early.splice(0)) onAdd(r);
        for (const r of kept()) show(r);
      },
      answer: async (id, choice) => {
        open.delete(id);
        keep();
        const allowed = choice !== 'deny';
        o.live.result(id, {
          content: [{ type: 'text', text: allowed ? 'The person allowed agents to edit PDFs.' : 'The person did not allow agents to edit PDFs for now.' }],
          structuredContent: choice === 'once' ? { allowed: true, once: true } : { allowed },
        });
        if (choice === 'always') o.setAccess('allowed');
      },
    },
    storedChoice: {
      get: async (): Promise<StoredChoiceState> => {
        const s = await api.settings();
        return { value: s.outsideAgents === 'allowed' || s.outsideAgents === 'blocked' ? s.outsideAgents : 'ask', changedOutside: s.sealBroken === true };
      },
      set: async (value: StoredChoice) => { o.setAccess(value); },
    },
    openSettings: o.settings,
  };
  return { adapter, desk };
}
