# Parity with Adobe Acrobat

formpdf 0.1.0, scored row by row against Adobe Acrobat Pro and Studio (help current to the August 2026 feature update).

## Method

Each row is a capability Acrobat's own help documents, written in Acrobat's terms: what it does to a PDF. Each formpdf cell names the file and symbol where the trace ended. Full means implemented and reachable from the interface (or, for agent rows, the agent surface) through to the saved file; Partial means present but narrower than Acrobat's, or not reachable; None means nothing was found. Full counts 1, Partial one half, None 0. Rows Acrobat does not document (formpdf's agent rows) and the Platform rows are listed but not scored. The rows and grades live in docs/parity.py; rerun `python3 docs/parity.py --md` after a release and paste the tables here.

## Scores

| Area | vs Acrobat |
| --- | --- |
| PDF viewing | 5.5 of 6 · 92% |
| PDF annotation | 6 of 7 · 86% |
| Content editing | 2 of 14 · 14% |
| PDF forms and signing | 4 of 6 · 67% |
| PDF organize | 6.5 of 7 · 93% |
| PDF protect and redact | 4.5 of 5 · 90% |
| PDF convert | 6.5 of 11 · 59% |
| Review and comments | 1.5 of 2 · 75% |
| Collaboration and sharing | 1 of 2 · 50% |
| Accessibility | 0.5 of 5 · 10% |
| Import and export | 0 of 1 · 0% |
| Print | 1 of 3 · 33% |
| Automation and agents | 0.5 of 3 · 17% |
| **Overall** | **39.5 of 72 · 55%** |

Across the 72 scored rows formpdf has 32 full, 15 partial and 25 none.

## Where formpdf leads

Rows no Acrobat page documents: MCP server for outside agents (HTTP and stdio); Agent edits land live in the open window and undo per turn; Agent sees its pages; Agent consent and on/off switch; Skills shipped for Claude Code, Codex and Cursor; Headless processing from the command line.

## Where formpdf trails most

- **Content editing.** formpdf adds text boxes, notes, stamps and signatures on top of a page, but does not yet edit the PDF's own text and pictures in place, reformat existing text, add or crop pictures as page content, or add links.
- **Accessibility.** No accessibility checker, no tagging and no reading-order editor for PDFs.
- **Signing and scanning.** No certificate signatures, signature requests, OCR or scanning.
- Rows with nothing yet: Measure distance, perimeter and area; Edit PDF text and pictures in place; Bulleted and numbered lists in PDF text; Align PDF paragraphs: left, centre, right, justify; Add links to PDF pages; Crop pictures on PDF pages; Generate pictures with AI (Adobe Express); Arrange objects: bring forward, send backward; Align and distribute objects on a page; Rotate and flip pictures on PDF pages; Attach files to a PDF; Certificate-based digital signatures; Request signatures from others; Export to HTML or RTF; OCR for scanned pages; Scan paper documents to PDF; Share PDF links with permissions; Accessibility checker for PDFs; Reading Order tool for tagged PDFs; Alternate text for figures; Tag a PDF for accessibility (autotag); Create PDFs from Office files (Word, PowerPoint, Excel); Preflight and PDF/A, PDF/X standards; Generate a presentation from PDFs and files with AI (PDF Spaces); Plug-ins and add-ons.

## Line by line

### PDF viewing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| View with thumbnails, zoom, fit width or page, rotate view | yes | Full | `frontend/src/pdf/viewer.ts Viewer` (pdf.js), `workbench.ts` |
| Search text | yes | Full | `frontend/src/pdf/find.ts` |
| Bookmarks and links | yes | Full | `workbench.ts` Bookmarks side panel, `viewer.ts` link layer |
| Open password-protected PDFs | yes | Full | `workbench.ts askPassword`, `services/pdf/core.py reader(passwords)` |
| Read aloud, reflow, two-page layout | yes | Full | `viewer.ts setLayout` (single, continuous, two-page, two-page continuous, cover), `reading.ts Reflow` over `layout.py reflow`, `reading.ts Speaker` (speechSynthesis with sentence and word highlight) |
| Summarize or ask questions of a PDF (AI Assistant) | yes | Partial | no built-in model; an outside agent reads the PDF through the MCP pdf actions text and tables (`mcp.py t_pdf`, `services/pdf/core.py extract_text, extract_tables`) and answers in its own chat |

### PDF annotation

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Highlight, underline, strike through text | yes | Full | `frontend/src/pdf/annotate.ts`, `backend/app/services/pdf/annot.py annotate` |
| Sticky notes and text boxes | yes | Full | `annotate.ts` note and freetext tools |
| Drawing: ink, rectangle, ellipse, line, arrow | yes | Full | `annotate.ts` tools, `annot.py draw` |
| Stamps | yes | Full | `pdf/stamps.ts STAMPS` (standard, dynamic with name and date, sign-here, marks, picture stamps), `annot.py _stamp` Stamp annotations with appearance streams |
| Comment list with replies and status | yes | Full | Comment panel threads with replies and status (`panels.ts syncAnnots`), written as /IRT reply and /State annotations (`annot.py _thread`), read by `GET /pdf/{id}/comments` |
| Flatten annotations into the page | yes | Full | `panels.ts` Flatten into the page, `annot.py annotate(flatten)` |
| Measure distance, perimeter and area | yes | None | nothing found: no measuring tool in `annotate.ts Tool` or `services/pdf/annot.py KINDS` |

### Content editing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Edit PDF text and pictures in place | yes | None | nothing found: no tool edits text already on the page (`annotate.ts Tool` has markup and drawing tools only), and placed pictures are new annotations, not the page's own images |
| Add new text to PDF pages | yes | Partial | Fill & Sign > Add text and the Comment text box (`annotate.ts` freetext, `annot.py draw`) flattened into the page; size and colour only, one font, not editable as text after Apply |
| Edit PDF text formatting: font, size, colour, style | yes | Partial | only for text formpdf adds (`annotate.ts` freetext size select and colour palette, `annot.py font_for`); no font choice, bold, italic or underline, and no tool edits text already on the page (`annotate.ts Tool` has markup and drawing tools only) |
| Bulleted and numbered lists in PDF text | yes | None | nothing found |
| Align PDF paragraphs: left, centre, right, justify | yes | None | nothing found: added text boxes are left-aligned (`annot.py _text_block`); only new form fields have an alignment (`pdf/form.ts` Align) |
| Add links to PDF pages | yes | None | nothing found: `viewer.ts` follows existing links, but no tool creates a link |
| Spell check edited text and comments | yes | Partial | browser spell check on comment and text-box editing (`annotate.ts` textarea spellcheck) and multi-line form fields (`fill.ts`); no dictionaries or language settings |
| Add pictures to PDF pages | yes | Partial | Stamps > From a picture (`panels.ts` stamp-image) places a PNG, JPEG, WebP, GIF or BMP and `annot.py draw` image writes it (flattened or as a stamp comment); re-encoded to PNG at most 1600 px, and not editable as a page image afterwards |
| Crop pictures on PDF pages | yes | None | nothing found: placed pictures resize only (`annotate.ts`); no crop for any image |
| Generate pictures with AI (Adobe Express) | yes | None | nothing found |
| Arrange objects: bring forward, send backward | yes | None | nothing found: annotations and placed pictures have no z-order commands (`annotate.ts`) |
| Align and distribute objects on a page | yes | None | nothing found for page objects or form fields |
| Rotate and flip pictures on PDF pages | yes | None | nothing found: placed pictures follow the page rotation only; no rotate or flip |
| Attach files to a PDF | yes | None | nothing found: attachments are only counted and removed (`sanitize.py scan, sanitize`) |

### PDF forms and signing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Fill form fields | yes | Full | `frontend/src/pdf/fill.ts`, `services/pdf/edit.py read_fields, fill_fields` |
| Flatten a filled form | yes | Full | `edit.py fill_fields(flatten)` |
| Place a drawn or typed signature | yes | Full | `panels.ts` signature pad (Draw, Type), `placeSignature` |
| Certificate-based digital signatures | yes | None | nothing found: no certificate or PKCS#7 code in `services/pdf`; the Signature field type in `pdf/form.ts FormBuilder` only creates an empty /Sig field |
| Request signatures from others | yes | None | nothing found: no sending or signer workflow |
| Create form fields | yes | Full | Prepare form tab (`pdf/form.ts FormBuilder`: text, multi-line, check box, radio groups, dropdown, list box, date, signature; rename, delete), `forms.py prepare` writes AcroForm fields with appearance streams |

### PDF organize

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Reorder, rotate, delete, insert blank and insert pages from a PDF | yes | Full | `frontend/src/pdf/organize.ts Organizer`, `services/pdf/edit.py organize` |
| Extract pages | yes | Full | `panels.ts` Extract selected |
| Split by ranges | yes | Full | `services/pdf/core.py split` |
| Merge PDFs | yes | Full | `core.py merge`, `routers/pdf.py /pdf/merge` |
| Crop pages | yes | Full | Edit > Crop pages by margins, a drawn box or white-margin detection (`edit.py crop`, `annotate.ts` crop tool, `POST /pdf/{id}/crop`) |
| Page numbers, headers and footers, watermark | yes | Full | Edit > Header and footer with tokens and Bates numbering (`edit.py header_footer`), page numbers and watermark |
| Bates numbering | yes | Partial | `services/pdf/edit.py header_footer(bates)` with a <<bates>> token, prefix, start and digits from Edit > Header and footer, also MCP `pdf header_footer`; one file at a time, no numbering across a set of files |

### PDF protect and redact

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Password protection with permissions | yes | Full | `edit.py protect`, `panels.ts` Password and permissions |
| Remove protection | yes | Full | `edit.py unlock` |
| Redact marked areas | yes | Partial | `edit.py redact` removes the content by re-rendering each redacted page as a picture, so the rest of that page loses its text |
| Find and redact text or patterns | yes | Full | Protect > Find text to redact: words, regex, email, phone, card and date presets (`search.py find`), redacted through `edit.py redact`; MCP `pdf redact` |
| Remove metadata and hidden information | yes | Full | Protect > Remove hidden information (`sanitize.py scan, sanitize`: metadata, JavaScript, attachments, comments, flattened fields, hidden layers, links, bookmarks, thumbnails, private data, hidden text) |

### PDF convert

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Export to PowerPoint (.pptx) | yes | Partial | Convert > Export to PowerPoint and the to_pptx action (`services/pdf/slides.py to_pptx`): one slide per page, the page drawn as a picture with its text removed, words placed as real text boxes and detected tables as PowerPoint tables; rotated words and text in form XObjects stay in the picture, and shapes and pictures are not rebuilt as objects |
| Extract text as .txt or .md | yes | Full | `core.py extract_text`, `panels.ts` text-txt, text-md |
| Export to HTML or RTF | yes | None | nothing found: text leaves only as .txt or .md (`panels.ts` text-txt, text-md) and Word (`word.py to_docx`) |
| Extract pictures | yes | Full | `core.py extract_images` |
| Tables to Excel | yes | Partial | `core.py extract_tables, tables_xlsx` (detected tables only, not page layout) |
| Pages to pictures | yes | Full | `services/pdf/core.py pages_zip`, `render_png`, Convert > pages as PNG at 72, 144, 216 or 300 dpi; PNG only |
| Compress | yes | Full | `edit.py compress` |
| PDF to Word | yes | Partial | Convert > Word (`word.py to_docx`: headings, styled paragraphs, pictures, tables, page breaks), MCP `pdf to_docx`; multi-column pages flow into one column |
| OCR for scanned pages | yes | None | nothing found: no OCR engine in requirements or `services/pdf`; `panels.ts` tells the person scanned pages need OCR first |
| Create a PDF from pictures | yes | Full | `create.py from_files` (one page per picture, fit, A4 or Letter, margins, orientation; PDFs combined in order), `pdf/create.ts` from Home and the Open menu |
| Scan paper documents to PDF | yes | None | nothing found: no scanner acquisition |

### Review and comments

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Compare two versions of a PDF | yes | Full | `pdf/compare.ts Comparer`, `services/pdf/compare.py compare`: View > Compare against an older or newer PDF, word-level insertions, changes and deletions marked on the page with optional picture changes, every difference listed with before and after text; no summary report file |
| Track a review: who commented, when, and with what status | yes | Partial | comments are read with author, date, replies and status (`annot.py comments`, `panels.ts syncAnnots`); no review tracker across files or reviewers |

### Collaboration and sharing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Share PDF links with permissions | yes | None | nothing found: no hosted service |
| Works offline on local files | yes | Full | local engine; working copies under the data folder (`services/pdf/docs.py root`) and Save writes the PDF back to disk (`routers/pdf.py /pdf/{doc_id}/save`) |

### Accessibility

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Accessibility checker for PDFs | yes | None | nothing found: formsld's `services/lint.py` checks decks, not PDFs |
| Reading Order tool for tagged PDFs | yes | None | nothing found: reading order is only inferred for Reading view (`layout.py xycut`), never written to tags |
| Screen reader support in the app | yes | Partial | ARIA roles and labels on workbench buttons, panels and dialogs (`workbench.ts`, `panels.ts`, `form.ts` aria-label); page content is pdf.js canvas plus text layer; not audited |
| Alternate text for figures | yes | None | nothing found: no structure-tree editing in `services/pdf` |
| Tag a PDF for accessibility (autotag) | yes | None | nothing found: no PDF is tagged; edits through pypdf keep but never add /StructTreeRoot |

### Import and export

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Create PDFs from Office files (Word, PowerPoint, Excel) | yes | None | nothing found: `services/pdf/create.py from_files` takes pictures and PDFs only |

### Print

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Print PDFs, including several pages per sheet | yes | Partial | Print renders every page with pdf.js and hands it to the system print dialog (`workbench.ts print`, Tauri print_window or window.print); pages per sheet, booklet and scaling only where the system dialog offers them |
| Print settings: paper size, grayscale, scaling | yes | Partial | no print settings of its own: paper, colour and scaling come from the system print dialog (`workbench.ts print`) |
| Preflight and PDF/A, PDF/X standards | yes | None | nothing found: no preflight, output intents or PDF/A conversion in `services/pdf` |

### Automation and agents

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Generate a presentation from PDFs and files with AI (PDF Spaces) | yes | None | nothing found: formpdf has no deck editor and no built-in model; Export to PowerPoint converts pages, it does not draft a presentation |
| JavaScript and guided actions | yes | Partial | no JavaScript (`sanitize.py` only removes it) and no in-app action sequences; repeatable steps only from outside, through the MCP pdf actions or the CLI |
| Plug-ins and add-ons | yes | None | nothing found |
| MCP server for outside agents (HTTP and stdio) | no | Full | `backend/app/routers/mcp.py` HTTP server on 127.0.0.1:8198/mcp and `setup/mcp_stdio.py` stdio bridge (engine found through ~/Formpdf/engine.json); tools get_context, open_pdf, pdf, render_pages, extract, save, undo |
| Agent edits land live in the open window and undo per turn | no | Full | a change from `mcp.py t_pdf` without an out path replaces the PDF open in the window live (`live/agent.ts`, `pdf/workbench.ts`), labelled Agent: in its history; Undo turn in the status bar, Edit > Undo agent turn (Alt+Mod+Z) and the MCP `undo` tool return the version before the turn; the agent's change is refused if the person edited meanwhile |
| Agent sees its pages | no | Full | `render_pages` returns a contact sheet of chosen pages (`services/pdf/slides.py`, pdfium) and `extract` returns text, tables and pictures (`core.py extract_text, extract_tables, extract_images`) |
| Agent consent and on/off switch | no | Full | `mcp.py _mutating` sends open_pdf, save, undo and every change or export action of the pdf tool through `_consent` (Allow agents to edit? in the window); reads never ask; Preferences > Agents turns agents off |
| Skills shipped for Claude Code, Codex and Cursor | no | Full | `.claude/skills/formpdf-harness` and `formpdf-skillset`, mirrored by `./formpdf agents sync` to .agents/skills; `.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json` point at the formpdf MCP server |
| Headless processing from the command line | no | Full | `./formpdf run` (`setup/cli.py`): any pdf action on files with --out, --pages, --preset and the rest, plus render and merge, headless |

### Platform

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Desktop app | yes | Partial | Tauri shell in `src-tauri/`, bundles from `.github/workflows/desktop.yml`; signing optional |
| Runs in a browser | yes | Partial | Vite app against a local engine; no hosted service |
| Phone and tablet | yes | None | nothing found |
| macOS, Windows and Linux builds | no | Full | `.github/workflows/desktop.yml` builds the Tauri app on macos-latest, ubuntu-22.04 and windows-latest (`src-tauri/tauri.conf.json` bundle targets all) |
