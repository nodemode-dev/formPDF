import { uid } from '../pdf/annotate';
import type { Annot } from '../pdf/api';

export type DemoId = 'pages' | 'sign' | 'protect';
export interface Anchor { page: number; rects: Array<{ x: number; y: number; w: number; h: number }> }
export interface DemoDef { id: DemoId; title: string; line: string; file: string; tab: 'view' | 'fill' | 'protect'; marks?: boolean; find?: string; art: string }

const page = (x: number, lines: number[]): string => `<rect class="pg" x="${x}" y="14" width="56" height="76" rx="3"/>${lines.map((y, i) => `<rect x="${x + 7}" y="${y}" width="${i % 3 === 2 ? 28 : 42}" height="3" rx="1.5"/>`).join('')}`;
const svg = (body: string): string => `<svg class="fs-home-demo-art" viewBox="0 0 160 104" aria-hidden="true" fill="currentColor">${body}</svg>`;

export const DEMOS: DemoDef[] = [
  { id: 'pages', title: 'Pages and search', line: 'A 53 page illustrated Alice in Wonderland to read, search, organize and number.', file: 'alice-in-wonderland.pdf', tab: 'view',
    art: svg(`${page(22, [52, 60, 68, 76])}<rect class="ac-soft" x="29" y="22" width="42" height="24" rx="2"/>${page(82, [22, 30, 38, 46, 54, 62, 70])}<rect class="ac" x="96" y="37" width="20" height="5" rx="1"/><circle class="ring" cx="122" cy="74" r="11"/><path class="ring" d="M130 82l9 9"/>`) },
  { id: 'sign', title: 'Annotate, fill and sign', line: 'A half filled loan form with comments, ready to fill, sign and stamp.', file: 'telescope-loan-agreement.pdf', tab: 'fill', marks: true,
    art: svg(`<rect class="pg" x="40" y="10" width="80" height="86" rx="3"/><rect x="48" y="18" width="40" height="4" rx="2"/><rect class="ac-soft" x="48" y="28" width="56" height="5" rx="1"/><rect x="48" y="29" width="52" height="3" rx="1.5"/><rect class="box" x="48" y="40" width="30" height="9" rx="1.5"/><rect class="box" x="82" y="40" width="30" height="9" rx="1.5"/><rect class="box" x="48" y="54" width="8" height="8" rx="1.5"/><path class="tick" d="M50 58l2 2 3-4"/><rect x="60" y="57" width="34" height="3" rx="1.5"/><path class="line" d="M48 86h50"/><path class="ink" d="M50 82c4-9 8-9 9-2s4 6 7-3 6-6 7 1 5 3 9-3"/><rect class="ac" x="104" y="24" width="12" height="11" rx="1.5"/>`) },
  { id: 'protect', title: 'Redact, compare, convert', line: 'A season report with contacts and hidden data to redact, clean and protect.', file: 'season-report-final.pdf', tab: 'protect', find: 'email',
    art: svg(`<rect class="pg" x="34" y="10" width="76" height="86" rx="3"/><rect x="42" y="18" width="36" height="4" rx="2"/><rect x="42" y="30" width="58" height="3" rx="1.5"/><rect class="bar" x="42" y="38" width="38" height="6" rx="1"/><rect x="42" y="50" width="58" height="3" rx="1.5"/><rect x="42" y="58" width="30" height="3" rx="1.5"/><rect class="bar" x="76" y="56" width="24" height="6" rx="1"/><rect x="42" y="68" width="58" height="3" rx="1.5"/><rect class="bar" x="42" y="76" width="44" height="6" rx="1"/><rect class="ac" x="104" y="64" width="26" height="22" rx="4"/><path class="shackle" d="M110 64v-6a7 7 0 0 1 14 0v6"/>`) },
];

export function seedLoanMarks(a: Record<string, Anchor>): Annot[] {
  const base = { rot: 0, opacity: 1 };
  const out: Annot[] = [];
  if (a.deposit) out.push({ ...base, id: uid('a'), page: a.deposit.page, kind: 'highlight', color: '#FFD400', opacity: 0.4, rects: a.deposit.rects, quote: 'A refundable deposit of 40 dollars is held until the instrument is returned complete' });
  if (a.deposit) {
    const r0 = a.deposit.rects[0];
    out.push({ ...base, id: uid('a'), page: a.deposit.page, kind: 'note', color: '#FFD400', x: 574, y: r0.y - 4, text: 'Deposit is repaid within seven days of the return. Confirm the amount with the treasurer before pickup.' });
  }
  if (a.sun) out.push({ ...base, id: uid('a'), page: a.sun.page, kind: 'underline', color: '#2563EB', rects: a.sun.rects, quote: 'will never point it at or near the sun' });
  if (a.damage) out.push({ ...base, id: uid('a'), page: a.damage.page, kind: 'squiggly', color: '#16A34A', rects: a.damage.rects, quote: 'Damage from a fall, from water, or from use against these conditions' });
  return out;
}
