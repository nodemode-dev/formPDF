import { pdfApi } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { PageView } from '../pdf/viewer';
import { el, patchList, q, setHidden, setText } from '../ui/dom';
import { toast } from '../ui/toast';
import { PageLayers } from './overlay';

interface Inks { process: string[]; spots: string[]; rgb: boolean }

let hostRef: ToolHost | null = null;
let rootEl: HTMLElement | null = null;
let inks: Inks | null = null;
let inksFor = '';
let loading = '';
const hidden = new Set<string>();
const shots = new Map<string, string>();
const queue: number[] = [];
let working = false;

const hideKey = (): string => Array.from(hidden).sort().join(',');
const shotKey = (doc: string, page: number): string => `${doc}|${page}|${hideKey()}`;

const layers = new PageLayers('output', (index, layer) => {
  const d = hostRef?.doc();
  const url = d && hidden.size ? shots.get(shotKey(d.id, index + 1)) : undefined;
  let img = layer.querySelector<HTMLImageElement>('img');
  if (!url) { if (img) setHidden(img, true); if (d && hidden.size) want(index + 1); return; }
  if (!img) { img = el('<img class="fs-sep-shot" alt="" draggable="false">') as HTMLImageElement; layer.appendChild(img); }
  if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  setHidden(img, false);
});

function want(page: number): void {
  if (!queue.includes(page)) queue.push(page);
  void pump();
}

async function pump(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const page = queue.shift()!;
      const d = hostRef?.doc();
      if (!d || !hidden.size) { queue.length = 0; break; }
      const key = shotKey(d.id, page);
      if (shots.has(key)) continue;
      try {
        const got = await pdfApi.act<{ png: string }>(d.id, 'separation_preview', { page, hide: Array.from(hidden), scale: 2 });
        shots.set(key, got.png);
        if (shots.size > 60) shots.delete(shots.keys().next().value as string);
        layers.repaint([page - 1]);
      } catch (err) { toast((err as Error).message, 'error'); queue.length = 0; }
    }
  } finally { working = false; }
}

async function loadInks(host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) { inks = null; inksFor = ''; sync(); return; }
  if (inksFor === d.id || loading === d.id) return;
  loading = d.id;
  try {
    const got = await pdfApi.act<Inks>(d.id, 'inks', {});
    if (host.doc()?.id !== d.id) return;
    inks = got;
    inksFor = d.id;
    for (const n of Array.from(hidden)) if (!got.process.includes(n) && !got.spots.includes(n)) hidden.delete(n);
    sync();
    layers.repaint();
  } catch (err) { toast((err as Error).message, 'error'); } finally { if (loading === d.id) loading = ''; }
}

function setInk(name: string, on: boolean): void {
  if (on) hidden.delete(name); else hidden.add(name);
  queue.length = 0;
  sync();
  layers.repaint();
}

function sync(): void {
  const root = rootEl;
  if (!root) return;
  const d = hostRef?.doc();
  const all = inks ? [...inks.process, ...inks.spots] : [];
  setText(q(root, '[data-o="note"]'), !d ? 'Open a PDF to preview its inks.' : !inks ? 'Reading the inks…'
    : hidden.size ? `Showing ${all.length - hidden.size} of ${all.length} inks. Turn an ink off to see what prints on the other plates.` : `${all.length} inks. Turn an ink off to see the page without it.`);
  patchList(q(root, '[data-o="inks"]'), all, {
    key: (n) => n,
    create: (n) => { const row = el(`<label class="fs-check fs-sep-ink"><input type="checkbox" data-ink=""><span class="fs-sep-chip"></span><span class="fs-sep-name"></span></label>`); fill(row, n); return row; },
    update: (row, n) => fill(row, n),
  });
  setHidden(q(root, '[data-o="rgb"]'), !inks?.rgb);
  setHidden(q(root, '[data-o="all"]'), !hidden.size);
}

function fill(row: HTMLElement, name: string): void {
  const box = q<HTMLInputElement>(row, 'input');
  if (box.dataset.ink !== name) box.dataset.ink = name;
  const on = !hidden.has(name);
  if (box.checked !== on) box.checked = on;
  const proc = ['Cyan', 'Magenta', 'Yellow', 'Black'].includes(name);
  const chip = q(row, '.fs-sep-chip');
  const kind = proc ? name.toLowerCase() : 'spot';
  if (chip.dataset.kind !== kind) chip.dataset.kind = kind;
  setText(q(row, '.fs-sep-name'), proc ? name : `${name} (spot)`);
}

function setHide(names: string[]): Record<string, unknown> {
  const all = inks ? [...inks.process, ...inks.spots] : [];
  const bad = names.filter((n) => !all.includes(n));
  if (bad.length) throw new Error(`not an ink in this PDF: ${bad.join(', ')} (inks: ${all.join(', ')})`);
  hidden.clear();
  for (const n of names) hidden.add(n);
  queue.length = 0;
  sync();
  layers.repaint();
  return { hidden: Array.from(hidden), inks: all };
}

registerTool({
  id: 'output-preview',
  tab: 'print',
  title: 'Output preview',
  words: ['separations', 'plates', 'inks', 'spot colours', 'output preview', 'separation preview'],
  section: () => `<p class="fs-note fs-tool-note" data-o="note"></p>
<div class="fs-sep-inks" data-o="inks"></div>
<p class="fs-note" data-o="rgb" hidden>Some colours are RGB; the preview separates them into the process inks the way a simple conversion would.</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-o="all" hidden>Show all inks</button></div>`,
  mount: (root, host) => {
    rootEl = root;
    hostRef = host;
    root.addEventListener('change', (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-ink]');
      if (box?.dataset.ink) setInk(box.dataset.ink, box.checked);
    });
    q(root, '[data-o="all"]').addEventListener('click', () => { hidden.clear(); sync(); layers.repaint(); });
    sync();
  },
  sync: (_root, host) => {
    hostRef = host;
    const d = host.doc();
    if (d?.id !== inksFor) { shots.clear(); void loadInks(host); }
    sync();
  },
  page: (pv: PageView) => layers.mount(pv),
  commands: (host) => [
    { id: 'tool-output-preview', label: 'Preview separations…', words: ['output preview', 'separations', 'plates', 'hide ink'], group: 'Print', when: 'Use to see a page without some inks, for example only the spot colour plate or without black; give the inks to hide, or none to show all.', params: { hide: { type: 'array', description: 'ink names to turn off: Cyan, Magenta, Yellow, Black or a spot colour name; empty shows every ink' } }, enabled: () => !!host.doc(), why: () => 'Open a PDF first', run: async (p) => { host.setTab('print'); await loadInks(host); return setHide(Array.isArray(p?.hide) ? p.hide.map(String) : []); } },
  ],
});
