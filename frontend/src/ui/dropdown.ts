import { el, escapeHtml, setHidden, setText } from './dom';
import { icon } from './icons';

export function enhanceSelect(select: HTMLSelectElement, opts: { search?: string } = {}): void {
  const btn = el<HTMLButtonElement>(`<button class="fs-dd-btn" type="button" aria-haspopup="listbox"><span class="fs-dd-label"></span>${icon('chevronDown', 12)}</button>`);
  const pop = el(`<div class="fs-dd-pop" role="listbox" hidden>${opts.search ? '<input class="fs-dd-search" type="search">' : ''}<div class="fs-dd-list"></div></div>`);
  const list = pop.querySelector('.fs-dd-list') as HTMLElement, search = pop.querySelector('.fs-dd-search') as HTMLInputElement | null;
  if (search) { search.placeholder = opts.search as string; search.setAttribute('aria-label', opts.search as string); }
  btn.setAttribute('aria-label', select.getAttribute('aria-label') ?? '');
  for (const c of Array.from(select.classList)) if (c !== 'fs-dd-native') btn.classList.add(c);
  new MutationObserver(() => label()).observe(select, { childList: true, subtree: true });
  btn.title = select.title;
  select.classList.add('fs-dd-native');
  select.after(btn);
  const host = document.getElementById('overlay-root');
  if (host) host.appendChild(pop); else document.body.appendChild(pop);
  let picked = 0;
  const label = (): void => { setText(btn.querySelector('.fs-dd-label') as HTMLElement, select.selectedOptions[0]?.textContent ?? ''); btn.disabled = select.disabled; };
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') as PropertyDescriptor;
  Object.defineProperty(select, 'value', { configurable: true, get() { return proto.get?.call(select); }, set(v) { proto.set?.call(select, v); label(); } });
  const disabled = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled') as PropertyDescriptor;
  Object.defineProperty(select, 'disabled', { configurable: true, get() { return disabled.get?.call(select); }, set(v) { disabled.set?.call(select, v); label(); } });
  select.addEventListener('change', label);
  const fill = (): void => {
    const q = search?.value.trim().toLowerCase() ?? '';
    list.textContent = '';
    for (const node of Array.from(select.children)) {
      const group = node instanceof HTMLOptGroupElement ? node : null, options = group ? Array.from(group.children) as HTMLOptionElement[] : [node as HTMLOptionElement];
      const shown = options.filter((o) => !q || (o.textContent ?? '').toLowerCase().includes(q));
      if (!shown.length) continue;
      if (group && !q) list.appendChild(el(`<div class="fs-dd-head">${escapeHtml(group.label)}</div>`));
      for (const o of shown) {
        const item = el<HTMLButtonElement>(`<button class="fs-dd-item" type="button" role="option"><span></span>${icon('check', 14)}</button>`);
        setText(item.querySelector('span') as HTMLElement, o.textContent ?? '');
        item.dataset.value = o.value;
        item.classList.toggle('is-chosen', o.value === select.value);
        item.setAttribute('aria-selected', String(o.value === select.value));
        item.addEventListener('click', () => { close(); if (select.value !== o.value) { select.value = o.value; select.dispatchEvent(new Event('change', { bubbles: true })); } });
        list.appendChild(item);
      }
    }
    const items = Array.from(list.querySelectorAll<HTMLElement>('.fs-dd-item'));
    picked = Math.max(0, items.findIndex((i) => i.classList.contains('is-chosen')));
    if (q) picked = 0;
    mark();
  };
  const mark = (): void => { list.querySelectorAll<HTMLElement>('.fs-dd-item').forEach((i, n) => i.classList.toggle('is-picked', n === picked)); };
  const close = (): void => { setHidden(pop, true); btn.setAttribute('aria-expanded', 'false'); };
  const open = (): void => {
    if (search) search.value = '';
    fill();
    setHidden(pop, false);
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect(), h = pop.offsetHeight;
    pop.style.minWidth = `${Math.round(r.width)}px`;
    pop.style.left = `${Math.round(Math.min(r.left, window.innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${Math.round(r.bottom + 4 + h <= window.innerHeight - 4 ? r.bottom + 4 : Math.max(4, r.top - 4 - h))}px`;
    (search ?? (list.querySelector('.is-chosen') as HTMLElement | null) ?? btn).focus();
    (list.querySelector('.is-chosen') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  search?.addEventListener('input', fill);
  pop.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll<HTMLElement>('.fs-dd-item'));
    if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { picked = (picked + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; mark(); items[picked].scrollIntoView({ block: 'nearest' }); } return; }
    if (e.key === 'Enter') { e.preventDefault(); items[picked]?.click(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) close(); }, true);
  label();
}

export function enhanceAllSelects(root: ParentNode = document): void {
  const pick = (n: ParentNode): void => {
    for (const s of Array.from(n.querySelectorAll<HTMLSelectElement>('select:not(.fs-dd-native):not([multiple]):not([size]):not([data-native])'))) enhanceSelect(s);
  };
  pick(root);
  new MutationObserver((records) => {
    for (const r of records) for (const node of Array.from(r.addedNodes)) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLSelectElement) { if (!node.classList.contains('fs-dd-native') && !node.multiple && !node.hasAttribute('size') && !node.hasAttribute('data-native')) enhanceSelect(node); }
      else pick(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
