import { pdfApi, Quiet } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { q } from '../ui/dom';
import { icon } from '../ui/icons';

interface Kind { action: string; ext: string; busy: string }

const KINDS: Record<string, Kind> = {
  html: { action: 'to_html', ext: '.html', busy: 'Saving as a web page' },
  rtf: { action: 'to_rtf', ext: '.rtf', busy: 'Saving as rich text' },
  xlsx: { action: 'to_xlsx', ext: '.xlsx', busy: 'Saving as Excel' },
};

const stem = (name: string): string => name.replace(/\.pdf$/i, '');

async function save(root: HTMLElement, host: ToolHost, kind: string): Promise<void> {
  const d = host.doc();
  const k = KINDS[kind];
  if (!d || !k) return;
  const body: Record<string, unknown> = { pages: q<HTMLInputElement>(root, '[data-t="pages"]').value.trim() || undefined };
  if (kind === 'xlsx') body.tables_only = q<HTMLInputElement>(root, '[data-t="tables"]').checked;
  else body.pictures = q<HTMLInputElement>(root, '[data-t="pictures"]').checked;
  await host.ctx.deliver(async () => {
    const got = await host.ctx.run(k.busy, async () => (await pdfApi.actFile(d.id, k.action, body)).blob);
    if (!got) throw new Quiet();
    return got;
  }, `${stem(d.name)}${k.ext}`);
}

const run = (host: ToolHost, kind: string): void => {
  const root = document.querySelector<HTMLElement>('[data-section="exports"]');
  if (root) void save(root, host, kind);
};

registerTool({
  id: 'exports',
  tab: 'convert',
  title: 'Web page, rich text and Excel',
  words: ['html', 'web page', 'rtf', 'rich text', 'excel', 'xlsx', 'spreadsheet'],
  section: () => `<p class="fs-note">Headings, paragraphs, lists and tables in reading order. Running headers and footers are left out, columns are read one after the other, and Excel gets one sheet per page with table numbers as real numbers.</p>
<div class="fs-prop-row"><span class="fs-prop-label">Pages</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-t="pages" placeholder="All pages"></div></div>
<label class="fs-check"><input type="checkbox" data-t="pictures" checked>Pictures in the web page and RTF</label>
<label class="fs-check"><input type="checkbox" data-t="tables">Excel: tables only</label>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-t="html">${icon('fileCode', 14)}Save as HTML</button><button class="fs-btn fs-btn-sm" type="button" data-t="rtf">${icon('fileText', 14)}Save as RTF</button><button class="fs-btn fs-btn-sm" type="button" data-t="xlsx">${icon('fileSheet', 14)}Save as Excel</button></div>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button[data-t]');
      if (t && KINDS[t.dataset.t ?? '']) void save(root, host, t.dataset.t ?? '');
    });
  },
  commands: (host) => [
    { id: 'tool-export-html', label: 'Save as HTML', words: ['web page'], enabled: () => !!host.doc(), run: () => run(host, 'html') },
    { id: 'tool-export-rtf', label: 'Save as RTF', words: ['rich text', 'wordpad'], enabled: () => !!host.doc(), run: () => run(host, 'rtf') },
    { id: 'tool-export-xlsx', label: 'Save as Excel', words: ['spreadsheet', 'xlsx'], enabled: () => !!host.doc(), run: () => run(host, 'xlsx') },
  ],
});
