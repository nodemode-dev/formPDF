import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFNumber } = require('../../../demo/node_modules/pdf-lib/cjs/index.js');

const W = 612, H = 792, M = 52;
const NAVY = rgb(0.078, 0.129, 0.239), INK = rgb(0.11, 0.12, 0.15), GREY = rgb(0.42, 0.44, 0.5), LINE = rgb(0.82, 0.84, 0.88), AMBER = rgb(0.98, 0.45, 0.09);
const OUT = fileURLToPath(new URL('../assets/media/loan-form.js', import.meta.url));

const doc = await PDFDocument.create();
doc.setTitle('Telescope Loan Agreement');
doc.setAuthor('Harbor Light Observatory Club');
doc.setSubject('Equipment loan form TL-14');
doc.setProducer('formpdf demo generator');
doc.setCreator('formpdf demo generator');
const reg = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const form = doc.getForm();
const pages = [doc.addPage([W, H]), doc.addPage([W, H])];
const anchors = {};
const fieldNames = [];

const T = (y) => H - y;
const wid = (t, f, s) => f.widthOfTextAtSize(t, s);

function text(p, t, x, y, o = {}) {
  p.drawText(t, { x, y: T(y), size: o.size ?? 9.5, font: o.font ?? reg, color: o.color ?? INK });
}

function wrap(t, f, s, max) {
  const words = t.split(' ');
  const lines = [];
  let cur = '', start = 0, pos = 0;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && wid(next, f, s) > max) { lines.push({ text: cur, start }); start = pos; cur = w; } else cur = next;
    pos += w.length + 1;
  }
  if (cur) lines.push({ text: cur, start });
  return lines;
}

function para(p, t, x, y, o = {}) {
  const size = o.size ?? 9.5, lead = o.lead ?? size * 1.5, f = o.font ?? reg, max = o.max ?? W - M - x;
  const lines = wrap(t, f, size, max);
  lines.forEach((ln, i) => text(p, ln.text, x, y + i * lead, { size, font: f, color: o.color }));
  if (o.mark) {
    for (const [key, phrase] of Object.entries(o.mark)) {
      const a = t.indexOf(phrase), b = a + phrase.length;
      const rects = [];
      lines.forEach((ln, i) => {
        const l0 = ln.start, l1 = ln.start + ln.text.length;
        const s = Math.max(a, l0), e = Math.min(b, l1);
        if (e <= s) return;
        const x0 = x + wid(ln.text.slice(0, s - l0), f, size), x1 = x + wid(ln.text.slice(0, e - l0), f, size);
        rects.push({ x: x0, y: y + i * lead - size * 0.82, w: x1 - x0, h: size * 1.2 });
      });
      anchors[key] = { page: o.page, rects };
    }
  }
  return y + lines.length * lead;
}

function rule(p, y, x0 = M, x1 = W - M) {
  p.drawLine({ start: { x: x0, y: T(y) }, end: { x: x1, y: T(y) }, thickness: 0.6, color: LINE });
}

function section(p, n, title, y) {
  p.drawRectangle({ x: M, y: T(y + 14), width: 18, height: 18, color: NAVY });
  text(p, String(n), M + (n > 9 ? 3.5 : 6), y + 10.2, { size: 10, font: bold, color: rgb(1, 1, 1) });
  text(p, title, M + 26, y + 10.4, { size: 11.5, font: bold, color: NAVY });
  rule(p, y + 20);
  return y + 32;
}

function label(p, t, x, y) { text(p, t, x, y, { size: 7.6, font: bold, color: GREY }); }

function boxStyle() {
  return { borderWidth: 0.8, borderColor: rgb(0.58, 0.64, 0.78), backgroundColor: rgb(0.93, 0.95, 1) };
}

function textField(p, name, x, y, w, h, value = '', o = {}) {
  const f = form.createTextField(name);
  if (value) f.setText(value);
  if (o.required) f.enableRequired();
  f.addToPage(p, { x, y: T(y + h), width: w, height: h, textColor: INK, font: reg, ...boxStyle() });
  f.setFontSize(o.size ?? 10);
  fieldNames.push(name);
  return f;
}

function moon(p, cx, cy, r) {
  p.drawCircle({ x: cx, y: T(cy), size: r, color: rgb(0.96, 0.9, 0.7) });
  p.drawCircle({ x: cx + r * 0.42, y: T(cy - r * 0.18), size: r * 0.86, color: NAVY });
}

function header(p) {
  p.drawRectangle({ x: 0, y: T(104), width: W, height: 104, color: NAVY });
  p.drawRectangle({ x: 0, y: T(108), width: W, height: 4, color: AMBER });
  moon(p, M + 18, 52, 17);
  text(p, 'HARBOR LIGHT OBSERVATORY CLUB', M + 52, 40, { size: 8.6, font: bold, color: rgb(0.96, 0.78, 0.5) });
  text(p, 'Telescope Loan Agreement', M + 52, 66, { size: 25, font: bold, color: rgb(1, 1, 1) });
  text(p, 'Form TL-14', W - M - wid('Form TL-14', bold, 9), 40, { size: 9, font: bold, color: rgb(0.8, 0.84, 0.92) });
  text(p, 'Revised January 2026', W - M - wid('Revised January 2026', reg, 8.4), 54, { size: 8.4, color: rgb(0.66, 0.72, 0.84) });
}

function footer(p, n) {
  rule(p, 752);
  text(p, 'Harbor Light Observatory Club  |  Loans desk  |  loans@harborlight.example', M, 768, { size: 8, color: GREY });
  const pn = `Page ${n} of 2`;
  text(p, pn, W - M - wid(pn, reg, 8), 768, { size: 8, color: GREY });
}

const p1 = pages[0], p2 = pages[1];
header(p1);
footer(p1, 1);
footer(p2, 2);

let y = 134;
y = para(p1, 'The club lends telescopes to members so that more people can see the sky for themselves. Complete sections 1 to 3, read the conditions, and sign on page 2. A volunteer will check the instrument with you when you collect it.', M, y, { page: 1, size: 10, color: GREY, max: W - 2 * M });

y = section(p1, 1, 'Borrower', y + 12);
label(p1, 'FULL NAME', M, y); label(p1, 'EMAIL', M + 252, y); y += 5;
textField(p1, 'borrower_name', M, y, 240, 22, 'Ana Rivera', { required: true });
textField(p1, 'borrower_email', M + 252, y, 256, 22, 'ana.rivera@example.org', { required: true });
y += 32;
label(p1, 'PHONE', M, y); label(p1, 'MEMBERSHIP NUMBER', M + 252, y); y += 5;
textField(p1, 'borrower_phone', M, y, 240, 22, '');
textField(p1, 'membership_no', M + 252, y, 140, 22, 'HL-2048');
y += 40;

y = section(p1, 2, 'Equipment', y);
label(p1, 'TELESCOPE', M, y); label(p1, 'INCLUDED WITH THE LOAN', M + 252, y); y += 5;
const dd = form.createDropdown('telescope');
dd.addOptions(['Refractor 80 mm', 'Dobsonian 8 inch', 'Maksutov 127 mm', 'Binocular set 15x70']);
dd.select('Dobsonian 8 inch');
dd.addToPage(p1, { x: M, y: T(y + 22), width: 240, height: 22, textColor: INK, font: reg, ...boxStyle() });
dd.setFontSize(10);
fieldNames.push('telescope');
const checks = [['inc_tripod', 'Tripod or mount', false], ['inc_eyepieces', 'Eyepiece set (25 mm and 10 mm)', true], ['inc_torch', 'Red torch', false], ['inc_case', 'Carry case', true]];
checks.forEach(([name, t, on], i) => {
  const cx = M + 252 + (i % 2) * 132, cy = y + Math.floor(i / 2) * 22 + 2;
  const c = form.createCheckBox(name);
  if (on) c.check();
  c.addToPage(p1, { x: cx, y: T(cy + 14), width: 14, height: 14, ...boxStyle() });
  text(p1, t, cx + 20, cy + 10.5, { size: 9 });
  fieldNames.push(name);
});
y += 40;
label(p1, 'COLLECTION', M, y); y += 8;
const radio = form.createRadioGroup('collection');
radio.addOptionToPage('pickup', p1, { x: M, y: T(y + 14), width: 14, height: 14, ...boxStyle() });
radio.addOptionToPage('delivery', p1, { x: M + 252, y: T(y + 14), width: 14, height: 14, ...boxStyle() });
radio.select('pickup');
text(p1, 'Pick up at the observatory', M + 20, y + 10.5, { size: 9 });
text(p1, 'Delivery by a club volunteer', M + 272, y + 10.5, { size: 9 });
fieldNames.push('collection', 'collection');
y += 38;

y = section(p1, 3, 'Loan period', y);
label(p1, 'LOAN STARTS', M, y); label(p1, 'RETURN BY', M + 176, y); label(p1, 'DEPOSIT (USD)', M + 352, y); y += 5;
textField(p1, 'loan_start', M, y, 164, 22, '14 November 2026');
textField(p1, 'return_by', M + 176, y, 164, 22, '', { required: true });
textField(p1, 'deposit', M + 352, y, 156, 22, '40.00');
y += 44;

y = section(p1, 4, 'Conditions of the loan', y);
y = para(p1, '4.1  The instrument remains the property of the club. It is lent to the named borrower only and may not be passed to anyone else without the written agreement of the loans desk.', M, y, { page: 1, size: 9.4, max: W - 2 * M }) + 5;
y = para(p1, '4.2  A refundable deposit of 40 dollars is held until the instrument is returned complete. The deposit is repaid within seven days of the return.', M, y, { page: 1, size: 9.4, max: W - 2 * M, mark: { deposit: 'A refundable deposit of 40 dollars is held until the instrument is returned complete' } }) + 5;
y = para(p1, '4.3  The borrower will keep the instrument dry and indoors between observing sessions, and will never point it at or near the sun. Solar viewing needs a certified filter that the club supplies on request.', M, y, { page: 1, size: 9.4, max: W - 2 * M, mark: { sun: 'will never point it at or near the sun' } }) + 5;
y = para(p1, '4.4  The instrument must be returned by the date in section 3. A loan may be extended once, by two weeks, if no other member has asked for it.', M, y, { page: 1, size: 9.4, max: W - 2 * M, mark: { returns: 'must be returned by the date in section 3' } });
anchors.endOfPage1 = { page: 1, rects: [{ x: M, y, w: 0, h: 0 }] };

let z = 60;
z = section(p2, 5, 'Care, damage and loss', z);
z = para(p2, '5.1  Lenses and mirrors are never to be cleaned by the borrower. Dust is blown off with the supplied bulb and nothing else touches the glass.', M, z, { page: 2, size: 9.4, max: W - 2 * M }) + 5;
z = para(p2, '5.2  Damage that follows normal use is the club’s to repair. Damage from a fall, from water, or from use against these conditions is charged at the cost of repair, up to the replacement value shown on the equipment label.', M, z, { page: 2, size: 9.4, max: W - 2 * M, mark: { damage: 'Damage from a fall, from water, or from use against these conditions is charged at the cost of repair' } }) + 5;
z = para(p2, '5.3  Loss or theft is reported to the loans desk on the same day. The deposit is kept and the borrower is asked to meet the balance of the replacement value.', M, z, { page: 2, size: 9.4, max: W - 2 * M }) + 5;
z = para(p2, '5.4  The borrower agrees that the club may share name and contact details with the volunteer who delivers or collects the instrument, and with no one else.', M, z, { page: 2, size: 9.4, max: W - 2 * M });

z += 14;
z = section(p2, 6, 'Initials', z);
text(p2, 'Initial each line to show that you have read it.', M, z + 2, { size: 9, color: GREY });
z += 16;
['I will not point the instrument at the sun.', 'I will report damage or loss on the same day.', 'I will return the instrument by the date in section 3.'].forEach((t, i) => {
  textField(p2, `initials_${i + 1}`, M, z, 54, 22, i === 0 ? 'AR' : '', { required: true });
  text(p2, t, M + 66, z + 15, { size: 9.6 });
  z += 30;
});

z += 12;
z = section(p2, 7, 'Declaration and signature', z);
para(p2, 'I have read and accept the conditions in sections 4 to 6 and I confirm that the details in sections 1 to 3 are correct.', M, z, { page: 2, size: 9.6, max: W - 2 * M });
z += 38;
const sigY = z;
label(p2, 'SIGNATURE OF BORROWER', M, z); label(p2, 'DATE SIGNED', M + 340, z); z += 6;
const addSig = (name, x, yy, w, h, required = false) => {
  const ctx = doc.context;
  const blank = ctx.stream('');
  for (const [k, v] of Object.entries({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] })) blank.dict.set(PDFName.of(k), ctx.obj(v));
  const dict = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of(name), Rect: [x, T(yy + h), x + w, T(yy)], F: 4, P: p2.ref, Ff: required ? 2 : 0, AP: { N: ctx.register(blank) } });
  const ref = ctx.register(dict);
  p2.node.addAnnot(ref);
  form.acroForm.addField(ref);
  fieldNames.push(name);
};
addSig('borrower_signature', M, z, 320, 44, true);
p2.drawLine({ start: { x: M, y: T(z + 44) }, end: { x: M + 320, y: T(z + 44) }, thickness: 0.8, color: INK });
textField(p2, 'date_signed', M + 340, z + 22, 168, 22, '', { required: true });
anchors.signature = { page: 2, rects: [{ x: M, y: z, w: 320, h: 44 }] };
anchors.dateSigned = { page: 2, rects: [{ x: M + 340, y: z + 22, w: 168, h: 22 }] };
z += 74;
label(p2, 'WITNESS NAME', M, z); label(p2, 'WITNESS SIGNATURE', M + 252, z); z += 6;
textField(p2, 'witness_name', M, z, 240, 22, '');
addSig('witness_signature', M + 252, z - 22, 256, 44);
p2.drawLine({ start: { x: M + 252, y: T(z + 22) }, end: { x: M + 508, y: T(z + 22) }, thickness: 0.8, color: INK });
anchors.witness = { page: 2, rects: [{ x: M + 252, y: z - 22, w: 256, h: 44 }] };
z += 40;
text(p2, 'Office use only', M, z + 12, { size: 8, font: bold, color: GREY });
rule(p2, z + 18);
text(p2, 'Instrument label  ____________    Checked by  ____________    Date  ____________', M, z + 34, { size: 8.4, color: GREY });

form.updateFieldAppearances(reg);
const bytes = await doc.save();
const b64 = Buffer.from(bytes).toString('base64');
const labels = {
  borrower_name: 'Full name', borrower_email: 'Email', borrower_phone: 'Phone', membership_no: 'Membership number', telescope: 'Telescope',
  inc_tripod: 'Includes tripod or mount', inc_eyepieces: 'Includes eyepiece set', inc_torch: 'Includes red torch', inc_case: 'Includes carry case', collection: 'Collection',
  loan_start: 'Loan starts', return_by: 'Return by', deposit: 'Deposit (USD)', initials_1: 'Initials, sun', initials_2: 'Initials, damage', initials_3: 'Initials, return date',
  borrower_signature: 'Signature of borrower', date_signed: 'Date signed', witness_name: 'Witness name', witness_signature: 'Witness signature',
};
const meta = JSON.stringify({ anchors, labels, fields: fieldNames.length });
writeFileSync(OUT, `window.__formpdfMedia=window.__formpdfMedia||{};window.__formpdfMeta=window.__formpdfMeta||{};window.__formpdfMedia['loan-form']='${b64}';window.__formpdfMeta['loan-form']=${meta};\n`);
console.log(`wrote ${OUT} ${bytes.length} bytes, ${fieldNames.length} fields, sigY ${sigY}`);
