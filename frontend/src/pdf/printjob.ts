import { el } from '../ui/dom';
import { isTauri } from './api';
import { openDocument } from './viewer';

type Run = <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;

let busy = false;

export async function printBlob(blob: Blob, run: Run): Promise<void> {
  if (busy) return;
  busy = true;
  const urls: string[] = [];
  const host = el('<div class="fs-pdf-print" aria-hidden="true"></div>');
  const style = document.createElement('style');
  try {
    await run('Preparing to print', async () => {
      const doc = await openDocument(new Uint8Array(await blob.arrayBuffer()));
      let size: [number, number] | null = null;
      let same = true;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        if (!size) size = [base.width, base.height];
        else if (Math.abs(size[0] - base.width) > 0.5 || Math.abs(size[1] - base.height) > 0.5) same = false;
        const viewport = page.getViewport({ scale: Math.min(200 / 72, 4200 / Math.max(base.width, base.height)) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, viewport, intent: 'print' }).promise;
        const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
        canvas.width = 0;
        if (!out) continue;
        const url = URL.createObjectURL(out);
        urls.push(url);
        const img = el<HTMLImageElement>(`<img alt="" src="${url}">`);
        if (viewport.width > viewport.height) img.classList.add('is-wide');
        host.appendChild(img);
      }
      await doc.cleanup();
      await doc.loadingTask.destroy();
      if (same && size) {
        style.textContent = `@page { size: ${size[0].toFixed(2)}pt ${size[1].toFixed(2)}pt; margin: 0; }`;
        document.head.appendChild(style);
      }
      document.body.appendChild(host);
      await Promise.all(Array.from(host.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)));
    });
    if (!host.isConnected) return;
    document.body.classList.add('fs-printing-pdf');
    if (isTauri()) {
      const done = new Promise<void>((r) => { window.addEventListener('afterprint', () => r(), { once: true }); window.setTimeout(r, 30000); });
      const core = await import('@tauri-apps/api/core');
      await core.invoke('print_window', { label: 'main' }).catch(() => window.print());
      await done;
    } else window.print();
  } finally {
    document.body.classList.remove('fs-printing-pdf');
    host.remove();
    style.remove();
    for (const u of urls) URL.revokeObjectURL(u);
    busy = false;
  }
}
