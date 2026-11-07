export type Permission = 'document' | 'files-read' | 'files-write' | 'network' | 'models' | 'native-code';
export type Source = 'catalogue' | 'sideload' | 'development';

export interface PanelDef {
  id: string;
  title: string;
  location?: 'dock' | 'dialog';
}

export interface CommandDef {
  id: string;
  title: string;
  panel?: string;
}

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  source: Source;
  permissions: Permission[];
  base: string;
  entryUi: string;
  panels: PanelDef[];
  commands: CommandDef[];
  description?: string;
  path?: string;
  state: 'ready' | 'refused';
  reason?: string;
}

export interface Theme {
  mode: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface HostHandlers {
  product: string;
  app: string;
  appVersion: string;
  locale?: () => string;
  theme: () => Theme;
  notify: (ext: ExtensionRecord, message: string, level: string) => void;
  setTitle?: (ext: ExtensionRecord, frame: HTMLIFrameElement, title: string) => void;
  readDocument?: (ext: ExtensionRecord, params: { what?: string }) => unknown | Promise<unknown>;
  applyDocument?: (ext: ExtensionRecord, label: string, ops: { command: string; args?: unknown }[]) => Promise<{ applied: number; results: unknown[] }>;
  commands?: (ext: ExtensionRecord) => unknown[] | Promise<unknown[]>;
  run?: (ext: ExtensionRecord, command: string, args: unknown) => unknown | Promise<unknown>;
  openFiles?: (ext: ExtensionRecord, accept: string[], multiple: boolean) => Promise<{ name: string; type: string; size: number; data: string }[]>;
  saveFile?: (ext: ExtensionRecord, name: string, type: string, data: string) => Promise<{ saved: boolean; name: string }>;
  fetch?: (ext: ExtensionRecord, req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  consent: (ext: ExtensionRecord) => Promise<boolean>;
  storage?: { get: (ext: ExtensionRecord, key: string) => unknown; set: (ext: ExtensionRecord, key: string, value: unknown) => void };
}

export class HostError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export const ERR = { NOT_FOUND: -32601, INVALID: -32602, PERMISSION: -32001, CANCELLED: -32002, UNAVAILABLE: -32003, REFUSED: -32004 } as const;

const NEEDS: Record<string, Permission | null> = {
  'host.hello': null,
  'ui.notify': null,
  'ui.resize': null,
  'ui.setTitle': null,
  'storage.get': null,
  'storage.set': null,
  'ext.done': null,
  'document.read': 'document',
  'document.apply': 'document',
  'app.commands': 'document',
  'app.run': 'document',
  'files.open': 'files-read',
  'files.save': 'files-write',
  'net.fetch': 'network',
};

const STORAGE_CAP = 256 * 1024;
const GRANTS_KEY = 'formext.grants';

function grantKey(ext: ExtensionRecord) {
  return `${ext.id}@${ext.version}#${[...ext.permissions].sort().join(',')}`;
}

function readGrants(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GRANTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeGrants(grants: Record<string, boolean>) {
  try {
    localStorage.setItem(GRANTS_KEY, JSON.stringify(grants));
  } catch {
    return;
  }
}

function localStore(): NonNullable<HostHandlers['storage']> {
  const key = (ext: ExtensionRecord) => `formext.store.${ext.id}`;
  const load = (ext: ExtensionRecord): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(key(ext)) ?? '{}');
    } catch {
      return {};
    }
  };
  return {
    get: (ext, k) => load(ext)[k] ?? null,
    set: (ext, k, v) => {
      const all = load(ext);
      if (v === null || v === undefined) delete all[k];
      else all[k] = v;
      const text = JSON.stringify(all);
      if (text.length > STORAGE_CAP) throw new HostError(ERR.REFUSED, 'this extension has used its 256 KB of storage');
      try {
        localStorage.setItem(key(ext), text);
      } catch {
        throw new HostError(ERR.UNAVAILABLE, 'storage is not available');
      }
    },
  };
}

export interface Frame {
  ext: ExtensionRecord;
  frame: HTMLIFrameElement;
  activate: (activation: { reason: 'panel' | 'command'; panel?: string; command?: string; args?: unknown }) => Promise<unknown>;
  send: (method: string, params?: unknown) => Promise<unknown>;
  dispose: () => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number };

export interface MountOptions {
  hidden?: boolean;
  onDone?: (result: unknown) => void;
  onResize?: (h: number) => void;
  onRequest?: (method: string, phase: 'start' | 'end') => void;
}

const PAUSING = new Set(['files.open', 'files.save', 'app.run', 'document.apply', 'net.fetch']);
const HEADLESS_IDLE_MS = 120_000;

export class ExtensionHost {
  private frames = new Set<Frame>();
  private storage: NonNullable<HostHandlers['storage']>;

  constructor(private handlers: HostHandlers) {
    this.storage = handlers.storage ?? localStore();
  }

  isGranted(ext: ExtensionRecord) {
    return ext.permissions.length === 0 || readGrants()[grantKey(ext)] === true;
  }

  async ensureConsent(ext: ExtensionRecord) {
    if (this.isGranted(ext)) return true;
    const ok = await this.handlers.consent(ext);
    if (ok) {
      const grants = readGrants();
      grants[grantKey(ext)] = true;
      writeGrants(grants);
    }
    return ok;
  }

  revoke(ext: ExtensionRecord) {
    const grants = readGrants();
    delete grants[grantKey(ext)];
    writeGrants(grants);
  }

  async open(ext: ExtensionRecord, container: HTMLElement, opts: MountOptions = {}): Promise<Frame | null> {
    if (!(await this.ensureConsent(ext))) return null;
    return this.mount(ext, container, opts);
  }

  mount(ext: ExtensionRecord, container: HTMLElement, opts: MountOptions = {}): Frame {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', ext.name);
    frame.className = 'formext-frame';
    if (opts.hidden) {
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    }
    const pending = new Map<number, Pending>();
    let seq = 0;
    let ready: () => void = () => undefined;
    const loaded = new Promise<void>((resolve) => (ready = resolve));
    const post = (body: Record<string, unknown>) => frame.contentWindow?.postMessage({ formext: 1, jsonrpc: '2.0', ...body }, '*');

    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.formext !== 1 || msg.jsonrpc !== '2.0') return;
      if (!msg.method) {
        const waiting = pending.get(msg.id);
        if (!waiting) return;
        pending.delete(msg.id);
        clearTimeout(waiting.timer);
        if (msg.error) waiting.reject(new HostError(msg.error.code, msg.error.message));
        else waiting.resolve(msg.result);
        return;
      }
      if (msg.method === 'host.hello') ready();
      const method = String(msg.method);
      opts.onRequest?.(method, 'start');
      try {
        const result = await this.dispatch(handle, method, msg.params ?? {}, opts);
        if (msg.id !== undefined) post({ id: msg.id, result: result ?? null });
      } catch (err) {
        const e = err as { code?: number; message?: string };
        if (msg.id !== undefined) post({ id: msg.id, error: { code: typeof e.code === 'number' ? e.code : ERR.REFUSED, message: String(e.message ?? err) } });
      } finally {
        opts.onRequest?.(method, 'end');
      }
    };
    window.addEventListener('message', onMessage);

    const send = async (method: string, params: unknown = {}) => {
      await loaded;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new HostError(ERR.UNAVAILABLE, `${ext.name} did not answer ${method}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        post({ id, method, params });
      });
    };

    const handle: Frame = {
      ext,
      frame,
      activate: (activation) => send('ext.activate', activation),
      send,
      dispose: () => {
        window.removeEventListener('message', onMessage);
        for (const w of pending.values()) {
          clearTimeout(w.timer);
          w.reject(new HostError(ERR.CANCELLED, 'closed'));
        }
        pending.clear();
        frame.contentWindow?.postMessage({ formext: 1, jsonrpc: '2.0', method: 'ext.deactivate', params: {} }, '*');
        frame.remove();
        this.frames.delete(handle);
      },
    };
    this.frames.add(handle);
    frame.src = `${ext.base}${ext.entryUi}`;
    container.appendChild(frame);
    return handle;
  }

  async runCommand(ext: ExtensionRecord, commandId: string, args: unknown, container: HTMLElement): Promise<unknown> {
    const command = ext.commands.find((c) => c.id === commandId);
    if (!command) throw new HostError(ERR.NOT_FOUND, `${ext.name} has no command ${commandId}`);
    if (!(await this.ensureConsent(ext))) throw new HostError(ERR.PERMISSION, `${ext.name} was not allowed to run`);
    return new Promise((resolve, reject) => {
      let finished = false;
      let busy = 0;
      let last = Date.now();
      const end = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearInterval(limit);
        frame.dispose();
        fn();
      };
      const frame = this.mount(ext, container, {
        hidden: true,
        onDone: (result) => end(() => resolve(result)),
        onRequest: (method, phase) => {
          if (!PAUSING.has(method)) return;
          busy += phase === 'start' ? 1 : -1;
          last = Date.now();
        },
      });
      const limit = window.setInterval(() => {
        if (busy === 0 && Date.now() - last > HEADLESS_IDLE_MS) end(() => reject(new HostError(ERR.UNAVAILABLE, `${ext.name}: ${command.title} stopped answering for 120 s`)));
      }, 1000);
      frame.activate({ reason: 'command', command: commandId, args }).catch((err) => end(() => reject(err)));
    });
  }

  broadcast(name: string, data: unknown) {
    for (const f of this.frames) f.frame.contentWindow?.postMessage({ formext: 1, jsonrpc: '2.0', method: 'ext.event', params: { name, data } }, '*');
  }

  setTheme(theme: Theme) {
    for (const f of this.frames) f.frame.contentWindow?.postMessage({ formext: 1, jsonrpc: '2.0', method: 'ext.theme', params: theme }, '*');
  }

  disposeExtension(id: string) {
    for (const f of [...this.frames]) if (f.ext.id === id) f.dispose();
  }

  private async dispatch(frame: Frame, method: string, params: any, opts: MountOptions) {
    const ext = frame.ext;
    if (!(method in NEEDS)) throw new HostError(ERR.NOT_FOUND, `${method} is not in API 1`);
    const need = NEEDS[method];
    if (need && (!ext.permissions.includes(need) || !this.isGranted(ext))) throw new HostError(ERR.PERMISSION, `${ext.name} does not have the ${need} permission`);
    const h = this.handlers;
    const missing = () => new HostError(ERR.UNAVAILABLE, `${h.app} does not offer ${method}`);
    switch (method) {
      case 'host.hello':
        return { product: h.product, app: h.app, appVersion: h.appVersion, api: '1', extension: { id: ext.id, version: ext.version, source: ext.source }, permissions: this.isGranted(ext) ? ext.permissions : [], theme: h.theme(), locale: h.locale?.() ?? navigator.language };
      case 'ui.notify':
        if (typeof params.message !== 'string') throw new HostError(ERR.INVALID, 'message must be text');
        h.notify(ext, params.message.slice(0, 400), ['info', 'success', 'warning', 'error'].includes(params.level) ? params.level : 'info');
        return null;
      case 'ui.resize':
        if (typeof params.height === 'number' && params.height > 0) opts.onResize?.(Math.min(params.height, 4000));
        return null;
      case 'ui.setTitle':
        h.setTitle?.(ext, frame.frame, String(params.title ?? '').slice(0, 80));
        return null;
      case 'storage.get':
        return this.storage.get(ext, String(params.key));
      case 'storage.set':
        this.storage.set(ext, String(params.key), params.value);
        return null;
      case 'ext.done':
        opts.onDone?.(params.result);
        return null;
      case 'document.read':
        if (!h.readDocument) throw missing();
        return h.readDocument(ext, params);
      case 'document.apply':
        if (!h.applyDocument) throw missing();
        if (!Array.isArray(params.ops) || params.ops.some((o: any) => typeof o?.command !== 'string')) throw new HostError(ERR.INVALID, 'ops must be a list of { command, args }');
        return h.applyDocument(ext, String(params.label ?? ext.name), params.ops);
      case 'app.commands':
        if (!h.commands) throw missing();
        return h.commands(ext);
      case 'app.run':
        if (!h.run) throw missing();
        if (typeof params.command !== 'string') throw new HostError(ERR.INVALID, 'command must be text');
        return h.run(ext, params.command, params.args ?? {});
      case 'files.open':
        if (!h.openFiles) throw missing();
        return h.openFiles(ext, Array.isArray(params.accept) ? params.accept.map(String) : [], Boolean(params.multiple));
      case 'files.save':
        if (!h.saveFile) throw missing();
        if (typeof params.data !== 'string' || typeof params.name !== 'string') throw new HostError(ERR.INVALID, 'name and data are required');
        return h.saveFile(ext, params.name, String(params.type ?? 'application/octet-stream'), params.data);
      case 'net.fetch':
        if (!h.fetch) throw missing();
        if (typeof params.url !== 'string' || !params.url.startsWith('https://')) throw new HostError(ERR.INVALID, 'only https:// addresses');
        return h.fetch(ext, params);
    }
    throw new HostError(ERR.NOT_FOUND, method);
  }
}

export const PERMISSION_WORDS: Record<Permission, string> = {
  document: 'Read and change the open document',
  'files-read': 'Open files you choose',
  'files-write': 'Save files where you choose',
  network: 'Reach the internet',
  models: 'Use local models',
  'native-code': 'Run native code',
};

export function themeTokens(names: string[] = ['--bg', '--panel', '--text', '--muted', '--accent', '--border', '--radius']): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = style.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  return out;
}
