export interface EngineEvent {
  seq?: number;
  type: string;
  [key: string]: unknown;
}

type Handler = (e: EngineEvent) => void;

export class Events {
  private source: EventSource | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private lastSeq = 0;

  start(): void {
    if (this.source) return;
    const src = new EventSource('/api/events');
    this.source = src;
    src.onmessage = (m) => {
      let e: EngineEvent;
      try { e = JSON.parse(m.data) as EngineEvent; } catch { return; }
      if (e.type === 'hello') { this.emit({ type: this.lastSeq > 0 ? 'resync' : 'hello' }); return; }
      if (typeof e.seq === 'number') this.lastSeq = e.seq;
      this.emit(e);
    };
  }

  on(type: string, fn: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn);
    return () => set?.delete(fn);
  }

  private emit(e: EngineEvent): void {
    for (const fn of this.handlers.get(e.type) ?? []) fn(e);
    for (const fn of this.handlers.get('*') ?? []) fn(e);
  }
}

export const events = new Events();
