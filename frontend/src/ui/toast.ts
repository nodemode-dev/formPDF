import { el } from './dom';

const timers = new WeakMap<Element, number>();

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const ms = kind === 'error' ? 6000 : 3600, cls = `fs-toast${kind === 'error' ? ' is-error' : ''}`;
  const same = Array.from(root.children).find((n) => n.textContent === text && n.className === cls);
  if (same && !(same as HTMLElement).dataset.gone) {
    window.clearTimeout(timers.get(same));
    timers.set(same, window.setTimeout(() => expire(root, same as HTMLElement), ms));
    return;
  }
  const node = el(`<div class="${cls}" role="status"></div>`);
  node.textContent = text;
  root.appendChild(node);
  timers.set(node, window.setTimeout(() => expire(root, node), ms));
  const live = Array.from(root.children).filter((n) => !(n as HTMLElement).dataset.gone);
  if (live.length > 4) expire(root, live[0] as HTMLElement);
}

function expire(root: HTMLElement, node: HTMLElement): void {
  window.clearTimeout(timers.get(node));
  node.dataset.gone = '1';
  node.style.visibility = 'hidden';
  while (root.lastElementChild && (root.lastElementChild as HTMLElement).dataset.gone) root.lastElementChild.remove();
  if (Array.from(root.children).every((n) => (n as HTMLElement).dataset.gone)) root.replaceChildren();
}
