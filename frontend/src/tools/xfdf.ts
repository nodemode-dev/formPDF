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

function importXfdf(host: ToolHost): void {
  const d = host.doc();
  if (!d) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xfdf,application/vnd.adobe.xfdf,application/xml,text/xml';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void host.ctx.run('Importing comments', async () => {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error('The XFDF file is larger than 20 MB');
        const data = await file.text();
        const id = await host.ctx.flush() ?? d.id;
        const res = await pdfApi.act<Derived & { comments?: number; replies?: number; skipped?: number }>(id, 'import_xfdf', { data });
        await host.ctx.commit(res, `Import comments from ${file.name}`);
        const n = res.comments ?? 0, r = res.replies ?? 0, s = res.skipped ?? 0;
        toast(`Brought in ${n} comment${n === 1 ? '' : 's'} and ${r} repl${r === 1 ? 'y' : 'ies'}${s ? `; ${s} already here or unreadable were left out` : ''}.`);
      } catch (err) { toast((err as Error).message, 'error'); }
    });
  };
  input.click();
}

registerTool({
  id: 'xfdf',
  tab: 'comment',
  title: 'Share comments',
  words: ['xfdf', 'fdf', 'export comments', 'import comments', 'review', 'merge comments'],
  section: () => `<p class="fs-note fs-tool-note">Exchange comments with other copies of this PDF, in formpdf, Acrobat or other readers, as an XFDF file. Importing adds only comments this PDF does not have yet, with their replies and status.</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-x="export">${icon('download', 14)}Export comments</button><button class="fs-btn fs-btn-sm" type="button" data-x="import">${icon('upload', 14)}Import comments…</button></div>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest<HTMLElement>('[data-x]')?.dataset.x;
      if (x === 'export') void exportXfdf(host);
      else if (x === 'import') importXfdf(host);
    });
  },
  sync: (root, host) => {
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-x]'))) {
      const off = !host.doc();
      if (b.disabled !== off) b.disabled = off;
    }
  },
  commands: (host) => [
    { id: 'tool-xfdf-export', label: 'Export comments (XFDF)', words: ['xfdf', 'share review'], enabled: () => !!host.doc(), run: () => void exportXfdf(host) },
    { id: 'tool-xfdf-import', label: 'Import comments (XFDF)…', words: ['xfdf', 'merge review'], enabled: () => !!host.doc(), run: () => importXfdf(host) },
  ],
});
