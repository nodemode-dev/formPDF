# pdf actions

The `pdf` MCP tool, action by action, as built in formpdf 0.1.0. The action names formsld's `pdf` tool used (info, text, images, tables, merge, split, header_footer, crop, find, redact, to_docx) are unchanged; `to_deck` is replaced by `to_pptx`, and the workbench's own operations are added. All paths are absolute. A failure answers `pdf [action] failed: [reason]` with isError.

## Contents

- Where an action works
- Page syntax
- Read actions: info, text, images, tables, find, comments, fields, hidden, compare
- Change actions: header_footer, page_numbers, watermark, crop, redact, organize, protect, unlock, metadata, compress, sanitize, fill, annotate, form, merge
- Export actions: split, to_docx, to_pptx

## Where an action works

| Arguments | Source | Changing actions write |
| --- | --- | --- |
| `path` | that file | `[stem]-[suffix].pdf` beside it, or `out` (file or existing folder) |
| `doc` (id or key) | that open PDF | a new version, shown live in the window as your turn |
| neither | the window's open PDF, else the last PDF you opened | as with `doc` |

Suffixes: header-footer, numbered, watermarked, cropped, redacted, organized, protected, unlocked, metadata, compressed, clean, filled, commented, form, merged.

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

## Change actions

- **header_footer** `{header: {left, center, right}, footer, size, color, font: sans | serif | mono, margins: {top, bottom, left, right}, pages, start, apply: all | odd | even, bates: {prefix, start, digits, suffix}, date}`. Tokens `<<page>>`, `<<pages>>`, `<<date>>`, `<<file>>`, `<<bates>>`; Bates numbers go at `<<bates>>`, else the footer's right.
- **page_numbers** `{position: bottom-center | bottom-right | bottom-left | top-center | top-right | top-left, format: "{n}" | "Page {n}" | "Page {n} of {total}" | "{n} / {total}", start, size, color, pages}`.
- **watermark** `{text, opacity (0..1, default 0.15), angle (45), size (64), color, pages}`.
- **crop** `{margins: {l, t, r, b} | box: {x, y, w, h} | auto: true, pages}`: sets the CropBox; the hidden area stays in the file.
- **redact** `{query | preset (+ find options) | areas: [{page, x, y, w, h}], pages}`: true redaction; pages with something to redact become 200 dpi pictures with black boxes. No match writes nothing.
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

## Export actions

- **split** `{ranges, out: existing folder}`: one file per range named `[stem]-part[n]-[range].pdf`. Default folder: beside the input, or `~/Formpdf/Exports` for the open PDF.
- **to_docx** `{pages, out}`: Word document with paragraphs in reading order, headings, pictures, tables and a page break after each page.
- **to_pptx** `{pages, out, text}`: PowerPoint with one slide per page at the first page's size; each page is the slide picture (its text removed) with its words as real text boxes and its tables as PowerPoint tables. `text: false` gives pictures only.
