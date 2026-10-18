const WANTED = /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|docx?|docm|dotx?|odt|ott|rtf|txt|pptx?|pptm|ppsx?|potx?|odp|otp|key|xlsx?|xlsm|xlsb|ods|ots|csv|numbers|zip)$/i;
const TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
const LIMIT = 1024 * 1024 * 1024;

export const isZip = (f: File): boolean => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

async function inflate(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(file: File, depth = 0): Promise<File[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file.name} is not a zip file formpdf can read`);
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  if (at === 0xffffffff || count === 0xffff) throw new Error(`${file.name} is a zip64 archive; unzip it first and drop the files`);
  const utf8 = new TextDecoder('utf-8');
  const out: File[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
    const csize = dv.getUint32(at + 20, true), usize = dv.getUint32(at + 24, true);
    const nlen = dv.getUint16(at + 28, true), xlen = dv.getUint16(at + 30, true), clen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const path = utf8.decode(buf.subarray(at + 46, at + 46 + nlen));
    at += 46 + nlen + xlen + clen;
    const base = path.split('/').pop() ?? '';
    if (!base || path.endsWith('/') || path.startsWith('__MACOSX/') || base.startsWith('.') || !WANTED.test(base) || flags & 1) continue;
    if (method !== 0 && method !== 8) continue;
    total += usize;
    if (total > LIMIT) throw new Error(`${file.name} unpacks to more than 1 GB; unzip it first`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data: Uint8Array<ArrayBuffer> = method === 8 ? await inflate(raw) : raw.slice();
    const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    const inner = new File([data], base, { type: TYPES[ext] ?? '' });
    if (ext === 'zip') {
      if (depth < 1) out.push(...(await unzip(inner, depth + 1)));
      continue;
    }
    out.push(inner);
  }
  return out;
}

export async function expandZips(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (isZip(f)) out.push(...(await unzip(f)));
    else out.push(f);
  }
  return out;
}
