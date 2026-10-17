import { el, patchList, setClass, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';

const KEY = 'fs-pdf-sections';
export const REVEAL = 'fs-reveal';

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
}

function store(v: Record<string, string>): void {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { return; }
}

const title = (s: HTMLElement): string => (s.querySelector(':scope > .fs-pdfwb-sec-title')?.childNodes[0]?.textContent ?? '').trim();
const keyOf = (s: HTMLElement): string => s.dataset.section || title(s);

/** Asks the panel to show the section that holds node, from code that has no handle on the panel. */
export function reveal(node: Element | null): void {
  node?.dispatchEvent(new CustomEvent(REVEAL, { bubbles: true }));
}

/** One section of a tab's pane at a time, chosen from a row of chips at the top of the pane, as in formdeck's panel groups. */
export class SectionChips {
  private chosen = load();
  private frame = 0;

  constructor(private readonly root: HTMLElement) {
    new MutationObserver((recs) => {
      if (recs.some((r) => (r.type === 'childList' && (r.target as HTMLElement).classList?.contains('fs-pdfwb-pane'))
        || (r.type === 'attributes' && (r.target as HTMLElement).classList?.contains('fs-pdfwb-sec')))) this.later();
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const chip = t.closest<HTMLElement>('.fs-sec-chip');
      if (chip) { this.pick(chip.closest<HTMLElement>('.fs-pdfwb-pane'), chip.dataset.key ?? ''); return; }
      if (t.closest('.fs-sec-pop')) {
        const pane = t.closest<HTMLElement>('.fs-pdfwb-pane');
        pane?.querySelector<HTMLElement>(':scope > .fs-pdfwb-sec:not(.is-sec-off) [data-ws="pop"]')?.click();
      }
    });
    root.addEventListener(REVEAL, (e) => {
      const s = (e.target as HTMLElement).closest<HTMLElement>('.fs-pdfwb-sec');
      const pane = s?.closest<HTMLElement>('.fs-pdfwb-pane');
      if (s && pane) this.pick(pane, keyOf(s), false);
    });
  }

  private later(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.sync(); });
  }

  private pick(pane: HTMLElement | null, key: string, top = true): void {
    const tab = pane?.dataset.for;
    if (!pane || !tab || !key) return;
    if (this.chosen[tab] !== key) { this.chosen[tab] = key; store(this.chosen); }
    this.sync();
    if (top) pane.closest('.fs-pdfwb-panel')?.scrollTo({ top: 0 });
  }

  sync(): void {
    for (const pane of Array.from(this.root.querySelectorAll<HTMLElement>('.fs-pdfwb-pane'))) {
      if (pane.hidden) continue;
      const secs = Array.from(pane.querySelectorAll<HTMLElement>(':scope > .fs-pdfwb-sec')).filter((s) => !s.hidden && !s.classList.contains('is-ws-off'));
      const docked = secs.filter((s) => !s.classList.contains('is-ws-float') && keyOf(s));
      const multi = docked.length > 1;
      let bar = pane.querySelector<HTMLElement>(':scope > .fs-sec-bar');
      if (!bar && multi) {
        bar = el(`<div class="fs-sec-bar"><div class="fs-sec-chips" role="tablist" aria-label="Sections"></div><button class="fs-icon-btn is-sm fs-sec-pop" type="button" title="Float this section over the pages" aria-label="Float this section over the pages">${icon('maximize', 12)}</button></div>`);
        pane.prepend(bar);
      }
      if (bar) setHidden(bar, !multi);
      setClass(pane, 'has-chips', multi);
      const want = this.chosen[pane.dataset.for ?? ''];
      const active = docked.find((s) => keyOf(s) === want) ?? docked[0];
      for (const s of secs) setClass(s, 'is-sec-off', multi && s !== active && !s.classList.contains('is-ws-float'));
      if (!multi || !bar) continue;
      const paint = (n: HTMLElement, s: HTMLElement): void => {
        setText(n, title(s) || keyOf(s));
        setClass(n, 'is-on', s === active);
        if (n.getAttribute('aria-selected') !== String(s === active)) n.setAttribute('aria-selected', String(s === active));
      };
      patchList(bar.firstElementChild as HTMLElement, docked, {
        key: keyOf,
        create: (s) => { const n = el('<button class="fs-sec-chip" type="button" role="tab"></button>'); paint(n, s); return n; },
        update: paint,
      });
      setHidden(bar.querySelector<HTMLElement>('.fs-sec-pop')!, !active?.dataset.section);
    }
  }
}
