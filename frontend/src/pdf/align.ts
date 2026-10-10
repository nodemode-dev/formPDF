export type AlignHow = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distH' | 'distV';
export interface Box { key: string; x: number; y: number; w: number; h: number }

export const ALIGN_LABEL: Record<AlignHow, [string, string]> = {
  left: ['alignLeftEdge', 'Align left edges'], center: ['alignHcenterEdge', 'Align centres'], right: ['alignRightEdge', 'Align right edges'],
  top: ['alignTopEdge', 'Align top edges'], middle: ['alignVcenterEdge', 'Align middles'], bottom: ['alignBottomEdge', 'Align bottom edges'],
  distH: ['distributeH', 'Distribute across'], distV: ['distributeV', 'Distribute down'],
};

export const needs = (how: AlignHow): number => (how === 'distH' || how === 'distV' ? 3 : 2);

export function alignMoves(boxes: Box[], how: AlignHow): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  if (boxes.length < needs(how)) return out;
  const minX = Math.min(...boxes.map((b) => b.x)), maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  if (how === 'distH' || how === 'distV') {
    const h = how === 'distH';
    const sorted = [...boxes].sort((a, b) => (h ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2)));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const total = sorted.reduce((s, b) => s + (h ? b.w : b.h), 0);
    const span = h ? last.x + last.w - first.x : last.y + last.h - first.y;
    const gap = (span - total) / (sorted.length - 1);
    let at = h ? first.x : first.y;
    for (const b of sorted) {
      out.set(b.key, { dx: h ? at - b.x : 0, dy: h ? 0 : at - b.y });
      at += (h ? b.w : b.h) + gap;
    }
    return out;
  }
  for (const b of boxes) {
    const dx = how === 'left' ? minX - b.x : how === 'center' ? (minX + maxX) / 2 - (b.x + b.w / 2) : how === 'right' ? maxX - (b.x + b.w) : 0;
    const dy = how === 'top' ? minY - b.y : how === 'middle' ? (minY + maxY) / 2 - (b.y + b.h / 2) : how === 'bottom' ? maxY - (b.y + b.h) : 0;
    out.set(b.key, { dx, dy });
  }
  return out;
}
