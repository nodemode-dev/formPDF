# demos/sign HASHOUT_LOG

Why demo 2 is built the way it is. Anchored by file and symbol.

## Org navi map

```
src/index.html     page shell, favicon, inline background before CSS
src/main.ts        imports the app's tokens, shell, dialog, panel, pdf and tool styles, then start()
src/app.ts         window markup, tabs, Annotator and Fields wiring, signature and stamps panes, history, save and apply
src/pdfwrite.ts    pdf-lib side: readFields, writePdf (entries, annotations with appearance streams, flatten), readInfo
src/media.ts       LIBRARY, loadPack, packMeta (anchors and field labels written by the generator)
src/demo.css       demo-only layout (dm- classes), sticky sub tabs, opening card
tools/make-form.mjs  draws the agreement and writes assets/media/loan-form.js
assets/media/      real documents as base64 JS packs, sources in CREDITS.md
vite.config.mjs    narrowAssets, classicHtml, pdf-lib alias, build options
index.html assets/ committed build output
```

## TOC

1. The real Annotator and Fields, not a copy
2. Fields are read from the PDF, not from the engine
3. Marks are pending until saved, like the app
4. One appearance stream serves annotation and flatten
5. Signing a field
6. A generated form beside a real document
7. Zero shift rules kept
8. pdf-lib flatten leaves dangling widgets

## 1. The real Annotator and Fields, not a copy

`Annotator` only needs a `Viewer` and five hooks, and `Fields` only a `Viewer`, so the demo imports both from `frontend/src/pdf/` and gets every comment tool, selection, move, resize, text editing and the field overlay (with its required and changed looks) unchanged. The toolbar, palette, comment rows, signature section and stamp palette reuse the app's own markup and classes, so the window is the Comment and Fill Forms and Sign tabs of the app. The stamp catalogue is `STAMPS` and `paletteHtml`, the signature pad is `SignaturePad` and `typedSignature`.

## 2. Fields are read from the PDF, not from the engine

The app asks `/api/pdf/fields`. The demo has no engine, so `readFields` walks the AcroForm with pdf-lib and returns the same `Field` records (page, top-left rectangle, type, value, on-state, options, required). `Fields.load` would call the engine, so `show` sets `fields.fields` and `fields.loadedFor` directly and calls `renderAll`. Labels come from the generator's `labels` map; any other PDF falls back to the field name.

## 3. Marks are pending until saved, like the app

Annotator items and field entries stay in memory; the bytes only change on Apply. History is a list of snapshots (bytes, marks, entries). `record` runs on every Annotator change and, debounced, on field input, so undo steps over a whole entry, not a keystroke. Edited means "history has steps"; the pre-placed marks of the opening document are the baseline, not an edit.

## 4. One appearance stream serves annotation and flatten

`build` turns a mark into content operators in page coordinates plus the annotation entries that go with it. `attach` registers them as a form XObject whose BBox equals the annotation Rect, so the same stream is the annotation's normal appearance (Save with comments kept) or is drawn on the page with `Do` (flatten). Highlights use a Multiply ExtGState so text stays dark. Text boxes, images, stamps and dates are always page content, matching the app's Signature panel note. Stamps are rasterised from `stampSvg` at 4x on a canvas, because the SVG uses Helvetica.

## 5. Signing a field

`Fields.onSign` hands over the field rectangle; `placeSignature` fits the signature image inside it and adds an `image` mark. A signature field counts as signed when an image mark has its centre inside the field (`signedBy`); `syncFields` then sets the field's `value` so `Fields` stops drawing the Sign here button. The borrower signature carries the Required flag (Ff 2) so the progress bar waits for it.

## 6. A generated form beside a real document

No public-domain source offered a clean, fillable, good-looking form, and a scanned government form would not show every field type. The agreement is generated with pdf-lib (own work, vector only) so each field type exists and the positions of the pre-placed marks are known exactly (`anchors`, measured from the same font metrics that lay the text out). The NASA report pages in the Documents list are real text that a visitor can select and mark. Signature widgets get an empty appearance stream because pdf-lib cannot remove a widget without one.

## 7. Zero shift rules kept

Window markup is mounted once. Lists (comments, fields) go through `patchList`; rows are patched, never rebuilt. The opening card sits in the page area until the viewer has loaded, then is hidden with the `hidden` attribute. Tool, tab and sub tab changes only toggle classes and `hidden`. Measured under 4x CPU throttling: layout shift total 0.001, no element moves after the pages appear. The page background is set inline before the stylesheet.

## 8. pdf-lib flatten leaves dangling widgets

`form.flatten()` deletes the widget objects but leaves their references in each page's /Annots, which readers report as invalid xref entries. `writePdf` removes any /Annots reference that no longer resolves after flattening. If flattening throws (a signature widget without an appearance in a foreign file), the entries are written and the fields stay live.
