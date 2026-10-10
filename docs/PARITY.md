# Parity with Adobe Acrobat

formpdf 0.5.0, scored row by row against Adobe Acrobat Pro and Studio (help current to the August 2026 feature update).

## Method

Each row is a capability Acrobat's own help documents, written in Acrobat's terms: what it does to a PDF. Each formpdf cell names the file and symbol where the trace ended. Full means implemented and reachable from the interface (or, for agent rows, the agent surface) through to the saved file; Partial means present but narrower than Acrobat's, or not reachable; None means nothing was found. Full counts 1, Partial one half, None 0. Rows Acrobat does not document (formpdf's agent rows) and the Platform rows are listed but not scored. The rows and grades live in docs/parity.py; rerun `python3 docs/parity.py --md` after a release and paste the tables here.

## Scores

| Area | vs Acrobat |
| --- | --- |
| PDF viewing | 5.5 of 6 · 92% |
| PDF annotation | 7 of 7 · 100% |
| Content editing | 11.5 of 14 · 82% |
| PDF forms and signing | 4 of 6 · 67% |
| PDF organize | 7 of 7 · 100% |
| PDF protect and redact | 5 of 5 · 100% |
| PDF convert | 8.5 of 11 · 77% |
| Review and comments | 1.5 of 2 · 75% |
| Collaboration and sharing | 1 of 2 · 50% |
| Accessibility | 0.5 of 5 · 10% |
| Import and export | 0 of 1 · 0% |
| Print | 1 of 3 · 33% |
| Automation and agents | 0.5 of 3 · 17% |
| **Overall** | **53 of 72 · 74%** |

Across the 72 scored rows formpdf has 49 full, 8 partial and 15 none.

## Where formpdf leads

Rows no Acrobat page documents: MCP server for outside agents (HTTP and stdio); Agent edits land live in the open window and undo per turn; Agent sees its pages; Agent consent and on/off switch; Skills shipped for Claude Code, Codex and Cursor; Headless processing from the command line.

## Where formpdf trails most

- **Content editing.** formpdf adds page text and pictures that stay editable, crops, rotates, arranges and aligns them and the pictures already on a page, adds links and attached files and checks spelling, but does not yet edit or reformat the text a PDF already has.
- **Accessibility.** No accessibility checker, no tagging and no reading-order editor for PDFs.
- **Signing and scanning.** No certificate signatures, signature requests, OCR or scanning.
- Rows with nothing yet: Edit PDF text and pictures in place; Generate pictures with AI (Adobe Express); Certificate-based digital signatures; Request signatures from others; OCR for scanned pages; Scan paper documents to PDF; Share PDF links with permissions; Accessibility checker for PDFs; Reading Order tool for tagged PDFs; Alternate text for figures; Tag a PDF for accessibility (autotag); Create PDFs from Office files (Word, PowerPoint, Excel); Preflight and PDF/A, PDF/X standards; Generate a presentation from PDFs and files with AI (PDF Spaces); Plug-ins and add-ons.

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
| Measure distance, perimeter and area | yes | Full | Comment > Measure (`frontend/src/tools/measure.ts`): distance, perimeter and area with a live value, units, calibration from a known length, snapping to path ends, midpoints and crossings, 45 degree steps, a list with remove and CSV export; saved as Line, PolyLine and Polygon measurement annotations with a Measure dictionary and their own appearance (`services/pdf/measure.py change, read, snap`; actions measure, measurements, snap_points) |

### Content editing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Edit PDF text and pictures in place | yes | None | nothing found: no tool edits text already on the page (`annotate.ts Tool` has markup and drawing tools only), and placed pictures are new annotations, not the page's own images |
| Add new text to PDF pages | yes | Full | Edit > Text and pictures > Add text (`tools/content.ts`, `tools/richtext.ts`): type on the page in a live editor, saved as page content that stays editable (`services/pdf/items.py`, actions items and edit_items in MCP and the CLI); double-click to edit again, move, resize the width, rotate; Make page text turns a comment text box into page text |
| Edit PDF text formatting: font, size, colour, style | yes | Partial | for text formpdf adds: Inter, Noto Serif or JetBrains Mono, size, colour, bold, italic, underline, strike, super and subscript per run, line spacing (`tools/content.ts`, `items.py layout`); text already on the page is not editable yet (Phase 4) |
| Bulleted and numbered lists in PDF text | yes | Full | in added page text: bulleted and numbered lists with hanging indents and four levels (Tab and Shift+Tab), numbering restarting after other paragraphs (`richtext.ts setList, indent`, `items.py layout`) |
| Align PDF paragraphs: left, centre, right, justify | yes | Full | in added page text, per paragraph: left, centre, right and justify with the last line left (`richtext.ts`, `items.py layout`) |
| Add links to PDF pages | yes | Full | Edit > Links (`frontend/src/tools/links.ts`): draw a box and link it to a web address, an email address or a page, link every web and email address in the text, list and remove links; `services/pdf/links.py change, read` (actions edit_links and links in MCP, the CLI and Batch); following a link offers http, https and mailto only, behind a prompt (`workbench.ts openLink`) |
| Spell check edited text and comments | yes | Full | Comment > Check spelling (`tools/spell.ts`, F7) over PDF comments, text boxes, form field text and comments not applied yet, with suggestions, Change, Change all, Ignore, Ignore all and Add to dictionary; engine `spell.py` reads Hunspell dictionaries (SCOWL en_US bundled, more in Formpdf/dictionaries), MCP `pdf spell` and `spell_fix`; Preferences > Spelling sets the language and your words |
| Add pictures to PDF pages | yes | Full | Edit > Text and pictures > Add picture (`tools/content.ts`): PNG, JPEG, GIF, WebP, BMP or TIFF placed as page content at full resolution, JPEG kept as JPEG, EXIF orientation honoured, editable afterwards (`items.py image_object`) |
| Crop pictures on PDF pages | yes | Full | Select a picture added by formpdf or already on the page, Crop and drag the handles (Enter keeps it), Reset crop; a clip in the picture's form, never a re-encode (`items.py _picture_form`, `Page.convert`) |
| Generate pictures with AI (Adobe Express) | yes | None | nothing found |
| Arrange objects: bring forward, send backward | yes | Full | Bring to front, Bring forward, Send backward, Send to back (Mod+], Mod+[ with Shift for front and back) for page text, pictures (added or already on the page) and comments (`tools/content.ts arrange`; `items.py Page.arrange`, edit_items comments for comments already in the PDF) |
| Align and distribute objects on a page | yes | Full | align left, centre, right, top, middle, bottom and distribute across or down for selected page text, pictures and comments (Edit > Text and pictures) and for new form fields (Prepare form > Align fields, Shift-click to select several) (`pdf/align.ts`, `tools/formalign.ts`) |
| Rotate and flip pictures on PDF pages | yes | Full | rotate by any angle with the rotate handle (Shift for 15 degree steps) or by 90 degrees, flip horizontally or vertically, for pictures added by formpdf and pictures already on the page, by transform only (`items.py placement`) |
| Attach files to a PDF | yes | Full | Edit > Attached files (`frontend/src/tools/attachments.ts`): attach files of any type to the document, pin a file to a spot on a page (a FileAttachment comment with a paperclip), list, save a copy and remove; `services/pdf/attach.py change, read, get_file` (actions edit_attachments and attachments), GET /api/pdf/{id}/attachment; Remove hidden information still strips them |

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
| Bates numbering | yes | Full | `services/pdf/edit.py header_footer(bates)` with a <<bates>> token, prefix, suffix, start and digits from Edit > Header and footer and MCP `pdf header_footer`; across a set of legal documents from Home > Batch (`routers/batch.py _bates, _numbered`): numbers continue from file to file in the order listed, each row shows its range, and Bates numbers.csv records file, numbered copy, first and last |

### PDF protect and redact

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Password protection with permissions | yes | Full | `edit.py protect`, `panels.ts` Password and permissions |
| Remove protection | yes | Full | `edit.py unlock` |
| Redact marked areas | yes | Full | `redact.py apply`: text, covered pixels, shapes, comments, fields and item text under each box removed, the rest stays text; marks in the file applied with their own fill and overlay text; re-read and render checks before writing; `mark_redactions`; Protect > Redact (fill, text on box, Scanned pages for `edit.py redact` raster) |
| Find and redact text or patterns | yes | Full | Protect > Find text to redact: words, regex, email, phone, card and date presets (`search.py find`), redacted through `edit.py redact`; MCP `pdf redact` |
| Remove metadata and hidden information | yes | Full | Protect > Remove hidden information (`sanitize.py scan, sanitize`: metadata, JavaScript, attachments, comments, flattened fields, hidden layers, links, bookmarks, thumbnails, private data, hidden text) |

### PDF convert

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Export to PowerPoint (.pptx) | yes | Partial | Convert > Export to PowerPoint and the to_pptx action (`services/pdf/slides.py to_pptx`): one slide per page, the page drawn as a picture with its text removed, words placed as real text boxes and detected tables as PowerPoint tables; rotated words and text in form XObjects stay in the picture, and shapes and pictures are not rebuilt as objects |
| Extract text as .txt or .md | yes | Full | `core.py extract_text`, `panels.ts` text-txt, text-md |
| Export to HTML or RTF | yes | Full | Convert > Web page, rich text and Excel (`tools/exports.ts`), MCP `pdf to_html` and `to_rtf` (`exports.py`): one self-contained HTML file with pictures inline, or RTF with lists, tables and pictures; headings, lists and tables in reading order with running headers and footers left out |
| Extract pictures | yes | Full | `core.py extract_images` |
| Tables to Excel | yes | Full | Convert > Save as Excel and MCP `pdf to_xlsx` (`exports.py`): one sheet per page in reading order, table numbers, money and percentages stored as real numbers with their formats, a tables-only option; Extract > Tables (`core.py tables_xlsx`) still exports detected tables |
| Pages to pictures | yes | Full | `services/pdf/core.py pages_zip`, `render_png`, Convert > pages as PNG at 72, 144, 216 or 300 dpi; PNG only |
| Compress | yes | Full | `edit.py compress` |
| PDF to Word | yes | Full | Convert > Word (`word.py to_docx`: headings, styled paragraphs, Word bullet and numbered lists, pictures, tables, column sections, running headers and footers in the Word header and footer with a PAGE field), MCP `pdf to_docx` |
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
