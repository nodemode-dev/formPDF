import { api } from '../io/api';
import { record } from './recorder';

const rec = <T>(action: string, args: unknown) => (res: T): T => { record(action, args); return res; };

export interface PageSize { w: number; h: number; rotate: number }
export interface OutlineItem { title: string; page: number | null; level: number }
export interface PdfInfo {
  bytes: number; encrypted: boolean; locked: boolean; pages: number; sizes: PageSize[]; outline: OutlineItem[]; fields: number;
  title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string; created?: string | null; modified?: string | null;
  version?: string; id?: string; name?: string; key?: string; path?: string | null; protected?: boolean; savePath?: string; signed?: boolean;
}
export interface Opened { id: string; name: string; pages: number; info: PdfInfo; key: string; path?: string | null }
export interface Derived { id: string; pages: number; bytes: number; images?: number; before?: number; after?: number }
export interface Identity { id?: string; label?: string; name: string; email: string; org: string; issuer: string; selfSigned: boolean; from: string; to: string; fingerprint: string; der?: string }
export interface SigEntry {
  index: number; field: string; verdict: 'valid' | 'unknown' | 'invalid'; says: string[]; signer?: Identity; time?: string; timestamped?: boolean;
  reason: string; location: string; certified: number; end: number; coversAll: boolean;
}
export interface SigRequestPerson { order: number; name: string; email: string; field: string; state: 'signed' | 'next' | 'waiting'; verdict?: string; signedBy?: string; time?: string }
export interface SigReport { signatures: SigEntry[]; empty: Array<{ field: string; tooltip: string }>; request: { signers: SigRequestPerson[]; message: string; next: SigRequestPerson | null; done: boolean } | null }
export interface ScanDevice { id: string; name: string; kind: 'network' | 'usb'; address?: string }
export interface ScanCaps { device: string; name: string; sources: string[]; dpis: number[]; color: boolean; gray: boolean }
export interface ScanRequest { device?: string; address?: string; source: string; dpi: number; color: boolean; ocr: boolean; into?: string; name?: string }
export interface RecentItem { key: string; id: string; name: string; pages: number; opened: number; path?: string }
export type FieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'button' | 'signature';
export interface Field { name: string; type: FieldType; page: number; x: number; y: number; w: number; h: number; value: string; readonly: boolean; required: boolean; multiline: boolean; on?: string; options?: string[]; maxLen?: number; tooltip?: string; format?: string; scripts?: { calculate?: string; format?: string; keystroke?: string; validate?: string }; calcOrder?: number }
export type NewFieldType = 'text' | 'multiline' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'date' | 'signature';
export interface NewField {
  id: string; type: NewFieldType; page: number; x: number; y: number; w: number; h: number; name: string; tooltip: string; required: boolean; readonly: boolean;
  value: string; checked: boolean; options: string[]; export: string; dateFormat: string; fontSize: number; align: 'left' | 'center' | 'right';
}
export interface StampSpec { label: string; sub?: string; shape: 'box' | 'tag' | 'mark'; mark?: 'check' | 'cross'; name: string }
export interface ReflowRun { text: string; bold: boolean; italic: boolean }
export interface ReflowBlock { kind: 'para' | 'heading' | 'table'; text?: string; size?: number; align?: string; level?: number; list?: boolean; runs?: ReflowRun[]; rows?: string[][] }
export interface ReflowPage { page: number; blocks: ReflowBlock[] }
export interface HiddenItem { key: string; label: string; count: number; note: string }
export type ChangeKind = 'inserted' | 'deleted' | 'changed' | 'page-added' | 'page-removed' | 'picture';
export interface CompareChange { id: number; kind: ChangeKind; page: number | null; other: number | null; at?: number; before: string; after: string; rects: Rect[] }
export interface CompareResult {
  summary: { pages: number; otherPages: number; added: number; removed: number; changed: number; same: number; pictures: number; words: { inserted: number; deleted: number; changed: number } };
  changes: CompareChange[]; truncated: boolean;
}
export interface CreateOptions { page: 'fit' | 'a4' | 'letter'; margin: number; orientation: 'auto' | 'portrait' | 'landscape'; name?: string }
export interface ImageItem { page: number; id: string; w: number; h: number; mime: string; bytes: number; name: string; url: string }
export interface TableItem { page: number; header: string[]; rows: string[][] }
export interface Rect { x: number; y: number; w: number; h: number }
export type Pt = [number, number];
export type AnnotKind = 'highlight' | 'underline' | 'strikeout' | 'note' | 'freetext' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'image' | 'reply' | 'stamp';
export type Status = 'none' | 'accepted' | 'rejected' | 'completed' | 'cancelled';
export interface Reply { id: string; text: string }
export interface Target { index: number; nm?: string }
export interface Annot {
  id: string; page: number; kind: AnnotKind; color: string; opacity?: number; width?: number; rot?: number; flatten?: boolean; fill?: string;
  rects?: Rect[]; points?: Pt[]; paths?: Pt[][]; x?: number; y?: number; w?: number; h?: number; text?: string; size?: number; image?: string; quote?: string;
  replies?: Reply[]; status?: Status; target?: Target; stamp?: StampSpec;
}
export interface Area extends Rect { id: string; page: number }
export interface PdfComment {
  page: number; index: number; nm: string; kind: string; label: string; text: string; author: string; date: string; color: string; rect: Rect;
  replies: Array<{ text: string; author: string; date: string }>; status: Status; statusBy: string;
}
export interface Band { left?: string; center?: string; right?: string }
export interface HeaderFooter {
  header: Band; footer: Band; size: number; color: string; font: 'sans' | 'serif' | 'mono'; margins: { top: number; bottom: number; left: number; right: number };
  pages?: string; start: number; apply: 'all' | 'odd' | 'even'; bates?: { prefix: string; start: number; digits: number }; date?: string;
}
export interface Margins { l: number; t: number; r: number; b: number }
export type Preset = 'email' | 'phone' | 'card' | 'date';
export interface FindBody { query?: string; regex?: boolean; preset?: Preset; caseSensitive?: boolean; wholeWord?: boolean; pages?: string }
export interface Match { page: number; text: string; before: string; after: string; context: string; rects: Rect[] }
export type OrganizePage = { src: string; page: number; rotate: number } | { blank: true; w?: number; h?: number };

const base = (id: string): string => `/api/pdf/${encodeURIComponent(id)}`;
const q = (pages?: string): string => (pages && pages.trim() ? `?pages=${encodeURIComponent(pages.trim())}` : '');

async function form<T>(url: string, fd: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = res.statusText;
    try { const body = await res.json() as { detail?: string }; if (body.detail) detail = body.detail; } catch { detail = `${res.status} ${res.statusText}`; }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const pdfApi = {
  open(file: File | Blob, name: string): Promise<Opened> {
    const fd = new FormData();
    fd.append('file', file, name);
    return form<Opened>('/api/pdf/open', fd);
  },
  openPath: (path: string) => api.post<Opened>('/api/pdf/open-path', { path }),
  info: (id: string) => api.get<PdfInfo>(`${base(id)}/info`),
  recent: () => api.get<{ items: RecentItem[] }>('/api/pdf/recent'),
  forget: (key: string) => api.post<{ ok: boolean }>('/api/pdf/recent/forget', { key }),
  fileUrl: (id: string, download = false) => `${base(id)}/file${download ? '?download=1' : ''}`,
  async act<T>(id: string, name: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${base(id)}/act/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { let d = res.statusText; try { d = ((await res.json()) as { detail?: string }).detail ?? d; } catch { d = `${res.status} ${res.statusText}`; } throw new Error(d); }
    const out = await res.json() as T;
    if (out && typeof out === 'object' && 'id' in out && !('text' in out) && !['run_list', 'edit_structure', 'sign'].includes(name)) record(name, body);
    return out;
  },
  async actFile(id: string, name: string, body: Record<string, unknown> = {}): Promise<{ blob: Blob; name: string }> {
    const res = await fetch(`${base(id)}/act/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { let d = res.statusText; try { d = ((await res.json()) as { detail?: string }).detail ?? d; } catch { d = `${res.status} ${res.statusText}`; } throw new Error(d); }
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
    return { blob: await res.blob(), name: m?.[1] ?? name };
  },
  renderUrl: (id: string, page: number, scale: number) => `${base(id)}/render/${page}?scale=${scale.toFixed(3)}`,
  zipUrl: (id: string, scale: number, pages?: string) => `${base(id)}/pages.zip?scale=${scale}${pages && pages.trim() ? `&pages=${encodeURIComponent(pages.trim())}` : ''}`,
  xlsxUrl: (id: string, pages?: string) => `${base(id)}/tables.xlsx${q(pages)}`,
  text: (id: string, pages?: string) => api.get<{ pages: Array<{ page: number; text: string }> }>(`${base(id)}/text${q(pages)}`),
  images: (id: string, pages?: string) => api.get<{ images: ImageItem[] }>(`${base(id)}/images${q(pages)}`),
  tables: (id: string, pages?: string) => api.get<{ tables: TableItem[] }>(`${base(id)}/tables${q(pages)}`),
  fields: (id: string) => api.get<{ fields: Field[] }>(`${base(id)}/fields`),
  fill: (id: string, values: Record<string, string>, flatten: boolean) => api.post<Derived>(`${base(id)}/fields`, { values, flatten }),
  annotate: (id: string, annotations: Annot[], flatten = false) => api.post<Derived>(`${base(id)}/annotate`, { annotations, flatten }),
  organize: (id: string, pages: OrganizePage[]) => api.post<Derived>(`${base(id)}/organize`, { pages }),
  merge: (ids: string[]) => api.post<Derived>('/api/pdf/merge', { ids }),
  split: (id: string, ranges: string[]) => api.post<{ ids: string[]; parts: Array<{ id: string; range: string; name: string; pages: number }> }>(`${base(id)}/split`, { ranges }),
  protect: (id: string, body: { password: string; owner?: string; permissions: Record<string, boolean> }) => api.post<Derived>(`${base(id)}/protect`, body),
  unlock: (id: string, password: string) => api.post<Derived>(`${base(id)}/unlock`, { password }),
  redact: (id: string, areas: Area[], look: { color?: string; overlay?: string; mode?: 'content' | 'raster' } = {}) => api.post<Derived>(`${base(id)}/redact`, { areas, ...look }),
  metadata: (id: string, body: { title?: string; author?: string; subject?: string; keywords?: string; strip?: boolean }) => api.post<Derived>(`${base(id)}/metadata`, body).then(rec('metadata', body)),
  compress: (id: string, quality: number) => api.post<Derived>(`${base(id)}/compress`, { quality }).then(rec('compress', { quality })),
  pageNumbers: (id: string, body: { position: string; start: number; format: string; size?: number }) => api.post<Derived>(`${base(id)}/page-numbers`, body).then(rec('page_numbers', body)),
  watermark: (id: string, body: { text: string; opacity: number; angle: number; size: number; color: string }) => api.post<Derived>(`${base(id)}/watermark`, body).then(rec('watermark', body)),
  headerFooter: (id: string, body: HeaderFooter) => api.post<Derived>(`${base(id)}/header-footer`, body).then(rec('header_footer', body)),
  crop: (id: string, body: { box?: Rect; margins?: Margins; auto?: boolean; pages?: string }) => api.post<Derived & { cropped: number }>(`${base(id)}/crop`, body).then(rec('crop', body)),
  find: (id: string, body: FindBody) => api.post<{ matches: Match[]; count: number; pages: number; truncated: boolean }>(`${base(id)}/find`, body),
  comments: (id: string) => api.get<{ comments: PdfComment[] }>(`${base(id)}/comments`),
  identities: () => api.get<{ identities: Identity[]; trusted: Identity[] }>('/api/identities'),
  makeIdentity: (body: { name: string; email: string; org: string; password: string }) => api.post<Identity>('/api/identities', body),
  importIdentity(file: File, password: string): Promise<Identity> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('password', password);
    return form<Identity>('/api/identities/import', fd);
  },
  deleteIdentity: (id: string) => fetch(`/api/identities/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
  trust: (der: string) => api.post<{ fingerprint: string }>('/api/trust', { der }),
  untrust: (fp: string) => fetch(`/api/trust/${encodeURIComponent(fp)}`, { method: 'DELETE' }).then(() => undefined),
  signedVersionUrl: (id: string, index: number) => `${base(id)}/signatures/${index}/revision`,
  joinCopy(id: string, file: File): Promise<Derived> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return form<Derived>(`${base(id)}/request/join`, fd);
  },
  scanDevices: () => api.get<{ devices: ScanDevice[] }>('/api/scan/devices'),
  scanCaps: (body: { device?: string; address?: string }) => api.post<ScanCaps>('/api/scan/capabilities', body),
  scan: <T = Opened | Derived>(body: ScanRequest) => api.post<T & { scanned: number }>('/api/scan/run', body),
  pptxUrl: (id: string, pages?: string, text = true) => `${base(id)}/pptx?text=${text ? 1 : 0}${pages && pages.trim() ? `&pages=${encodeURIComponent(pages.trim())}` : ''}`,
  save: (id: string, path: string) => api.post<{ path: string; bytes: number }>(`${base(id)}/save`, { path }),
  reflow: (id: string, pages: string) => api.get<{ pages: ReflowPage[]; total: number; body: number }>(`${base(id)}/reflow${q(pages)}`),
  docxUrl: (id: string, pages?: string) => `${base(id)}/docx${q(pages)}`,
  hidden: (id: string) => api.get<{ items: HiddenItem[] }>(`${base(id)}/hidden`),
  sanitize: (id: string, remove: string[]) => api.post<Derived & { removed: string[]; flattened: number }>(`${base(id)}/sanitize`, { remove }).then(rec('sanitize', { remove })),
  form: (id: string, body: { create: Array<Omit<NewField, 'id'>>; rename: Record<string, string>; delete: string[] }) => api.post<Derived & { created: number; renamed: number; deleted: number }>(`${base(id)}/form`, body),
  compare: (id: string, other: string, opts: { otherIsNewer: boolean; pictures: boolean }) => api.post<CompareResult>(`${base(id)}/compare`, { other, ...opts }),
  create(files: File[], opts: CreateOptions): Promise<Opened> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    fd.append('page', opts.page);
    fd.append('margin', String(opts.margin));
    fd.append('orientation', opts.orientation);
    fd.append('name', opts.name ?? '');
    return form<Opened>('/api/pdf/create', fd);
  },
  write(blob: Blob, name: string, path = ''): Promise<{ path: string; bytes: number }> {
    const fd = new FormData();
    fd.append('file', blob, name);
    fd.append('name', name);
    fd.append('path', path);
    return form('/api/pdf/write', fd);
  },
};

export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

export async function deliver(data: Blob | string, name: string): Promise<string | null> {
  const blob = typeof data === 'string' ? await fetch(data).then(async (r) => {
    if (!r.ok) { let detail = `${r.status} ${r.statusText}`; try { detail = ((await r.json()) as { detail?: string }).detail ?? detail; } catch { return Promise.reject(new Error(detail)); } throw new Error(detail); }
    return r.blob();
  }) : data;
  if (isTauri()) return (await pdfApi.write(blob, name)).path;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  return null;
}
