import { api } from '../io/api';
import { Dialog } from '../ui/dialogs';
import { el, q, setDisabled, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { pdfApi, type ScanCaps, type ScanDevice, type ScanRequest } from './api';

const SOURCE_LABEL: Record<string, string> = { glass: 'Glass', feeder: 'Document feeder', 'feeder, both sides': 'Feeder, both sides' };

function setOptions(sel: HTMLSelectElement, opts: Array<[string, string]>, keep: string): void {
  const html = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = opts.some(([v]) => v === keep) ? keep : opts[0]?.[0] ?? '';
}

class ScanDialog extends Dialog {
  private resolve: ((v: ScanRequest | null) => void) | null = null;
  private devices: ScanDevice[] = [];
  private caps: ScanCaps | null = null;
  private ocrReady = false;
  private openDoc = '';
  private readonly go: HTMLButtonElement;
  private seq = 0;

  constructor() {
    super('Scan', 520);
    this.body.appendChild(el(`<div class="fs-scan">
<p class="fs-note fs-scan-note" data-s="note">Looking for scanners on this computer and your network.</p>
<div class="fs-scan-row"><label class="fs-field is-stack fs-scan-grow"><span>Scanner</span><select data-s="device" aria-label="Scanner"><option value="">Looking…</option></select></label><button class="fs-btn fs-btn-sm" type="button" data-s="refresh">${icon('refresh', 14)}Look again</button></div>
<div class="fs-scan-row"><label class="fs-field is-stack fs-scan-grow"><span>Or a network scanner's address</span><input class="fs-input" type="text" data-s="address" placeholder="192.168.1.20" spellcheck="false"></label><button class="fs-btn fs-btn-sm" type="button" data-s="check">Use</button></div>
<div class="fs-scan-opts">
<label class="fs-field is-stack"><span>Paper from</span><select data-s="source"><option value="glass">Glass</option></select></label>
<label class="fs-field is-stack"><span>Resolution</span><select data-s="dpi"><option value="300">300 dpi</option></select></label>
</div>
<label class="fs-check"><input type="checkbox" data-s="color" checked>Colour</label>
<label class="fs-check"><input type="checkbox" data-s="ocr" checked>Make the scan searchable (OCR)</label>
<label class="fs-check"><input type="checkbox" data-s="into">Add the pages to the end of the open PDF</label>
</div>`));
    this.button('Cancel', 'ghost', () => this.finish(null));
    this.go = this.button('Scan', 'primary', () => this.submit());
    this.onClose = () => this.finish(null);
    this.body.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
      if (t?.dataset.s === 'refresh') void this.look();
      else if (t?.dataset.s === 'check') void this.useAddress();
    });
    q<HTMLSelectElement>(this.body, '[data-s="device"]').addEventListener('change', () => void this.loadCaps({ device: this.val('device') }));
  }

  private val(k: string): string { return q<HTMLInputElement | HTMLSelectElement>(this.body, `[data-s="${k}"]`).value; }
  private note(text: string): void { setText(q(this.body, '[data-s="note"]'), text); }

  ask(openDoc: string): Promise<ScanRequest | null> {
    this.openDoc = openDoc;
    const into = q<HTMLInputElement>(this.body, '[data-s="into"]');
    into.checked = false;
    setDisabled(into, !openDoc);
    void api.capabilities().then((c) => {
      this.ocrReady = !!(c.ocr as { available?: boolean } | undefined)?.available;
      const box = q<HTMLInputElement>(this.body, '[data-s="ocr"]');
      setDisabled(box, !this.ocrReady);
      if (!this.ocrReady) box.checked = false;
    }).catch(() => undefined);
    this.open(q(this.body, '[data-s="device"]'));
    void this.look();
    return new Promise((res) => { this.resolve = res; });
  }

  private async look(): Promise<void> {
    const n = ++this.seq;
    this.note('Looking for scanners on this computer and your network.');
    setDisabled(this.go, true);
    let list: ScanDevice[] = [];
    try { list = (await pdfApi.scanDevices()).devices; } catch { list = []; }
    if (n !== this.seq) return;
    this.devices = list;
    const sel = q<HTMLSelectElement>(this.body, '[data-s="device"]');
    setOptions(sel, list.length ? list.map((d) => [d.id, `${d.name}${d.kind === 'network' ? ` (network${d.address ? `, ${d.address}` : ''})` : ' (connected)'}`]) : [['', 'No scanner found']], sel.value);
    if (list.length) await this.loadCaps({ device: sel.value });
    else this.note('No scanner answered. Check that it is on and on the same network, or type its address below. Scanners connected by USB need their driver (WIA on Windows, SANE on Linux).');
  }

  private async useAddress(): Promise<void> {
    const address = this.val('address').trim();
    if (!address) return;
    await this.loadCaps({ address });
  }

  private async loadCaps(target: { device?: string; address?: string }): Promise<void> {
    const n = ++this.seq;
    this.note('Asking the scanner what it can do.');
    setDisabled(this.go, true);
    try {
      const caps = await pdfApi.scanCaps(target);
      if (n !== this.seq) return;
      this.caps = caps;
      setOptions(q<HTMLSelectElement>(this.body, '[data-s="source"]'), caps.sources.map((s) => [s, SOURCE_LABEL[s] ?? s]), this.val('source'));
      const dpis = caps.dpis.filter((d) => d >= 75 && d <= 1200);
      setOptions(q<HTMLSelectElement>(this.body, '[data-s="dpi"]'), dpis.map((d) => [String(d), `${d} dpi`]), dpis.includes(300) ? '300' : String(dpis[Math.floor(dpis.length / 2)] ?? 300));
      setDisabled(q<HTMLInputElement>(this.body, '[data-s="color"]'), !caps.color);
      this.note(`${caps.name || 'The scanner'} is ready. Put the paper on the glass or in the feeder, then Scan.`);
      setDisabled(this.go, false);
    } catch (err) {
      if (n !== this.seq) return;
      this.caps = null;
      this.note((err as Error).message);
    }
  }

  private submit(): void {
    if (!this.caps) return;
    const req: ScanRequest = {
      device: this.caps.device, source: this.val('source'), dpi: Number(this.val('dpi')) || 300,
      color: q<HTMLInputElement>(this.body, '[data-s="color"]').checked && this.caps.color,
      ocr: this.ocrReady && q<HTMLInputElement>(this.body, '[data-s="ocr"]').checked,
    };
    if (this.openDoc && q<HTMLInputElement>(this.body, '[data-s="into"]').checked) req.into = this.openDoc;
    this.finish(req);
  }

  private finish(v: ScanRequest | null): void {
    const r = this.resolve;
    this.resolve = null;
    this.seq += 1;
    if (this.isOpen) this.close();
    r?.(v);
  }
}

let dialog: ScanDialog | null = null;

export function askScan(openDoc: string): Promise<ScanRequest | null> {
  dialog ??= new ScanDialog();
  return dialog.ask(openDoc);
}
