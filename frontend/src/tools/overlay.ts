import { el } from '../ui/dom';
import type { PageView } from '../pdf/viewer';

const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();
export const calc = (v: number): string => `calc(var(--k) * ${n2(v)}px)`;

export class PageLayers {
  private readonly layers = new Map<number, HTMLElement>();

  constructor(private readonly name: string, private readonly paint: (index: number, layer: HTMLElement) => void) {}

  mount(pv: PageView): void {
    let layer = this.layers.get(pv.index);
    if (!layer || !pv.space.contains(layer)) {
      layer = el(`<div class="fs-pdf-tool" data-layer="${this.name}"></div>`);
      pv.space.appendChild(layer);
      this.layers.set(pv.index, layer);
    }
    this.paint(pv.index, layer);
  }

  repaint(pages?: Iterable<number>): void {
    const which = pages ? new Set(pages) : null;
    for (const [i, layer] of this.layers) if (!which || which.has(i)) this.paint(i, layer);
  }
}

export function place(node: HTMLElement, x: number, y: number, w: number, h: number): void {
  const style = `left:${calc(x)};top:${calc(y)};width:${calc(w)};height:${calc(h)}`;
  if (node.getAttribute('style') !== style) node.setAttribute('style', style);
}
