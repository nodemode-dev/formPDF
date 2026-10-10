# Engine

## Documents and versions

`docs.py` stores every opened or derived PDF as `Pdf/[id].pdf` plus a meta file: display name, original path, the root key shared by all versions, and protection. `docs.derive(src)` reserves a new id; the route runs the service from the source file to the new one, re-applies protection, and discards the output on failure. Nothing is deleted on success, so the window and agents can step back to any version.

## Adding an operation

1. A pure service function in `services/pdf/` taking `(src, out, ..., passwords=...)`, raising `ValueError` with a sentence for bad input. pdfium calls run under `core.serial`.
2. A route in `routers/pdf.py` through `_derive` (changes) or `_run` (reads); errors map to 400, 404, 409 (locked), 422 (unreadable), 500.
3. A pane control in `frontend/src/pdf/panels.ts` using `ctx.run` and `ctx.commit` (see workbench.md).
4. An action in `routers/mcp.py`: add it to `CHANGE_ACTIONS` (with `SUFFIX` and `LABEL`) or `READ_ACTIONS` or `EXPORT_ACTIONS`, map its arguments in `_change`, `_read` or `_export`, and document it in the harness `pdf-actions.md` and the `GUIDE`.

## Libraries per job

pypdf for structure, organize, fields, protect, stamping; reportlab to draw stamps, numbers and annotation appearances; pypdfium2 to render, redact and extract pictures; pdfplumber for words, layout and tables; python-docx and python-pptx for exports; Pillow for pictures and contact sheets.
