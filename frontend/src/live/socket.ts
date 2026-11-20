import { windowKey } from '../io/window-key';

type ToolHandler =(name: string, args: Record<string, unknown>) => Promise<unknown>;

export class LiveClient {
  connected = false;
  agents = false;
  onTool: ToolHandler | null = null;
  onStatus: ((connected: boolean) => void) | null = null;
  onConsent: ((id: string, args: Record<string, unknown>) => void) | null = null;
  onWithdrawn: ((id: string) => void) | null = null;
  private readonly held: Array<Record<string, unknown>> = [];
  private ws: WebSocket | null = null;
  private retry = 0;
  private doc: unknown = null;

  constructor(private readonly name = 'window') {}

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/live`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.raw({ t: 'hello', kind: 'window', name: this.name, agents: this.agents, key: windowKey() });
      this.raw({ t: 'doc', doc: this.doc });
      for (const msg of this.held.splice(0)) this.raw(msg);
      this.onStatus?.(true);
    };
    ws.onmessage = (ev) => { try { void this.handle(JSON.parse(String(ev.data)) as Record<string, unknown>); } catch { return; } };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      window.setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.retry++));
    };
  }

  private raw(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setAgents(on: boolean): void {
    this.agents = on;
    this.raw({ t: 'hello', kind: 'window', name: this.name, agents: on, key: windowKey() });
  }

  setDoc(doc: unknown): void {
    this.doc = doc;
    this.raw({ t: 'doc', doc });
  }

  result(id: string, result: unknown): void {
    const msg = { t: 'toolResult', id, result };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.held.push(msg);
  }

  private async handle(m: Record<string, unknown>): Promise<void> {
    if (m.t === 'consentWithdrawn') { this.onWithdrawn?.(String(m.id)); return; }
    if (m.t !== 'tool') return;
    if (m.name === 'consent' && this.onConsent) { this.onConsent(String(m.id), (m.args as Record<string, unknown>) ?? {}); return; }
    let result: unknown;
    try {
      result = this.onTool ? await this.onTool(String(m.name), (m.args as Record<string, unknown>) ?? {}) : { content: [{ type: 'text', text: 'formpdf has no window tools ready.' }], isError: true };
    } catch (e) {
      result = { content: [{ type: 'text', text: `The window could not run ${String(m.name)}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    this.raw({ t: 'toolResult', id: m.id, result });
  }
}
