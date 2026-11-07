import type { Block, Pic } from './engine';

const te = new TextEncoder();
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    const head = new Uint8Array(lh.buffer);
    parts.push(head, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += head.length + name.length + f.data.length;
  }
  const size = central.reduce((n, x) => n + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}

const b64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function toText(blocks: Block[]): string {
  return blocks.map((b) => (b.kind === 'table' ? (b.rows ?? []).map((r) => r.join('\t')).join('\n') : b.kind === 'image' ? '' : b.text ?? '')).filter(Boolean).join('\n\n') + '\n';
}

export function toMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'h1') out.push(`# ${b.text}`);
    else if (b.kind === 'h2') out.push(`## ${b.text}`);
    else if (b.kind === 'p') out.push(b.text ?? '');
    else if (b.kind === 'table') {
      const rows = b.rows ?? [];
      out.push([`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n'));
    }
  }
  return out.join('\n\n') + '\n';
}

export function toHtml(blocks: Block[], pics: Pic[], title: string): string {
  const body = blocks.map((b) => {
    if (b.kind === 'h1') return `<h1>${esc(b.text ?? '')}</h1>`;
    if (b.kind === 'h2') return `<h2>${esc(b.text ?? '')}</h2>`;
    if (b.kind === 'p') return `<p>${esc(b.text ?? '')}</p>`;
    if (b.kind === 'table') {
      const rows = b.rows ?? [];
      return `<table><thead><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    const p = pics[b.image ?? 0];
    return p ? `<figure><img alt="" src="data:image/jpeg;base64,${b64(p.bytes)}"></figure>` : '';
  }).join('\n');
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{max-width:42rem;margin:2rem auto;padding:0 1rem;font:16px/1.55 Georgia,serif;color:#1d1d1d}h1{font-size:2rem}h2{font-size:1.4rem;margin-top:2rem}table{border-collapse:collapse;width:100%;font:14px sans-serif}td,th{border-bottom:1px solid #ccc;padding:.35rem .5rem;text-align:left}figure{margin:1.5rem 0}img{max-width:100%;height:auto}</style></head><body>\n${body}\n</body></html>\n`;
}

const rtfText = (s: string): string => Array.from(s, (c) => {
  const n = c.codePointAt(0) as number;
  if (c === '\\' || c === '{' || c === '}') return `\\${c}`;
  return n > 126 ? `\\u${n > 32767 ? n - 65536 : n}?` : c;
}).join('');

export function toRtf(blocks: Block[], pics: Pic[]): string {
  const out: string[] = ['{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Georgia;}{\\f1 Arial;}}\\f0\\fs22'];
  for (const b of blocks) {
    if (b.kind === 'h1') out.push(`{\\pard\\sa200\\b\\fs48 ${rtfText(b.text ?? '')}\\par}`);
    else if (b.kind === 'h2') out.push(`{\\pard\\sb200\\sa120\\b\\fs34 ${rtfText(b.text ?? '')}\\par}`);
    else if (b.kind === 'p') out.push(`{\\pard\\sa160 ${rtfText(b.text ?? '')}\\par}`);
    else if (b.kind === 'table') for (const r of b.rows ?? []) out.push(`{\\pard\\f1\\fs20\\tx2400\\tx4800\\tx7200 ${r.map(rtfText).join('\\tab ')}\\par}`);
    else {
      const p = pics[b.image ?? 0];
      if (p) {
        const wt = Math.round(Math.min(p.w, 480) * 15), ht = Math.round((Math.min(p.w, 480) / p.w) * p.h * 15);
        out.push(`{\\pard\\sa160{\\pict\\jpegblip\\picw${p.w}\\pich${p.h}\\picwgoal${wt}\\pichgoal${ht} ${Array.from(p.bytes, (x) => x.toString(16).padStart(2, '0')).join('')}}\\par}`);
      }
    }
  }
  out.push('}');
  return out.join('\n');
}

export function toDocx(blocks: Block[], pics: Pic[], title: string): Uint8Array {
  const used: number[] = [];
  const para = (text: string, style: string): string => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = blocks.map((b) => {
    if (b.kind === 'h1') return para(b.text ?? '', 'Heading1');
    if (b.kind === 'h2') return para(b.text ?? '', 'Heading2');
    if (b.kind === 'p') return para(b.text ?? '', 'Normal');
    if (b.kind === 'table') {
      const rows = b.rows ?? [];
      return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:bottom w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideH w:val="single" w:sz="4" w:color="BBBBBB"/></w:tblBorders></w:tblPr>${rows.map((r, i) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r>${i === 0 ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl><w:p/>`;
    }
    const p = pics[b.image ?? 0];
    if (!p) return '';
    used.push(b.image ?? 0);
    const rid = `rIdImg${used.length}`;
    const cx = Math.round(Math.min(p.w, 480) * 9525 * 1), cy = Math.round((Math.min(p.w, 480) / p.w) * p.h * 9525);
    return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${used.length}" name="Picture ${used.length}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${used.length}" name="p${used.length}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }).join('');
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const styles = `${head}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`;
  const rels = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${used.map((_, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p${i + 1}.jpg"/>`).join('')}</Relationships>`;
  const files = [
    { name: '[Content_Types].xml', data: te.encode(`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`) },
    { name: '_rels/.rels', data: te.encode(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`) },
    { name: 'docProps/core.xml', data: te.encode(`${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`) },
    { name: 'word/document.xml', data: te.encode(`${head}<w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`) },
    { name: 'word/styles.xml', data: te.encode(styles) },
    { name: 'word/_rels/document.xml.rels', data: te.encode(rels) },
    ...used.map((idx, i) => ({ name: `word/media/p${i + 1}.jpg`, data: pics[idx].bytes })),
  ];
  return zip(files);
}
