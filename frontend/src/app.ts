import { api } from './io/api';
import { AgentBridge } from './live/agent';
import { LiveClient } from './live/socket';
import type { CreateKind } from './pdf/intent';
import { ensureWorkbench, openWorkbench, type AppHooks } from './pdf/workbench';
import { agentsDialog, helpDialog, preferencesDialog, shortcutsDialog } from './ui/app-dialogs';
import { comboOf } from './ui/commands';
import { anyDialogOpen, promptName } from './ui/dialogs';
import { revealApp } from './ui/dom';
import { enhanceAllSelects } from './ui/dropdown';
import { Home } from './ui/home';
import { applyTheme } from './ui/themes';
import { toast } from './ui/toast';
import { VERSION } from './version';

export async function startApp(): Promise<void> {
  applyTheme();
  document.title = `formpdf ${VERSION}`;
  const live = new LiveClient(navigator.platform || 'window');
  let agentsAllowed = false;
  const setAgents = (on: boolean): void => {
    agentsAllowed = on;
    live.setAgents(on);
    void api.setSettings({ agentsAllowed: on }).catch(() => undefined);
  };
  const agentHooks = { agentsAllowed: () => agentsAllowed, setAgents };

  const hooks: AppHooks = {
    home: () => home.open(),
    shown: () => home.close(),
    help: () => helpDialog(),
    shortcuts: (cmds) => shortcutsDialog(cmds),
    preferences: () => preferencesDialog(agentHooks),
    agents: () => agentsDialog(agentHooks),
    doc: (state) => live.setDoc(state),
  };
  const bench = ensureWorkbench(hooks);
  const open = (o: { file?: File; path?: string; recent?: string; create?: CreateKind; files?: File[] }): void => { openWorkbench({ ...o, app: hooks }); };

  const home = new Home({
    openFiles: (files) => { if (files[0]) open({ file: files[0] }); },
    openPath: () => void promptName('Open a PDF by path', '', 'Open').then((p) => { if (p) open({ path: p }); }),
    openRecent: (id) => open({ recent: id }),
    create: (kind, files) => open({ create: kind, files }),
    preferences: hooks.preferences,
    agents: hooks.agents,
    help: hooks.help,
  });

  const bridge = new AgentBridge({ bench: () => bench, allow: () => setAgents(true) });
  live.onTool = (name, args) => bridge.run(name, args);
  live.connect();

  window.addEventListener('keydown', (e) => {
    if (bench.isOpen || anyDialogOpen()) return;
    const combo = comboOf(e);
    if (combo === 'Mod+O') { e.preventDefault(); home.root.querySelector<HTMLElement>('[data-a="open"]')?.click(); }
    else if (combo === 'F1') { e.preventDefault(); helpDialog(); }
    else if (combo === 'Mod+/') { e.preventDefault(); shortcutsDialog(bench.commands); }
    else if (combo === 'Mod+,') { e.preventDefault(); hooks.preferences(); }
  });

  const openPaths = (paths: string[]): void => { const p = paths.find((x) => /\.pdf$/i.test(x)); if (p) open({ path: p }); };
  (window as unknown as { __formpdfOpen?: (paths: string[]) => void }).__formpdfOpen = openPaths;

  enhanceAllSelects(document);
  try {
    const settings = await api.settings();
    agentsAllowed = !!settings.agentsAllowed;
    live.setAgents(agentsAllowed);
  } catch { toast('The formpdf engine is not answering yet; retrying.', 'error'); }
  const files = new URLSearchParams(location.search).getAll('open').filter(Boolean);
  home.open();
  if (files.length) {
    history.replaceState(null, '', location.pathname);
    openPaths(files);
  }
  revealApp();
}
