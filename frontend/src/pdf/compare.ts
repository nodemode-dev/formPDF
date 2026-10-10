import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import type { ChangeKind, CompareChange, CompareResult, Rect } from './api';
import type { PageView, Viewer } from './viewer';

const MAX_LIST = 600;
export const CHANGE_LABEL: Record<ChangeKind, string> = {
  inserted: 'Inserted', deleted: 'Deleted', changed: 'Changed', 'page-added': 'Page added', 'page-removed': 'Page removed', picture: 'Picture changed',
};
const calc = (v: number): string => `calc(var(--k) * ${Math.round(v * 100) / 100}px)`;

interface Box { key: string; kind: ChangeKind; r: Rect; current: boolean }

export class Comparer {
  result: CompareResult | null = null;
  docId = '';
  otherName = '';
  current = -1;
  private layers = new Map<number, HTMLElement>();
  onChange: () => void = () => undefined;

  constructor(private readonly viewer: Viewer) {}

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el('<div class="fs-pdf-cmps"></div>');
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.render(pv.index);
  }

  set(result: CompareResult | null, docId = '', otherName = ''): void {
    this.result = result;
    this.docId = docId;
    this.otherName = otherName;
    this.current = -1;
    for (const i of this.layers.keys()) this.render(i);
    this.onChange();
  }

  go(id: number): void {
    const c = this.result?.changes.find((x) => x.id === id);
    if (!c) return;
    const prev = this.result?.changes.find((x) => x.id === this.current);
    this.current = id;
    if (prev?.page) this.render(prev.page - 1);
    if (c.page) {
      this.render(c.page - 1);
      const r = c.rects[0];
      if (c.kind === 'page-added' || !r) this.viewer.goTo(c.page);
      else this.viewer.scrollToPoint(c.page - 1, r.x + r.w / 2, r.y);
    } else this.viewer.goTo(Math.max(1, Math.min(this.viewer.pages.length, (c.at ?? 0) + 1)));
    this.onChange();
  }

  step(dir: 1 | -1): void {
    const list = this.result?.changes ?? [];
    if (!list.length) return;
    const at = list.findIndex((c) => c.id === this.current);
    const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length];
    if (next) this.go(next.id);
  }

  private render(index: number): void {
    const layer = this.layers.get(index);
    if (!layer) return;
    const boxes: Box[] = [];
    for (const c of this.result?.changes ?? []) {
      if (c.page !== index + 1) continue;
      c.rects.forEach((r, k) => boxes.push({ key: `${this.docId}|${c.id}|${k}`, kind: c.kind, r, current: c.id === this.current }));
    }
    const update = (n: HTMLElement, b: Box): void => {
      const pad = b.kind === 'page-added' ? 0 : 1;
      const css = `left:${calc(b.r.x - pad)};top:${calc(b.r.y - pad)};width:${calc(b.r.w + 2 * pad)};height:${calc(b.r.h + 2 * pad)}`;
      if (n.getAttribute('style') !== css) n.setAttribute('style', css);
      setClass(n, 'is-current', b.current);
    };
    patchList(layer, boxes, { key: (b) => b.key, create: (b) => { const n = el(`<div class="fs-pdf-cmp" data-kind="${b.kind}"></div>`); update(n, b); return n; }, update });
  }
}

export class ComparePanel {
  readonly root: HTMLElement;
  onPick: () => void = () => undefined;
  onClear: () => void = () => undefined;

  constructor(private readonly cmp: Comparer) {
    this.root = el(`<div class="fs-pdfwb-cmp">
<p class="fs-note">Compare this PDF with another version to see what text was inserted, deleted or changed, page by page. Nothing in either PDF changes.</p>
<div class="fs-prop-row"><span class="fs-prop-label">Other file</span><div class="fs-prop-ctl"><select data-c="newer" aria-label="The other file is"><option value="0">Older version</option><option value="1">Newer version</option></select></div></div>
<label class="fs-check"><input type="checkbox" data-c="pictures">Compare pictures too</label>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-c="pick">${icon('compare', 14)}Choose a PDF to compare</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-c="clear" hidden>Clear</button></div>
<div class="fs-pdfwb-cmpsum" hidden><p class="fs-pdfwb-cmphead"></p><div class="fs-pdfwb-cmplegend"><span data-kind="inserted">Inserted</span><span data-kind="deleted">Deleted</span><span data-kind="changed">Changed</span><span data-kind="picture">Picture</span></div><div class="fs-pdfwb-cmpnav"><span class="fs-pdfwb-cmpcount"></span><button class="fs-icon-btn is-sm" type="button" data-c="prev" title="Previous change" aria-label="Previous change">${icon('chevronUp', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-c="next" title="Next change" aria-label="Next change">${icon('chevronDown', 14)}</button></div></div>
<div class="fs-list fs-pdfwb-cmplist"></div>
<p class="fs-note fs-pdfwb-cmpmore" hidden></p>
</div>`);
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-c]') as HTMLElement | null;
      if (!t || (t as HTMLButtonElement).disabled) return;
      const a = t.dataset.c;
      if (a === 'pick') this.onPick();
      else if (a === 'clear') this.onClear();
      else if (a === 'prev') this.cmp.step(-1);
      else if (a === 'next') this.cmp.step(1);
      else if (a === 'go') this.cmp.go(Number(t.dataset.id));
    });
  }

  get otherIsNewer(): boolean { return q<HTMLSelectElement>(this.root, '[data-c="newer"]').value === '1'; }
  get pictures(): boolean { return q<HTMLInputElement>(this.root, '[data-c="pictures"]').checked; }

  sync(): void {
    const r = this.cmp.result;
    setHidden(q(this.root, '[data-c="clear"]'), !r);
    setHidden(q(this.root, '.fs-pdfwb-cmpsum'), !r);
    const list = r ? r.changes.slice(0, MAX_LIST) : [];
    if (r) {
      const s = r.summary, w = s.words;
      const bits = [`${s.changed} page${s.changed === 1 ? '' : 's'} changed`, `${s.added} added`, `${s.removed} removed`, `${s.same} the same`];
      setText(q(this.root, '.fs-pdfwb-cmphead'), `Compared with ${this.cmp.otherName || 'the other PDF'}: ${bits.join(', ')}. ${w.inserted} insertion${w.inserted === 1 ? '' : 's'}, ${w.deleted} deletion${w.deleted === 1 ? '' : 's'}, ${w.changed} change${w.changed === 1 ? '' : 's'}${s.pictures ? `, pictures differ on ${s.pictures} page${s.pictures === 1 ? '' : 's'}` : ''}.`);
      const at = r.changes.findIndex((c) => c.id === this.cmp.current);
      setText(q(this.root, '.fs-pdfwb-cmpcount'), r.changes.length ? `${at >= 0 ? `${at + 1} of ` : ''}${r.changes.length} difference${r.changes.length === 1 ? '' : 's'}` : 'No differences found');
      for (const b of ['prev', 'next']) setDisabled(q<HTMLButtonElement>(this.root, `[data-c="${b}"]`), !r.changes.length);
    }
    const more = r ? r.changes.length - list.length : 0;
    setHidden(q(this.root, '.fs-pdfwb-cmpmore'), more <= 0 && !r?.truncated);
    setText(q(this.root, '.fs-pdfwb-cmpmore'), more > 0 ? `${more} more difference${more === 1 ? '' : 's'} are highlighted on the pages; use the arrows to step through them.` : 'Only the first differences were compared.');
    const update = (n: HTMLElement, c: CompareChange): void => setClass(n, 'is-selected', c.id === this.cmp.current);
    patchList(q(this.root, '.fs-pdfwb-cmplist'), list, {
      key: (c) => `${this.cmp.docId}|${c.id}`,
      create: (c) => {
        const n = el(`<button class="fs-pdfwb-cmprow" type="button" data-c="go" data-id="${c.id}" data-kind="${c.kind}"><span class="fs-pdfwb-cmpmeta"><span class="fs-pdfwb-cmpdot"></span><span class="fs-pdfwb-cmpkind"></span></span><span class="fs-pdfwb-cmptext"><del></del><ins></ins></span></button>`);
        const where = c.page ? `Page ${c.page}` : c.kind === 'page-removed' || c.kind === 'page-added' ? `Page ${c.other ?? ''} of the other file, after page ${c.at ?? 0}` : '';
        setText(n.querySelector('.fs-pdfwb-cmpkind'), `${CHANGE_LABEL[c.kind]} · ${where}`);
        const del = n.querySelector('del') as HTMLElement, ins = n.querySelector('ins') as HTMLElement;
        setText(del, c.before);
        setText(ins, c.after);
        setHidden(del, !c.before);
        setHidden(ins, !c.after);
        update(n, c);
        return n;
      },
      update,
    });
  }
}
