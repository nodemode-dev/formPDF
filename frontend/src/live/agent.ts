import type { AgentReply, Workbench } from '../pdf/workbench';
import { Dialog } from '../ui/dialogs';
import { el, setText } from '../ui/dom';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const reply = (r: AgentReply): ToolResult => ({ content: [{ type: 'text', text: r.text }], ...(r.data ? { structuredContent: r.data } : {}), ...(r.ok ? {} : { isError: true }) });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

class Consent extends Dialog {
  private readonly lead = el('<p class="fs-note"></p>');
  private readonly allowBtn: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;
  constructor() {
    super('Allow agents to edit?', 460);
    this.body.append(
      this.lead,
      el('<p class="fs-note">Agents edit live: the open PDF switches to each result as it happens, and files they write are named in their answer.</p>'),
      el('<p class="fs-note">Every agent turn can be undone at once with Edit, Undo agent turn.</p>'),
      el('<p class="fs-note">You can turn this off any time in Agents or Preferences.</p>'),
    );
    this.button('Not now', 'ghost', () => this.finish(false));
    this.allowBtn = this.button('Allow', 'primary', () => this.finish(true));
    this.onClose = () => this.finish(false);
  }
  ask(agent: string): Promise<boolean> {
    this.setTitle(`Allow ${agent} to edit your PDFs?`);
    setText(this.lead, `${agent} is connected to formpdf and asks to change PDFs and write files for you.`);
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

export class AgentBridge {
  private consentAsk: Promise<boolean> | null = null;
  private consentDlg: Consent | null = null;

  constructor(private readonly h: { bench: () => Workbench; allow: () => void }) {}

  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const wb = this.h.bench();
    if (name === 'consent') {
      const agent = str(args.agent) || 'An agent';
      this.consentAsk ??= this.ask(agent).finally(() => { this.consentAsk = null; });
      const allowed = await this.consentAsk;
      return { content: [{ type: 'text', text: allowed ? 'The person allowed agents to edit PDFs.' : 'The person did not allow agents to edit PDFs for now.' }], structuredContent: { allowed } };
    }
    if (name === 'state') {
      const s = wb.state();
      return { content: [{ type: 'text', text: s ? `${s.name} is open (${s.pages} pages, page ${s.page}).` : 'No PDF is open in the window.' }], structuredContent: { doc: s } };
    }
    if (name === 'open') return reply(await wb.agentOpen(str(args.id)));
    if (name === 'commit') return reply(await wb.agentCommit(str(args.from), str(args.id), str(args.label) || 'Agent change', str(args.turn), str(args.agent) || 'Agent'));
    if (name === 'undo-turn') return reply(await wb.undoAgent());
    if (name === 'saved') { wb.agentSaved(str(args.id)); return reply({ ok: true, text: 'The window knows the PDF was saved.' }); }
    if (name === 'ai-answer') { window.dispatchEvent(new CustomEvent('fs-ai-answer', { detail: args })); return reply({ ok: true, text: 'The answer is in the Assistant tab.' }); }
    return reply({ ok: false, text: `The window has no tool named ${name}.` });
  }

  private async ask(agent: string): Promise<boolean> {
    this.consentDlg ??= new Consent();
    const yes = await this.consentDlg.ask(agent);
    if (yes) this.h.allow();
    return yes;
  }
}
