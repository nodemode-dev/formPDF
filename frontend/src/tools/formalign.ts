import { ALIGN_LABEL, alignMoves, needs, type AlignHow } from '../pdf/align';
import { registerTool, type ToolHost } from '../pdf/tools';
import { setDisabled } from '../ui/dom';
import { icon } from '../ui/icons';

const HOWS = Object.keys(ALIGN_LABEL) as AlignHow[];

function chosen(host: ToolHost) {
  const list = host.forms.chosen();
  const page = list[0]?.page;
  return list.filter((d) => d.page === page);
}

function run(host: ToolHost, how: AlignHow): void {
  const list = chosen(host);
  const moves = alignMoves(list.map((d) => ({ key: d.id, x: d.x, y: d.y, w: d.w, h: d.h })), how);
  for (const d of list) {
    const m = moves.get(d.id);
    if (m && (Math.abs(m.dx) > 0.01 || Math.abs(m.dy) > 0.01)) host.forms.update(d.id, { x: d.x + m.dx, y: d.y + m.dy });
  }
}

registerTool({
  id: 'form-align',
  tab: 'form',
  title: 'Align fields',
  words: ['align fields', 'distribute fields', 'line up fields'],
  section: () => `<p class="fs-note">Shift-click new fields to select several, then line them up or space them evenly.</p>
<div class="fs-cx-btns">${HOWS.map((h) => `<button class="fs-icon-btn is-sm" type="button" data-how="${h}" title="${ALIGN_LABEL[h][1]}" aria-label="${ALIGN_LABEL[h][1]}" disabled>${icon(ALIGN_LABEL[h][0], 14)}</button>`).join('')}</div>`,
  mount: (root, host) => {
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-how]');
      if (b && !b.disabled) run(host, b.dataset.how as AlignHow);
    });
  },
  sync: (root, host) => {
    const n = chosen(host).length;
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-how]'))) setDisabled(b, n < needs(b.dataset.how as AlignHow));
  },
  commands: (host) => HOWS.map((h) => ({ id: `form-align-${h}`, label: `${ALIGN_LABEL[h][1]} (form fields)`, words: ['form fields'], enabled: () => chosen(host).length >= needs(h), run: () => run(host, h) })),
});
