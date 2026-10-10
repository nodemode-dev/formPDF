import { el } from './dom';

const timers = new WeakMap<Element, number>();

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const ms = kind === 'error' ? 6000 : 3600, cls = `fs-toast${kind === 'error' ? ' is-error' : ''}`;
  const same = Array.from(root.children).find((n) => n.textContent === text && n.className === cls);
  if (same) {
    window.clearTimeout(timers.get(same));
    timers.set(same, window.setTimeout(() => same.remove(), ms));
    return;
  }
  const node = el(`<div class="${cls}" role="status"></div>`);
  node.textContent = text;
  root.appendChild(node);
  while (root.children.length > 4) root.firstElementChild?.remove();
  timers.set(node, window.setTimeout(() => node.remove(), ms));
}
