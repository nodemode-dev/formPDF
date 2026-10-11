import { api } from '../io/api';
import { Dialog } from '../ui/dialogs';
import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import type { CreateOptions } from './api';
import type { CreateKind } from './intent';

const PICTURE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const OFFICE = /\.(docx?|docm|dotx?|odt|ott|rtf|txt|wpd|pages|pptx?|pptm|ppsx?|potx?|odp|otp|key|xlsx?|xlsm|xlsb|ods|ots|csv|numbers)$/i;
const OFFICE_ACCEPT = '.doc,.docx,.docm,.dot,.dotx,.odt,.ott,.rtf,.txt,.wpd,.pages,.ppt,.pptx,.pptm,.pps,.ppsx,.pot,.potx,.odp,.otp,.key,.xls,.xlsx,.xlsm,.xlsb,.ods,.ots,.csv,.numbers';
const isPdf = (f: File): boolean => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isOffice = (f: File): boolean => OFFICE.test(f.name);
const KIND: Array<[RegExp, string]> = [[/\.(pptx?|pptm|ppsx?|potx?|odp|otp|key)$/i, 'Slides'], [/\.(xlsx?|xlsm|xlsb|ods|ots|csv|numbers)$/i, 'Sheet'], [OFFICE, 'Document']];
const kindOf = (f: File): string => (isPdf(f) ? 'PDF · ' : isOffice(f) ? `${KIND.find(([re]) => re.test(f.name))?.[1] ?? 'Document'} · ` : '');
let office: Promise<boolean> | null = null;
const isPicture = (f: File): boolean => (f.type.startsWith('image/') && !/svg/.test(f.type)) || PICTURE.test(f.name);
const size = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
let seq = 0;

interface Item { key: string; file: File; url: string; pdf: boolean }

class CreateDialog extends Dialog {
  private items: Item[] = [];
  private kind: CreateKind = 'pictures';
  private resolve: ((v: { files: File[]; opts: CreateOptions } | null) => void) | null = null;
  private readonly list: HTMLElement;
  private readonly create: HTMLButtonElement;
  private dragKey = '';

  constructor() {
    super('Create PDF', 600);
    q<HTMLElement>(this.scrim, '.fs-dialog').classList.add('fs-pdfwb-create');
    this.body.appendChild(el(`<div class="fs-pdfwb-cbody">
<div class="fs-seg fs-pdfwb-cmode"><button type="button" data-k="pictures" class="is-on">From pictures</button><button type="button" data-k="files">Combine files</button></div>
<p class="fs-note fs-pdfwb-cnote"></p>
<div class="fs-pdfwb-cdrop"><span>${icon('upload', 18)}</span><span class="fs-pdfwb-cdroptext">Drop files here or</span><button class="fs-btn fs-btn-sm" type="button" data-k="add">Add files…</button></div>
<div class="fs-pdfwb-clist" role="list"></div>
<div class="fs-pdfwb-copts">
<label class="fs-field is-stack"><span>Page size</span><select data-k="page"><option value="fit">Fit to picture</option><option value="a4">A4</option><option value="letter">Letter</option></select></label>
<label class="fs-field is-stack"><span>Margins</span><select data-k="margin"><option value="0" selected>None</option><option value="18">Small</option><option value="36">Medium</option><option value="72">Large</option></select></label>
<label class="fs-field is-stack" data-k="orient-row"><span>Orientation</span><select data-k="orientation"><option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
</div></div>`));
    this.list = q(this.body, '.fs-pdfwb-clist');
    this.button('Cancel', 'ghost', () => this.finish(null));
    this.create = this.button('Create PDF', 'primary', () => this.finish(this.items.map((i) => i.file)));
    this.onClose = () => this.finish(null);
    this.body.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null;
      if (!t) return;
      const k = t.dataset.k;
      if (k === 'pictures' || k === 'files') this.setKind(k);
      else if (k === 'add') this.pick();
      else if (k === 'up' || k === 'down' || k === 'remove') this.edit(t.closest('[data-key]')?.getAttribute('data-key') ?? '', k);
    });
    this.body.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).dataset.k !== 'page') return;
      const page = (e.target as HTMLSelectElement).value, margin = q<HTMLSelectElement>(this.body, '[data-k="margin"]');
      if (page !== 'fit' && margin.value === '0') margin.value = '36';
      else if (page === 'fit' && margin.value === '36') margin.value = '0';
      this.syncOpts();
    });
    const drop = q(this.body, '.fs-pdfwb-cdrop');
    this.scrim.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setClass(drop, 'is-over', true); } });
    this.scrim.addEventListener('dragleave', (e) => { if (!this.scrim.contains(e.relatedTarget as Node | null)) setClass(drop, 'is-over', false); });
    this.scrim.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setClass(drop, 'is-over', false);
      this.addFiles(Array.from(e.dataTransfer.files));
    });
    this.list.addEventListener('dragstart', (e) => { const r = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null; if (r) { this.dragKey = r.dataset.key ?? ''; e.dataTransfer?.setData('text/plain', this.dragKey); setClass(r, 'is-dragging', true); } });
    this.list.addEventListener('dragend', () => { this.dragKey = ''; for (const r of Array.from(this.list.children)) setClass(r, 'is-dragging', false); });
    this.list.addEventListener('dragover', (e) => {
      if (!this.dragKey) return;
      e.preventDefault();
      const over = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null;
      if (!over || over.dataset.key === this.dragKey) return;
      const from = this.items.findIndex((i) => i.key === this.dragKey), to = this.items.findIndex((i) => i.key === over.dataset.key);
      if (from < 0 || to < 0) return;
      const [it] = this.items.splice(from, 1);
      this.items.splice(to, 0, it);
      this.sync();
    });
    this.list.addEventListener('drop', (e) => { if (this.dragKey) e.preventDefault(); });
  }

  ask(kind: CreateKind, files: File[] = []): Promise<{ files: File[]; opts: CreateOptions } | null> {
    this.clear();
    this.setKind(kind);
    if (files.length) this.addFiles(files);
    this.open(this.create.disabled ? q<HTMLButtonElement>(this.body, '[data-k="add"]') : this.create);
    return new Promise((r) => { this.resolve = r; });
  }

  private setKind(kind: CreateKind): void {
    this.kind = kind;
    for (const b of Array.from(q(this.body, '.fs-pdfwb-cmode').children)) setClass(b, 'is-on', (b as HTMLElement).dataset.k === kind);
    this.setTitle(kind === 'pictures' ? 'Create PDF from pictures' : 'Combine files into a PDF');
    const note = q(this.body, '.fs-pdfwb-cnote');
    setText(note, kind === 'pictures' ? 'Each picture becomes one page. Drag the rows, or use the arrows, to change the order.' : 'PDFs keep their pages, pictures become pages and Office files are converted, in the order shown. Drag the rows to reorder.');
    if (kind === 'files') {
      office ??= api.capabilities().then((c) => !!(c.office as { available?: boolean } | undefined)?.available).catch(() => { office = null; return true; });
      void office.then((on) => {
        if (!on && this.kind === 'files') setText(note, 'PDFs keep their pages and pictures become pages, in the order shown. Office files need LibreOffice, which is not installed (libreoffice.org).');
      });
    }
    this.sync();
  }

  private pick(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = this.kind === 'pictures' ? 'image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff' : `.pdf,application/pdf,image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,${OFFICE_ACCEPT}`;
    input.onchange = () => this.addFiles(Array.from(input.files ?? []));
    input.click();
  }

  private addFiles(files: File[]): void {
    const ok = files.filter((f) => isPdf(f) || isPicture(f) || isOffice(f));
    if (ok.length < files.length) toast(`${files.length - ok.length} file${files.length - ok.length === 1 ? ' is' : 's are'} not a PDF, a picture or an Office file and ${files.length - ok.length === 1 ? 'was' : 'were'} left out`);
    if (ok.some((f) => isPdf(f) || isOffice(f)) && this.kind === 'pictures') this.setKind('files');
    for (const f of ok) this.items.push({ key: `c${seq++}`, file: f, url: isPdf(f) || isOffice(f) ? '' : URL.createObjectURL(f), pdf: isPdf(f) || isOffice(f) });
    this.sync();
  }

  private edit(key: string, op: string): void {
    const i = this.items.findIndex((x) => x.key === key);
    if (i < 0) return;
    if (op === 'remove') { const [it] = this.items.splice(i, 1); if (it.url) URL.revokeObjectURL(it.url); }
    else {
      const j = op === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= this.items.length) return;
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
    this.sync();
  }

  private syncOpts(): void {
    const page = q<HTMLSelectElement>(this.body, '[data-k="page"]').value;
    setHidden(q(this.body, '[data-k="orient-row"]'), page === 'fit');
  }

  private sync(): void {
    const n = this.items.length;
    patchList(this.list, this.items, {
      key: (it) => it.key,
      create: (it) => {
        const r = el(`<div class="fs-pdfwb-crow" role="listitem" draggable="true"><span class="fs-pdfwb-cthumb">${it.pdf ? icon(isOffice(it.file) ? 'fileText' : 'filePdf', 22) : `<img alt="" decoding="async" src="${it.url}">`}</span><span class="fs-pdfwb-cname"></span><span class="fs-pdfwb-cmeta"></span><button class="fs-icon-btn is-sm" type="button" data-k="up" title="Move up" aria-label="Move up">${icon('chevronUp', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-k="down" title="Move down" aria-label="Move down">${icon('chevronDown', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-k="remove" title="Remove" aria-label="Remove">${icon('close', 14)}</button></div>`);
        setText(r.querySelector('.fs-pdfwb-cname'), it.file.name);
        setText(r.querySelector('.fs-pdfwb-cmeta'), `${kindOf(it.file)}${size(it.file.size)}`);
        return r;
      },
      update: () => undefined,
    });
    this.items.forEach((it, i) => {
      const r = this.list.children[i] as HTMLElement | undefined;
      if (!r) return;
      setDisabled(q<HTMLButtonElement>(r, '[data-k="up"]'), i === 0);
      setDisabled(q<HTMLButtonElement>(r, '[data-k="down"]'), i === n - 1);
    });
    setText(q(this.body, '.fs-pdfwb-cdroptext'), n ? `${n} file${n === 1 ? '' : 's'}. Drop more here or` : 'Drop files here or');
    setDisabled(this.create, !n);
    this.syncOpts();
  }

  private clear(): void {
    for (const it of this.items) if (it.url) URL.revokeObjectURL(it.url);
    this.items = [];
    this.sync();
  }

  private finish(files: File[] | null): void {
    const r = this.resolve;
    this.resolve = null;
    const opts: CreateOptions = {
      page: q<HTMLSelectElement>(this.body, '[data-k="page"]').value as CreateOptions['page'],
      margin: Number(q<HTMLSelectElement>(this.body, '[data-k="margin"]').value) || 0,
      orientation: q<HTMLSelectElement>(this.body, '[data-k="orientation"]').value as CreateOptions['orientation'],
      name: this.items[0] ? this.items[0].file.name.replace(/\.[^.]+$/, '') : undefined,
    };
    if (this.isOpen) this.close();
    r?.(files && files.length ? { files, opts } : null);
    if (files) window.setTimeout(() => this.clear(), 0);
  }
}

let dialog: CreateDialog | null = null;

export function askCreate(kind: CreateKind, files: File[] = []): Promise<{ files: File[]; opts: CreateOptions } | null> {
  dialog ??= new CreateDialog();
  return dialog.ask(kind, files);
}
