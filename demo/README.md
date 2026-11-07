# formpdf demo

An offline, in-browser demo of formpdf's viewer and page tools. Open `index.html` by double-click (file://) or serve this folder with any static server. No backend, no network, no install: every script, style, font and the sample document are local.

## What it shows

It runs the app's real viewer: the pdf.js `Viewer`, `Thumbs` and `Finder` from `frontend/src/pdf/`, the real design tokens and shell stylesheets, and the real inline icon set. The window layout follows the app: title bar, tab strip, options row, pages rail, page area, right panel and status bar.

It opens on a real document: a 53 page illustrated edition of Alice's Adventures in Wonderland (public domain), with a cover, contents, colour plates and line drawings. The Library list in the View and Merge tabs holds two more real PDFs, page excerpts of NASA's Apollo 11 Mission Report, to open or to add to a merge. Sources and licences are in `CREDITS.md`. Open your own PDF with Open PDF or drop it on the window. If a document pack fails to load, a small generated sample opens instead.

| Tab | What you can do |
|---|---|
| View | Continuous, single or two-page layout, zoom and fit, rotate the view, find text across every page with a match list, read and set the document title |
| Organize | Page card grid: select, drag to reorder, rotate left or right, delete, extract the selected pages, then Apply changes to write a new working copy |
| Extract | Extract a page range to a new PDF (for example `1-3,5`), save all text as a .txt, copy the text of the current page |
| Merge | Add one or more PDFs and insert them at the start, the end or after a page |
| Number and mark | Add page numbers (format, position, size, start) and a diagonal text watermark |

Save writes the working copy as a PDF download. Undo and redo step through every applied change. Ctrl or Cmd+F focuses find, Ctrl or Cmd+Z undoes, Ctrl or Cmd+S saves.

## Limits

- Password-protected PDFs are refused with a message.
- Over file:// the browser blocks module workers, so pdf.js parses on the main thread and logs one "Setting up fake worker" warning. Served over http it uses a real worker and logs nothing.
- Only the pdf.js standard fonts and the JBIG2 decoder are bundled. Pages that need CJK character maps or the JPEG 2000 decoder may render those parts blank.
- The NASA excerpts are scans; their text layer is the report's own character recognition, so find may match words that run together.
- Editing text in place, redaction, OCR, signing and forms need the engine in the full app.

## Rebuild

The build imports from `../frontend/src`, so install the frontend first.

```sh
cd frontend && npm ci
cd ../demo && npm ci
npm run build        # writes index.html and assets/ here
npm run dev          # http://localhost:5199 (host false)
../frontend/node_modules/.bin/tsc --noEmit -p .
```

`vite.config.ts` holds the shim: it narrows the viewer's asset glob to the standard fonts, turns the pdf.js worker into a blob URL, inlines assets as data URIs, builds one classic script (modules do not load from file://) and strips `crossorigin`. Why each choice was made is in `HASHOUT_LOG.md`.

The one added dependency is pdf-lib (MIT), listed in `NOTICE.md`. It writes the PDFs; pdf.js reads and draws them.
