import { api } from './io/api';
import { events } from './io/events';
import { AgentBridge } from './live/agent';
import { LiveClient } from './live/socket';
import type { CreateKind } from './pdf/intent';
import { ensureWorkbench, openWorkbench, type AppHooks, type DocState } from './pdf/workbench';
import './tools';
import { agentsDialog, applyLang, helpDialog, preferencesDialog, shortcutsDialog } from './ui/app-dialogs';
import { Batch } from './ui/batch';
import { comboOf, type Command } from './ui/commands';
import { anyDialogOpen, promptName } from './ui/dialogs';
import { revealApp } from './ui/dom';
import { enhanceAllSelects } from './ui/dropdown';
import { Home } from './ui/home';
import { Palette } from './ui/palette';
import { Reviews } from './ui/reviews';
import { offerResume } from './ui/resume';
import { isDockCombo, TerminalDock } from './ui/terminal-dock';
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
  events.start();
  let docNow: DocState | null = null;
  const dock = new TerminalDock();
  dock.onFail = (err) => toast(err instanceof Error ? err.message : String(err), 'error');
  dock.onPage = (n) => { if (!bench.showPage(n)) toast('Open the PDF in the window to go to that page'); };
  dock.context = () => (docNow ? `formpdf window: ${docNow.name} open, page ${docNow.page} of ${docNow.pages}, ${docNow.tab} tab, doc id ${docNow.id}${docNow.path ? `, file ${docNow.path}` : ''}${docNow.dirty ? ', unsaved changes' : ''}` : 'formpdf window: no PDF open');
  dock.note = () => (docNow ? `with ${docNow.name} open` : '');
  const dockCmds: Command[] = [
    { id: 'view-agent-dock', label: 'Show agent dock and terminal', keys: ['Mod+J'], words: ['terminal', 'shell', 'console', 'dock', 'agent'], run: () => void dock.toggle() },
    { id: 'agent-claude-code', label: 'Claude Code in the dock', keys: ['Shift+Mod+J'], words: ['claude', 'agent', 'ai', 'terminal'], run: () => void dock.claude() },
    { id: 'agent-chat', label: 'Chat with Claude about this PDF', keys: ['Alt+Mod+J'], words: ['claude', 'chat', 'ask', 'ai', 'assistant'], run: () => void dock.showChat() },
    { id: 'view-new-terminal', label: 'New terminal', words: ['shell', 'console', 'bash', 'zsh'], run: () => void dock.open() },
  ];

  const hooks: AppHooks = {
    home: () => home.open(),
    shown: () => home.close(),
    help: () => helpDialog(),
    shortcuts: (cmds) => shortcutsDialog(cmds),
    preferences: () => preferencesDialog(agentHooks),
    agents: () => agentsDialog(agentHooks),
    doc: (state) => { docNow = state; live.setDoc(state); },
    palette: () => palette.show(),
  };
  const homeCmds: Command[] = [
    { id: 'home-open', label: 'Open a PDF…', keys: ['Mod+O'], words: ['file', 'load'], run: () => home.root.querySelector<HTMLElement>('[data-a="open"]')?.click() },
    { id: 'home-path', label: 'Open a PDF by path…', words: ['file', 'location'], run: () => home.root.querySelector<HTMLElement>('[data-a="path"]')?.click() },
    { id: 'home-pictures', label: 'Create PDF from pictures…', words: ['images', 'scan', 'photos', 'jpg', 'png'], run: () => open({ create: 'pictures' }) },
    { id: 'home-merge', label: 'Merge PDFs…', words: ['combine', 'join', 'append'], run: () => open({ create: 'files' }) },
    { id: 'home-scan', label: 'Scan…', words: ['scanner', 'scan to pdf', 'paper', 'feeder'], run: () => open({ scan: true }) },
    { id: 'home-recent', label: 'Recent PDFs', words: ['history', 'last'], run: () => home.show('recent') },
    { id: 'home-batch', label: 'Batch: run an action on many PDFs', words: ['batch', 'many files', 'bulk', 'folder', 'action wizard', 'bates'], run: () => home.show('batch') },
    { id: 'home-reviews', label: 'Reviews: comments across your PDFs', words: ['review tracker', 'track review', 'reviewers', 'comments', 'shared review'], run: () => home.show('reviews') },
    { id: 'home-office', label: 'Create PDF from Office files…', words: ['word', 'docx', 'powerpoint', 'pptx', 'excel', 'xlsx', 'convert to pdf', 'libreoffice'], run: () => open({ create: 'files' }) },
    { id: 'home-help', label: 'formpdf Help', keys: ['F1'], run: () => hooks.help() },
    { id: 'home-shortcuts', label: 'Keyboard shortcuts', keys: ['Mod+/'], run: () => hooks.shortcuts(bench.commands) },
    { id: 'home-prefs', label: 'Preferences…', keys: ['Mod+,'], words: ['settings', 'theme', 'dark', 'light'], run: () => hooks.preferences() },
    { id: 'home-agents', label: 'Agents and MCP…', words: ['claude', 'codex', 'cursor', 'mcp'], run: () => hooks.agents() },
    ...dockCmds,
  ];
  const palette = new Palette({
    commands: () => (bench.isOpen ? bench.commands.all() : [...homeCmds, ...bench.commands.all().filter((c) => !/^pdf-(open|create|help|shortcuts|preferences|agents|palette|home)/.test(c.id))]),
    enabled: (c) => (homeCmds.includes(c) ? true : bench.commands.enabled(c)),
    why: (c) => c.why?.() ?? (bench.hasDoc ? 'Not available right now' : 'Open a PDF first'),
    run: (c) => { if (homeCmds.includes(c)) c.run(); else bench.commands.run(c.id); },
  });
  const bench = ensureWorkbench(hooks);
  bench.commands.add(...dockCmds);
  window.addEventListener('keydown', (e) => {
    if (!isDockCombo(e) || anyDialogOpen()) return;
    const cmd = bench.commands.forCombo(comboOf(e));
    if (!cmd || !dockCmds.includes(cmd)) return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run();
  }, true);
  const open =(o: { file?: File; path?: string; recent?: string; create?: CreateKind; files?: File[]; scan?: boolean; restore?: { page: number; tab: string; dirty: boolean } }): void => { openWorkbench({ ...o, app: hooks }); };

  const home = new Home({
    openFiles: (files) => { if (files[0]) open({ file: files[0] }); },
    openPath: () => void promptName('Open a PDF by path', '', 'Open').then((p) => { if (p) open({ path: p }); }),
    openRecent: (id) => open({ recent: id }),
    create: (kind, files) => open({ create: kind, files }),
    scan: () => open({ scan: true }),
    preferences: hooks.preferences,
    agents: hooks.agents,
    help: hooks.help,
  });

  new Batch(home.root.querySelector<HTMLElement>('[data-page="batch"]') as HTMLElement);
  const reviews = new Reviews(home.root.querySelector<HTMLElement>('[data-page="reviews"]') as HTMLElement, (id) => open({ recent: id, restore: { page: 1, tab: 'comment', dirty: false } }));
  home.onView = (v) => { if (v === 'reviews') void reviews.load(); };

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
    else if (combo === 'Mod+K') { e.preventDefault(); palette.show(); }
  });

  const openPaths = (paths: string[]): void => { const p = paths.find((x) => /\.pdf$/i.test(x)); if (p) open({ path: p }); };
  (window as unknown as { __formpdfOpen?: (paths: string[]) => void }).__formpdfOpen = openPaths;

  enhanceAllSelects(document);
  try {
    const settings = await api.settings();
    agentsAllowed = !!settings.agentsAllowed;
    live.setAgents(agentsAllowed);
    applyLang(typeof settings.spellLang === 'string' ? settings.spellLang : '');
  } catch { toast('The formpdf engine is not answering yet; retrying.', 'error'); }
  const files = new URLSearchParams(location.search).getAll('open').filter(Boolean);
  home.open();
  if (!files.length) void offerResume(home.root.querySelector<HTMLElement>('[data-page="start"] .fs-home-sub') as HTMLElement, (id, restore) => openWorkbench({ recent: id, restore, app: hooks }));
  if (files.length) {
    history.replaceState(null, '', location.pathname);
    openPaths(files);
  }
  revealApp();
}
