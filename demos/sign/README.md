# formpdf demo 2: annotate, fill and sign

An offline, in-browser demo of formpdf's comment, Fill Forms and Sign tools. Open `index.html` by double-click (file://) or serve this folder with any static server. No backend, no network, no install.

The three demos are linked from the title bar: `../../demo/index.html` (view and page tools), this one, and `../protect/index.html` (redact, compare, protect).

## What it shows

It runs the app's real window parts: the pdf.js `Viewer` and `Thumbs`, the real `Annotator` (every comment tool, selection, move, resize, text editing), the real `Fields` overlay for form fields, the real `SignaturePad` and typed signature, the real stamp catalogue, the real tokens, shell and PDF styles and the real inline icons.

It opens on a two page fillable agreement (a telescope loan form, 21 fields: text, dropdown, checkboxes, a radio group, initials, date and two signature lines) that is half filled in and already carries a highlight, a sticky note, an underline and a squiggle. The Documents list also holds two pages of the NASA Apollo 11 mission report to mark up. Open your own PDF with the folder button or drop it on the window.

| Tab | What you can do |
|---|---|
| Comment | Highlight, underline, strike through, squiggle, sticky note, text box, pen, rectangle, ellipse, line and arrow with colour, width and text size; select, move, resize and delete; a comment list that jumps to each mark |
| Fill Forms and Sign | Fill every field type, with a progress bar and a list of fields that jumps to the next missing one; draw or type a signature and place it by pressing Sign here on a signature line or anywhere on the page; Date; 23 stamps, with dynamic stamps carrying your name and the time |
| Flatten and save | Choose to flatten the form fields and the marks into the pages, or keep the marks as real PDF annotations; Apply to a new working copy (undoable) or Save a copy |

Undo and redo cover every mark, every entry and every Apply. Ctrl or Cmd+Z undoes, Ctrl or Cmd+S saves, Esc returns to Select, Delete removes the selected mark.

## What is written to the file

- Highlight, underline, strike through and squiggle become real Highlight, Underline, StrikeOut and Squiggly annotations with appearance streams. Sticky notes become Text annotations with their text, pen, rectangle, ellipse, line and arrow become Ink, Square, Circle and Line annotations.
- Text boxes, signatures, stamps and dates are stamped into the page content, as in the app.
- Form entries are written into the fields (text, dropdown, checkbox, radio) and the field looks are rebuilt. With Flatten form fields on, fields become page content and the field list is removed. Flatten comments burns the annotations into the pages too.

## Limits

- Digital ID signing, Request signatures and Prepare form need the engine in the full app.
- Marks are written for pages without a /Rotate setting; rotated pages are not corrected.
- Password-protected PDFs are refused with a message.
- Over file:// the browser blocks module workers, so pdf.js parses on the main thread and logs one "Setting up fake worker" warning. Served over http it logs nothing.
- Flattened sticky notes keep their icon but not their text.

## Rebuild

The build imports from `../../frontend/src` and uses pdf-lib from `../../demo/node_modules`, so both must be installed already.

```sh
cd demos/sign
node tools/make-form.mjs      # rewrites assets/media/loan-form.js, the generated agreement
node ../../frontend/node_modules/vite/bin/vite.js build --config ./vite.config.mjs
```

The build writes `index.html` and `assets/sign.js`, `assets/sign.css`, `assets/sign.png` in this folder and touches nothing outside it. `tools/make-form.mjs` draws the agreement with pdf-lib; its output is the pack `assets/media/loan-form.js` that holds the PDF and the positions of the pre-placed marks.
