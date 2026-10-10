import { api } from '../io/api';
import { pdfApi, type Derived, type Identity, type SigEntry, type SigReport } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import type { PageView } from '../pdf/viewer';
import { Dialog } from '../ui/dialogs';
import { el, patchList, q, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { PageLayers, place } from './overlay';

type Pt = { x: number; y: number };

let ids: Identity[] = [];
let idsLoaded = false;
let report: SigReport | null = null;
let reportFor = '';
let reportLoading = '';
let picture: string | null = null;
let tsUrl = '';
let warnedFor = '';
let rootEl: HTMLElement | null = null;
let hostRef: ToolHost | null = null;
let draft: { page: number; a: Pt; b: Pt } | null = null;

const VERDICT: Record<string, { word: string; ico: string; cls: string }> = {
  valid: { word: 'Valid', ico: 'success', cls: 'is-ok' },
  unknown: { word: 'Identity not confirmed', ico: 'warning', cls: 'is-warn' },
  invalid: { word: 'Invalid', ico: 'error', cls: 'is-bad' },
};

const layers = new PageLayers('certsign', (index, layer) => {
  const d = draft;
  let box = layer.firstElementChild as HTMLElement | null;
  if (!d || d.page !== index + 1) { if (box) box.hidden = true; return; }
  if (!box) box = layer.appendChild(el('<div class="fs-sig-draft"></div>'));
  box.hidden = false;
  place(box, Math.min(d.a.x, d.b.x), Math.min(d.a.y, d.b.y), Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y));
});

function val(k: string): string { return rootEl ? q<HTMLInputElement | HTMLSelectElement>(rootEl, `[data-c="${k}"]`).value : ''; }

async function loadIds(): Promise<void> {
  try {
    const got = await pdfApi.identities();
    ids = got.identities;
    idsLoaded = true;
    const s = await api.settings().catch(() => ({} as Record<string, unknown>));
    tsUrl = String(s.timestampUrl ?? '');
  } catch { ids = []; }
  sync();
}

async function loadReport(host: ToolHost, force = false): Promise<void> {
  const d = host.doc();
  if (!d) { report = null; reportFor = ''; sync(); return; }
  if (!force && (reportFor === d.id || reportLoading === d.id)) return;
  reportLoading = d.id;
  try {
    const got = await pdfApi.act<SigReport>(d.id, 'signatures');
    if (host.doc()?.id !== d.id) return;
    report = got;
    reportFor = d.id;
    if (got.signatures.length && warnedFor !== d.key) {
      warnedFor = d.key;
      toast('This PDF is signed. Comments, form filling and further signatures keep the signatures valid; other changes break them.');
    }
  } catch { report = null; } finally { if (reportLoading === d.id) reportLoading = ''; }
  sync();
  syncRequest();
}

function sigTitle(s: SigEntry): string { return `${s.signer?.name || 'Unknown signer'} · ${VERDICT[s.verdict]?.word ?? s.verdict}`; }

function sigSub(s: SigEntry): string {
  const bits = [...s.says];
  if (s.certified) bits.unshift(`Certified: ${s.certified === 1 ? 'no changes allowed' : s.certified === 2 ? 'form filling allowed' : 'comments and form filling allowed'}.`);
  if (s.reason) bits.push(`Reason: ${s.reason}.`);
  if (s.location) bits.push(`Location: ${s.location}.`);
  return bits.join(' ');
}

function sync(): void {
  const root = rootEl, host = hostRef;
  if (!root || !host) return;
  const sel = q<HTMLSelectElement>(root, '[data-c="id"]');
  const html = ids.length ? ids.map((i) => `<option value="${i.id}">${escape(i.name)}${i.email ? ` (${escape(i.email)})` : ''}${i.selfSigned ? ', made here' : ''}</option>`).join('') : '<option value="">No digital ID yet</option>';
  if (sel.dataset.html !== html) { const keep = sel.value; sel.innerHTML = html; sel.dataset.html = html; if (ids.some((i) => i.id === keep)) sel.value = keep; }
  const fsel = q<HTMLSelectElement>(root, '[data-c="field"]');
  const empty = report?.empty ?? [];
  const fhtml = `<option value="">Draw a box on the page</option>${empty.map((f) => `<option value="${escape(f.field)}">Field ${escape(f.field)}${f.tooltip ? `: ${escape(f.tooltip)}` : ''}</option>`).join('')}`;
  if (fsel.dataset.html !== fhtml) { const keep = fsel.value; fsel.innerHTML = fhtml; fsel.dataset.html = fhtml; if (empty.some((f) => f.field === keep)) fsel.value = keep; }
  const ts = q<HTMLInputElement>(root, '[data-c="ts"]');
  setDisabled(ts, !tsUrl);
  if (!tsUrl) ts.checked = false;
  const tsLabel = q(root, '[data-c="tsnote"]').closest('label') as HTMLElement;
  const tsTitle = tsUrl ? `Timestamp from ${tsUrl}` : 'Set a timestamp server in Preferences > Signing first';
  if (tsLabel.title !== tsTitle) tsLabel.title = tsTitle;
  setText(q(root, '[data-c="picnote"]'), picture ? 'Picture chosen' : '');
  setDisabled(q<HTMLButtonElement>(root, '[data-c="sign"]'), !host.doc() || !ids.length);
  if (!idsLoaded) setText(q(root, '[data-c="note"]'), 'Loading your digital IDs.');
  else if (!ids.length) setText(q(root, '[data-c="note"]'), 'Make a digital ID here, or import the .p12 or .pfx file your organisation gave you. A signature made with it shows whether the PDF changed afterwards.');
  else setText(q(root, '[data-c="note"]'), 'Choose the ID, type its password, and draw where the signature goes or pick an empty signature field.');
  const sigs = report?.signatures ?? [];
  patchList(q(root, '[data-c="list"]'), sigs, {
    key: (s) => `${s.index}|${s.field}`,
    create: (s) => {
      const n = el(`<div class="fs-row fs-tool-row fs-sig-row"><span class="fs-row-icon fs-sig-ico"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-tool-acts"><button class="fs-icon-btn is-sm" type="button" data-c="trust" title="Trust this certificate" aria-label="Trust this certificate">${icon('check', 14)}</button><button class="fs-icon-btn is-sm" type="button" data-c="version" title="Save the version this signature covers" aria-label="Save the version this signature covers">${icon('download', 14)}</button></span></div>`);
      fillRow(n, s);
      return n;
    },
    update: fillRow,
  });
  setText(q(root, '[data-c="count"]'), String(sigs.length));
  setHidden(q(root, '[data-c="empty"]'), sigs.length > 0);
}

function fillRow(n: HTMLElement, s: SigEntry): void {
  const v = VERDICT[s.verdict] ?? VERDICT.invalid;
  const ico = q(n, '.fs-sig-ico');
  if (ico.dataset.v !== s.verdict) { ico.innerHTML = icon(v.ico, 14); ico.dataset.v = s.verdict; ico.className = `fs-row-icon fs-sig-ico ${v.cls}`; }
  setText(q(n, '.fs-row-title'), sigTitle(s));
  setText(q(n, '.fs-row-sub'), sigSub(s));
  n.dataset.index = String(s.index);
  setDisabled(q<HTMLButtonElement>(n, '[data-c="trust"]'), s.verdict !== 'unknown' || !s.signer?.der);
}

function escape(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

class NewIdDialog extends Dialog {
  private resolve: ((v: { name: string; email: string; org: string; password: string } | null) => void) | null = null;
  constructor() {
    super('New digital ID', 460);
    this.body.appendChild(el(`<div class="fs-sig-dlg"><p class="fs-note">The ID is made and kept on this computer, in the Formpdf folder. People who receive your signed PDFs see your name and email, and can choose to trust the ID.</p>
<label class="fs-field is-stack"><span>Your name</span><input class="fs-input" data-n="name" autocomplete="name"></label>
<label class="fs-field is-stack"><span>Email</span><input class="fs-input" data-n="email" autocomplete="email"></label>
<label class="fs-field is-stack"><span>Organisation (optional)</span><input class="fs-input" data-n="org"></label>
<label class="fs-field is-stack"><span>Password (6 or more characters)</span><input class="fs-input" type="password" data-n="pw" autocomplete="new-password"></label>
<label class="fs-field is-stack"><span>Password again</span><input class="fs-input" type="password" data-n="pw2" autocomplete="new-password"></label>
<p class="fs-note fs-sig-err" data-n="err"></p></div>`));
    this.button('Cancel', 'ghost', () => this.done(null));
    this.button('Make ID', 'primary', () => this.submit());
    this.onClose = () => this.done(null);
  }
  private v(k: string): string { return q<HTMLInputElement>(this.body, `[data-n="${k}"]`).value; }
  ask(): Promise<{ name: string; email: string; org: string; password: string } | null> {
    for (const k of ['pw', 'pw2']) q<HTMLInputElement>(this.body, `[data-n="${k}"]`).value = '';
    setText(q(this.body, '[data-n="err"]'), '');
    this.open(q(this.body, '[data-n="name"]'));
    return new Promise((r) => { this.resolve = r; });
  }
  private submit(): void {
    const err = !this.v('name').trim() ? 'Type your name.' : this.v('pw').length < 6 ? 'Choose a password of at least 6 characters.' : this.v('pw') !== this.v('pw2') ? 'The passwords differ.' : '';
    if (err) { setText(q(this.body, '[data-n="err"]'), err); return; }
    this.done({ name: this.v('name').trim(), email: this.v('email').trim(), org: this.v('org').trim(), password: this.v('pw') });
  }
  private done(v: { name: string; email: string; org: string; password: string } | null): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

class PasswordDialog extends Dialog {
  private resolve: ((v: string | null) => void) | null = null;
  constructor() {
    super('Digital ID password', 420);
    this.body.appendChild(el('<div class="fs-sig-dlg"><p class="fs-note" data-n="what"></p><label class="fs-field is-stack"><span>Password</span><input class="fs-input" type="password" data-n="pw" autocomplete="current-password"></label></div>'));
    this.button('Cancel', 'ghost', () => this.done(null));
    this.button('Import', 'primary', () => this.done(q<HTMLInputElement>(this.body, '[data-n="pw"]').value));
    this.onClose = () => this.done(null);
    q(this.body, '[data-n="pw"]').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') this.done(q<HTMLInputElement>(this.body, '[data-n="pw"]').value); });
  }
  ask(what: string): Promise<string | null> {
    setText(q(this.body, '[data-n="what"]'), what);
    q<HTMLInputElement>(this.body, '[data-n="pw"]').value = '';
    this.open(q(this.body, '[data-n="pw"]'));
    return new Promise((r) => { this.resolve = r; });
  }
  private done(v: string | null): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

let newIdDlg: NewIdDialog | null = null;
let pwDlg: PasswordDialog | null = null;

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function newId(): Promise<void> {
  newIdDlg ??= new NewIdDialog();
  const got = await newIdDlg.ask();
  if (!got) return;
  try {
    const made = await pdfApi.makeIdentity(got);
    await loadIds();
    if (rootEl && made.id) q<HTMLSelectElement>(rootEl, '[data-c="id"]').value = made.id;
    toast(`Made a digital ID for ${made.name}.`);
  } catch (err) { toast((err as Error).message, 'error'); }
}

async function importId(): Promise<void> {
  const f = await pickFile('.p12,.pfx,application/x-pkcs12');
  if (!f) return;
  pwDlg ??= new PasswordDialog();
  const pw = await pwDlg.ask(`Type the password of ${f.name}. formpdf keeps a copy of the ID in the Formpdf folder; the password is never stored.`);
  if (pw === null) return;
  try {
    const got = await pdfApi.importIdentity(f, pw);
    await loadIds();
    if (rootEl && got.id) q<HTMLSelectElement>(rootEl, '[data-c="id"]').value = got.id;
    toast(`Imported the digital ID of ${got.name}.`);
  } catch (err) { toast((err as Error).message, 'error'); }
}

async function choosePicture(): Promise<void> {
  const f = await pickFile('image/png,image/jpeg');
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast('Choose a picture smaller than 8 MB', 'error'); return; }
  picture = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(f); });
  if (rootEl) q<HTMLSelectElement>(rootEl, '[data-c="look"]').value = 'picture';
  sync();
}

async function doSign(host: ToolHost, target: { field?: string; box?: { page: number; x: number; y: number; w: number; h: number } }): Promise<void> {
  const d = host.doc();
  if (!d) return;
  const body: Record<string, unknown> = {
    identity: val('id'), password: val('pw'), reason: val('reason').trim(), location: val('location').trim(), certify: val('certify'),
    lock: !!rootEl && q<HTMLInputElement>(rootEl, '[data-c="lock"]').checked, timestamp: !!rootEl && q<HTMLInputElement>(rootEl, '[data-c="ts"]').checked,
    ...target,
  };
  if (val('look') === 'picture' && picture) body.picture = picture;
  await host.ctx.run('Signing', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived>(id, 'sign', body);
      await host.ctx.commit(res, 'Sign with digital ID');
      if (rootEl) q<HTMLInputElement>(rootEl, '[data-c="pw"]').value = '';
      toast('Signed. Save to keep the signed PDF; later comments and form filling keep the signature valid.');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  await loadReport(host, true);
}

function startSign(host: ToolHost): void {
  if (!val('id')) { toast('Make or import a digital ID first', 'error'); return; }
  if (!val('pw')) { toast('Type the digital ID password', 'error'); rootEl?.querySelector<HTMLInputElement>('[data-c="pw"]')?.focus(); return; }
  const field = val('field');
  if (field) { void doSign(host, { field }); return; }
  host.useTool({
    hint: 'Drag a box where the signature goes. Esc cancels.',
    down: (pv: PageView, p: Pt) => { draft = { page: pv.index + 1, a: p, b: p }; layers.repaint([pv.index]); },
    move: (pv: PageView, p: Pt) => { if (draft && draft.page === pv.index + 1) { draft.b = p; layers.repaint([pv.index]); } },
    up: (pv: PageView, p: Pt) => {
      const d = draft;
      draft = null;
      layers.repaint([pv.index]);
      host.useTool(null);
      if (!d) return;
      d.b = p;
      let x = Math.min(d.a.x, d.b.x), y = Math.min(d.a.y, d.b.y), w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y);
      if (w < 20 || h < 10) { w = 180; h = 54; x = Math.min(pv.size.w - w - 6, Math.max(6, p.x - w / 2)); y = Math.min(pv.size.h - h - 6, Math.max(6, p.y - h / 2)); }
      void doSign(host, { box: { page: d.page, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } });
    },
    cancel: () => { if (draft) { const pg = draft.page - 1; draft = null; layers.repaint([pg]); } },
  });
}

async function listAction(host: ToolHost, what: string, index: number): Promise<void> {
  const d = host.doc();
  const s = report?.signatures.find((x) => x.index === index);
  if (!d || !s) return;
  if (what === 'trust' && s.signer?.der) {
    try {
      await pdfApi.trust(s.signer.der);
      toast(`You now trust ${s.signer.name}'s certificate on this computer.`);
      await loadReport(host, true);
    } catch (err) { toast((err as Error).message, 'error'); }
  } else if (what === 'version') {
    await host.ctx.deliver(pdfApi.signedVersionUrl(d.id, index), `${d.name.replace(/\.pdf$/i, '')} (as signed by ${s.signer?.name ?? 'signer'}).pdf`);
  }
}

registerTool({
  id: 'certsign',
  tab: 'fill',
  title: 'Sign with a digital ID',
  words: ['digital signature', 'certificate', 'digital id', 'p12', 'pfx', 'certify', 'validate signature', 'pades'],
  section: () => `<p class="fs-note fs-tool-note fs-cx-note" data-c="note">Loading your digital IDs.</p>
<div class="fs-prop-row"><span class="fs-prop-label">Digital ID</span><div class="fs-prop-ctl"><select class="fs-tool-unit" data-c="id" aria-label="Digital ID"><option value="">Loading</option></select></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-c="new">${icon('add', 14)}New digital ID…</button><button class="fs-btn fs-btn-sm" type="button" data-c="import">${icon('upload', 14)}Import .p12 or .pfx…</button></div>
<div class="fs-prop-row"><span class="fs-prop-label">Password</span><div class="fs-prop-ctl"><input class="fs-input" type="password" data-c="pw" autocomplete="off" aria-label="Digital ID password"></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Reason</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-c="reason" placeholder="Optional, such as I approve this document"></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Location</span><div class="fs-prop-ctl"><input class="fs-input" type="text" data-c="location" placeholder="Optional"></div></div>
<div class="fs-prop-row"><span class="fs-prop-label">Appearance</span><div class="fs-prop-ctl fs-sig-look"><select class="fs-tool-unit" data-c="look" aria-label="Appearance"><option value="text">Name and date</option><option value="picture">Picture with name and date</option></select><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-c="pic">Picture…</button></div></div>
<p class="fs-note fs-sig-picnote" data-c="picnote"></p>
<div class="fs-prop-row"><span class="fs-prop-label">Kind</span><div class="fs-prop-ctl"><select class="fs-tool-unit" data-c="certify" aria-label="Kind of signature"><option value="">Approval signature</option><option value="forms">Certify: allow form filling</option><option value="comments">Certify: allow comments and form filling</option><option value="none">Certify: allow no changes</option></select></div></div>
<label class="fs-check"><input type="checkbox" data-c="lock">Lock the form fields after signing</label>
<label class="fs-check"><input type="checkbox" data-c="ts"><span data-c="tsnote">Add a timestamp from the server in Preferences</span></label>
<div class="fs-prop-row"><span class="fs-prop-label">Sign in</span><div class="fs-prop-ctl"><select class="fs-tool-unit" data-c="field" aria-label="Where to sign"><option value="">Draw a box on the page</option></select></div></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-c="sign">${icon('signature', 14)}Sign</button></div>
<div class="fs-pdfwb-subhead">Signatures in this PDF <span class="fs-badge is-count" data-c="count">0</span></div>
<div class="fs-tool-listbox"><div class="fs-list fs-tool-list" data-c="list"></div><p class="fs-note fs-tool-empty" data-c="empty">No signatures.</p></div>`,
  mount: (root, host) => {
    rootEl = root;
    hostRef = host;
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-c]');
      if (!b || b.disabled) return;
      const c = b.dataset.c;
      if (c === 'new') void newId();
      else if (c === 'import') void importId();
      else if (c === 'pic') void choosePicture();
      else if (c === 'sign') startSign(host);
      else if (c === 'trust' || c === 'version') void listAction(host, c, Number(b.closest<HTMLElement>('.fs-sig-row')?.dataset.index ?? -1));
    });
    void loadIds();
    void loadReport(host);
  },
  sync: (_root, host) => { void loadReport(host); sync(); },
  page: (pv: PageView) => layers.mount(pv),
  commands: (host) => [
    { id: 'tool-certsign', label: 'Sign with a digital ID', words: ['certificate signature', 'digital id'], enabled: () => !!host.doc(), run: () => { host.setTab('fill'); rootEl?.querySelector<HTMLElement>('[data-c="pw"]')?.focus(); } },
    { id: 'tool-sig-new-id', label: 'New digital ID…', words: ['certificate', 'self-signed'], run: () => void newId() },
  ],
});

let reqRoot: HTMLElement | null = null;
let people: Array<{ key: string; name: string; email: string }> = [{ key: 'p1', name: '', email: '' }];
let seq = 1;

function syncRequest(): void {
  const root = reqRoot, host = hostRef;
  if (!root || !host) return;
  patchList(q(root, '[data-r="people"]'), people, {
    key: (p) => p.key,
    create: (p) => {
      const n = el(`<div class="fs-sig-person" data-key="${p.key}"><span class="fs-sig-order"></span><input class="fs-input" type="text" data-r="name" placeholder="Name" aria-label="Signer name"><input class="fs-input" type="email" data-r="email" placeholder="Email" aria-label="Signer email"><button class="fs-icon-btn is-sm" type="button" data-r="drop" title="Remove signer" aria-label="Remove signer">${icon('close', 14)}</button></div>`);
      q<HTMLInputElement>(n, '[data-r="name"]').value = p.name;
      q<HTMLInputElement>(n, '[data-r="email"]').value = p.email;
      return n;
    },
    update: (n) => { setText(q(n, '.fs-sig-order'), `${people.findIndex((x) => x.key === n.dataset.key) + 1}.`); },
  });
  for (const n of Array.from(root.querySelectorAll<HTMLElement>('.fs-sig-person'))) setText(q(n, '.fs-sig-order'), `${people.findIndex((x) => x.key === n.dataset.key) + 1}.`);
  const req = report?.request ?? null;
  const rows = req?.signers ?? [];
  patchList(q(root, '[data-r="status"]'), rows, {
    key: (p) => `${p.order}|${p.field}`,
    create: (p) => {
      const n = el(`<div class="fs-row fs-tool-row"><span class="fs-row-icon"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span><span class="fs-tool-acts"><button class="fs-icon-btn is-sm" type="button" data-r="mail" title="Write an email asking them to sign" aria-label="Write an email asking them to sign">${icon('send', 14)}</button></span></div>`);
      fillStatus(n, p);
      return n;
    },
    update: fillStatus,
  });
  setHidden(q(root, '[data-r="statusbox"]'), !req);
  const empty = report?.empty.length ?? 0;
  setText(q(root, '[data-r="note"]'), req ? (req.done ? 'Everyone has signed.' : `Waiting for ${req.next?.name ?? 'the next signer'}. Send them the latest signed copy, then bring their signed copy back here.`)
    : `Signers sign one after another, each in their own signature field. This PDF has ${empty} empty signature field${empty === 1 ? '' : 's'}; add more in Prepare form > Signature.`);
  setDisabled(q<HTMLButtonElement>(root, '[data-r="prepare"]'), !host.doc());
  setDisabled(q<HTMLButtonElement>(root, '[data-r="join"]'), !host.doc());
}

function fillStatus(n: HTMLElement, p: { order: number; name: string; email: string; field: string; state: string; signedBy?: string; verdict?: string }): void {
  const ico = q(n, '.fs-row-icon');
  const name = p.state === 'signed' ? 'success' : p.state === 'next' ? 'send' : 'history';
  if (ico.dataset.v !== name) { ico.innerHTML = icon(name, 14); ico.dataset.v = name; }
  setText(q(n, '.fs-row-title'), `${p.order}. ${p.name}`);
  setText(q(n, '.fs-row-sub'), p.state === 'signed' ? `Signed${p.signedBy && p.signedBy !== p.name ? ` by ${p.signedBy}` : ''} in ${p.field}` : p.state === 'next' ? `Next to sign, in ${p.field}${p.email ? ` · ${p.email}` : ''}` : `Waiting, in ${p.field}`);
  n.dataset.order = String(p.order);
  setDisabled(q<HTMLButtonElement>(n, '[data-r="mail"]'), p.state === 'signed' || !p.email);
}

function readPeople(): void {
  if (!reqRoot) return;
  for (const n of Array.from(reqRoot.querySelectorAll<HTMLElement>('.fs-sig-person'))) {
    const p = people.find((x) => x.key === n.dataset.key);
    if (p) { p.name = q<HTMLInputElement>(n, '[data-r="name"]').value; p.email = q<HTMLInputElement>(n, '[data-r="email"]').value; }
  }
}

async function prepare(host: ToolHost): Promise<void> {
  readPeople();
  const d = host.doc();
  const list = people.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), email: p.email.trim() }));
  if (!d || !list.length) { toast('Add at least one signer with a name', 'error'); return; }
  const message = reqRoot ? q<HTMLTextAreaElement>(reqRoot, '[data-r="message"]').value : '';
  await host.ctx.run('Preparing the request', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      await host.ctx.commit(await pdfApi.act<Derived>(id, 'request_signatures', { signers: list, message }), 'Request signatures');
      toast('Request prepared. Save the PDF, then send it to the first signer.');
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  await loadReport(host, true);
}

function mail(host: ToolHost, order: number): void {
  const d = host.doc();
  const p = report?.request?.signers.find((x) => x.order === order);
  if (!d || !p?.email) return;
  const msg = report?.request?.message?.trim();
  const body = `${msg ? `${msg}\n\n` : ''}Please sign ${d.name}. Open the attached PDF, sign with your digital ID in the field ${p.field}, and send the signed copy back to me.\n\nAttach the latest saved copy of the PDF to this email before sending.`;
  const url = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(`Please sign: ${d.name}`)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function join(host: ToolHost): Promise<void> {
  const d = host.doc();
  if (!d) return;
  const f = await pickFile('application/pdf,.pdf');
  if (!f) return;
  await host.ctx.run('Bringing in the signed copy', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      await host.ctx.commit(await pdfApi.joinCopy(id, f), 'Bring in a signed copy');
      toast(`Brought in the signatures from ${f.name}.`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  await loadReport(host, true);
}

registerTool({
  id: 'sigrequest',
  tab: 'fill',
  title: 'Request signatures',
  words: ['request signatures', 'send for signature', 'signers', 'sign in order', 'routing'],
  section: () => `<p class="fs-note fs-tool-note" data-r="note">Signers sign one after another, each in their own signature field.</p>
<div class="fs-sig-people" data-r="people"></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-r="add">${icon('add', 14)}Add signer</button></div>
<label class="fs-field is-stack fs-tool-field"><span>Message (optional)</span><textarea class="fs-input fs-sig-msg" data-r="message" rows="3"></textarea></label>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-r="prepare">${icon('signature', 14)}Prepare request</button><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-r="join">${icon('upload', 14)}Bring in a signed copy…</button></div>
<div data-r="statusbox" hidden><div class="fs-pdfwb-subhead">Signers</div><div class="fs-list fs-tool-list" data-r="status"></div></div>`,
  mount: (root, host) => {
    reqRoot = root;
    hostRef ??= host;
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-r]');
      if (!b || b.disabled) return;
      const r = b.dataset.r;
      if (r === 'add') { readPeople(); seq += 1; people = [...people, { key: `p${seq}`, name: '', email: '' }]; syncRequest(); }
      else if (r === 'drop') { readPeople(); const k = b.closest<HTMLElement>('.fs-sig-person')?.dataset.key; people = people.length > 1 ? people.filter((p) => p.key !== k) : people; syncRequest(); }
      else if (r === 'prepare') void prepare(host);
      else if (r === 'join') void join(host);
      else if (r === 'mail') mail(host, Number(b.closest<HTMLElement>('[data-order]')?.dataset.order ?? 0));
    });
    syncRequest();
  },
  sync: () => syncRequest(),
  commands: (host) => [
    { id: 'tool-sigrequest', label: 'Request signatures', words: ['send for signature', 'signers'], enabled: () => !!host.doc(), run: () => host.setTab('fill') },
  ],
});
