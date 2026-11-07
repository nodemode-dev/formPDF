import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const W = 612;
const H = 792;
const INK = rgb(0.1, 0.11, 0.14);
const MUTE = rgb(0.4, 0.42, 0.47);
const ACCENT = rgb(0.976, 0.451, 0.086);
const SEA = rgb(0.1, 0.32, 0.5);

interface Fonts { sans: PDFFont; bold: PDFFont; serif: PDFFont; serifBold: PDFFont; mono: PDFFont }

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function paragraph(page: PDFPage, text: string, font: PDFFont, x: number, y: number, size: number, width: number, gap = 1.45): number {
  for (const line of wrap(text, font, size, width)) {
    page.drawText(line, { x, y, size, font, color: INK });
    y -= size * gap;
  }
  return y;
}

function header(page: PDFPage, f: Fonts, n: number, kicker: string): void {
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: ACCENT });
  page.drawText(`${String(n - 1).padStart(2, '0')}  ${kicker.toUpperCase()}`, { x: 56, y: H - 44, size: 8.5, font: f.bold, color: ACCENT });
  page.drawText('Harbor Light Field Guide', { x: W - 56 - f.sans.widthOfTextAtSize('Harbor Light Field Guide', 8.5), y: H - 44, size: 8.5, font: f.sans, color: MUTE });
  page.drawLine({ start: { x: 56, y: H - 54 }, end: { x: W - 56, y: H - 54 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.82) });
}

function cover(doc: PDFDocument, f: Fonts): void {
  const p = doc.addPage([W, H]);
  const bands = 24;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    p.drawRectangle({ x: 0, y: H - (i + 1) * (H * 0.62 / bands), width: W, height: H * 0.62 / bands + 1, color: rgb(0.08 + 0.55 * t, 0.2 + 0.4 * t, 0.42 + 0.2 * t) });
  }
  p.drawCircle({ x: 430, y: 520, size: 52, color: rgb(1, 0.82, 0.5), opacity: 0.95 });
  for (let i = 0; i < 6; i++) {
    const y = 330 - i * 14;
    p.drawRectangle({ x: 0, y: y - 14, width: W, height: 14, color: rgb(0.05 + i * 0.012, 0.18 + i * 0.02, 0.32 + i * 0.03) });
  }
  p.drawRectangle({ x: 150, y: 300, width: 38, height: 150, color: rgb(0.96, 0.96, 0.94) });
  p.drawRectangle({ x: 150, y: 370, width: 38, height: 22, color: ACCENT });
  p.drawRectangle({ x: 144, y: 450, width: 50, height: 16, color: rgb(0.2, 0.2, 0.24) });
  p.drawRectangle({ x: 154, y: 466, width: 30, height: 20, color: rgb(1, 0.9, 0.55) });
  p.drawLine({ start: { x: 184, y: 476 }, end: { x: 330, y: 500 }, thickness: 1.5, color: rgb(1, 0.9, 0.55), opacity: 0.6 });
  p.drawRectangle({ x: 0, y: 0, width: W, height: H * 0.38, color: rgb(0.07, 0.09, 0.12) });
  p.drawText('Harbor Light', { x: 56, y: 232, size: 44, font: f.serifBold, color: rgb(0.97, 0.97, 0.97) });
  p.drawText('Field Guide', { x: 56, y: 186, size: 44, font: f.serif, color: rgb(0.97, 0.97, 0.97) });
  p.drawText('Tides, lighthouses and the small harbors of a working coast', { x: 58, y: 150, size: 12, font: f.sans, color: rgb(0.75, 0.77, 0.82) });
  p.drawRectangle({ x: 58, y: 118, width: 48, height: 3, color: ACCENT });
  p.drawText('A procedurally generated sample document for the formpdf demo', { x: 58, y: 90, size: 9, font: f.sans, color: rgb(0.55, 0.57, 0.62) });
}

function story(doc: PDFDocument, f: Fonts): void {
  const p = doc.addPage([W, H]);
  header(p, f, 2, 'Chapter one');
  p.drawText('Where the land runs out', { x: 56, y: H - 110, size: 28, font: f.serifBold, color: INK });
  const body = [
    'The lighthouse at Harbor Point has stood on the same rock since the tide tables were first written by hand. Keepers came and went, but the lamp never failed, and the beam still sweeps the bay every twelve seconds.',
    'Walk the old path at low tide and the harbor shows its other face: moored boats lean on the mud, gulls work the tide line, and the fish market opens before the light has fully gone out. Bring boots, and bring patience.',
    'Between the breakwater and the lighthouse lies a mile of shingle. It is the best place on the coast to watch the water change its mind, and the only place where the foghorn can be heard from both sides of the bay.',
  ];
  let y = H - 150;
  for (const t of body) y = paragraph(p, t, f.serif, 56, y, 11.5, 500, 1.55) - 12;
  p.drawRectangle({ x: 56, y: y - 90, width: 500, height: 80, color: rgb(0.95, 0.96, 0.98) });
  p.drawRectangle({ x: 56, y: y - 90, width: 4, height: 80, color: ACCENT });
  p.drawText('Field note', { x: 76, y: y - 30, size: 9, font: f.bold, color: ACCENT });
  paragraph(p, 'Arrive an hour before low water. The causeway to the light is dry for about two hours either side of the lowest tide.', f.sans, 76, y - 48, 11, 460);
}

function chart(doc: PDFDocument, f: Fonts): void {
  const p = doc.addPage([W, H]);
  header(p, f, 3, 'Tide tables');
  p.drawText('Mean high water by month', { x: 56, y: H - 110, size: 24, font: f.serifBold, color: INK });
  const data = [4.1, 4.3, 4.8, 5.2, 5.6, 5.9, 6.1, 5.8, 5.4, 4.9, 4.4, 4.2];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const x0 = 90, y0 = 420, cw = 440, ch = 220;
  for (let g = 0; g <= 6; g++) {
    const gy = y0 + (ch / 6) * g;
    p.drawLine({ start: { x: x0, y: gy }, end: { x: x0 + cw, y: gy }, thickness: 0.4, color: rgb(0.85, 0.86, 0.88) });
    p.drawText(`${g} m`, { x: x0 - 30, y: gy - 3, size: 8, font: f.sans, color: MUTE });
  }
  const bw = cw / data.length;
  data.forEach((v, i) => {
    const h = (v / 6.5) * ch;
    p.drawRectangle({ x: x0 + i * bw + 5, y: y0, width: bw - 10, height: h, color: i === 6 ? ACCENT : SEA });
    p.drawText(String(v), { x: x0 + i * bw + 8, y: y0 + h + 4, size: 8, font: f.sans, color: INK });
    p.drawText(months[i], { x: x0 + i * bw + 9, y: y0 - 14, size: 8, font: f.sans, color: MUTE });
  });
  paragraph(p, 'The July peak is the spring high of the year. Every figure is the mean height above chart datum at Harbor Point, in metres, averaged over ten seasons of tide gauge readings.', f.sans, 56, 340, 11, 500);
}

function table(doc: PDFDocument, f: Fonts): void {
  const p = doc.addPage([W, H]);
  header(p, f, 4, 'Harbors');
  p.drawText('Harbors on the coast road', { x: 56, y: H - 110, size: 24, font: f.serifBold, color: INK });
  const rows: Array<[string, string, string, string]> = [
    ['Harbor', 'Moorings', 'Fuel', 'Open'],
    ['Harbor Point', '48', 'Yes', 'All year'],
    ['Saltmarsh Quay', '22', 'No', 'Apr to Oct'],
    ['Gull Rock', '15', 'Yes', 'All year'],
    ['Pilot Cove', '60', 'Yes', 'All year'],
    ['Lantern Bay', '9', 'No', 'May to Sep'],
    ['Old Mole', '31', 'Yes', 'All year'],
  ];
  const cols = [56, 250, 340, 420];
  rows.forEach((r, i) => {
    const y = H - 160 - i * 30;
    if (i === 0) p.drawRectangle({ x: 56, y: y - 8, width: 500, height: 26, color: rgb(0.1, 0.11, 0.14) });
    else if (i % 2 === 0) p.drawRectangle({ x: 56, y: y - 8, width: 500, height: 26, color: rgb(0.95, 0.96, 0.98) });
    r.forEach((c, j) => p.drawText(c, { x: cols[j] + 8, y: y, size: 10.5, font: i === 0 ? f.bold : f.sans, color: i === 0 ? rgb(1, 1, 1) : INK }));
  });
  paragraph(p, 'Moorings are counted at the summer peak. Fuel is sold from the harbor office during staffed hours only; call ahead on the working channel before arrival.', f.sans, 56, H - 400, 11, 500);
}

function contact(doc: PDFDocument, f: Fonts): void {
  const p = doc.addPage([W, H]);
  header(p, f, 5, 'Practical');
  p.drawText('Talk to the harbor master', { x: 56, y: H - 110, size: 24, font: f.serifBold, color: INK });
  paragraph(p, 'Search this document for the word tide, lighthouse or harbor. Rotate, reorder, extract or merge its pages from the tabs above, then save the result as a new PDF.', f.sans, 56, H - 150, 12, 500);
  p.drawText('Working channel', { x: 56, y: H - 260, size: 9, font: f.bold, color: ACCENT });
  p.drawText('VHF 16, then 72', { x: 56, y: H - 280, size: 16, font: f.mono, color: INK });
  p.drawText('Office hours', { x: 56, y: H - 330, size: 9, font: f.bold, color: ACCENT });
  p.drawText('Daily, one hour either side of high water', { x: 56, y: H - 350, size: 12, font: f.sans, color: INK });
  p.drawRectangle({ x: 56, y: 90, width: 500, height: 1, color: rgb(0.8, 0.8, 0.82) });
  p.drawText('End of the sample. Open your own PDF to try the same tools on it.', { x: 56, y: 70, size: 9, font: f.sans, color: MUTE });
}

export async function makeSample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  cover(doc, f);
  story(doc, f);
  chart(doc, f);
  table(doc, f);
  contact(doc, f);
  doc.setTitle('Harbor Light Field Guide');
  doc.setAuthor('formpdf demo');
  doc.setProducer('formpdf demo');
  return doc.save();
}
