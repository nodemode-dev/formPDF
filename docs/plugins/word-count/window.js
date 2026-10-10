export default function (fp) {
  let root = null;
  let host = null;

  async function run() {
    const d = host && host.doc();
    if (!d || !root) return;
    const note = fp.q(root, '[data-w="note"]');
    fp.setText(note, 'Counting.');
    try {
      const got = await fp.pdfApi.act(d.id, 'word_count', {});
      fp.setText(note, got.text.split('\n')[0]);
    } catch (err) {
      fp.setText(note, err.message);
    }
  }

  fp.registerTool({
    id: 'section',
    tab: 'view',
    title: 'Word count',
    section: () => `<p class="fs-note fs-tool-note" data-w="note">Counts the words on every page.</p>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-w="run">${fp.icon('fileText', 14)}Count words</button></div>`,
    mount: (r, h) => {
      root = r;
      host = h;
      r.addEventListener('click', (e) => { if (e.target.closest('[data-w="run"]')) run(); });
    },
    sync: (_r, h) => { host = h; fp.setDisabled(fp.q(root, '[data-w="run"]'), !h.doc()); },
  });
}
