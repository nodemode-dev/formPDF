import type { Command } from '../ui/commands';
import { el } from '../ui/dom';
import type { PageTool } from './annotate';
import type { FormBuilder } from './form';
import type { Ctx, Doc, Tab } from './panels';
import type { PageView } from './viewer';

export interface BarChoice { label: string; kind?: 'primary' | 'ghost' | 'danger'; run: () => void }

export interface ToolHost {
  ctx: Ctx;
  forms: FormBuilder;
  doc(): Doc | null;
  setTab(tab: Tab): void;
  useTool(tool: PageTool | null): void;
  activeTool(): PageTool | null;
  bar(text: string, choices: BarChoice[]): void;
  hideBar(): void;
}

export interface Tool {
  id: string;
  tab: Tab;
  title?: string;
  words?: string[];
  section?: (host: ToolHost) => string;
  mount?: (root: HTMLElement, host: ToolHost) => void;
  sync?: (root: HTMLElement, host: ToolHost) => void;
  commands?: (host: ToolHost) => Command[];
  page?: (pv: PageView, host: ToolHost) => void;
  rendered?: (pv: PageView, host: ToolHost) => void;
}

export const TAB_WORDS: Record<Tab, string[]> = {
  view: ['zoom', 'layout', 'two page', 'reading mode', 'read aloud', 'speak', 'properties', 'bookmarks', 'thumbnails'],
  comment: ['annotate', 'highlight', 'underline', 'strike', 'note', 'markup', 'stamp', 'draw', 'shapes', 'reply', 'review'],
  fill: ['sign', 'signature', 'fill form', 'initials', 'date', 'stamp'],
  form: ['form fields', 'fillable', 'checkbox', 'radio', 'dropdown', 'text field'],
  edit: ['header', 'footer', 'bates', 'page numbers', 'watermark', 'crop', 'margins'],
  organize: ['rotate', 'delete pages', 'reorder', 'move pages', 'insert', 'blank page', 'split', 'merge', 'extract pages'],
  extract: ['copy text', 'text', 'markdown', 'tables', 'csv', 'excel', 'pictures', 'images'],
  protect: ['password', 'encrypt', 'redact', 'black out', 'remove text', 'metadata', 'sanitize', 'hidden information', 'permissions'],
  convert: ['word', 'docx', 'powerpoint', 'pptx', 'slides', 'compress', 'reduce size', 'png', 'pictures', 'export'],
  access: ['accessibility', 'a11y', 'screen reader', 'tags', 'reading order', 'alt text', 'alternate text', 'pdf/ua', 'wcag', 'section 508'],
};

const TOOLS: Tool[] = [];
const mounted = new Map<string, HTMLElement>();

export function registerTool(tool: Tool): void {
  if (TOOLS.some((t) => t.id === tool.id)) throw new Error(`duplicate tool: ${tool.id}`);
  TOOLS.push(tool);
}

export function tools(): readonly Tool[] { return TOOLS; }

export function mountTools(panes: HTMLElement, host: ToolHost): Command[] {
  const cmds: Command[] = [];
  for (const t of TOOLS) {
    if (t.section && !mounted.has(t.id)) {
      const pane = panes.querySelector<HTMLElement>(`.fs-pdfwb-pane[data-for="${t.tab}"]`);
      if (pane) {
        const root = el(`<section class="fs-pdfwb-sec" data-section="${t.id}">${t.title ? `<h3 class="fs-pdfwb-sec-title"></h3>` : ''}${t.section(host)}</section>`);
        const head = root.querySelector('.fs-pdfwb-sec-title');
        if (head && t.title) head.textContent = t.title;
        pane.appendChild(root);
        mounted.set(t.id, root);
        t.mount?.(root, host);
      }
    }
    for (const c of t.commands?.(host) ?? []) cmds.push({ ...c, words: [...(c.words ?? []), ...(t.words ?? [])] });
  }
  return cmds;
}

export function pageTools(pv: PageView, host: ToolHost): void {
  for (const t of TOOLS) t.page?.(pv, host);
}

export function renderedTools(pv: PageView, host: ToolHost): void {
  for (const t of TOOLS) t.rendered?.(pv, host);
}

export function syncTools(host: ToolHost): void {
  for (const t of TOOLS) {
    const root = mounted.get(t.id);
    if (root && t.sync) t.sync(root, host);
  }
}
