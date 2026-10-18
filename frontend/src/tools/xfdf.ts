import { pdfApi, Quiet, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import type { Command } from '../ui/commands';

const stem = (name: string): string => name.replace(/\.pdf$/i, '');

async function exportXfdf(host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) return;
  await host.ctx.deliver(async () => {
    const got = await host.ctx.run('Exporting comments', async () => (await pdfApi.actFile(await host.ctx.flush() ?? d.id, 'export_xfdf', { name: d.name })).blob);
    if (!got) throw new Quiet();
    return got;
  }, `${stem(d.name)}.xfdf`);
}

type Imported = Derived & { comments?: number; replies?: number; skipped?: number; duplicates?: number; statuses?: number; outside?: number };

/** Each part is a whole phrase with only the number as a value, so the window can translate the parts one by one. */
function said(res: Imported): string {
  const n = res.comments ?? 0, r = res.replies ?? 0, st = res.statuses ?? 0, dup = res.duplicates ?? 0, out = res.outside ?? 0;
  const left = Math.max(0, (res.skipped ?? 0) - dup);
  const parts = [n === 1 ? `${n} comment brought in` : `${n} comments brought in`, r === 1 ? `${r} reply brought in` : `${r} replies brought in`];
  if (st) parts.push(st === 1 ? `${st} comment's status updated` : `${st} comments' status updated`);
  if (dup) parts.push(dup === 1 ? `${dup} comment already here under another name` : `${dup} comments already here under another name`);
  if (left) parts.push(`${left} left out as already here or unreadable`);
  if (out) parts.push(out === 1 ? `${out} on another page not imported` : `${out} on other pages not imported`);
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

type Carried = Imported & { followed?: number; in_place?: number; left_out?: number };

/** Whole phrases with only the counts as values, joined, so the window translates each part on its own. */
function carriedSaid(res: Carried): string {
  const f = res.followed ?? 0, k = res.in_place ?? 0, o = res.left_out ?? 0, r = res.replies ?? 0;
  const parts = [f === 1 ? `${f} comment moved with its words` : `${f} comments moved with their words`];
  if (k) parts.push(k === 1 ? `${k} comment kept where it was` : `${k} comments kept where they were`);
  if (r) parts.push(r === 1 ? `${r} reply carried` : `${r} replies carried`);
  if (o) parts.push(o === 1 ? `${o} comment on a page this version does not have` : `${o} comments on pages this version does not have`);
  return `${parts.join('; ')}.`;
}

/** Comments from the reviewed version of this PDF, moved to where their words are in this one (a new PDF from the layout app). */
async function carryFrom(host: ToolHost, source: { path?: string; file?: File }): Promise<Carried | null> {
  const d = host.doc();
  if (!d) throw new Error('Open a PDF first');
  let out: Carried | null = null;
  let failed: Error | null = null;
  await host.ctx.run('Carrying comments', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      let args: Record<string, unknown>;
      let label = source.path ? source.path.split(/[\\/]/).pop() ?? source.path : '';
      if (source.file) {
        const other = await pdfApi.open(source.file, source.file.name);
        if (other.info.locked) throw new Error(`${source.file.name} is password protected. Open it here and unlock it first.`);
        args = { from_doc: other.id };
        label = source.file.name;
      } else args = { from: source.path };
      const res = await pdfApi.act<Carried>(id, 'carry_comments', args);
      await host.ctx.commit(res, `Carry comments from ${label}`);
      out = res;
    } catch (err) { failed = err as Error; throw err; }
  });
  if (failed) throw failed;
  return out;
}

function pickCarry(host: ToolHost): void {
  if (!host.doc()) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,application/pdf';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    void carryFrom(host, { file }).then((res) => { if (res) toast(carriedSaid(res)); }).catch((err: Error) => toast(err.message, 'error'));
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
    toast(n ? (n === 1 ? `Saved ${n} change for the layout app.` : `Saved ${n} changes for the layout app.`) : 'There are no text changes or notes on text to export; the file lists none.');
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
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-x="carry">${icon('upload', 14)}Carry comments from the reviewed version…</button></div>
<p class="fs-note">For a new PDF of the same document, such as one exported again from the layout app: each comment from the reviewed PDF moves to where its words are now, to another page if they moved there, with its replies and status. Comments not near any text stay where they were.</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-x="changes">${icon('download', 14)}Export text changes (JSON)</button></div>
<p class="fs-note">Text changes lists struck-out, replaced and inserted text, and notes on text, each with the words around it, so a layout app or script can apply them to the source document. Highlights and underlines move with their words when you edit the page text.</p>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-x]');
      if (!b || b.disabled) return;
      if (b.dataset.x === 'export') void exportXfdf(host);
      else if (b.dataset.x === 'import') importXfdf(host, root);
      else if (b.dataset.x === 'carry') pickCarry(host);
      else if (b.dataset.x === 'changes') void exportChanges(host).catch((err) => toast((err as Error).message, 'error'));
    });
  },
  sync: (root, host) => {
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-x]'))) {
      const off = !host.doc();
      if (b.disabled !== off) b.disabled = off;
    }
  },
  commands: (host): Command[] => [
    { id: 'tool-xfdf-export', label: 'Export comments (XFDF)', words: ['xfdf', 'share review'], enabled: () => !!host.doc(), run: () => void exportXfdf(host) },
    { id: 'tool-xfdf-import', label: 'Import comments (XFDF)…', words: ['xfdf', 'merge review', 'sync status'], group: 'Comment', when: 'Use to bring a reviewer\'s comments and their status (accepted, completed, rejected) back into this PDF; give the XFDF text as data, or leave it out to ask the person for a file.', params: { data: { type: 'string', description: 'the XFDF file text; a file picker opens when left out' }, pages: { type: 'string', description: 'only comments on these pages, such as 2-5' } }, mutates: true, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: async (p) => { if (typeof p?.data !== 'string') { importXfdf(host, null); return null; } const res = await importData(host, p.data, 'an agent', typeof p.pages === 'string' ? p.pages : ''); return res ? { said: said(res), comments: res.comments, replies: res.replies, statuses: res.statuses, duplicates: res.duplicates } : null; } },
    { id: 'tool-carry-comments', label: 'Carry comments from the reviewed version…', words: ['carry comments', 'new version', 'transfer comments', 'layout app', 'migrate review'], group: 'Comment', when: 'Use when this PDF is a new version of a reviewed one (exported again from the layout app) and the reviewer\'s comments should move onto it, following their words; give from, the reviewed PDF\'s path, or leave it out to ask the person for the file.', params: { from: { type: 'string', description: 'path of the reviewed PDF; a file picker opens when left out' } }, mutates: true, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: async (p) => { if (typeof p?.from !== 'string') { pickCarry(host); return null; } const res = await carryFrom(host, { path: p.from }); if (res) toast(carriedSaid(res)); return res ? { said: carriedSaid(res), followed: res.followed, in_place: res.in_place, left_out: res.left_out, replies: res.replies } : null; } },
    { id: 'tool-changes-export', label: 'Export text changes (JSON)', words: ['change list', 'indesign', 'corrections', 'text edits', 'proof'], group: 'Comment', when: 'Use to hand struck-out, replaced and inserted text to a layout app as a JSON change list with the surrounding words.', enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: () => exportChanges(host) },
  ],
});
