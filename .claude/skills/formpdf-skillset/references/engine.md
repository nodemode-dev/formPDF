# Engine

## Documents and versions

`docs.py` stores every opened or derived PDF as `Pdf/[id].pdf` plus a meta file: display name, original path, the root key shared by all versions, and protection. `docs.derive(src)` reserves a new id; the route runs the service from the source file to the new one, re-applies protection, and discards the output on failure. Nothing is deleted on success, so the window and agents can step back to any version.

## Adding an operation

1. A pure service function in `services/pdf/` taking `(src, out, ..., passwords=...)`, raising `ValueError` with a sentence for bad input. pdfium calls run under `core.serial`.
2. A route in `routers/pdf.py` through `_derive` (changes) or `_run` (reads); errors map to 400, 404, 409 (locked), 422 (unreadable), 500.
3. A pane control in `frontend/src/pdf/panels.ts` using `ctx.run` and `ctx.commit` (see workbench.md).
4. An action: register it in `services/pdf/actions.py` (name, kind read, change or export, label, suffix, palette synonyms, extension, batch fields). New actions pass a `run` handler, which `routers/mcp.py` falls through to from `_change`, `_export` or `_read`; the MCP enum, consent, `./formpdf run actions`, Home > Batch and GET /api/pdf/actions follow automatically. Document it in the harness `pdf-actions.md` and the `GUIDE`.

## Content interpreter and fonts

`services/pdf/content/` walks a page with its graphics state and returns `PageContent`: every glyph (operator index, code, text, box, origin, advance, MCID) and every draw (picture, inline image, form, path, clip, shading), with forms walked in place under `where` keys. Use it, not pdfplumber, whenever a change has to find and rewrite the operators that drew something (redaction, editing text and pictures, OCR placement, tagging); `write_page` and `replace_form` write changes back, copying shared forms. `FontInfo.encode` refuses characters a font has no glyph for. Text formpdf writes uses `fontkit.font_name(family, bold, italic)` (Inter, Noto Serif, JetBrains Mono, embedded as subsets with ToUnicode); check `fontkit.covers` first and say so when no family covers the text (CJK today).

## Libraries per job

pypdf for structure, organize, fields, protect, stamping; reportlab to draw stamps, numbers and annotation appearances; pypdfium2 to render, redact and extract pictures; pdfplumber for words, layout and tables; python-docx and python-pptx for exports; Pillow for pictures and contact sheets.
