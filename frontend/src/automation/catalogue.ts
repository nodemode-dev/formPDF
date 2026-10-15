import { api } from '../io/api';
import type { Command, CommandParam, Commands } from '../ui/commands';

export interface CatalogueEntry {
  id: string;
  label: string;
  group: string;
  description: string;
  when: string;
  keys: string[];
  params: Record<string, CommandParam>;
  mutates: boolean;
  risky: boolean;
  enabled: boolean;
  why: string;
  checked?: boolean;
}

export interface RunResult { ok: boolean; id: string; label?: string; result?: unknown; error?: string; risky?: boolean }

const GROUPS: Array<[RegExp, string]> = [
  [/^pdf-(open|create|scan|save|print|close|home)/, 'File'],
  [/^pdf-(undo|redo|find)/, 'Edit'],
  [/^pdf-(layout|cover|reading|zoom|fit|rotate|compare|go-page)/, 'View'],
  [/^pdf-tab-/, 'Tabs'],
  [/^(view-agent|view-new-terminal|agent-)/, 'Agents'],
  [/^tool-/, 'Tools'],
  [/^home-/, 'Home'],
];
const MUTATES = new Set(['pdf-save', 'pdf-undo', 'pdf-redo', 'pdf-undo-agent']);
const RISKY = new Set(['pdf-save', 'pdf-close', 'pdf-home', 'pdf-undo-agent']);
const WINDOW_ONLY = new Set(['view-agent-dock', 'agent-claude-code', 'agent-chat', 'view-new-terminal', 'pdf-palette']);

const groupOf = (c: Command): string => c.group ?? GROUPS.find(([re]) => re.test(c.id))?.[1] ?? 'Help';

function typed(name: string, spec: CommandParam, v: unknown): string | null {
  const t = spec.type;
  if (t === 'integer' && !(typeof v === 'number' && Number.isInteger(v))) return `${name} must be a whole number`;
  if (t === 'number' && typeof v !== 'number') return `${name} must be a number`;
  if (t === 'string' && typeof v !== 'string') return `${name} must be text`;
  if (t === 'boolean' && typeof v !== 'boolean') return `${name} must be true or false`;
  if (t === 'array' && !Array.isArray(v)) return `${name} must be a list`;
  if (t === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) return `${name} must be an object`;
  if (spec.enum && !spec.enum.includes(v as string | number)) return `${name} must be one of ${spec.enum.join(', ')}`;
  if (typeof v === 'number' && spec.min !== undefined && v < spec.min) return `${name} must be at least ${spec.min}`;
  if (typeof v === 'number' && spec.max !== undefined && v > spec.max) return `${name} must be at most ${spec.max}`;
  return null;
}

export class Catalogue {
  private timer = 0;

  constructor(private readonly reg: () => Commands, private readonly extra: () => Command[] = () => []) {}

  private commands(): Command[] {
    const seen = new Set<string>();
    const out: Command[] = [];
    for (const c of [...this.reg().all(), ...this.extra()]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }

  private find(id: string): Command | undefined {
    return this.reg().get(id) ?? this.extra().find((c) => c.id === id);
  }

  private enabled(c: Command): boolean {
    return this.reg().get(c.id) ? this.reg().enabled(c) : (c.enabled ? c.enabled() : true);
  }

  entry(c: Command): CatalogueEntry {
    const label = typeof c.label === 'function' ? c.label() : c.label;
    const on = this.enabled(c);
    return {
      id: c.id, label, group: groupOf(c), description: c.description ?? label, when: c.when ?? '', keys: [...(c.keys ?? [])],
      params: c.params ?? {}, mutates: c.mutates ?? MUTATES.has(c.id), risky: c.risky ?? RISKY.has(c.id), enabled: on,
      why: on ? '' : (c.why?.() ?? 'Not available right now'), ...(c.checked ? { checked: c.checked() } : {}),
    };
  }

  list(group?: string, text?: string): CatalogueEntry[] {
    const g = group?.trim().toLowerCase();
    const words = (text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return this.commands().filter((c) => !WINDOW_ONLY.has(c.id)).map((c) => this.entry(c)).filter((e) => {
      if (g && e.group.toLowerCase() !== g) return false;
      const hay = `${e.id} ${e.label} ${e.description} ${e.when} ${(this.find(e.id)?.words ?? []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  describe(id: string): CatalogueEntry | null {
    const c = this.find(id);
    return c && !WINDOW_ONLY.has(id) ? this.entry(c) : null;
  }

  async run(id: string, params: Record<string, unknown> = {}): Promise<RunResult> {
    const c = this.find(id);
    if (!c || WINDOW_ONLY.has(id)) {
      const near = this.list(undefined, id.replace(/[-_.]/g, ' ')).slice(0, 5).map((e) => e.id);
      return { ok: false, id, error: `No command ${id}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} list_commands gives every id.` };
    }
    const e = this.entry(c);
    if (!e.enabled) return { ok: false, id, label: e.label, error: `${e.label} is not available right now: ${e.why}.` };
    for (const [name, spec] of Object.entries(e.params)) {
      if (params[name] === undefined) { if (spec.required) return { ok: false, id, error: `${id} needs ${name} (${spec.type}${spec.description ? `: ${spec.description}` : ''}).` }; continue; }
      const bad = typed(name, spec, params[name]);
      if (bad) return { ok: false, id, error: `${id}: ${bad}.` };
    }
    try {
      const out = this.reg().get(id) ? await this.reg().call(id, params) : { ran: true, result: await c.run(params) };
      if (!out.ran) return { ok: false, id, label: e.label, error: `${e.label} did not run; it may have become unavailable.` };
      return { ok: true, id, label: e.label, result: out.result ?? null, risky: e.risky };
    } catch (err) {
      return { ok: false, id, label: e.label, error: `${e.label} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async runMany(steps: Array<{ id: string; params?: Record<string, unknown> }>, stopOnError = true): Promise<RunResult[]> {
    const out: RunResult[] = [];
    for (const s of steps) {
      const r = await this.run(s.id, s.params ?? {});
      out.push(r);
      if (!r.ok && stopOnError) break;
    }
    return out;
  }

  mirror(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const entries = this.commands().filter((c) => !WINDOW_ONLY.has(c.id)).map((c) => this.entry(c));
      void api.post('/api/commands/catalogue', { commands: entries }).catch(() => undefined);
    }, 400);
  }
}
