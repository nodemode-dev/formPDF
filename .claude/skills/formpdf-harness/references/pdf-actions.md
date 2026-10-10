# pdf actions

The `pdf` MCP tool, action by action, as built in formpdf 0.7.0. The action names formsld's `pdf` tool used (info, text, images, tables, merge, split, header_footer, crop, find, redact, to_docx) are unchanged; `to_deck` is replaced by `to_pptx`, and the workbench's own operations are added. All paths are absolute. A failure answers `pdf [action] failed: [reason]` with isError.

## Contents

- Where an action works
- Page syntax
- Read actions: info, text, images, tables, find, comments, fields, hidden, compare, links, attachments, measurements, snap_points, spell, items, signatures
- Change actions: header_footer, page_numbers, watermark, crop, redact, mark_redactions, organize, protect, unlock, metadata, compress, sanitize, fill, annotate, form, merge, edit_links, edit_attachments, measure, spell_fix, edit_items, ocr, sign, request_signatures
- Export actions: split, to_docx, to_pptx, to_html, to_rtf, to_xlsx

## Where an action works

| Arguments | Source | Changing actions write |
| --- | --- | --- |
| `path` | that file | `[stem]-[suffix].pdf` beside it, or `out` (file or existing folder) |
| `doc` (id or key) | that open PDF | a new version, shown live in the window as your turn |
| neither | the window's open PDF, else the last PDF you opened | as with `doc` |

Suffixes: header-footer, numbered, watermarked, cropped, redacted, organized, protected, unlocked, metadata, compressed, clean, filled, commented, form, merged, linked, attached, measured, spelling, edited.

## Page syntax

`pages`: `"3"`, `"1-4"`, `"2,5"`, `"1-3,7"`, `"4-"`; omit for every page. `ranges` (split): one string per file, open ends allowed (`"4-"`, `"-3"`, `"all"`). Coordinates are points from the top left of the page as shown.

## Read actions

- **info**: JSON with bytes, encrypted, locked, title, author, subject, keywords, creator, producer, created, modified, pages, sizes `[{w, h, rotate}]`, outline, form field count.
- **text** `{pages}`: `## Page N` sections, cut at 16,000 characters. Scanned pages have no text.
- **images** `{pages}`: one line per picture `p1 · img_... · 1920x1080 · image/jpeg`; files in `~/Formpdf/Media`. Pictures under 24 px are skipped.
- **tables** `{pages}`: each ruled or clearly aligned table as `pN:` and a markdown table (header and 30 rows).
- **find** `{query | preset, regex, caseSensitive, wholeWord, pages}`: presets `email`, `phone`, `card` (Luhn checked), `date`. Answers `N matches on M pages` and up to 200 `pN · match · context` lines; structured `matches` with `rects` (first 500).
- **comments**: existing comments with page, kind, author, status and replies.
- **fields**: form fields with name, type, page, value and options.
- **hidden**: counts of metadata, javascript, attachments, comments, fields, layers, links, bookmarks, thumbnails, private, hidden_text.
- **compare** `{other, otherIsNewer, pictures}`: pages changed, added, removed and the same, then up to 200 differences with before and after text. Nothing changes.
- **links** `{pages}`: every link with page, index, box and target (web address, email or page). Use page and index to remove one.
- **attachments** `{save: name, out}`: files attached to the document and files pinned to pages (page, index, name, size, description). With `save`, writes that file to `out` or `~/Formpdf/Exports`.
- **measurements**: measurement comments (distance, perimeter, area) with page, index, value and unit, read from their stored scale.
- **snap_points** `{pages}`: path ends, segment midpoints and crossings on the page, in points from the top left, for exact measuring.
- **spell** `{scope: "comments,fields,pages", texts: [{id, text}], ignore: [words], lang, skip_caps, suggest}`: possible misspellings in the PDF's comments, form text fields, page text (scope) or texts you pass, each with where it is (comment page and index, field name, page, or your id), offset, context and up to six suggestions. Default scope is comments and fields. Words in all capitals, web and email addresses and the person's own dictionary are skipped.
- **items** `{pages}`: text and pictures added by formpdf (id, kind, page, x, y, w, h, rot, flips, z order; for text the font and paragraphs; for pictures the crop) and pictures already on the page (page, op, box, pixel size), and `paragraphs`: text already on the page grouped into paragraphs (page, key, box, rot, font with the document's font name, paragraphs, text, editable). Use the id, page and op, or page and paragraph key with edit_items; `text: false` leaves paragraphs out.
- **signatures**: every digital signature with its verdict (`valid`, `unknown` when the certificate is not trusted on this computer, `invalid`), signer, signing time, timestamp, whether it certifies, and plain sentences saying what changed after it (comments, form filling, signing, other changes) and whether that was allowed; then empty signature fields and, for a prepared request, each signer as signed, next or waiting. Validation never uses the network.

## Change actions

- **header_footer** `{header: {left, center, right}, footer, size, color, font: sans | serif | mono, margins: {top, bottom, left, right}, pages, start, apply: all | odd | even, bates: {prefix, start, digits, suffix}, date}`. Tokens `<<page>>`, `<<pages>>`, `<<date>>`, `<<file>>`, `<<bates>>`; Bates numbers go at `<<bates>>`, else the footer's right.
- **page_numbers** `{position: bottom-center | bottom-right | bottom-left | top-center | top-right | top-left, format: "{n}" | "Page {n}" | "Page {n} of {total}" | "{n} / {total}", start, size, color, pages}`.
- **watermark** `{text, opacity (0..1, default 0.15), angle (45), size (64), color, pages}`.
- **crop** `{margins: {l, t, r, b} | box: {x, y, w, h} | auto: true, pages}`: sets the CropBox; the hidden area stays in the file.
- **redact** `{query | preset (+ find options) | areas: [{page, x, y, w, h}] | marked: true, color, overlay, mode: content | raster, pages}`: true redaction. The text, pictures (only the covered pixels), shapes, comments and form fields under each box are removed from the file and a box in `color` (default black) with optional `overlay` text is drawn; the rest of the page stays text. Redaction marks saved in the file are applied too; `marked: true` applies only those. The call stops and writes nothing if a check finds anything left under a box. `mode: raster` turns the marked pages into 200 dpi pictures instead, for scans. No match writes nothing.
- **mark_redactions** `{areas: [{page, x, y, w, h}], color, overlay}`: writes redaction marks (Redact annotations) without removing anything, so the person can review them in the window; `redact {marked: true}` applies them.
- **organize** `{order: [pages in the new order; pages left out are deleted], delete: [pages], rotate: 90 | 180 | 270 (with pages, default all), blank: [positions after which a blank page goes; 0 for the front]}`.
- **protect** `{password, owner, permissions: {print, copy, modify, annotate, fill, assemble}}`: AES-256.
- **unlock** `{password}`.
- **metadata** `{title, author, subject, keywords, strip}`.
- **compress** `{quality: 10..95, default 70}`: recompresses pictures, compresses streams, merges identical objects.
- **sanitize** `{remove: [...]}`: removes the named kinds of hidden information (see hidden); fields are flattened so values stay. Default: metadata, javascript, attachments, private, thumbnails.
- **fill** `{values: {field name: value}, flatten}`: use fields first for the names.
- **annotate** `{annotations: [...], highlight, color, flatten}`: annotations are `{page, kind, color, text, x, y, w, h}` for note, freetext, rect, ellipse; `{page, kind, rects: [[x, y, w, h]]}` for highlight, underline, strikeout; `{page, kind, points: [[x, y], [x, y]]}` for line and arrow. `highlight: "phrase"` highlights every match.
- **form** `{create: [{type: text | multiline | checkbox | radio | dropdown | listbox | date | signature, page, x, y, w, h, name, options}], rename: {old: new}, delete: [names]}`.
- **merge**: with `paths` and `out` (and no path or doc) merges those files into `out`; with `path` and `paths` writes `[stem]-merged.pdf`; on the open PDF appends `paths` to it live.
- **edit_links** `{add: [{page, x, y, w, h, to}], remove: [{page, index}], auto, border}`: `to` is a web address, `mailto:` address or page number. `auto: true` links every web and email address found in the text. Run links first for indexes.
- **edit_attachments** `{add: [{path, name, description, page, x, y}], remove: [names], unpin: [{page, index}]}`: without `page` the file is attached to the document; with `page` it is pinned there as a paperclip comment. A name already taken becomes `name (2).ext`.
- **measure** `{add: [{page, kind: distance | perimeter | area, points: [[x, y], ...], unit, factor, label, color}], remove: [{page, index}]}`: measurement comments other readers show. `factor` is units per point (true size for the unit when omitted); distance takes two points, area at least three.
- **spell_fix** `{fixes: [{where: comment, page, index, nm, offset, word, to} | {where: field, name, offset, word, to}]}`: replaces each word in comment text or a field value, using spell's output. Text boxes are redrawn with the corrected text.
- **ocr** `{dpi: 300, skip_text: true, deskew: true, redo: false, pages}`: recognises scanned pages on this computer and adds invisible, searchable text (render mode 3, one text matrix per word, an embedded Unicode font) that find, redact, text, to_docx and to_pptx then use. Pages with real text, or recognised before, are skipped unless `skip_text: false` or `redo: true`; tilted full-page scans are straightened (the scan itself is replaced by the straightened picture). About 10 seconds a page. `get_context` says `OCR: not installed` with the reason when it cannot run. Result: `recognised`, `words`, `straightened`, `skipped`.
- **sign** `{identity, password, field | box: {page, x, y, w, h}, reason, location, contact, picture, certify: "forms" | "comments" | "none", lock, timestamp}`: signs with a digital ID the person made or imported in the window (Fill & Sign > Sign with a digital ID). Only sign when the person asked and gave you the ID password in this conversation; never guess one. `field` names an empty signature field (see signatures); otherwise `box` places a new one. `picture` is a data URL shown left of the text. `timestamp: true` uses the server set in Preferences. Saved as an incremental update, so earlier signatures stay valid. Result: `field`, `timestamped`.
- **request_signatures** `{signers: [{name, email}], message}`: assigns the PDF's empty signature fields to the signers in document order (each field's tooltip names its signer) and records the request; signatures then reports who is next. The PDF needs one empty signature field per signer first (form action, type signature). The person sends the PDF themselves.
- **edit_items** `{add, update, arrange, comments, remove}`: page text and pictures that stay editable. `add`: `{kind: "text", page, x, y, w, text}` (plain text, one paragraph per line) or `paras: [{align: left | center | right | justify, list: none | bullet | number, level: 0..3, runs: [{t, b, i, u, s, sup, sub, color}]}]`, with `font: {family: sans | serif | mono, size, color, lineHeight}` and `rot`; the height follows the text. `{kind: "picture", page, x, y, w, h, path | data, rot, flipH, flipV, crop: {l, t, r, b}}` (crop as fractions of the picture). `update`: `{id, ...}` with any of those fields, or `{page, picture: op}` to change a picture already on the page (it becomes an item, `converted` in the result gives its id); a new crop alone keeps the picture's scale; `path` or `data` replaces the picture in its frame. `{page, paragraph: key}` edits a paragraph already on the page: its glyphs leave the page's own content and it becomes page text with the same place, size, colour, alignment and line spacing, set in the document's own font where that font has every letter (the font's name is in `font.orig`) and in the closest bundled family otherwise; plain `text` keeps the paragraph's bold and italic, a one-line paragraph widens to fit, and text with no character mapping is refused. `arrange`: `[{id | page and picture | page and paragraph, to: front | back | forward | backward}]`. `comments`: `[{page, index, to}]` reorders comments. `remove`: ids, `{page, picture}` or `{page, paragraph}`. Result: `ids` of added items, `converted` ("page:op" or "page:tkey" to the new id).

## Export actions

- **split** `{ranges, out: existing folder}`: one file per range named `[stem]-part[n]-[range].pdf`. Default folder: beside the input, or `~/Formpdf/Exports` for the open PDF.
- **to_docx** `{pages, out}`: Word document with paragraphs in reading order, headings, bullet and numbered lists, pictures and tables; two- and three-column pages become Word columns, running headers and footers go into the Word header and footer with a live page number, and each page starts a new page.
- **to_html** `{pages, out, pictures}`: one self-contained web page, pictures inline, headings, lists and tables in reading order, running headers and footers left out.
- **to_rtf** `{pages, out, pictures}`: rich text with the same content, for WordPad, TextEdit and older word processors.
- **to_xlsx** `{pages, out, tables_only}`: one sheet per page in reading order; table numbers, money and percentages become real numbers with their formats. `tables_only` writes only the tables.
- **to_pptx** `{pages, out, text}`: PowerPoint with one slide per page at the first page's size; each page is the slide picture (its text removed) with its words as real text boxes and its tables as PowerPoint tables. `text: false` gives pictures only.
