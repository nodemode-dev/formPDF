export interface LibDoc { id: string; file: string; title: string; note: string; src: string }

export const LIBRARY: LibDoc[] = [
  { id: 'report-final', file: 'season-report-final.pdf', title: 'Season report, final', note: '4 pages, with contacts and hidden data', src: 'assets/media/report-final.js' },
  { id: 'report-draft', file: 'season-report-draft.pdf', title: 'Season report, earlier draft', note: '4 pages, to compare with the final', src: 'assets/media/report-draft.js' },
  { id: 'apollo-summary', file: 'apollo11-mission-summary.pdf', title: 'Apollo 11 mission summary', note: '12 scanned pages, NASA report excerpt', src: '../../demo/assets/media/apollo-summary.js' },
];

type MediaWindow = Window & { __formpdfMedia?: Record<string, string> };

const decode = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export function loadPack(id: string): Promise<Uint8Array> {
  const w = window as MediaWindow;
  const have = w.__formpdfMedia?.[id];
  if (have) return Promise.resolve(decode(have));
  const doc = LIBRARY.find((d) => d.id === id);
  if (!doc) return Promise.reject(new Error(`${id} is not in the library`));
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = doc.src;
    s.onload = () => {
      const got = w.__formpdfMedia?.[id];
      s.remove();
      if (got) resolve(decode(got)); else reject(new Error(`${id} pack is empty`));
    };
    s.onerror = () => { s.remove(); reject(new Error(`${id} pack did not load`)); };
    document.head.appendChild(s);
  });
}
