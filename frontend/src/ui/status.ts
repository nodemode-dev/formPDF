import { api } from '../io/api';
import { q, setText, setTitle } from './dom';
import { onLanguage, t } from './i18n';

const INFO_KEY = 'formpdf.statusInfo';
const INFO_KINDS = ['page', 'edits', 'file'] as const;
type InfoKind = (typeof INFO_KINDS)[number];

export interface StatusSource {
  pageSize(): { w: number; h: number; rotate: number } | null;
  edit(): { label: string; count: number } | null;
  fileName(): string;
}

const SERVICE_NOTE = 'The engine service is not running, so opening, saving and the PDF tools that need it wait for it. Start it with ./formpdf boot.';

export class StatusInfo {
  private readonly info: HTMLElement;
  private readonly engineEl: HTMLElement;
  private readonly hint: HTMLElement;
  private kind: InfoKind = 'page';
  private segs: string[] = [];
  private engineRaw = '';

  constructor(root: HTMLElement, private readonly src: StatusSource) {
    this.info = q(root, '.fs-st-info');
    this.engineEl = q(root, '.fs-st-engine');
    this.hint = q(root, '.fs-pdfwb-hint');
    try { const k = localStorage.getItem(INFO_KEY) as InfoKind | null; if (k && INFO_KINDS.includes(k)) this.kind = k; } catch { /* default */ }
    this.info.addEventListener('click', (e) => {
      const n = INFO_KINDS.length;
      this.kind = INFO_KINDS[(INFO_KINDS.indexOf(this.kind) + (e.shiftKey ? n - 1 : 1)) % n];
      try { localStorage.setItem(INFO_KEY, this.kind); } catch { /* not kept */ }
      this.sync();
    });
    new ResizeObserver(() => this.fit()).observe(this.hint);
    onLanguage(() => { this.showEngine(); this.sync(); this.fit(); });
    this.sync();
    this.setEngine('Engine offline');
    void api.health().then((h) => this.setEngine(`Engine ${h.version}`)).catch(() => this.setEngine('Engine offline'));
  }

  setEngine(raw: string): void { this.engineRaw = raw; this.showEngine(); }

  private showEngine(): void {
    const raw = this.engineRaw, m = /^Engine (\d\S*)$/.exec(raw);
    setText(this.engineEl, m ? `${t('Engine')} ${m[1]}` : t(raw));
    setTitle(this.engineEl, raw === 'Engine offline' ? t(SERVICE_NOTE) : '');
  }

  sync(): void {
    let text = '', tip = '';
    if (this.kind === 'page') {
      const s = this.src.pageSize();
      if (s) { const r = s.rotate % 180 !== 0; text = `${t('Page')}: ${Math.round(r ? s.h : s.w)} × ${Math.round(r ? s.w : s.h)} pt`; tip = t('Size of the current page in points'); }
    } else if (this.kind === 'edits') {
      const e = this.src.edit();
      if (e) { text = e.count > 0 ? `${t('Edits')}: ${e.count} · ${e.label}` : `${t('Edits')}: ${t('none')}`; tip = t('Edits made since the file was opened and the last one'); }
    } else {
      text = this.src.fileName();
      tip = text ? t('The open file') : '';
    }
    setText(this.info, text);
    setTitle(this.info, `${tip}${tip ? '. ' : ''}${t('Click for the next readout, Shift+click for the previous.')}`);
  }

  setHint(text: string): void {
    this.segs = text.split(' · ');
    this.fit();
  }

  private fit(): void {
    const segs = this.segs;
    if (!segs.length) return;
    let n = segs.length;
    setText(this.hint, segs.join(' · '));
    while (n > 1 && this.hint.scrollWidth > this.hint.clientWidth) { n--; setText(this.hint, segs.slice(0, n).join(' · ')); }
    setTitle(this.hint, n < segs.length ? segs.join(' · ') : '');
  }
}
