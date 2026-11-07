export interface LibDoc { id: string; file: string; title: string; note: string }
export interface Anchor { page: number; rects: Array<{ x: number; y: number; w: number; h: number }> }
export interface PackMeta { anchors: Record<string, Anchor>; labels: Record<string, string> }

export const LIBRARY: LibDoc[] = [
  { id: 'loan-form', file: 'telescope-loan-agreement.pdf', title: 'Telescope loan agreement', note: '2 pages, a fillable form with 21 fields' },
  { id: 'apollo-summary', file: 'apollo11-mission-summary.pdf', title: 'Apollo 11 mission summary', note: '12 pages, NASA report excerpt to mark up' },
];

type MediaWindow = Window & { __formpdfMedia?: Record<string, string>; __formpdfMeta?: Record<string, PackMeta> };

const decode = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export function packMeta(id: string): PackMeta | undefined {
  return (window as MediaWindow).__formpdfMeta?.[id];
}

export function loadPack(id: string): Promise<Uint8Array> {
  const w = window as MediaWindow;
  const have = w.__formpdfMedia?.[id];
  if (have) return Promise.resolve(decode(have));
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `assets/media/${id}.js`;
    s.onload = () => {
      const got = w.__formpdfMedia?.[id];
      s.remove();
      if (got) resolve(decode(got)); else reject(new Error(`${id} pack is empty`));
    };
    s.onerror = () => { s.remove(); reject(new Error(`${id} pack did not load`)); };
    document.head.appendChild(s);
  });
}
