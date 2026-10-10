import { el, q, setText } from './dom';
import { icon } from './icons';

let openCount = 0;
let dialogSeq = 0;
export const anyDialogOpen = (): boolean => openCount > 0;

export class Dialog {
  readonly scrim: HTMLElement;
  readonly body: HTMLElement;
  readonly foot: HTMLElement;
  private readonly titleEl: HTMLElement;
  private lastFocus: HTMLElement | null = null;
  onClose: (() => void) | null = null;

  constructor(title: string, width = 440) {
    this.scrim = el(`<div class="fs-scrim" hidden><div class="fs-dialog" role="dialog" aria-modal="true" tabindex="-1"><div class="fs-dialog-head"><span class="fs-dialog-title"></span><button class="fs-icon-btn" type="button" data-close title="Close" aria-label="Close">${icon('close', 16)}</button></div><div class="fs-dialog-body"></div><div class="fs-dialog-foot"></div></div></div>`);
    q<HTMLElement>(this.scrim, '.fs-dialog').style.setProperty('--fs-dialog-w', `${width}px`);
    this.titleEl = q(this.scrim, '.fs-dialog-title');
    this.titleEl.id = `fs-dialog-title-${++dialogSeq}`;
    q(this.scrim, '.fs-dialog').setAttribute('aria-labelledby', this.titleEl.id);
    this.body = q(this.scrim, '.fs-dialog-body');
    this.foot = q(this.scrim, '.fs-dialog-foot');
    setText(this.titleEl, title);
    q(this.scrim, '[data-close]').addEventListener('click', () => this.close());
    this.scrim.addEventListener('pointerdown', (e) => { if (e.target === this.scrim) this.close(); });
    this.scrim.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      if (e.key === 'Tab') {
        const all = Array.from(this.scrim.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
          .filter((n) => !(n as HTMLButtonElement).disabled && !n.closest('[hidden]') && n.getClientRects().length > 0);
        if (!all.length) return;
        const first = all[0], last = all[all.length - 1];
        if (e.shiftKey && (document.activeElement === first || !this.scrim.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.getElementById('overlay-root')?.appendChild(this.scrim);
  }

  get isOpen(): boolean { return !this.scrim.hidden; }
  setTitle(title: string): void { setText(this.titleEl, title); }

  open(focus?: HTMLElement | null): void {
    if (this.isOpen) return;
    this.lastFocus = document.activeElement as HTMLElement | null;
    document.getElementById('overlay-root')?.appendChild(this.scrim);
    this.scrim.hidden = false;
    openCount += 1;
    const preferred = focus ?? this.scrim.querySelector<HTMLElement>('input, select, .fs-btn-primary:not(:disabled)');
    preferred?.focus();
    if (!this.scrim.contains(document.activeElement)) q<HTMLElement>(this.scrim, '.fs-dialog').focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.scrim.hidden = true;
    openCount -= 1;
    this.onClose?.();
    if (this.scrim.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.lastFocus?.focus?.();
  }

  button(label: string, kind: '' | 'primary' | 'ghost' | 'danger', run: () => void): HTMLButtonElement {
    const b = el<HTMLButtonElement>(`<button class="fs-btn${kind ? ` fs-btn-${kind}` : ''}" type="button"></button>`);
    b.textContent = label;
    b.addEventListener('click', run);
    this.foot.appendChild(b);
    return b;
  }

  field(label: string, control: HTMLElement): HTMLElement {
    const row = el('<label class="fs-field"><span></span></label>');
    setText(q(row, 'span'), label);
    row.appendChild(control);
    this.body.appendChild(row);
    return row;
  }
}

class SaveChanges extends Dialog {
  private readonly question = el('<p class="fs-save-q">Save changes to <strong></strong>?</p>');
  private readonly saveBtn: HTMLButtonElement;
  private resolve: ((v: 'save' | 'discard' | 'cancel') => void) | null = null;
  constructor() {
    super('Unsaved Changes', 460);
    q<HTMLElement>(this.scrim, '.fs-dialog').classList.add('fs-savechanges');
    this.body.append(this.question, el('<p class="fs-note">Your changes will be lost if you don’t save them.</p>'));
    this.button('Don’t Save', 'ghost', () => this.finish('discard')).classList.add('fs-btn-apart');
    this.button('Cancel', 'ghost', () => this.finish('cancel'));
    this.saveBtn = this.button('Save', 'primary', () => this.finish('save'));
    this.onClose = () => this.finish('cancel');
  }
  ask(name: string): Promise<'save' | 'discard' | 'cancel'> {
    setText(this.question.querySelector('strong') as HTMLElement, name);
    this.open(this.saveBtn);
    return new Promise((r) => { this.resolve = r; });
  }
  private finish(v: 'save' | 'discard' | 'cancel'): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

let saveChangesDialog: SaveChanges | null = null;
export function askSaveChanges(name: string): Promise<'save' | 'discard' | 'cancel'> {
  saveChangesDialog ??= new SaveChanges();
  return saveChangesDialog.ask(name);
}

class Confirm extends Dialog {
  private readonly text = el('<p class="fs-note"></p>');
  private readonly ok: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;
  constructor() {
    super('Confirm', 400);
    this.body.appendChild(this.text);
    this.button('Cancel', 'ghost', () => this.finish(false));
    this.ok = this.button('OK', 'primary', () => this.finish(true));
    this.onClose = () => this.finish(false);
  }
  ask(title: string, text: string, okLabel: string, danger: boolean): Promise<boolean> {
    this.setTitle(title);
    setText(this.text, text);
    setText(this.ok, okLabel);
    this.ok.className = danger ? 'fs-btn fs-btn-danger' : 'fs-btn fs-btn-primary';
    this.open(this.ok);
    return new Promise((r) => { this.resolve = r; });
  }
  private finish(v: boolean): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

class Prompt extends Dialog {
  private readonly input = el<HTMLInputElement>('<input class="fs-input" type="text" spellcheck="false">');
  private readonly ok: HTMLButtonElement;
  private resolve: ((v: string | null) => void) | null = null;
  constructor() {
    super('Name', 400);
    this.field('Name', this.input);
    this.button('Cancel', 'ghost', () => this.finish(null));
    this.ok = this.button('OK', 'primary', () => this.finish(this.input.value.trim() || null));
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.ok.click(); } });
    this.onClose = () => this.finish(null);
  }
  ask(title: string, value: string, okLabel: string): Promise<string | null> {
    this.setTitle(title);
    setText(this.ok, okLabel);
    this.input.value = value;
    this.open(this.input);
    this.input.select();
    return new Promise((r) => { this.resolve = r; });
  }
  private finish(v: string | null): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

let confirmDialog: Confirm | null = null;
let promptDialog: Prompt | null = null;

export function confirmAction(title: string, text: string, okLabel = 'OK', danger = false): Promise<boolean> {
  confirmDialog ??= new Confirm();
  return confirmDialog.ask(title, text, okLabel, danger);
}

export function promptName(title: string, value: string, okLabel = 'OK'): Promise<string | null> {
  promptDialog ??= new Prompt();
  return promptDialog.ask(title, value, okLabel);
}
