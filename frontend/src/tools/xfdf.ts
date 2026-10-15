import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

const stem = (name: string): string => name.replace(/\.pdf$/i, '');

async function exportXfdf(host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.run('Exporting comments', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const got = await pdfApi.actFile(id, 'export_xfdf', { name: d.name });
      await host.ctx.deliver(got.blob, `${stem(d.name)}.xfdf`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

type Imported = Derived & { comments?: number; replies?: number; skipped?: number; duplicates?: number; statuses?: number; outside?: number };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function said(res: Imported): string {
  const n = res.comments ?? 0, r = res.replies ?? 0, st = res.statuses ?? 0, dup = res.duplicates ?? 0, out = res.outside ?? 0;
  const left = Math.max(0, (res.skipped ?? 0) - dup);
  const parts = [`Brought in ${plural(n, 'comment', 'comments')} and ${plural(r, 'reply', 'replies')}`];
  if (st) parts.push(`updated the status of ${plural(st, 'comment', 'comments')}`);
  if (dup) parts.push(`recognised ${plural(dup, 'comment', 'comments')} already here under another name`);
  if (left) parts.push(`left out ${left} already here or unreadable`);
  if (out) parts.push(`${out} on other pages were not imported`);
  return `${parts.join('; ')}.`;
}

async function importData(host: ToolHost, data: string, label: string, pages: string): Promise<Imported | null> {
  const d = host.doc();
  if (!d) throw new Error('Open a PDF first');
  let out: Imported | null = null;
  await host.ctx.run('Importing comments', async () => {
    const id = await host.ctx.flush() ?? d.id;
    const res = await pdfApi.act<Imported>(id, 'import_xfdf', { data, ...(pages.trim() ? { pages: pages.trim() } : {}) });
    await host.ctx.commit(res, `Import comments from ${label}`);
    out = res;
  });
  return out;
}

function importXfdf(host: ToolHost, root: HTMLElement | null): void {
  const d = host.doc();
  if (!d) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xfdf,application/vnd.adobe.xfdf,application/xml,text/xml';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error('The XFDF file is larger than 20 MB');
        const pages = root?.querySelector<HTMLInputElement>('[data-x="pages"]')?.value ?? '';
        const res = await importData(host, await file.text(), file.name, pages);
        if (res) toast(said(res));
      } catch (err) { toast((err as Error).message, 'error'); }
    })();
  };
  input.click();
}

async function exportChanges(host: ToolHost): Promise<Record<string, unknown> | null> {
  const d = host.doc();
  if (!d) throw new Error('Open a PDF first');
  let out: Record<string, unknown> | null = null;
  await host.ctx.run('Exporting text changes', async () => {
    const id = await host.ctx.flush() ?? d.id;
    const got = await pdfApi.actFile(id, 'export_changes', { name: d.name });
    const body = JSON.parse(await got.blob.text()) as { changes: Array<{ type: string }> };
    await host.ctx.deliver(got.blob, `${stem(d.name)}-changes.json`);
    const n = body.changes.length;
    out = { changes: n, file: `${stem(d.name)}-changes.json` };
    toast(n ? `Saved ${plural(n, 'change', 'changes')} for the layout app.` : 'There are no text changes or notes on text to export; the file lists none.');
  });
  return out;
}

registerTool({
  id: 'xfdf',
  tab: 'comment',
  title: 'Share comments',
  words: ['xfdf', 'fdf', 'export comments', 'import comments', 'review', 'merge comments'],
  section: () => `<p class="fs-note fs-tool-note">Exchange comments with other copies of this PDF, in formpdf, Acrobat or other readers, as an XFDF file. Importing adds only comments this PDF does not have yet, recognises ones it already has even under another name, and takes the reviewer's status (accepted, completed and so on) for the ones it has.</p>
<div class="fs-prop-row"><span class="fs-prop-label">Pages</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-x="pages" placeholder="All pages, or 2-5" spellcheck="false" aria-label="Pages to import comments for"></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-x="export">${icon('download', 14)}Export comments</button><button class="fs-btn fs-btn-sm" type="button" data-x="import">${icon('upload', 14)}Import comments…</button></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-x="changes">${icon('download', 14)}Export text changes (JSON)</button></div>
<p class="fs-note">Text changes lists struck-out, replaced and inserted text, and notes on text, each with the words around it, so a layout app or script can apply them to the source document. Highlights and underlines move with their words when you edit the page text.</p>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-x]');
      if (!b || b.disabled) return;
      if (b.dataset.x === 'export') void exportXfdf(host);
      else if (b.dataset.x === 'import') importXfdf(host, root);
      else if (b.dataset.x === 'changes') void exportChanges(host).catch((err) => toast((err as Error).message, 'error'));
    });
  },
  sync: (root, host) => {
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-x]'))) {
      const off = !host.doc();
      if (b.disabled !== off) b.disabled = off;
    }
  },
  commands: (host) => [
    { id: 'tool-xfdf-export', label: 'Export comments (XFDF)', words: ['xfdf', 'share review'], enabled: () => !!host.doc(), run: () => void exportXfdf(host) },
    { id: 'tool-xfdf-import', label: 'Import comments (XFDF)…', words: ['xfdf', 'merge review', 'sync status'], group: 'Comment', when: 'Use to bring a reviewer\'s comments and their status (accepted, completed, rejected) back into this PDF; give the XFDF text as data, or leave it out to ask the person for a file.', params: { data: { type: 'string', description: 'the XFDF file text; a file picker opens when left out' }, pages: { type: 'string', description: 'only comments on these pages, such as 2-5' } }, mutates: true, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: async (p) => { if (typeof p?.data !== 'string') { importXfdf(host, null); return null; } const res = await importData(host, p.data, 'an agent', typeof p.pages === 'string' ? p.pages : ''); return res ? { said: said(res), comments: res.comments, replies: res.replies, statuses: res.statuses, duplicates: res.duplicates } : null; } },
    { id: 'tool-changes-export', label: 'Export text changes (JSON)', words: ['change list', 'indesign', 'corrections', 'text edits', 'proof'], group: 'Comment', when: 'Use to hand struck-out, replaced and inserted text to a layout app as a JSON change list with the surrounding words.', enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: () => exportChanges(host) },
  ],
});
