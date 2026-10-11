import { api } from '../io/api';
import { el, patchList, q, setHidden, setText } from './dom';
import { icon } from './icons';

interface Reviewer { name: string; comments: number; replies: number; last: string }
interface Review { key: string; id: string; name: string; path: string; comments: number; replies: number; open: number; resolved: number; last: string; reviewers: Reviewer[]; error: string }

const when = (iso: string): string => {
  if (!iso) return 'No date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export class Reviews {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private items: Review[] = [];
  private seq = 0;

  constructor(host: HTMLElement, private readonly openDoc: (id: string) => void) {
    this.root = el(`<div class="fs-rev">
<div class="fs-home-head"><div><h1 class="fs-home-title">Reviews</h1><p class="fs-home-sub">Every recent PDF with comments: who commented, how many are still open, and when anyone last replied. Open one to answer on the Comment tab. To pass a review between copies, use Export comments and Import comments there.</p></div><div class="fs-home-head-actions"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-r="refresh">${icon('refresh', 14)}Refresh</button></div></div>
<div class="fs-rev-head" aria-hidden="true"><span>PDF</span><span>Reviewers</span><span>Open</span><span>Resolved</span><span>Last activity</span><span></span></div>
<div class="fs-rev-list" role="list"></div>
<div class="fs-empty fs-rev-empty" hidden><span class="fs-empty-icon">${icon('comment', 18)}</span><span class="fs-empty-title">No reviews yet</span><span class="fs-empty-note">PDFs you open here that have comments appear in this list.</span></div>
<p class="fs-note fs-rev-status" aria-live="polite">Reading comments.</p>
</div>`);
    host.appendChild(this.root);
    this.list = q(this.root, '.fs-rev-list');
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-r="refresh"]')) { void this.load(); return; }
      const row = t.closest<HTMLElement>('.fs-rev-row');
      if (row?.dataset.id) this.openDoc(row.dataset.id);
    });
    this.root.addEventListener('keydown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.fs-rev-row');
      if (row?.dataset.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.openDoc(row.dataset.id); }
    });
  }

  async load(): Promise<void> {
    const mine = ++this.seq;
    let got: Review[] = [];
    let failed = false;
    try { got = (await api.get<{ reviews: Review[] }>('/api/reviews')).reviews; } catch { failed = true; }
    if (mine !== this.seq) return;
    this.items = got;
    this.render();
    const open = got.reduce((n, r) => n + r.open, 0);
    setText(q(this.root, '.fs-rev-status'), failed ? 'Could not read the reviews. Refresh to try again.'
      : got.length ? `${plural(got.length, 'PDF')} with comments, ${plural(open, 'open comment')}.` : '');
  }

  private render(): void {
    const update = (n: HTMLElement, r: Review): void => {
      setText(n.querySelector('.fs-rev-name'), r.name);
      setText(n.querySelector('.fs-rev-sub'), r.error ? `Could not read: ${r.error}` : `${plural(r.comments, 'comment')}, ${plural(r.replies, 'reply', 'replies')}`);
      const names = r.reviewers.slice(0, 4).map((p) => p.name).join(', ') + (r.reviewers.length > 4 ? ` and ${r.reviewers.length - 4} more` : '');
      setText(n.querySelector('.fs-rev-people'), names || 'Unknown');
      const people = n.querySelector<HTMLElement>('.fs-rev-people');
      const tip = r.reviewers.map((p) => `${p.name}: ${plural(p.comments, 'comment')}, ${plural(p.replies, 'reply', 'replies')}, last ${when(p.last)}`).join('\n');
      if (people && people.title !== tip) people.title = tip;
      setText(n.querySelector('.fs-rev-open'), String(r.open));
      setText(n.querySelector('.fs-rev-done'), String(r.resolved));
      setText(n.querySelector('.fs-rev-last'), when(r.last));
      const t = r.path || r.name;
      if (n.title !== t) n.title = t;
    };
    patchList(this.list, this.items, {
      key: (r) => `${r.key}|${r.id}`,
      create: (r) => {
        const n = el(`<div class="fs-rev-row" role="listitem" tabindex="0"><span class="fs-rev-doc"><span class="fs-rev-name"></span><span class="fs-rev-sub"></span></span><span class="fs-rev-people"></span><span class="fs-rev-open"></span><span class="fs-rev-done"></span><span class="fs-rev-last"></span><span class="fs-rev-go">${icon('chevronRight', 14)}</span></div>`);
        n.dataset.id = r.id;
        update(n, r);
        return n;
      },
      update,
    });
    setHidden(q(this.root, '.fs-rev-empty'), this.items.length > 0);
    setHidden(q(this.root, '.fs-rev-head'), this.items.length === 0);
  }
}
