# File maps

## Engine (backend/)

| Path | Role |
| --- | --- |
| `app/main.py` | FastAPI app, CORS, discovery file `~/Formpdf/engine.json` (port, pid), routers, static `FORMPDF_DIST` |
| `app/core/config.py` | ports (5198, 8198), `FORMPDF_*` env, data folders (Pdf, Media, Exports), settings.json |
| `app/core/ids.py` | short ids, picture ids by content hash |
| `app/routers/pdf.py` | `/api/pdf/*`: open, open-path, recent, forget, merge, write, create, and per document file, info, text, images, tables(.xlsx), fields, annotate, organize, split, protect, unlock, redact, metadata, compress, page-numbers, watermark, header-footer, crop, find, comments, render, pages.zip, pptx, sheet, reflow, docx, hidden, sanitize, form, compare, save |
| `app/routers/live.py` | `/api/live` WebSocket: windows say hello, report their open document, answer window tools |
| `app/routers/mcp.py` | `/mcp` MCP server: 7 tools, the guide resource, the pdf-job prompt, consent, turns, live landing of agent versions |
| `app/routers/system.py`, `media.py` | health, version, capabilities, settings; extracted pictures |
| `app/routers/batch.py` | `/api/batch`: upload copies, run one action on many files as a job, status, zip of results |
| `app/services/bridge.py` | window list, the window's open document, `window_call` |
| `app/services/session.py` | `~/Formpdf/session.json`: the window's open document, for Home's pick-up and recovery line |
| `app/services/pdf/actions.py` | the pdf action registry: kinds, labels, suffixes, synonyms, batch fields, `run` handlers |
| `app/services/pdf/content/` | content interpreter (`walk`: glyphs and draws tied to operators), `FontInfo`, `write_page`, `replace_form` |
| `app/services/pdf/fontkit.py`, `app/fonts/` | Inter, Noto Serif, JetBrains Mono embedded as subsets; `covers`, `pick` |
| `app/services/media.py` | formpdf-owned picture store for extracted images (replaces formsld's media service) |
| `app/services/pdf/docs.py` | working copies `Pdf/pdf_xxxxxxxxxx.pdf` with meta (name, path, root key, protect), `derive`, recents (24) |
| `app/services/pdf/core.py` | info, text, images, tables, merge, split, render, pages zip, the `PDFIUM` lock (`serial`) |
| `app/services/pdf/edit.py` | organize, fields, protect, unlock, redact, metadata, compress, page numbers, watermark, header and footer, crop |
| `app/services/pdf/annot.py` | comments with replies and status, stamps, signatures, reading existing comments |
| `app/services/pdf/forms.py` | Prepare form: create, rename, delete fields |
| `app/services/pdf/layout.py` | reading order (XY cut), paragraphs, headings, runs; reflow for reading mode |
| `app/services/pdf/word.py` | PDF to Word (columns as Word sections, lists, running heads into header and footer) |
| `app/services/pdf/exports.py` | the shared reading of a PDF for export (`document`: blocks, running lines removed, list groups) and `to_html`, `to_rtf`, `to_xlsx` |
| `app/services/pdf/links.py`, `attach.py`, `measure.py`, `frame.py` | links (`links`, `edit_links`), attached and pinned files (`attachments`, `edit_attachments`), measurements (`measure`, `measurements`, `snap_points`), top-left page frame to PDF space |
| `app/services/pdf/items.py` | page items: added text (own layout over the font kit) and pictures (native encoding) as tagged forms with one placing stream each, existing pictures converted in place, crop, rotation, flips, z-order, comment order (`items`, `edit_items`), render without an item |
| `app/services/pdf/redact.py` | true redaction over the content interpreter: glyphs, covered pixels, shapes, comments, fields and item text removed, forms copied on write, clip-out, re-read and render checks, overlay; `mark_redactions` |
| `app/services/pdf/textedit.py` | text already on a page: paragraph detection (runs, lines, table walls, duplicate and invisible layers, alignment, bullets), conversion of paragraphs into page items in one pass with the document's font reused where it can encode the text |
| `app/services/pdf/ocr.py` | text recognition with RapidOCR on onnxruntime: status and model lookup (Formpdf/models/ocr, then the package), render capped at the scan's resolution, straightening, invisible per-word text layer tagged `/FormpdfOCR`, rotated pages (`ocr`) |
| `app/services/scan.py`, `app/routers/scan.py` | scanners: mDNS browse and eSCL client for network scanners, SANE and WIA for connected ones; `/api/scan/devices`, `/capabilities`, `/run` (new PDF or added to the open one, optional OCR) |
| `app/services/pdf/spell.py`, `app/dict/` | Hunspell-format dictionary reader, `spell` and `spell_fix`; SCOWL en_US with its notices, more languages in `~/Formpdf/dictionaries` |
| `app/services/pdf/slides.py` | PDF to PowerPoint (`to_pptx`) and contact sheets (`contact_sheet`) |
| `app/services/pdf/sanitize.py`, `search.py`, `create.py`, `compare.py` | hidden information, find (presets, regex), PDF from pictures and files, compare |
| `formpdf_engine.py` | frozen entry: `--selfcheck`, free port, bundled dist |

## Window (frontend/src/)

| Path | Role |
| --- | --- |
| `main.ts`, `app.ts` | composition root: Home, the workbench, live client, agent bridge, dialogs, global keys |
| `ui/home.ts` | Home: open, open by path, recent PDFs with forget, create from pictures, merge, agents, preferences |
| `ui/app-dialogs.ts` | Preferences (with the Network list), Agents, Help, Keyboard shortcuts |
| `ui/palette.ts`, `ui/batch.ts`, `ui/resume.ts` | Mod+K palette, Home > Batch, Home's pick-up and recovery line |
| `pdf/tools.ts` | tool registry: sections, commands and synonyms that tools add to the workbench; page tools (`useTool`) and per-page layers (`page`) |
| `tools/` | registered tools: `links.ts`, `attachments.ts`, `content.ts` with `richtext.ts` (Edit), `measure.ts`, `spell.ts` (Comment), `exports.ts` (Convert), `formalign.ts` (Prepare form), `overlay.ts` page layers, imported by `tools/index.ts`; `pdf/align.ts` is the shared align and distribute math |
| `ui/dom.ts`, `icons.ts`, `menu.ts`, `commands.ts`, `dialogs.ts`, `dropdown.ts`, `toast.ts`, `themes.ts`, `brand.ts` | the form family toolkit and the formpdf mark |
| `live/socket.ts`, `live/agent.ts` | WebSocket client, window tools (consent, state, open, commit, undo-turn, saved) |
| `pdf/workbench.ts` | the workbench shell, menus, history of versions with agent turns, save, print, close guard |
| `pdf/panels.ts` | side panes for every tab |
| `pdf/viewer.ts` | pdf.js viewer, layouts, zoom, thumbnails in fixed slots |
| `pdf/annotate.ts`, `stamps.ts`, `fill.ts`, `form.ts`, `organize.ts`, `compare.ts`, `create.ts`, `find.ts`, `reading.ts`, `api.ts` | tools per tab and the REST client |
| `styles/` | tokens, shell, panels, dialogs, app-dialogs, pdf, light mode, scrollbars, fonts |

## Desktop and setup

| Path | Role |
| --- | --- |
| `src-tauri/src/main.rs` | spawns the sidecar, waits for its port, opens the window; opens `.pdf` files (arguments, single instance, macOS open events) |
| `src-tauri/tauri.conf.json`, `capabilities/default.json` | product formpdf, identifier `ai.nodemode.formpdf`, `.pdf` association, permissions |
| `setup/` | install, boot, build, serve, freeze, desktop, doctor, clean, run (CLI), mcp_stdio, agents (with `.bat` twins) |
