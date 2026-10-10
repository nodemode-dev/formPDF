# backend HASHOUT_LOG

Living log for the formpdf engine, _v0.1.0. The code carries almost no comments; the reasons live here, anchored by file and symbol. Entries 2 to 7 were carried across from formsld 0.5.1 (its backend entries 8, 19, 20, 21, 27 and 3) and renumbered; the rest record the extraction. Read the map and the TOC first.

## Org navi map

```
app/main.py                  app, CORS, discovery file (~/Formpdf/engine.json), routers, static dist
app/core/                    config.py (ports 5198 and 8198, FORMPDF_* env, data folders, settings), ids.py
app/routers/pdf.py           /api/pdf: open, recent, every operation, exports, save
app/routers/live.py          /api/live WebSocket: windows, their open document, window tool results
app/routers/mcp.py           /mcp: the MCP server, tools, consent, turns, live landing
app/routers/system.py        health, version, capabilities, settings
app/routers/batch.py         /api/batch: upload copies, run one action on many files as a job, status, zip of results
app/routers/media.py         extracted pictures
app/services/bridge.py       window list, window document, window_call
app/services/media.py        formpdf-owned picture store
app/services/pdf/            docs, core, edit, annot, forms, layout, word, slides, sanitize, search, create, compare, actions (registry)
app/services/pdf/content/    fonts.py (codes, widths, Unicode both ways), interp.py (walk: glyphs, draws, streams), streams.py (write-back)
```

## TOC

1. Versions, never edits in place · services/pdf/docs.py, routers/pdf.py _derive
2. True redaction rasterizes · services/pdf/edit.py
3. Find text in a PDF and redact it · services/pdf/search.py
4. Headers, footers, Bates numbers and cropping · services/pdf/edit.py
5. PDF comment threads · services/pdf/annot.py
6. PDF reflow, Word, forms, sanitising and compare · services/pdf/layout.py and friends
7. Lenient MCP protocol versions · routers/mcp.py
8. What moved out of formsld and what stayed · the whole engine
9. A small picture store instead of formsld's media service · services/media.py
10. PDF to PowerPoint with real text boxes · services/pdf/slides.py to_pptx
11. Contact sheets for agents · services/pdf/slides.py contact_sheet
12. The MCP split: seven tools, one pdf tool with actions · routers/mcp.py
13. Live agent changes land in the window as a turn · routers/mcp.py _land, routers/live.py
14. Consent for every action that writes · routers/mcp.py _mutating
15. Compress without document info · services/pdf/edit.py compress
16. One action registry for MCP, the CLI, batch and the palette · services/pdf/actions.py
17. The content interpreter · services/pdf/content/
18. The font kit · services/pdf/fontkit.py, app/fonts/
19. Batch jobs · routers/batch.py
20. Session restore and the network list · services/session.py, routers/live.py, routers/system.py
21. One route for registered actions · routers/pdf.py act
22. Links · services/pdf/links.py, services/pdf/frame.py
23. Attached files · services/pdf/attach.py
24. Bates numbers across files · routers/batch.py _bates
25. Measurements · services/pdf/measure.py, content/interp.py Draw.points

## 1. Versions, never edits in place · _v0.1.0 (services/pdf/docs.py derive, routers/pdf.py _derive)

Every opened PDF becomes a working copy `Pdf/pdf_xxxxxxxxxx.pdf` with a meta file (name, original path, root key, protection). Every operation writes a new id derived from its source, re-applies protection and discards the output on failure; nothing is deleted on success. The window's Undo, the agent's undo and the recents all rely on old versions staying where they are, so do not prune them while a session is open.

## 2. True redaction rasterizes · _v0.1.0 (services/pdf/edit.py redact)

Redaction renders the marked pages with pypdfium2, burns black boxes in and replaces those pages with images, so nothing under a box survives; the UI and the agent guide both say those pages become images.

## 3. Find text in a PDF and redact it · _v0.1.0 (services/pdf/search.py pattern, find, areas; routers/pdf.py find)

Search runs over PDFium's text page, so matches carry real character boxes even across line breaks; each match returns its page, the matched text, trimmed context and one rect per line in top-left page points (the frame the redaction areas already use). Presets are regexes with a check function where a regex alone over-matches: phone numbers need 7 to 15 digits, card numbers pass Luhn, dates accept numeric and month-name forms. Results stop at 2000 matches with `truncated` set. `areas()` pads each rect by a point so redaction covers descenders.

## 4. Headers, footers, Bates numbers and cropping · _v0.1.0 (services/pdf/edit.py header_footer, crop, _content_margins)

Header and footer text is drawn with reportlab on an overlay per page and merged, honouring each page's rotation and view box, with `<<page>>`, `<<pages>>`, `<<date>>`, `<<file>>` and `<<bates>>` tokens, a page range, odd or even pages and a start number. Bates numbers are a prefix plus a zero-padded counter. Crop writes `/CropBox` only, so content outside stays in the file and the crop can be undone; that is why the panel points to Redact for removal. Remove white margins renders each page and finds the content bounds, padded by 4 points.

## 5. PDF comment threads · _v0.1.0 (services/pdf/annot.py _thread, comments; routers/pdf.py get_comments)

Replies are Text annotations with `/IRT` pointing at the parent and the reply flag set, so Acrobat and other readers show them as a thread. Status is a separate hidden Text annotation with `/State` and `/StateModel /Review`, as Acrobat writes it. `comments()` reads both back: replies are followed up their `/IRT` chain to the root comment, and the latest review state per comment wins.

## 6. PDF reflow, Word, forms, sanitising and compare · _v0.1.0 (services/pdf/layout.py, word.py, forms.py, sanitize.py, create.py, compare.py)

Reading order is an XY-cut that prefers vertical gutters and merges bands that share one, so aligned paragraph gaps do not interleave columns; tables and pictures take part in the cut. Words use pdfplumber with `x_tolerance_ratio=0.15` because the 3 pt default glues tight words. Form fields get upright appearance streams with `/Matrix` and `/MK /R` for rotated pages, `NeedAppearances`, Acrobat's AFDate actions for date fields, and radio groups as a parent with widget kids. Sanitising flattens widgets by painting their normal appearance, drops hidden layers by filtering `/OC` marked content, drops text drawn in render mode 3, and prunes orphans so removed data leaves the file. Compare pairs pages by exact text first, then aligns the rest by word-set similarity.

## 7. Lenient MCP protocol versions · _v0.1.0 (routers/mcp.py mcp)

2026-07-28 and 2025-11-25 are advertised, and 2025-06-18, 2025-03-26 and 2024-11-05 are accepted at initialize because older Cursor and Codex builds disconnect otherwise. Clients that send no session id share an "anon-[client name]" key so their turns still group.

## 8. What moved out of formsld and what stayed · _v0.1.0 (app/)

Moved unchanged apart from branding: services/pdf (core, edit, annot, forms, layout, word, sanitize, search, create, compare, docs), routers/pdf.py, the system and media routes, the discovery file, the MCP protocol handling and stdio bridge. Removed: the deck store and ops, compiler, autodraft, intake, templates, pptx reader and writer, lint, exports, the deck routes, `core.to_deck`, `core.images_deck` and the `/to-deck` and `/images-deck` routes. formsld's backend entry 13 (page text in reading order for deck notes) went with to_deck; its insight lives on in layout.py, which already orders words by position.

## 9. A small picture store instead of formsld's media service · _v0.1.0 (services/media.py)

`core.extract_images` needs somewhere to put pictures with stable ids so the window can show them and agents can name them. formsld's media service also handled video, audio, fonts and deck references; formpdf keeps only the image part (sniffing, size probing, content-hash ids, `~/Formpdf/Media`) as its own module, so no import reaches back into a slides codebase.

## 10. PDF to PowerPoint with real text boxes · _v0.1.0 (services/pdf/slides.py to_pptx, _textless, _textbox, _table; routers/pdf.py to_pptx)

One slide per page at the first page's size (PowerPoint allows one slide size per file; clamped to 1 to 56 inches, other pages fitted and centred). The slide picture is the page rendered from a copy whose text-showing operators (Tj, TJ, quote and double quote, keeping their line moves) are stripped, so the words are not doubled under the text boxes; when stripping fails the full render is used. Paragraphs and headings from `layout.page_blocks` become text boxes at their boxes with zero insets, a 3 percent width allowance, wrapping only for multi-line paragraphs, and runs with size, weight, style, colour and font; tables become PowerPoint tables with the No Style, No Grid style and no fills so the page's own rules show through. Known limits: text inside form XObjects and annotation appearances stays in the picture, and rotated words are not placed as boxes.

## 11. Contact sheets for agents · _v0.1.0 (services/pdf/slides.py contact_sheet; routers/pdf.py sheet)

Up to 12 pages in one PNG, one to four columns by count, each labelled "Page N" under it on a dark ground, 1600 px wide by default. One image per call keeps an agent's verification step to one tool result instead of one per page.

## 12. The MCP split: seven tools, one pdf tool with actions · _v0.1.0 (routers/mcp.py TOOLS, t_pdf, _read, _change, _export)

formsld exposed PDF work as one `pdf` tool next to 24 deck tools. formpdf keeps that tool and its action names (so agents and the formsld skills transfer), replaces `to_deck` with `to_pptx`, and adds the workbench's operations as actions; around it sit get_context, open_pdf, render_pages, extract, save and undo. One action-style tool keeps the tool list short for clients that cap tool counts, and the actions split into read, change and export lists that drive consent and output naming.

## 13. Live agent changes land in the window as a turn · _v0.1.0 (routers/mcp.py _source, _land, t_undo; routers/live.py handle doc; services/bridge.py window_doc)

The window reports its open document (id, key, page, unsaved changes, whether the newest state is an agent's) over /api/live whenever its chrome syncs. A change without a path derives a new version from the window's current id and calls the `commit` window tool with the turn id and the agent's name; the window refuses if its document moved on meanwhile. A turn is every mutating call from one session less than 90 s apart. With no window, the engine keeps its own version list per document key in `OPEN` and undo steps back over the newest turn there.

## 14. Consent for every action that writes · _v0.1.0 (routers/mcp.py _mutating, _consent)

A review of formsld 0.5.1 found that only `pdf to_deck` asked for consent while redact, crop, header_footer, merge, split and to_docx wrote files freely. In formpdf every change and export action, open_pdf, save and undo go through `_consent`: the window asks once (120 s), Allow persists `agentsAllowed`, Not now is cached for 120 s. With no window connected (headless, CLI) there is nobody to ask and calls proceed.

## 15. Compress without document info · _v0.1.0 (services/pdf/edit.py compress)

pypdf's `compress_identical_objects(remove_orphans=True)` dereferences the writer's `/Info` and raises AttributeError when there is none, which is the state after Remove hidden information strips metadata. Compress skips the identical-object pass in that case; pictures and streams are still recompressed.

## 16. One action registry for MCP, the CLI, batch and the palette · _v0.2.0 (services/pdf/actions.py; routers/mcp.py READ_ACTIONS to LABEL, _change, _export, _read; routers/pdf.py action_list)

The parity plan adds about forty actions, and each one has to reach the window, the MCP `pdf` tool, `./formpdf run`, Home batch and the command palette. Before this, the action names, labels and output suffixes lived as literals in mcp.py, so every new action meant edits in several places that could drift. `actions.py` is now the one table: name, kind (read, change, export), label, suffix, synonyms for the palette, an output extension, and the fields a batch form shows. mcp.py's names are the registry's live lists and dicts (same objects), so the tool's action enum and consent rules follow registration without rebuilding. The 27 built-in actions keep their hand-written branches in `_change`, `_export` and `_read`; an action registered with a `run` handler (later phases, plug-ins) falls through to it: change and export handlers take `(src, out, *, args, pages, passwords)`, read handlers take `(src, *, args, pages, passwords)` and return text plus data. `batch` is false for read actions and for actions that need per-file choices (merge, fill, annotate, form, organize, unlock). GET /api/pdf/actions serves the catalogue.

## 17. The content interpreter · _v0.2.0 (services/pdf/content/fonts.py FontInfo, parse_cmap; interp.py walk, Interpreter, PageContent.within; streams.py write_page, new_form, replace_form)

True redaction, editing text and pictures already on a page, OCR text placement and tagging all need the same thing: every glyph, picture draw and path tied to the operator that drew it, with its box on the page. pdfplumber finds characters but cannot say which operator made them, so it cannot drive a change. `walk(page, pdf)` parses the page's joined content (pypdf joins a /Contents array, so a piece that ends mid-operator is not a problem) and runs a graphics-state machine: CTM stack, text state (Tc, Tw, Tz, TL, Ts, Tr, font and size), text and line matrices, fill colour and the marked-content stack. Each shown code becomes a `Glyph` with its operator index, its position inside that operator, the code bytes, Unicode text, a box from font descent to ascent through the text rendering matrix, the origin, the advance (with Tc, and Tw only for single-byte code 32) and its MCID or Artifact state. Pictures, inline images, forms, paths, clips and shadings become `Draw`s. Form XObjects are walked in place with their Matrix and own or inherited resources, keyed by `where` (the chain of Do operator indexes), with a depth cap of 8, a cycle guard and a four-million-operator budget that sets `truncated`.

`FontInfo` reads simple fonts (Widths, FirstChar, MissingWidth; base encoding plus Differences; glyph names through the Adobe list, uniXXXX and uXXXX forms, with suffixes like .sc or .v1 stripped and ligature names split on underscores), standard 14 fonts without widths through reportlab's AFM tables (Arial, Times New Roman and Courier New names alias to them), Type0 fonts (W and DW, Identity-H and V, embedded CMaps with codespace and CID ranges; other predefined CMaps are treated as two-byte and flagged `approx`) and Type3 fonts (FontMatrix-scaled widths and box). ToUnicode wins over the encoding. `reverse` and `encode` map text back to codes and refuse a character the font has no glyph for, which is how later phases avoid printing question marks. pypdf's encoding and glyph tables are private modules, imported behind a guard so an upgrade degrades instead of crashing.

Checked against pdfplumber on twelve PDFs (reportlab standard and TrueType subset fonts, matplotlib Type3 and Type42, TeX Type1 with custom encodings, a Word-made math PDF, a browser-made PDF, formpdf's own outputs): every glyph origin and width matched to 0.000 pt, counts matched on every page, and text matched except where the font's own built-in Type1 or CFF encoding is the only source of Unicode (two glyphs in a TeX math font), which is not read yet. Writing every page back from its parsed operations rendered pixel-identical in PDFium and extracted the same text. No PDF in that set was tagged, so the MCID and Artifact paths have not run against a real file yet.

`write_page` replaces a page's content with one new stream; `new_form` and `replace_form` add a changed copy of a form under a new resource name and leave the original for the other pages that share it (the caller renames the Do operand).

## 18. The font kit · _v0.2.0 (services/pdf/fontkit.py font_name, covers, pick, available; app/fonts/; formpdf_engine.py selfcheck)

Text formpdf writes into a PDF (added text, edited paragraphs, OCR layers, Bates and headers later) must embed its font, or accents and non-Latin scripts are lost and extraction breaks. `app/fonts/` ships Inter 4.1, Noto Serif 2.015 and JetBrains Mono 2.304 in regular, bold, italic and bold italic with their OFL texts; `config.fonts_dir()` and the freeze script already pointed there, so the frozen engine carries them and `annot.text_font` now finds Inter instead of a system font. `font_name(family, bold, italic)` registers a family with reportlab on first use, which embeds a subset with a ToUnicode map, so fontTools is not needed yet; if a file is missing it falls back to the matching standard 14 font. `covers` checks a string against the font's character map and `pick` walks the families for one that covers it. No shipped family covers CJK; callers must say so (Beat Acrobat B8) until a CJK font is chosen. Checked: all twelve combinations write Greek, Cyrillic, accented Latin and Polish text that pdfplumber and the content interpreter extract unchanged, every font embedded as a subset. The selfcheck reports the number of font files found.

## 19. Batch jobs · _v0.2.0 (routers/batch.py upload, run, _work, status, download, _target, _nest, _prune)

Home > Batch runs one registered action (`Action.batch`) on many PDFs. Each file goes through `mcp.t_pdf` with `path` and an explicit `out`, the same code path agents and `./formpdf run` use, so batch behaves exactly like a file job: the input never changes. It calls `t_pdf` directly rather than `call_tool`, because the person started it in the window and the agent consent question does not apply. A run is a job in memory (`JOBS`, the newest 20 kept) worked through in an asyncio task kept in `TASKS` so it is not collected; the window polls GET /api/batch/{id} for per-file state, the message and the output paths, and GET /api/batch/{id}/zip zips what was written. Results go to a new folder `Exports/Batch <date time> <action label>`; output names follow the agents' `[stem]-[suffix].pdf` rule, and a second file with the same stem gets ` (2)`. Browser uploads are copied into `Formpdf/Batch/<random>/` because the window has no file paths in a browser; on each upload, copies older than a day are removed unless a running job uses them. Field names with dots from the batch form (`footer.center`, `bates.prefix`) are nested into the objects the actions take. Checked over HTTP: three files with Bates footers numbered ACME-000001 on, a refused non-batch action, a zip of three results, pruning of an old inbox folder.

## 20. Session restore and the network list · _v0.2.0 (services/session.py remember, clear, read; routers/live.py handle doc; routers/system.py get_session, dismiss_session, NETWORK, capabilities)

Every change already lands as an immutable working-copy version (entry 1), so a crash loses only what was never applied; what was missing was knowing which version the window had open. The window already reports its open document over /api/live, so the engine writes it to `~/Formpdf/session.json` as it arrives (id, key, name, page, tab, dirty, pages), at most every two seconds unless the id, tab or dirty state changes. A window that closes its PDF on purpose sends no document after having one, which clears the session; a fresh window's first empty report does not, because it never had one, which is how the file survives a reload or a crash to be read by the next start. GET /api/session returns the document only when its working copy still exists, with `recover` true when it had unsaved changes; POST /api/session/dismiss clears it. The page is approximate: the window reports page moves only alongside other changes.

Beat Acrobat B1 needs the network story in one place. `NETWORK` in system.py lists every connection formpdf could make and its state, served in /api/capabilities: today only the local engine link and the desktop update check, which is off because no update key is configured. Features that add a connection (timestamp servers, AI providers, update checks) append their row here. Capabilities also report the font count.

## 21. One route for registered actions · _v0.3.0 (routers/pdf.py act, MEDIA)

POST /api/pdf/{id}/act/{name} runs any registered action that has a `run` handler on a working copy: a change derives a new version through `_derive` (so protection is re-applied and failures discard the output, entry 1), a read returns its text and data as JSON, an export runs into a temporary file with the action's extension and streams it back with a filename (a handler may name the file by returning `filename`). New tools therefore need no route of their own: the window calls the same handler the MCP tool, the CLI and Batch call.

## 22. Links · _v0.3.0 (services/pdf/links.py target, read, change, URL; services/pdf/frame.py; routers/mcp.py _detail)

`edit_links` adds Link annotations from boxes (points from the top left of the unrotated page, the frame redaction areas use; `frame.py` converts both ways through the view box), removes links by page and index as `links` lists them, and with `auto` links every web and email address in the text: the URL pattern runs through `search.find`, so matches carry PDFium's per-line boxes and a URL broken over two lines becomes two link boxes with one target. Boxes that overlap an existing or just-added link are skipped, so running it twice adds nothing. A target is a page number (a GoTo destination with Fit), an email address (mailto:), or a web address (www. and bare domains get https://); anything else, including `javascript:`, is refused, and non-ASCII URLs must use punycode because URI actions are 7-bit. Links are printable, invert on click, and borderless unless `border` asks for a thin blue one. `links` reads URI actions and page destinations (explicit, named, or GoTo) back as page numbers. The change result says `added` and `deleted`; `deleted`, not `removed`, because `_detail` already reads `removed` as sanitize's list of categories.

## 23. Attached files · _v0.3.0 (services/pdf/attach.py change, read, listing, get_file, _tree, _filespec, _pin_ap; routers/pdf.py attachment)

Document-level files live in the catalog's EmbeddedFiles name tree. pypdf can add to it but not remove from it, so `change` flattens the tree (Names arrays and Kids, depth-capped), drops removed names, appends new files and writes one flat Names array sorted by name, which every reader accepts. A file whose name is taken becomes `name (2).ext` rather than replacing the first. Each file is a Filespec with F and UF names, an optional Desc, and an EmbeddedFile stream (Flate-compressed, MIME subtype, Size and ModDate in Params). A file with a page becomes a FileAttachment annotation (a pin) with a 20 point paperclip appearance of its own, because readers otherwise draw it differently or not at all. Files arrive as base64 (the window) or as a path (agents and the CLI), at most 200 MB each. `attachments` lists both kinds and, with `save`, writes one to a path or the Exports folder; the window downloads through GET /api/pdf/{id}/attachment by name, or by page and index for pins. Sanitize keeps its own removal path (entry 6).

## 24. Bates numbers across files · _v0.3.0 (routers/batch.py _work, _bates, _bates_text, _numbered; services/pdf/actions.py header_footer fields)

Acrobat's Bates numbering is a set operation: legal documents are numbered as one run. Batch with Add header and footer and Add Bates numbers now passes each file a start number that continues from the previous file, counting only the pages that file actually numbered (its page range and odd or even setting, the same sequence header_footer counts), and writes `Bates numbers.csv` (file, numbered copy, first, last) into the results folder and the zip. Each row's `note` shows its range. The form's `bates.on` and `bates.across` are batch-only switches and are removed before the call. `bates.on` also fixes a 0.2.0 fault: the batch form always sent start and digits, and header_footer treats any `bates` object as a request for Bates numbers, so every batch header and footer run was stamped with them.

## 25. Measurements · _v0.3.0 (services/pdf/measure.py change, read, snap, value, _annot, _appearance, _measure_dict; services/pdf/content/interp.py Draw.points)

Measurements are written the way Acrobat writes them, so other readers show and re-read them: a distance is a Line annotation with IT LineDimension, open arrows on both ends and Cap; a perimeter a PolyLine with PolyLineDimension; an area a Polygon with PolygonDimension. Each carries a rectilinear Measure dictionary whose X number format holds the unit and the scale (units per point), so the value can be recomputed later and recalibrating never changes earlier readings, plus Contents with the formatted value (optionally after a label). Each gets its own appearance stream (the line or outline in the colour, a 12 percent fill for areas through an ExtGState, the value in Helvetica on a white plate) because readers otherwise draw measurement annotations inconsistently. Values: length times scale, area times scale squared; perimeter sums the segments. `measurements` reads both formpdf's and other tools' measurement annotations back with their value from the stored scale; `measure` removes by page and index in that order.

`snap_points` walks the page with the content interpreter and returns path vertices, segment midpoints and segment crossings in top-left page points, capped at 4000 points and 700 segments for the crossing pass. That needed the interpreter to keep subpaths apart: `Draw.points` now holds each painted path's subpaths (m starts one, re adds a closed one, h closes, curves contribute their end point), so a midpoint or crossing is never invented between two separate shapes. The no-op write-back check stayed pixel-identical on all twelve corpus PDFs after the change.

## 26. HTML, RTF and Excel exports · _v0.3.0 (services/pdf/exports.py document, _items, to_html, to_rtf, to_xlsx, _cell_value, _put; services/pdf/layout.py list_item, strip_runs, running, is_running; routers/pdf.py act)

All three start from `document`: `layout.page_blocks` per page (the same reading order, headings, tables and pictures as Word), then running headers and footers are found across pages and left out. A running line is a short paragraph in the top or bottom tenth of the page whose shape (lower case, spaces folded, digits as #) appears on at least 60 percent of the pages and at least two, so "Page 3 of 9" matches "Page 4 of 9". `_items` groups consecutive list paragraphs into one list per kind and strips the marker from the runs. A marker is a bullet character, a dash, a number or letter with . or ), or `(cid:N)`, which is what pdfplumber gives for a bullet glyph with no Unicode mapping.

HTML is one self-contained file: a short inline style, one `section` per page, `h1` to `h3`, `ul` and `ol`, tables with a `thead` from the first row, pictures as base64 data. Everything is escaped. RTF is written by hand (no library): a font table, `\u` escapes for anything outside ASCII, hanging-indent list paragraphs with the bullet or number, `\trowd` tables with borders and a bold first row, `\pngblip` or `\jpegblip` pictures at their width (others converted to PNG), `\page` between pages. Excel writes one sheet per page, paragraphs in column A and tables from column A across; table cells after the header row become numbers when they read as numbers: thousands separators, a currency sign (kept in the format), percentages (stored as fractions with as many places as the text had) and accounting negatives in brackets. `tables_only` writes only the tables and fails if there are none. A text cell starting with = is forced to a string so it never becomes a formula.

The act route now sends `filename*` (UTF-8) beside a Latin-1-safe `filename`, because a PDF named in another script made the header itself fail.

## 27. Word export keeps columns, lists and running heads · _v0.3.0 (services/pdf/word.py to_docx, _cols, _restart, _field, _running, _para; services/pdf/layout.py columns)

`to_docx` now builds on `exports.document`, so Word, HTML, RTF and Excel read a PDF the same way. Columns: `layout.columns` looks for two or three side-by-side groups of narrow blocks (under 58 percent of the text width) whose vertical ranges overlap and that make up most of the page; the gutter is the smallest gap between groups. Blocks inside that region go into a continuous section with `w:cols` set to the count and gutter; a full-width block before or after switches back to one column through another continuous section. A new PDF page with columns in play starts a new-page section instead of a page break, because a page break inside a column section only moves to the next column. Lists use the List Bullet and List Number styles with the marker text removed; each numbered list gets its own numbering instance with a start override (the number it started at in the PDF), because the style's shared numbering otherwise counts on through the whole document. Running headers and footers from the first page that has them go into the first section's header and footer (later sections link to it); a number in them equal to the page number becomes a PAGE field, so "Page 1 of 3" counts in Word.

Checked by converting the outputs to PDF with LibreOffice: the two-column test page comes back in two columns with its lists restarting at 1 and its header and footer in place, and no corpus file grew in page count compared with 0.2.0.

## 28. Spelling · _v0.3.0 (services/pdf/spell.py Dictionary, check, read, change, _swap, _freetext_ap; core/config.py dict_dir; routers/system.py settings and capabilities; app/dict/en_US)

The dictionary is SCOWL's en_US Hunspell pair (size 60), shipped verbatim with its README, which carries the SCOWL, Ispell BSD and WordNet notices. pyspellchecker was rejected because its English frequency list comes from a subtitle corpus with no clear licence. The reader is formpdf's own and covers the part of the Hunspell format these dictionaries use: SET UTF-8, TRY, REP, NOSUGGEST, ONLYINCOMPOUND, FORBIDDENWORD, FLAG char, long or num, and PFX and SFX rules with strip, add and condition, including the prefix-suffix cross product. It expands every stem into its forms once per language (about 124,000 forms for en_US in a third of a second) and keeps them in memory. Compound rules are not implemented; they only cover ordinals, and any token with a digit is skipped anyway. More languages are Hunspell pairs dropped into Formpdf/dictionaries/<code>/<code>.dic and .aff.

A word passes when it is in the dictionary as written, when it is capitalised and its lower-case form is (sentence starts), when it is all capitals and any form is, or with a trailing 's when its stem is. Skipped: tokens with digits or underscores, words in all capitals (acronyms, on by default), mixed-case words such as iPhone, web and email addresses and file names, and the person's own words (settings `dictionary`) and the call's `ignore` list. Suggestions come from REP pairs, every single edit (deletions, transpositions, replacements and insertions over the TRY letters) and splits into two words, then two edits when fewer than six are close; each candidate gets a cost (a transposition, a doubled or dropped double letter or a vowel swap is cheap), plus a penalty for a capitalised proper noun when the word was lower case and for a different first letter, so "teh" offers "the" first and "thier" offers "their". Two-edit search runs for the first 40 distinct words of a check.

`spell` checks `texts` the caller sends (the window sends comments not applied yet and form field values as typed), plus PDF comments, form text fields and page text by `scope`, and returns each issue with where it is, its offset, a context line and suggestions. `spell_fix` takes fixes by comment (page, index, NM) or field name, applies them from the end of each text so offsets hold, falls back to the nearest whole-word match when the text moved, rewrites a FreeText appearance with formpdf's own text drawing (keeping the size and colour from DA and the fill from IC) so the page shows the corrected text, and fills fields through fill_fields. Settings take `spellLang` and `dictionary` (at most 5000 words of 64 characters); `capabilities` lists the installed languages.
