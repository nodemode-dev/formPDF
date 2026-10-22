export type Disposer = () => void;

export function delayedIndicator(show: () => void, hide: () => void, delay = 300, minVisible = 250): Disposer {
  let timer: number | undefined;
  let shownAt = 0;
  timer = window.setTimeout(() => { shownAt = performance.now(); show(); }, delay);
  return () => {
    if (timer !== undefined && shownAt === 0) { clearTimeout(timer); timer = undefined; return; }
    const remaining = Math.max(0, minVisible - (performance.now() - shownAt));
    window.setTimeout(hide, remaining);
  };
}

export function pendingClass(el: HTMLElement, delay = 300, minVisible = 250): Disposer {
  return delayedIndicator(() => el.classList.add('is-shown'), () => el.classList.remove('is-shown'), delay, minVisible);
}

export interface PatchListOptions<T> {
  key: (item: T) => string;
  create: (item: T) => HTMLElement;
  update: (node: HTMLElement, item: T) => void;
}

export function patchList<T>(container: HTMLElement, items: T[], opts: PatchListOptions<T>): void {
  const byKey = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const k = (child as HTMLElement).dataset.key;
    if (k !== undefined) byKey.set(k, child as HTMLElement);
  }
  let cursor: Element | null = container.firstElementChild;
  const seen = new Set<string>();
  for (const item of items) {
    const k = opts.key(item);
    seen.add(k);
    let node = byKey.get(k);
    if (node) {
      opts.update(node, item);
    } else {
      node = opts.create(item);
      node.dataset.key = k;
    }
    if (node !== cursor) container.insertBefore(node, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const [k, node] of byKey) if (!seen.has(k)) node.remove();
}

export function swapMedia(img: HTMLImageElement, nextSrc: string): Promise<void> {
  if (img.src === nextSrc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.decoding = 'async';
    probe.onload = () => {
      if (typeof probe.decode === 'function') {
        probe.decode().catch(() => undefined).then(() => { img.src = nextSrc; resolve(); });
      } else { img.src = nextSrc; resolve(); }
    };
    probe.onerror = () => reject(new Error('media load failed: ' + nextSrc));
    probe.src = nextSrc;
  });
}

export function setText(el: Element | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export function setClass(el: Element | null, cls: string, on: boolean): void {
  if (!el) return;
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function reserve(el: HTMLElement, box: { width?: number; height?: number; minHeight?: number; aspect?: string }): void {
  if (box.width !== undefined) el.style.width = box.width + 'px';
  if (box.height !== undefined) el.style.height = box.height + 'px';
  if (box.minHeight !== undefined) el.style.minHeight = box.minHeight + 'px';
  if (box.aspect) el.style.aspectRatio = box.aspect;
}

export function revealApp(): void {
  if (document.body.classList.contains('app-ready')) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('app-ready');
    if ('__TAURI_INTERNALS__' in window) {
      requestAnimationFrame(() => {
        try {
          void Promise.resolve((window as any).__TAURI_INTERNALS__?.invoke?.('app_ready')).catch(() => undefined);
        } catch {
          return;
        }
      });
    }
  }));
}

export function mountOnce(host: HTMLElement, html: string): void {
  if (host.childElementCount > 0) {
    throw new Error('mountOnce: host already rendered; patch in place instead of rebuilding');
  }
  host.innerHTML = html;
}

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const n = root.querySelector(sel);
  if (!n) throw new Error(`missing element: ${sel}`);
  return n as T;
}

export function setHidden(node: HTMLElement, hidden: boolean): void { if (node.hidden !== hidden) node.hidden = hidden; }
export function setDisabled(node: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, disabled: boolean): void { if (node.disabled !== disabled) node.disabled = disabled; }
export function setTitle(node: HTMLElement, title: string): void { if (node.title !== title) node.title = title; }
export function setStyleVar(node: HTMLElement, name: string, value: string): void { if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value); }
export function setValue(node: HTMLInputElement | HTMLSelectElement, value: string): void { if (node.value !== value && document.activeElement !== node) node.value = value; }
export function setChecked(node: HTMLInputElement, on: boolean): void { if (node.checked !== on) node.checked = on; }
export function setHtml(node: Element, html: string, key: string): void {
  const n = node as HTMLElement;
  if (n.dataset.htmlKey === key) return;
  n.dataset.htmlKey = key;
  const t = document.createElement('template');
  t.innerHTML = html;
  n.replaceChildren(t.content);
}
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
