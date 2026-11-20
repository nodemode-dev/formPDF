import type { Catalogue } from '../automation/catalogue';
import type { Extensions } from '../ext/extensions';
import type { AgentReply, Workbench } from '../pdf/workbench';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const reply = (r: AgentReply): ToolResult => ({ content: [{ type: 'text', text: r.text }], ...(r.data ? { structuredContent: r.data } : {}), ...(r.ok ? {} : { isError: true }) });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class AgentBridge {
  constructor(private readonly h: { bench: () => Workbench; catalogue: () => Catalogue; extensions?: () => Extensions }) {}

  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const wb = this.h.bench();
    const cat = this.h.catalogue();
    if (name === 'list_commands') {
      const list = cat.list(str(args.group) || undefined, str(args.text) || undefined);
      return { content: [{ type: 'text', text: `${list.length} commands.` }], structuredContent: { commands: list } };
    }
    if (name === 'describe_command') {
      const e = cat.describe(str(args.id));
      return e ? { content: [{ type: 'text', text: `${e.id}: ${e.label}` }], structuredContent: { command: e } } : reply({ ok: false, text: `No command ${str(args.id)}; list_commands gives every id.` });
    }
    if (name === 'run_command') {
      const r = await cat.run(str(args.id), (args.params as Record<string, unknown>) ?? {});
      return reply({ ok: r.ok, text: r.ok ? `Ran ${r.label}.` : r.error ?? 'Failed', data: { ...r } });
    }
    if (name === 'run_commands') {
      const steps = Array.isArray(args.steps) ? (args.steps as Array<{ id: string; params?: Record<string, unknown> }>) : [];
      const out = await cat.runMany(steps, args.stopOnError !== false);
      const failed = out.find((r) => !r.ok);
      return reply({ ok: !failed, text: failed ? `Stopped at ${failed.id}: ${failed.error}` : `Ran ${out.length} commands.`, data: { results: out } });
    }
    if (name === 'state') {
      const s = wb.state();
      return { content: [{ type: 'text', text: s ? `${s.name} is open (${s.pages} pages, page ${s.page}).` : 'No PDF is open in the window.' }], structuredContent: { doc: s } };
    }
    if (name === 'open') return reply(await wb.agentOpen(str(args.id)));
    if (name === 'commit') return reply(await wb.agentCommit(str(args.from), str(args.id), str(args.label) || 'Agent change', str(args.turn), str(args.agent) || 'Agent'));
    if (name === 'undo-turn') return reply(await wb.undoAgent());
    if (name === 'saved') { wb.agentSaved(str(args.id)); return reply({ ok: true, text: 'The window knows the PDF was saved.' }); }
    if (name === 'extensions-list' && this.h.extensions) return reply(this.h.extensions().agentList());
    if (name === 'extension-command' && this.h.extensions) return reply(await this.h.extensions().command(str(args.id), str(args.command), args.args ?? {}));
    if (name === 'ai-answer') { window.dispatchEvent(new CustomEvent('fs-ai-answer', { detail: args })); return reply({ ok: true, text: 'The answer is in the Assistant tab.' }); }
    return reply({ ok: false, text: `The window has no tool named ${name}.` });
  }
}
