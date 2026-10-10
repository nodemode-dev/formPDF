import { api } from '../io/api';
import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { q, setDisabled, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

type Result = Derived & { recognised?: number; skipped?: number; words?: number; straightened?: number };

let state: { available: boolean; reason: string } | null = null;
let rootEl: HTMLElement | null = null;

function checkReady(): void {
  if (state) return;
  void api.capabilities().then((c) => {
    const o = (c.ocr ?? {}) as { available?: boolean; reason?: string };
    state = { available: !!o.available, reason: o.reason ?? '' };
    sync();
  }).catch(() => { state = { available: false, reason: 'The engine did not answer; try again in a moment.' }; sync(); });
}

function sync(host?: ToolHost): void {
  const root = rootEl;
  if (!root) return;
  const ready = !!state?.available;
  setDisabled(q<HTMLButtonElement>(root, '[data-o="run"]'), !ready || (host ? !host.doc() : false));
  setText(q(root, '[data-o="note"]'), !state ? 'Checking whether text recognition is installed.' : !ready ? state.reason : last || INTRO);
}

const INTRO = 'Recognises the words on scanned pages and adds them as invisible text, so Find, copy, redaction and exports work. It runs on this computer.';
let last = '';

async function recognise(host: ToolHost): Promise<void> {
  const root = rootEl, d = host.doc();
  if (!root || !d || !state?.available) return;
  const body = {
    dpi: Number(q<HTMLSelectElement>(root, '[data-o="dpi"]').value) || 300,
    skip_text: q<HTMLInputElement>(root, '[data-o="skip"]').checked,
    deskew: q<HTMLInputElement>(root, '[data-o="deskew"]').checked,
    redo: q<HTMLInputElement>(root, '[data-o="redo"]').checked,
    pages: q<HTMLInputElement>(root, '[data-o="pages"]').value.trim() || undefined,
  };
  const n = d.info.pages;
  await host.ctx.run(`Recognising text on ${body.pages ? 'the chosen pages' : `${n} page${n === 1 ? '' : 's'}`}, about ${Math.max(5, Math.round(n * 12))} s`, async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Result>(id, 'ocr', body);
      await host.ctx.commit(res, 'Recognise text');
      const n = res.recognised ?? 0;
      const parts = [`${n} page${n === 1 ? '' : 's'} made searchable`, `${res.words ?? 0} words`];
      if (res.straightened) parts.push(`${res.straightened} straightened`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      last = `${parts.join(', ')}.`;
      setText(q(root, '[data-o="note"]'), last);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

registerTool({
  id: 'ocr',
  tab: 'convert',
  title: 'Make searchable (OCR)',
  words: ['ocr', 'recognise text', 'recognize text', 'scanned', 'searchable', 'scan to text', 'straighten'],
  section: () => `<p class="fs-note fs-tool-note" data-o="note">${INTRO}</p>
<div class="fs-prop-row"><span class="fs-prop-label">Resolution</span><div class="fs-prop-ctl"><select class="fs-tool-unit" data-o="dpi" aria-label="Resolution"><option value="200">200 dpi, faster</option><option value="300" selected>300 dpi</option><option value="400">400 dpi, small print</option></select></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Pages</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-o="pages" placeholder="All pages"></div></div>
<label class="fs-check"><input type="checkbox" data-o="skip" checked>Skip pages that already have text</label>
<label class="fs-check"><input type="checkbox" data-o="deskew" checked>Straighten tilted scans</label>
<label class="fs-check"><input type="checkbox" data-o="redo">Recognise again where formpdf already did</label>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-o="run">${icon('find', 14)}Make searchable</button></div>`,
  mount: (root, host) => {
    rootEl = root;
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-o="run"]');
      if (b && !b.disabled) void recognise(host);
    });
    checkReady();
    sync(host);
  },
  sync: (_root, host) => { checkReady(); sync(host); },
  commands: (host) => [
    { id: 'tool-ocr', label: 'Make searchable (OCR)', words: ['recognise text', 'scanned pdf'], enabled: () => !!host.doc() && !!state?.available, run: () => { host.setTab('convert'); void recognise(host); } },
  ],
});
