import { escapeHtml } from '../ui/dom';
import type { StampSpec } from './api';

export type StampGroup = 'standard' | 'dynamic' | 'sign' | 'basic';
export interface StampDef { id: string; title: string; group: StampGroup; color: string; spec: StampSpec; dynamic?: boolean }

const GREEN = '#15803D', RED = '#B91C1C', BLUE = '#1D4ED8', SIGN = '#DC2626', AMBER = '#C2410C';
const box = (id: string, title: string, color: string, group: StampGroup = 'standard', dynamic = false): StampDef => ({
  id, title, group, color, dynamic, spec: { label: title.toUpperCase(), shape: 'box', name: title.replace(/[^A-Za-z]/g, '') },
});
const tag = (id: string, title: string, color: string): StampDef => ({ id, title, group: 'sign', color, spec: { label: title.toUpperCase(), shape: 'tag', name: title.replace(/[^A-Za-z]/g, '') } });

export const STAMPS: StampDef[] = [
  box('approved', 'Approved', GREEN), box('not-approved', 'Not Approved', RED), box('draft', 'Draft', BLUE), box('final', 'Final', GREEN),
  box('completed', 'Completed', GREEN), box('confidential', 'Confidential', RED), box('public', 'For Public Release', GREEN),
  box('not-public', 'Not For Public Release', RED), box('comment', 'For Comment', BLUE), box('void', 'Void', RED),
  box('preliminary', 'Preliminary Results', BLUE), box('info', 'Information Only', BLUE),
  box('d-approved', 'Approved', GREEN, 'dynamic', true), box('d-reviewed', 'Reviewed', BLUE, 'dynamic', true), box('d-received', 'Received', BLUE, 'dynamic', true),
  box('d-revised', 'Revised', AMBER, 'dynamic', true),
  tag('sign-here', 'Sign Here', SIGN), tag('initial-here', 'Initial Here', AMBER), tag('witness', 'Witness', BLUE), tag('accepted', 'Accepted', GREEN), tag('rejected', 'Rejected', RED),
  { id: 'check', title: 'Check mark', group: 'basic', color: GREEN, spec: { label: '', shape: 'mark', mark: 'check', name: 'Check' } },
  { id: 'cross', title: 'Cross', group: 'basic', color: RED, spec: { label: '', shape: 'mark', mark: 'cross', name: 'Cross' } },
];

let ctx: CanvasRenderingContext2D | null = null;
function width(text: string, bold: boolean): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx || !text) return text.length * 0.6;
  ctx.font = `${bold ? 700 : 400} 100px Helvetica, Arial, sans-serif`;
  return ctx.measureText(text).width / 100;
}

const fit = (text: string, size: number, room: number, bold = true): number => { const w = width(text, bold); return w > 0 ? Math.max(3, Math.min(size, room / w)) : size; };
const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();

function darker(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round(x * 0.78).toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

export function dynamicLine(name: string, when = new Date()): string {
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = when.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return `By ${name.trim() || 'Reviewer'} at ${time}, ${date}`;
}

export function stampSize(spec: StampSpec): { w: number; h: number } {
  if (spec.shape === 'mark') return { w: 26, h: 26 };
  if (spec.shape === 'tag') {
    const h = 34, tip = h * 0.42;
    return { w: Math.round(tip + width(spec.label, true) * h * 0.46 + h * 0.5), h };
  }
  const h = spec.sub ? 52 : 40, lw = Math.max(0.8, h * 0.055), pad = h * 0.24 + lw * 2.2;
  const inner = spec.sub ? Math.max(width(spec.label, true) * h * 0.38, width(spec.sub, false) * h * 0.15) : width(spec.label, true) * h * 0.5;
  return { w: Math.round(Math.max(h * 2.2, inner + 2 * pad + 2)), h };
}

export function stampSvg(spec: StampSpec, color: string, cw: number, ch: number, opacity = 1): string {
  const c = escapeHtml(color);
  const font = 'font-family="Helvetica, Arial, sans-serif"';
  if (spec.shape === 'mark') {
    const sw = Math.max(1, Math.min(cw, ch) * 0.14);
    const d = spec.mark === 'cross'
      ? `M${n2(cw * 0.2)} ${n2(ch * 0.2)}L${n2(cw * 0.8)} ${n2(ch * 0.8)}M${n2(cw * 0.8)} ${n2(ch * 0.2)}L${n2(cw * 0.2)} ${n2(ch * 0.8)}`
      : `M${n2(cw * 0.14)} ${n2(ch * 0.55)}L${n2(cw * 0.4)} ${n2(ch * 0.8)}L${n2(cw * 0.88)} ${n2(ch * 0.22)}`;
    return `<svg viewBox="0 0 ${n2(cw)} ${n2(ch)}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${c}" stroke-opacity="${opacity}" stroke-width="${n2(sw)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const lw = Math.max(0.8, ch * 0.055);
  const label = escapeHtml(spec.label);
  if (spec.shape === 'tag') {
    const tip = ch * 0.42;
    const size = fit(spec.label, ch * 0.46, cw - tip - ch * 0.3);
    const pts = [[lw / 2, ch / 2], [tip, lw / 2], [cw - lw / 2, lw / 2], [cw - lw / 2, ch - lw / 2], [tip, ch - lw / 2]].map((p) => p.map(n2).join(',')).join(' ');
    return `<svg viewBox="0 0 ${n2(cw)} ${n2(ch)}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts}" fill="${c}" fill-opacity="${n2(opacity * 0.92)}" stroke="${darker(color)}" stroke-opacity="${opacity}" stroke-width="${n2(lw * 0.6)}" stroke-linejoin="round"/><text x="${n2((tip + cw) / 2)}" y="${n2(ch / 2 + size * 0.35)}" text-anchor="middle" ${font} font-weight="700" font-size="${n2(size)}" fill="#fff" fill-opacity="${opacity}">${label}</text></svg>`;
  }
  const r = Math.min(ch * 0.2, cw * 0.2), inset = lw * 2.2, pad = ch * 0.24 + inset;
  let text: string;
  if (spec.sub) {
    const ls = fit(spec.label, ch * 0.38, cw - 2 * pad), ss = fit(spec.sub, ch * 0.15, cw - 2 * pad, false);
    text = `<text x="${n2(cw / 2)}" y="${n2(ch / 2 - ch * 0.06)}" text-anchor="middle" ${font} font-weight="700" font-size="${n2(ls)}" fill="${c}" fill-opacity="${opacity}">${label}</text><text x="${n2(cw / 2)}" y="${n2(ch / 2 + ch * 0.28)}" text-anchor="middle" ${font} font-size="${n2(ss)}" fill="${c}" fill-opacity="${opacity}">${escapeHtml(spec.sub)}</text>`;
  } else {
    const ls = fit(spec.label, ch * 0.5, cw - 2 * pad);
    text = `<text x="${n2(cw / 2)}" y="${n2(ch / 2 + ls * 0.35)}" text-anchor="middle" ${font} font-weight="700" font-size="${n2(ls)}" fill="${c}" fill-opacity="${opacity}">${label}</text>`;
  }
  return `<svg viewBox="0 0 ${n2(cw)} ${n2(ch)}" preserveAspectRatio="none" aria-hidden="true"><rect x="${n2(lw / 2)}" y="${n2(lw / 2)}" width="${n2(cw - lw)}" height="${n2(ch - lw)}" rx="${n2(r)}" fill="${c}" fill-opacity="${n2(opacity * 0.08)}" stroke="${c}" stroke-opacity="${opacity}" stroke-width="${n2(lw)}"/><rect x="${n2(inset)}" y="${n2(inset)}" width="${n2(cw - 2 * inset)}" height="${n2(ch - 2 * inset)}" rx="${n2(r * 0.7)}" fill="none" stroke="${c}" stroke-opacity="${opacity}" stroke-width="${n2(lw * 0.45)}"/>${text}</svg>`;
}

const GROUPS: Array<[StampGroup, string]> = [['standard', 'Standard business'], ['dynamic', 'Dynamic, with your name and the time'], ['sign', 'Sign here'], ['basic', 'Marks']];

export function paletteHtml(sample: string): string {
  return GROUPS.map(([g, title]) => {
    const items = STAMPS.filter((s) => s.group === g).map((s) => {
      const spec = s.dynamic ? { ...s.spec, sub: sample } : s.spec;
      const { w, h } = stampSize(spec);
      return `<button class="fs-pdfwb-stamp${s.spec.shape === 'mark' ? ' is-mark' : ''}" type="button" data-a="stamp" data-stamp="${s.id}" title="${escapeHtml(s.title)}${s.dynamic ? ' (dynamic)' : ''}" aria-label="${escapeHtml(s.title)} stamp">${stampSvg(spec, s.color, w, h)}</button>`;
    }).join('');
    return `<div class="fs-pdfwb-subhead">${title}</div><div class="fs-pdfwb-stamps" data-group="${g}">${items}</div>`;
  }).join('');
}
