# Parity with Adobe Acrobat

formpdf 0.13.0, scored row by row against Adobe Acrobat Pro and Studio (help current to the August 2026 feature update).

## Method

Each row is a capability Acrobat's own help documents, written in Acrobat's terms: what it does to a PDF. Each formpdf cell names the file and symbol where the trace ended. Full means implemented and reachable from the interface (or, for agent rows, the agent surface) through to the saved file; Partial means present but narrower than Acrobat's, or not reachable; None means nothing was found. Full counts 1, Partial one half, None 0. Rows Acrobat does not document (formpdf's agent rows) and the Platform rows are listed but not scored. The rows and grades live in docs/parity.py; rerun `python3 docs/parity.py --md` after a release and paste the tables here.

## Scores

| Area | vs Acrobat |
| --- | --- |
| PDF viewing | 6 of 6 · 100% |
| PDF annotation | 7 of 7 · 100% |
| Content editing | 14 of 14 · 100% |
| PDF forms and signing | 5.5 of 6 · 92% |
| PDF organize | 7 of 7 · 100% |
| PDF protect and redact | 5 of 5 · 100% |
| PDF convert | 11 of 11 · 100% |
| Review and comments | 2 of 2 · 100% |
| Collaboration and sharing | 1 of 2 · 50% |
| Accessibility | 4.5 of 5 · 90% |
| Import and export | 1 of 1 · 100% |
| Print | 2.5 of 3 · 83% |
| Automation and agents | 2 of 3 · 67% |
| **Overall** | **68.5 of 72 · 95%** |

Across the 72 scored rows formpdf has 66 full, 5 partial and 1 none.

## Where formpdf leads

Rows no Acrobat page documents: MCP server for outside agents (HTTP and stdio); Agent edits land live in the open window and undo per turn; Agent sees its pages; Agent consent and on/off switch; Skills shipped for Claude Code, Codex and Cursor; Headless processing from the command line.

## Where formpdf trails most

- **AI presentations.** Outlines are drafted from several files and saved as PowerPoint, but as text slides on the default template, without a designed theme or pictures from the sources.
- **Signing requests.** Signers and their order are tracked in the PDF, but sending and reminders go through the person's own email rather than a service.
- **Print production.** No CMYK conversion or transparency flattening, and PDF/X output is not validated by an outside tool.
- **Form JavaScript.** Standard Acrobat calculations, formats and checks run, but no PDF JavaScript is executed, so custom form scripts do nothing.
- Rows with nothing yet: Share PDF links with permissions, which needs a hosted service; formpdf is local only by choice.

## Line by line

### PDF viewing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| View with thumbnails, zoom, fit width or page, rotate view | yes | Full | `frontend/src/pdf/viewer.ts Viewer` (pdf.js), `workbench.ts` |
| Search text | yes | Full | `frontend/src/pdf/find.ts` |
| Bookmarks and links | yes | Full | `workbench.ts` Bookmarks side panel, `viewer.ts` link layer |
| Open password-protected PDFs | yes | Full | `workbench.ts askPassword`, `services/pdf/core.py reader(passwords)` |
| Read aloud, reflow, two-page layout | yes | Full | `viewer.ts setLayout` (single, continuous, two-page, two-page continuous, cover), `reading.ts Reflow` over `layout.py reflow`, `reading.ts Speaker` (speechSynthesis with sentence and word highlight) |
| Summarize or ask questions of a PDF (AI Assistant) | yes | Full | Assistant tab (`tools/assistant.ts`) over `services/ai.py ask, summary`: questions and summaries from the person's agent (answer_question), Anthropic or OpenAI with their key, or a local model; answers cite pages as links and every quotation is checked against the cited page, unverified ones marked |

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
| Edit PDF text and pictures in place | yes | Full | Edit > Text and pictures > Select: any paragraph already on the page (`textedit.py detect`: lines, table walls, duplicate and invisible layers, alignment, bullets) is retyped in place, rewraps to its box and keeps its own font where the font has the letters (`items.py` orig fonts), or moves, widens, rotates and restyles; pictures already on the page move, resize, rotate, flip, crop, are replaced or deleted without re-encoding; MCP and CLI `edit_items {page, paragraph}` |
| Add new text to PDF pages | yes | Full | Edit > Text and pictures > Add text (`tools/content.ts`, `tools/richtext.ts`): type on the page in a live editor, saved as page content that stays editable (`services/pdf/items.py`, actions items and edit_items in MCP and the CLI); double-click to edit again, move, resize the width, rotate; Make page text turns a comment text box into page text |
| Edit PDF text formatting: font, size, colour, style | yes | Full | for added text and text already on the page: the document's font or Inter, Noto Serif or JetBrains Mono, size, colour, bold, italic, underline, strike, super and subscript per run, alignment, lists, line spacing (`tools/content.ts`, `items.py layout`, `textedit.py`); the pane names the font edits will use |
| Bulleted and numbered lists in PDF text | yes | Full | in added page text: bulleted and numbered lists with hanging indents and four levels (Tab and Shift+Tab), numbering restarting after other paragraphs (`richtext.ts setList, indent`, `items.py layout`) |
| Align PDF paragraphs: left, centre, right, justify | yes | Full | in added page text, per paragraph: left, centre, right and justify with the last line left (`richtext.ts`, `items.py layout`) |
| Add links to PDF pages | yes | Full | Edit > Links (`frontend/src/tools/links.ts`): draw a box and link it to a web address, an email address or a page, link every web and email address in the text, list and remove links; `services/pdf/links.py change, read` (actions edit_links and links in MCP, the CLI and Batch); following a link offers http, https and mailto only, behind a prompt (`workbench.ts openLink`) |
| Spell check edited text and comments | yes | Full | Comment > Check spelling (`tools/spell.ts`, F7) over PDF comments, text boxes, form field text and comments not applied yet, with suggestions, Change, Change all, Ignore, Ignore all and Add to dictionary; engine `spell.py` reads Hunspell dictionaries (SCOWL en_US bundled, more in Formpdf/dictionaries), MCP `pdf spell` and `spell_fix`; Preferences > Spelling sets the language and your words |
| Add pictures to PDF pages | yes | Full | Edit > Text and pictures > Add picture (`tools/content.ts`): PNG, JPEG, GIF, WebP, BMP or TIFF placed as page content at full resolution, JPEG kept as JPEG, EXIF orientation honoured, editable afterwards (`items.py image_object`) |
| Crop pictures on PDF pages | yes | Full | Select a picture added by formpdf or already on the page, Crop and drag the handles (Enter keeps it), Reset crop; a clip in the picture's form, never a re-encode (`items.py _picture_form`, `Page.convert`) |
| Generate pictures with AI (Adobe Express) | yes | Full | Assistant > Generate a picture and the ai_picture action (`services/ai.py picture`): a prompt goes to OpenAI's image API or a picture server on the person's computer, and the result is placed as an editable page picture (`items.py`) that Edit > Select moves, resizes and crops |
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
| Certificate-based digital signatures | yes | Full | Fill & Sign > Sign with a digital ID (`tools/certsign.ts`) and the sign and signatures actions (`services/pdf/sign.py`, pyHanko): digital IDs made here or imported from .p12 and .pfx, PAdES signatures into a field or a drawn box with a text or picture appearance, certification with forms, comments or no changes allowed, field locking, RFC 3161 timestamps from a server the person sets; validation against certificates trusted on this computer with plain-sentence verdicts and formpdf's own change analysis, signed versions saved out; comments and form filling save incrementally so signatures stay valid |
| Request signatures from others | yes | Partial | Fill & Sign > Request signatures and the request_signatures action (`services/pdf/sign.py`): ordered signers assigned to signature fields, status with who is next, an email link, and signed copies joined back as versions; partial because Acrobat sends, reminds and collects through its cloud service and formpdf leaves sending to the person's own email |
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
| Export to PowerPoint (.pptx) | yes | Full | Convert > Export to PowerPoint and the to_pptx action (`services/pdf/slides.py to_pptx`, `objects.py split`): one slide per page; words as real text boxes (turned words as turned boxes, text in form XObjects included), detected tables as PowerPoint tables, lines, rectangles and other paths as PowerPoint shapes and pictures as pictures, over a slide picture that keeps only what cannot be rebuilt (shadings, soft masks, clipped or skewed objects and what is drawn before them) |
| Extract text as .txt or .md | yes | Full | `core.py extract_text`, `panels.ts` text-txt, text-md |
| Export to HTML or RTF | yes | Full | Convert > Web page, rich text and Excel (`tools/exports.ts`), MCP `pdf to_html` and `to_rtf` (`exports.py`): one self-contained HTML file with pictures inline, or RTF with lists, tables and pictures; headings, lists and tables in reading order with running headers and footers left out |
| Extract pictures | yes | Full | `core.py extract_images` |
| Tables to Excel | yes | Full | Convert > Save as Excel and MCP `pdf to_xlsx` (`exports.py`): one sheet per page in reading order, table numbers, money and percentages stored as real numbers with their formats, a tables-only option; Extract > Tables (`core.py tables_xlsx`) still exports detected tables |
| Pages to pictures | yes | Full | `services/pdf/core.py pages_zip`, `render_png`, Convert > pages as PNG at 72, 144, 216 or 300 dpi; PNG only |
| Compress | yes | Full | `edit.py compress` |
| PDF to Word | yes | Full | Convert > Word (`word.py to_docx`: headings, styled paragraphs, Word bullet and numbered lists, pictures, tables, column sections, running headers and footers in the Word header and footer with a PAGE field), MCP `pdf to_docx` |
| OCR for scanned pages | yes | Full | Convert > Make searchable (OCR) and the ocr action (`services/pdf/ocr.py`): RapidOCR with PaddleOCR's Apache-2.0 models on onnxruntime, on this computer; skips pages with text, caps the render at the scan's resolution, straightens tilted scans, writes an invisible per-word text layer in an embedded Unicode font that find, redaction and exports use, rotated pages included; Batch, MCP and CLI |
| Create a PDF from pictures | yes | Full | `create.py from_files` (one page per picture, fit, A4 or Letter, margins, orientation; PDFs combined in order), `pdf/create.ts` from Home and the Open menu |
| Scan paper documents to PDF | yes | Full | Home and File > Scan (`pdf/scan.ts`, `services/scan.py`): network scanners found over mDNS and driven with eSCL (glass, feeder, both sides, resolution, colour), USB scanners through SANE on Linux and WIA on Windows; into a new PDF or added to the open one, made searchable on the way |

### Review and comments

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Compare two versions of a PDF | yes | Full | `pdf/compare.ts Comparer`, `services/pdf/compare.py compare`: View > Compare against an older or newer PDF, word-level insertions, changes and deletions marked on the page with optional picture changes, every difference listed with before and after text; no summary report file |
| Track a review: who commented, when, and with what status | yes | Full | Home > Reviews (`ui/reviews.ts`, `services/reviews.py`): every recent PDF with comments, its reviewers with their counts and last dates, open and resolved threads and last activity, opening on the Comment tab; reviews pass between copies as XFDF (`xfdf.py export_xfdf, import_xfdf`, Comment > Share comments) with replies, status, authors and dates, matched by name so nothing is duplicated |

### Collaboration and sharing

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Share PDF links with permissions | yes | None | nothing found: no hosted service |
| Works offline on local files | yes | Full | local engine; working copies under the data folder (`services/pdf/docs.py root`) and Save writes the PDF back to disk (`routers/pdf.py /pdf/{doc_id}/save`) |

### Accessibility

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Accessibility checker for PDFs | yes | Full | Accessibility > Accessibility check and the accessibility action (`services/pdf/access.py check`): Acrobat's 32 rules in its seven groups with passed, failed, manual and skipped, page findings, a fix per repairable rule (`fix_accessibility`: tags, title, language, tab order, untagged comments and fields, field descriptions, table summaries, bookmarks) and an HTML report (`accessibility_report`) |
| Reading Order tool for tagged PDFs | yes | Full | Accessibility > Reading order (`tools/access.ts`): numbered tagged regions on the pages, retag, move earlier or later, mark as background; `structure` and `edit_structure` for agents |
| Screen reader support in the app | yes | Partial | labelled region, tabs pattern with arrow keys and labelled tab panels (`workbench.ts`), status region for long jobs, dialogs labelled with focus kept inside (`ui/dialogs.ts`), ARIA labels on buttons and fields; page content is pdf.js canvas plus text layer; partial because it has not been tried with VoiceOver or NVDA |
| Alternate text for figures | yes | Full | Accessibility > Alternate text (`tools/access.ts`): figure by figure with a crop of the page, alternate text or decorative; `edit_structure {alt, decorative}` |
| Tag a PDF for accessibility (autotag) | yes | Full | Accessibility > Tags and the autotag action (`services/pdf/access.py tag`): headings, paragraphs, lists, tables with header cells, figures with boxes, links, fields and comments in reading order from `layout.page_blocks`, running headers and footers as artifacts, marked content written stream by stream; renders unchanged and Poppler reads the tree |

### Import and export

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Create PDFs from Office files (Word, PowerPoint, Excel) | yes | Full | Combine files, drops on Home and the workbench, open_pdf, merge and the CLI convert Word, PowerPoint, Excel, OpenDocument, RTF, text and CSV through the LibreOffice the person installs (`services/office.py`, `create.py from_files`), headless with macros and link updates off; the window says when LibreOffice is missing, as Acrobat needs Office for some of its own conversions |

### Print

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Print PDFs, including several pages per sheet | yes | Full | Print tab (`tools/print.ts`, `pdf/printjob.ts`) over `services/pdf/printing.py`: pages per sheet (1 to 16) in four orders with borders, booklets with binding side, posters with overlap, cut marks and labels, comments and fields choice, a live preview of every sheet, printed through a print PDF sized with @page on every platform or saved |
| Print settings: paper size, grayscale, scaling | yes | Full | fit, shrink, actual and custom scale, named or page-sized paper, orientation and margins (`printing.py options`); grayscale converted in the file by rewriting colours and pictures (`colour.py`), not left to the driver |
| Preflight and PDF/A, PDF/X standards | yes | Partial | PDF/A-2b, 2u and 3b check and convert with ISO 19005 clauses, font embedding from Liberation and an sRGB output intent (`pdfa.py`; converted files pass veraPDF where formpdf says they conform); PDF/X-4 with a supplied printer profile; preflight profiles with fixups and a report (`preflight.py`); partial because there is no CMYK conversion, transparency flattening or PDF/X validation |

### Automation and agents

| Capability | Acrobat | formpdf | Evidence |
| --- | --- | --- | --- |
| Generate a presentation from PDFs and files with AI (PDF Spaces) | yes | Partial | Assistant > Generate a presentation, ai_outline and ai_deck (`services/ai.py outline, deck`): an outline drafted from this PDF and up to ten more PDFs, Office or text files, edited in the pane, saved as PowerPoint with sources in the notes; partial because slides are text on the default template, without a designed theme or pictures from the sources |
| JavaScript and guided actions | yes | Partial | action lists: five built in, recorded from the window's own changes, saved, run on the open PDF as one undoable version, in Batch, by agents and from the CLI (`lists.py run_list`, `tools/lists.ts`, `pdf/recorder.ts`); form calculations, formats, keystrokes and range checks written with Acrobat's standard functions run as the person fills (`pdf/formcalc.ts`); partial because no PDF JavaScript is executed, so custom form scripts, document scripts and a console are not available |
| Plug-ins and add-ons | yes | Full | plug-in folders with an engine file and a window file, off until the person allows them and off again when they change (`plugins.py`); a plug-in registers ordinary actions that reach the MCP tool, the palette, Batch, action lists and the CLI, and adds tool sections to any tab (`pdf/plugins.ts`, `pdf/tools.ts registerTool`); sample in `docs/plugins/word-count` |
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
