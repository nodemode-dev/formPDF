import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFObject } from 'pdf-lib';

export interface Perms { print: boolean; copy: boolean; modify: boolean; annotate: boolean; fill: boolean; assemble: boolean }

const subtle = crypto.subtle;
const enc = new TextEncoder();
const cat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};
const rand = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function cbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt']);
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource));
  return pad ? out : out.slice(0, data.length);
}

async function sha(bits: 256 | 384 | 512, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest(`SHA-${bits}`, data as BufferSource));
}

async function hash(pw: Uint8Array, salt: Uint8Array, user: Uint8Array): Promise<Uint8Array> {
  let k = await sha(256, cat(pw, salt, user));
  let e = new Uint8Array(1);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const unit = cat(pw, k, user);
    const k1 = new Uint8Array(unit.length * 64);
    for (let r = 0; r < 64; r++) k1.set(unit, r * unit.length);
    e = await cbc(k.slice(0, 16), k.slice(16, 32), k1, false);
    let m = 0;
    for (let b = 0; b < 16; b++) m += e[b];
    k = await sha(([256, 384, 512] as const)[m % 3], e);
  }
  return k.slice(0, 32);
}

const pwBytes = (s: string): Uint8Array => enc.encode(s.normalize('NFKC')).slice(0, 127);
const zeroIv = new Uint8Array(16);

function permBits(p: Perms): number {
  let v = 0xfffff0c0 | 0;
  if (p.print) v |= (1 << 2) | (1 << 11);
  if (p.modify) v |= 1 << 3;
  if (p.copy) v |= 1 << 4;
  if (p.annotate) v |= 1 << 5;
  if (p.fill) v |= 1 << 8;
  v |= 1 << 9;
  if (p.assemble) v |= 1 << 10;
  return v | 0;
}

export async function protect(bytes: Uint8Array, user: string, owner: string, perms: Perms): Promise<Uint8Array> {
  const first = await PDFDocument.load(bytes, { updateMetadata: false });
  const flat = await PDFDocument.load(await first.save({ useObjectStreams: false }), { updateMetadata: false });
  const ctx = flat.context;
  const fk = rand(32);
  const up = pwBytes(user), op = pwBytes(owner || user + '\u0000owner');
  const uvs = rand(8), uks = rand(8);
  const uh = await hash(up, uvs, new Uint8Array(0));
  const U = cat(uh, uvs, uks);
  const UE = await cbc(await hash(up, uks, new Uint8Array(0)), zeroIv, fk, false);
  const ovs = rand(8), oks = rand(8);
  const O = cat(await hash(op, ovs, U), ovs, oks);
  const OE = await cbc(await hash(op, oks, U), zeroIv, fk, false);
  const P = permBits(perms);
  const pb = new Uint8Array(16);
  new DataView(pb.buffer).setInt32(0, P, true);
  pb.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4);
  pb.set(rand(4), 12);
  const Perms = await cbc(fk, zeroIv, pb, false);
  const seal = async (data: Uint8Array): Promise<Uint8Array> => { const iv = rand(16); return cat(iv, await cbc(fk, iv, data, true)); };
  const strings = async (o: PDFObject): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(hex(await seal(o.asBytes())));
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) o.set(i, await strings(o.get(i))); return o; }
    if (o instanceof PDFDict) { for (const [k, v] of o.entries()) o.set(k, await strings(v)); return o; }
    return o;
  };
  const list = [...ctx.enumerateIndirectObjects()];
  for (const [ref, obj] of list) {
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type instanceof PDFName && type.decodeText() === 'XRef') continue;
      await strings(obj.dict);
      const body = await seal(obj.contents);
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(body.length));
      ctx.assign(ref, PDFRawStream.of(obj.dict, body));
    } else await strings(obj);
  }
  const hx = (b: Uint8Array): PDFHexString => PDFHexString.of(hex(b));
  const std = ctx.obj({ AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 });
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P, O: hx(O), U: hx(U), OE: hx(OE), UE: hx(UE), Perms: hx(Perms),
    CF: ctx.obj({ StdCF: std }), StmF: 'StdCF', StrF: 'StdCF',
  });
  const ref: PDFRef = ctx.register(encDict);
  ctx.trailerInfo.Encrypt = ref;
  const id = hx(rand(16));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  return flat.save({ useObjectStreams: false, addDefaultPage: false });
}

export async function opensWith(bytes: Uint8Array, open: (b: Uint8Array, pw?: string) => Promise<number>, pw: string): Promise<{ ok: boolean; reason: string }> {
  try { await open(bytes, pw || undefined); return { ok: true, reason: '' }; } catch (e) { return { ok: false, reason: e instanceof Error ? e.name : 'Error' }; }
}
