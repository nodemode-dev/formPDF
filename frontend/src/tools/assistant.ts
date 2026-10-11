import { api } from '../io/api';
import { pdfApi, type Derived } from '../pdf/api';
import { registerTool, type ToolHost } from '../pdf/tools';
import { promptName } from '../ui/dialogs';
import { el, patchList, q, setClass, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

interface Cite { page: number; quote: string; verified: boolean; at: number; end: number }
interface Answer { answer: string; citations: Cite[] }
interface AiSettings { provider: string; label: string; model: string }
interface Slide { title: string; bullets: string[]; notes: string; sources: Array<{ doc: string; page: number }> }
interface Outline { title: string; subtitle: string; slides: Slide[] }

let host: ToolHost | null = null;
let askRoot: HTMLElement | null = null;
let deckRoot: HTMLElement | null = null;
let picRoot: HTMLElement | null = null;
let settings: AiSettings | null = null;
let waitingId = '';
let pollTimer = 0;
let outline: Outline | null = null;
const extra: string[] = [];
let seq = 0;

const stem = (name: string): string => name.replace(/\.pdf$/i, '');

let loadedAt = 0;

async function loadSettings(): Promise<AiSettings | null> {
  loadedAt = Date.now();
  try { settings = await api.get<AiSettings>('/api/ai/settings'); } catch { settings = null; }
  syncProvider();
  return settings;
}

function syncProvider(): void {
  const p = settings?.provider ?? 'off';
  const say = p === 'off' ? 'The AI tools are off. Choose a provider in Preferences > AI: your agent, Anthropic or OpenAI with your key, or a model on this computer.'
    : p === 'agent' ? 'Questions go to your agent. After asking, tell Claude Code, Codex or Cursor: answer my formpdf question.'
      : `Answers come from ${settings?.label ?? p}${settings?.model ? ` (${settings.model})` : ''}. Only the pages of this PDF are sent, and only when you ask.`;
  for (const r of [askRoot, deckRoot, picRoot]) {
    const n = r?.querySelector<HTMLElement>('[data-ai="provider"]');
    if (n) setText(n, say);
  }
}

function setStatus(text: string, waiting = false): void {
  if (!askRoot) return;
  setText(q(askRoot, '[data-ai="status"]'), text);
  setHidden(q(askRoot, '[data-ai="cancel"]'), !waiting);
}

function render(a: Answer): void {
  if (!askRoot) return;
  const box = q(askRoot, '[data-ai="answer"]');
  const frag = document.createDocumentFragment();
  let at = 0;
  const text = a.answer;
  const cites = [...a.citations].sort((x, y) => x.at - y.at);
  for (const c of cites) {
    if (c.at < at) continue;
    frag.append(document.createTextNode(text.slice(at, c.at)));
    if (c.quote) {
      const qn = el(`<span class="fs-ai-quote${c.verified ? '' : ' is-unverified'}"></span>`);
      qn.textContent = `“${c.quote}”`;
      if (!c.verified) qn.title = 'This quotation was not found on that page. Check it before relying on it.';
      frag.append(qn, document.createTextNode(' '));
    }
    const b = el(`<button class="fs-ai-cite${c.verified ? '' : ' is-unverified'}" type="button" data-page="${c.page}"></button>`);
    b.textContent = `p. ${c.page}`;
    b.title = c.verified ? `Go to page ${c.page}` : `Go to page ${c.page} (quotation not found there)`;
    frag.append(b);
    at = c.end;
  }
  frag.append(document.createTextNode(text.slice(at)));
  box.replaceChildren(frag);
  setClass(box, 'is-empty', false);
  const bad = a.citations.filter((c) => c.quote && !c.verified).length;
  setStatus(bad ? `${bad} quotation${bad === 1 ? ' was' : 's were'} not found on the cited page; they are marked.` : `${a.citations.length} citation${a.citations.length === 1 ? '' : 's'}; select one to go to its page.`);
}

function stopWaiting(): void {
  window.clearInterval(pollTimer);
  pollTimer = 0;
  waitingId = '';
  syncButtons();
}

async function ask(kind: 'ask' | 'summary'): Promise<void> {
  const d = host?.doc();
  if (!d || !askRoot || !host) return;
  const question = q<HTMLTextAreaElement>(askRoot, '[data-ai="question"]').value.trim();
  if (kind === 'ask' && !question) { q<HTMLTextAreaElement>(askRoot, '[data-ai="question"]').focus(); return; }
  const s = await loadSettings();
  if (!s || s.provider === 'off') { setStatus('Choose an AI provider in Preferences > AI first.'); return; }
  stopWaiting();
  const mine = ++seq;
  const length = q<HTMLSelectElement>(askRoot, '[data-ai="length"]').value;
  setStatus(s.provider === 'agent' ? 'Sending to your agent.' : `Asking ${s.label}.`);
  syncButtons(true);
  try {
    const id = await host.ctx.flush() ?? d.id;
    const res = await api.post<Answer & { waiting: boolean; id?: string }>('/api/ai/ask', { doc: id, kind, question, length });
    if (mine !== seq) return;
    if (res.waiting && res.id) {
      waitingId = res.id;
      setStatus('Waiting for your agent. In Claude Code, Codex or Cursor, say: answer my formpdf question.', true);
      pollTimer = window.setInterval(() => void poll(), 3000);
      syncButtons();
      return;
    }
    render(res);
  } catch (err) {
    if (mine === seq) setStatus((err as Error).message);
  }
  syncButtons();
}

async function poll(): Promise<void> {
  if (!waitingId) return;
  const id = waitingId;
  try {
    const got = await api.get<{ answer: string | null; citations?: Cite[] }>(`/api/ai/questions/${id}`);
    if (got.answer && waitingId === id) { stopWaiting(); render({ answer: got.answer, citations: got.citations ?? [] }); }
  } catch { stopWaiting(); setStatus('The question is no longer waiting.'); }
}

function onAgentAnswer(e: Event): void {
  const d = (e as CustomEvent<{ id: string; answer: string; citations: Cite[] }>).detail;
  if (!d || d.id !== waitingId) return;
  stopWaiting();
  render({ answer: d.answer, citations: d.citations ?? [] });
  host?.setTab('assistant');
}

function cancel(): void {
  const id = waitingId;
  stopWaiting();
  if (id) void fetch(`/api/ai/questions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  setStatus('Cancelled.');
}

function syncButtons(busy = false): void {
  const off = !host?.doc() || busy || !!waitingId;
  for (const r of [askRoot, deckRoot, picRoot]) {
    if (!r) continue;
    for (const b of Array.from(r.querySelectorAll<HTMLButtonElement>('button[data-go]'))) setDisabled(b, off);
  }
  if (deckRoot) setDisabled(q<HTMLButtonElement>(deckRoot, '[data-go="deck"]'), off || !outline);
}

function sources(): void {
  if (!deckRoot) return;
  const d = host?.doc();
  const items = [{ key: '__doc', name: d ? `${d.name} (this PDF)` : 'This PDF' }, ...extra.map((p) => ({ key: p, name: p }))];
  patchList(q(deckRoot, '[data-ai="sources"]'), items, {
    key: (it) => it.key,
    create: (it) => {
      const n = el(`<div class="fs-row fs-ai-src"><span class="fs-row-main"><span class="fs-row-title"></span></span>${it.key === '__doc' ? '' : `<button class="fs-icon-btn is-sm" type="button" data-ai="unsource" title="Remove" aria-label="Remove">${icon('close', 12)}</button>`}</div>`);
      setText(n.querySelector('.fs-row-title'), it.name);
      n.dataset.src = it.key;
      return n;
    },
    update: (n, it) => setText(n.querySelector('.fs-row-title'), it.name),
  });
}

function showOutline(): void {
  if (!deckRoot) return;
  const list = q(deckRoot, '[data-ai="outline"]');
  setHidden(q(deckRoot, '[data-ai="outline-empty"]'), !!outline);
  if (!outline) { list.replaceChildren(); syncButtons(); return; }
  const o = outline;
  const top = el(`<div class="fs-ai-slide is-title"><input class="fs-input" type="text" data-o="title" aria-label="Presentation title"><input class="fs-input" type="text" data-o="subtitle" aria-label="Subtitle" placeholder="Subtitle"></div>`);
  q<HTMLInputElement>(top, '[data-o="title"]').value = o.title;
  q<HTMLInputElement>(top, '[data-o="subtitle"]').value = o.subtitle;
  const rows = o.slides.map((s, i) => {
    const n = el(`<div class="fs-ai-slide" data-i="${i}"><span class="fs-ai-num">${i + 1}</span><div class="fs-ai-slide-body"><input class="fs-input" type="text" data-o="stitle" aria-label="Slide ${i + 1} title"><textarea class="fs-input" rows="3" data-o="bullets" aria-label="Slide ${i + 1} points, one per line"></textarea><span class="fs-note fs-ai-srcs"></span></div><button class="fs-icon-btn is-sm" type="button" data-ai="drop" title="Remove slide" aria-label="Remove slide ${i + 1}">${icon('close', 12)}</button></div>`);
    q<HTMLInputElement>(n, '[data-o="stitle"]').value = s.title;
    q<HTMLTextAreaElement>(n, '[data-o="bullets"]').value = s.bullets.join('\n');
    setText(n.querySelector('.fs-ai-srcs'), s.sources.length ? `From ${s.sources.map((r) => `${r.doc || 'document'} p. ${r.page}`).join(', ')}` : '');
    return n;
  });
  list.replaceChildren(top, ...rows);
  syncButtons();
}

function readOutline(): Outline | null {
  if (!outline || !deckRoot) return null;
  const list = q(deckRoot, '[data-ai="outline"]');
  const slides: Slide[] = [];
  for (const n of Array.from(list.querySelectorAll<HTMLElement>('.fs-ai-slide[data-i]'))) {
    const s = outline.slides[Number(n.dataset.i)];
    if (!s) continue;
    slides.push({ ...s, title: q<HTMLInputElement>(n, '[data-o="stitle"]').value.trim(), bullets: q<HTMLTextAreaElement>(n, '[data-o="bullets"]').value.split('\n').map((b) => b.trim()).filter(Boolean) });
  }
  return { title: q<HTMLInputElement>(list, '[data-o="title"]').value.trim() || 'Presentation', subtitle: q<HTMLInputElement>(list, '[data-o="subtitle"]').value.trim(), slides };
}

function dropSlide(node: HTMLElement | null): void {
  const cur = readOutline();
  if (!node || !cur || !deckRoot) return;
  const i = Number(node.dataset.i);
  cur.slides.splice(i, 1);
  outline = cur;
  node.remove();
  const rest = Array.from(q(deckRoot, '[data-ai="outline"]').querySelectorAll<HTMLElement>('.fs-ai-slide[data-i]'));
  rest.forEach((n, k) => { if (n.dataset.i !== String(k)) { n.dataset.i = String(k); setText(n.querySelector('.fs-ai-num'), String(k + 1)); } });
  if (!cur.slides.length) { outline = null; showOutline(); }
  syncButtons();
}

async function draft(): Promise<void> {
  const d = host?.doc();
  if (!d || !host || !deckRoot) return;
  const s = await loadSettings();
  if (!s || s.provider === 'off' || s.provider === 'agent') { setText(q(deckRoot, '[data-ai="deck-status"]'), s?.provider === 'agent' ? 'Drafting a presentation needs Anthropic, OpenAI or a model on this computer; ask your agent to use ai_deck instead.' : 'Choose an AI provider in Preferences > AI first.'); return; }
  const slides = Number(q<HTMLInputElement>(deckRoot, '[data-ai="slides"]').value) || 8;
  const brief = q<HTMLTextAreaElement>(deckRoot, '[data-ai="brief"]').value.trim();
  setText(q(deckRoot, '[data-ai="deck-status"]'), `Drafting with ${s.label}.`);
  syncButtons(true);
  await host.ctx.run('Drafting the outline', async () => {
    try {
      const id = await host!.ctx.flush() ?? d.id;
      const res = await pdfApi.act<{ text: string; outline: Outline }>(id, 'ai_outline', { slides, brief, paths: extra });
      outline = res.outline;
      showOutline();
      setText(q(deckRoot!, '[data-ai="deck-status"]'), `${outline.slides.length} slides drafted. Edit them, then Create presentation.`);
    } catch (err) { setText(q(deckRoot!, '[data-ai="deck-status"]'), (err as Error).message); }
  });
  syncButtons();
}

async function makeDeck(): Promise<void> {
  const d = host?.doc();
  const o = readOutline();
  if (!d || !host || !o || !deckRoot) return;
  await host.ctx.run('Writing the presentation', async () => {
    try {
      const got = await pdfApi.actFile(d.id, 'ai_deck', { outline: o });
      await host!.ctx.deliver(got.blob, `${stem(d.name)} presentation.pptx`);
      setText(q(deckRoot!, '[data-ai="deck-status"]'), `Saved ${o.slides.length + 1} slides as ${stem(d.name)} presentation.pptx.`);
    } catch (err) { toast((err as Error).message, 'error'); }
  });
}

async function picture(): Promise<void> {
  const d = host?.doc();
  if (!d || !host || !picRoot) return;
  const prompt = q<HTMLTextAreaElement>(picRoot, '[data-ai="prompt"]').value.trim();
  if (!prompt) { q<HTMLTextAreaElement>(picRoot, '[data-ai="prompt"]').focus(); return; }
  const shape = q<HTMLSelectElement>(picRoot, '[data-ai="shape"]').value;
  const page = host.ctx.viewer.currentPage();
  const w = shape === 'wide' ? 360 : shape === 'tall' ? 220 : 280;
  const h = shape === 'wide' ? 240 : shape === 'tall' ? 330 : 280;
  setText(q(picRoot, '[data-ai="pic-status"]'), 'Generating the picture.');
  syncButtons(true);
  await host.ctx.run('Generating a picture', async () => {
    try {
      const id = await host!.ctx.flush() ?? d.id;
      const res = await pdfApi.act<Derived>(id, 'ai_picture', { prompt, page, w, h });
      await host!.ctx.commit(res, 'Generate a picture');
      setText(q(picRoot!, '[data-ai="pic-status"]'), `Placed on page ${page}. Edit > Select moves, resizes or crops it.`);
    } catch (err) { setText(q(picRoot!, '[data-ai="pic-status"]'), (err as Error).message); }
  });
  syncButtons();
}

window.addEventListener('fs-ai-answer', onAgentAnswer);
window.addEventListener('fs-ai-settings', () => void loadSettings());

registerTool({
  id: 'ai-ask',
  tab: 'assistant',
  title: 'Ask this PDF',
  words: ['ai assistant', 'ask', 'question', 'summary', 'summarise', 'chat'],
  section: () => `<p class="fs-note fs-tool-note" data-ai="provider"></p>
<textarea class="fs-input fs-ai-q" rows="3" data-ai="question" placeholder="Ask a question about this PDF" aria-label="Question"></textarea>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-go="ask">${icon('send', 14)}Ask</button><select class="fs-input fs-input-sm fs-ai-len" data-ai="length" aria-label="Summary length"><option value="short">Short</option><option value="medium" selected>Medium</option><option value="long">Long</option></select><button class="fs-btn fs-btn-sm" type="button" data-go="summary">${icon('fileText', 14)}Summarise</button></div>
<div class="fs-ai-answer is-empty" data-ai="answer" aria-live="polite">Answers appear here with links to the pages they come from.</div>
<div class="fs-ai-status"><span class="fs-note" data-ai="status"></span><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-ai="cancel" hidden>Cancel</button></div>`,
  mount: (root, h) => {
    host = h;
    askRoot = root;
    void loadSettings();
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const cite = t.closest<HTMLElement>('.fs-ai-cite');
      if (cite) { h.ctx.viewer.goTo(Number(cite.dataset.page)); return; }
      const go = t.closest<HTMLElement>('[data-go]')?.dataset.go;
      if (go === 'ask' || go === 'summary') void ask(go);
      else if (t.closest('[data-ai="cancel"]')) cancel();
    });
    q(root, '[data-ai="question"]').addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && ((e as KeyboardEvent).metaKey || (e as KeyboardEvent).ctrlKey)) { e.preventDefault(); void ask('ask'); }
    });
  },
  sync: (_r, h) => { host = h; syncButtons(); if (Date.now() - loadedAt > 5000) void loadSettings(); },
  commands: (h) => [
    { id: 'tool-ai-ask', label: 'Ask this PDF (AI)', words: ['ai assistant', 'question', 'chat'], enabled: () => !!h.doc(), run: () => { h.setTab('assistant'); q<HTMLTextAreaElement>(askRoot!, '[data-ai="question"]').focus(); } },
    { id: 'tool-ai-summary', label: 'Summarise this PDF (AI)', words: ['summary', 'summarize', 'tl;dr'], enabled: () => !!h.doc(), run: () => { h.setTab('assistant'); void ask('summary'); } },
  ],
});

registerTool({
  id: 'ai-deck',
  tab: 'assistant',
  title: 'Generate a presentation',
  words: ['presentation', 'deck', 'slides', 'powerpoint', 'pdf spaces'],
  section: () => `<p class="fs-note fs-tool-note">Drafts slides from this PDF and any other PDFs, Office or text files you add. Review and edit the outline, then save it as PowerPoint; each slide's notes list its source pages.</p>
<div class="fs-ai-srclist" data-ai="sources"></div>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm fs-btn-ghost" type="button" data-ai="addsrc">${icon('plus', 14)}Add a file by path…</button></div>
<div class="fs-prop-row"><span class="fs-prop-label">Slides</span><div class="fs-prop-ctl"><input class="fs-input" type="number" min="3" max="30" value="8" data-ai="slides"></div></div>
<textarea class="fs-input" rows="2" data-ai="brief" placeholder="Audience and purpose (optional)" aria-label="Brief"></textarea>
<div class="fs-pdfwb-btns"><button class="fs-btn fs-btn-sm" type="button" data-go="draft">${icon('sparkle', 14)}Draft outline</button><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-go="deck" disabled>${icon('filePptx', 14)}Create presentation</button></div>
<p class="fs-note fs-ai-line" data-ai="deck-status" aria-live="polite"></p>
<p class="fs-note" data-ai="outline-empty">No outline yet.</p>
<div class="fs-ai-outline" data-ai="outline"></div>`,
  mount: (root, h) => {
    host = h;
    deckRoot = root;
    sources();
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const go = t.closest<HTMLElement>('[data-go]')?.dataset.go;
      if (go === 'draft') void draft();
      else if (go === 'deck') void makeDeck();
      else if (t.closest('[data-ai="addsrc"]')) void promptName('Add a file by path', '', 'Add').then((p) => { if (p && !extra.includes(p)) { extra.push(p); sources(); } });
      else if (t.closest('[data-ai="unsource"]')) { const k = t.closest<HTMLElement>('[data-src]')?.dataset.src ?? ''; const i = extra.indexOf(k); if (i >= 0) { extra.splice(i, 1); sources(); } }
      else if (t.closest('[data-ai="drop"]') && outline) dropSlide(t.closest<HTMLElement>('.fs-ai-slide[data-i]'));
    });
  },
  sync: (_r, h) => { host = h; sources(); syncButtons(); },
  commands: (h) => [{ id: 'tool-ai-deck', label: 'Generate a presentation (AI)', words: ['deck', 'slides', 'powerpoint'], enabled: () => !!h.doc(), run: () => h.setTab('assistant') }],
});

registerTool({
  id: 'ai-picture',
  tab: 'assistant',
  title: 'Generate a picture',
  words: ['generate image', 'ai image', 'picture'],
  section: () => `<p class="fs-note fs-tool-note">Describe a picture; it is placed on the current page as a picture you can move, resize and crop with Edit > Select. Needs OpenAI or a picture server on this computer.</p>
<textarea class="fs-input" rows="3" data-ai="prompt" placeholder="A watercolour of a lighthouse at dawn" aria-label="Describe the picture"></textarea>
<div class="fs-pdfwb-btns"><select class="fs-input fs-input-sm" data-ai="shape" aria-label="Shape"><option value="square">Square</option><option value="wide">Wide</option><option value="tall">Tall</option></select><button class="fs-btn fs-btn-sm fs-btn-primary" type="button" data-go="picture">${icon('fileImage', 14)}Generate and place</button></div>
<p class="fs-note fs-ai-line" data-ai="pic-status" aria-live="polite"></p>`,
  mount: (root, h) => {
    host = h;
    picRoot = root;
    root.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-go="picture"]')) void picture(); });
  },
  sync: (_r, h) => { host = h; syncButtons(); },
  commands: (h) => [{ id: 'tool-ai-picture', label: 'Generate a picture (AI)', words: ['image', 'illustration'], enabled: () => !!h.doc(), run: () => h.setTab('assistant') }],
});
