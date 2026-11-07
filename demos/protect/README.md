# formpdf demo 3: redact, compare, convert

A standalone page that runs formpdf's real viewer, thumbnails, compare panel, dialogs and styles on a PDF in the browser. Nothing is uploaded and nothing needs a server.

## Open it

Double-click `index.html`. It works over `file://`.

## What it shows

- Find text to redact: presets (email, phone, card number, date), plain text or regex, whole word and case options. Ticked matches draw opaque black. Apply flattens the marked pages, so the text under a mark is gone from the file.
- Remove hidden information: scans for metadata, XMP, JavaScript and open actions, attachments, comments, bookmarks, layers and thumbnails, then removes what you choose.
- Compare: two versions of the Season Report, word-level differences per page in the real compare panel.
- Extract: text by page range and the original pictures, with a zip download.
- Convert: Word (docx), HTML, RTF, Markdown or plain text, built in the page.
- Password: AES-256 protection with permission switches. The page proves the result by trying to open it with and without the password.
- Open your own PDF with Open PDF or by dropping it on the window.

## Rebuild

From this folder:

```
node ../../frontend/node_modules/vite/bin/vite.js build --config ./vite.config.mjs
```

The output goes to `assets/` and `index.html`. It needs `frontend/node_modules` and `demo/node_modules` (for pdf-lib) to exist.

## Limits

- Redaction rasterises each marked page (like the app's raster mode); unmarked pages are untouched.
- The scanned Apollo pages have no text layer, so there is nothing to search or redact in them.
- Convert keeps headings, paragraphs, simple tables and pictures; layout is approximate.
- The console shows pdf.js's "fake worker" notice on `file://`; it is harmless.

## Other demos

[Pages and search](../../demo/index.html), [Annotate and sign](../sign/index.html), [Redact, compare, convert](index.html).

Credits are in `CREDITS.md`.
