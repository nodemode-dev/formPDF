import { api } from '../io/api';
import type { Command } from '../ui/commands';
import { Dialog } from '../ui/dialogs';
import { el, patchList, q, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { pdfApi, type Derived } from './api';
import { registerTool, type Tool, type ToolHost } from './tools';

export interface PluginInfo { id: string; name: string; version: string; description: string; author: string; engine: boolean; window: boolean; state: 'on' | 'off' | 'new' | 'changed'; actions: string[]; error: string; folder: string }
interface ActionInfo { name: string; kind: 'read' | 'change' | 'export'; label: string; owner: string; ext: string }

const started = new Set<string>();

class TextDialog extends Dialog {
  private readonly pre: HTMLElement;
  constructor() {
    super('Result', 560);
    this.pre = el('<pre class="fs-plug-out"></pre>');
    this.body.appendChild(this.pre);
    this.button('Close', 'primary', () => this.close());
  }
  show(title: string, text: string): void { this.setTitle(title); setText(this.pre, text); this.open(); }
}
let textDlg: TextDialog | null = null;

async function runAction(host: ToolHost, a: ActionInfo): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.run(a.label, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      if (a.kind === 'change') await host.ctx.commit(await pdfApi.act<Derived>(id, a.name, {}), a.label);
      else if (a.kind === 'export') { const got = await pdfApi.actFile(id, a.name, {}); await host.ctx.deliver(got.blob, got.name); }
      else { const got = await pdfApi.act<{ text?: string }>(id, a.name, {}); (textDlg ??= new TextDialog()).show(a.label, got.text ?? ''); }
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

export async function loadPlugins(): Promise<void> {
  let list: PluginInfo[] = [];
  let acts: ActionInfo[] = [];
  try {
    list = (await api.get<{ plugins: PluginInfo[] }>('/api/plugins')).plugins;
    acts = (await api.get<{ actions: ActionInfo[] }>('/api/pdf/actions')).actions;
  } catch { return; }
  for (const p of list) {
    if (p.state !== 'on' || started.has(p.id)) continue;
    started.add(p.id);
    const mine = acts.filter((a) => a.owner === p.id);
    if (mine.length) {
      registerTool({
        id: `plugin-${p.id}-actions`,
        tab: 'view',
        commands: (host): Command[] => mine.map((a) => ({ id: `plugin-${p.id}-${a.name}`, label: `${a.label} (${p.name})`, words: [a.name, p.name, 'plug-in'], enabled: () => !!host.doc(), run: () => void runAction(host, a) })),
      });
    }
    if (!p.window) continue;
    try {
      const mod = await import(/* @vite-ignore */ `/api/plugins/${encodeURIComponent(p.id)}/window.js`) as { default?: (api: unknown) => void };
      mod.default?.({
        plugin: p,
        registerTool: (t: Tool) => registerTool({ ...t, id: `plugin-${p.id}-${t.id}` }),
        pdfApi, toast, el, q, setText, setDisabled, setHidden, patchList, icon,
      });
    } catch (err) {
      toast(`The plug-in ${p.name} did not start: ${(err as Error).message}`, 'error');
    }
  }
}
