# frontend HASHOUT_LOG

Living log for the formpdf window, _v0.1.0. The code carries almost no comments; the reasons live here, anchored by file and symbol. Entries 1 to 5 were carried across from formsld 0.5.1 (its frontend entries 15, 24, 28, 32 and 8) and renumbered; the rest record the extraction. Read the map and the TOC first.

## Org navi map

```
src/main.ts                 entry: startApp
src/app.ts                  composition root: Home, the workbench, live client, agent bridge, dialogs, global keys
src/pdf/                    workbench.ts (shell, menus, history, agent turns), panels.ts (panes), tools.ts (tool registry), viewer.ts, annotate.ts,
                            stamps.ts, fill.ts, form.ts, organize.ts, compare.ts, create.ts, find.ts, reading.ts, api.ts, intent.ts
src/live/                   socket.ts (LiveClient for /api/live), agent.ts (window tools and consent)
src/io/api.ts               REST helpers for settings and capabilities
src/ui/                     toolkit (dom, dialogs, menu, dropdown, commands, icons, themes, toast, palette), brand.ts, home.ts, app-dialogs.ts
src/styles/                 tokens.css (the only z-index source), shell, panels, dialogs, app-dialogs, palette, pdf, light-mode, scrollbars, fonts
```

## TOC

1. Opening files by path · app.ts openPaths, window.__formpdfOpen
2. PDF Edit tab, comment threads and find to redact · pdf/panels.ts
3. Zero shift on Home and in the workbench · ui/home.ts, styles/pdf.css
4. PDF page layouts, reading mode, forms, stamps and compare · pdf/viewer.ts and friends
5. Window tools and consent · live/agent.ts
6. What moved out of formsld and what was dropped · src/
7. Home is the front door; the workbench opens over it · app.ts, ui/home.ts
8. A menu bar in the workbench title · pdf/workbench.ts menus
9. Agent turns in the workbench history · pdf/workbench.ts agentCommit, undoAgent, state
10. Thumbnails in fixed slots and other shift fixes · pdf/viewer.ts Thumbs.sync, styles/pdf.css, pdf/panels.ts
11. Export to PowerPoint replaces PDF to deck · pdf/panels.ts, pdf/api.ts
12. The formpdf mark · ui/brand.ts
13. Command palette and the tool registry · ui/palette.ts, pdf/tools.ts
14. Batch on Home · ui/batch.ts
15. Resume on Home and the network list · ui/resume.ts, ui/app-dialogs.ts
16. Page tools and safe links · pdf/annotate.ts PageTool, pdf/tools.ts, tools/overlay.ts, pdf/workbench.ts openLink
17. The Links tool · tools/links.ts
18. The Attached files tool · tools/attachments.ts
19. Toasts and the comment list never move anything · ui/toast.ts, pdf/panels.ts
20. The Measure tool · tools/measure.ts
21. Web page, rich text and Excel · tools/exports.ts
22. Check spelling · tools/spell.ts
23. Text and pictures on the page · tools/content.ts, tools/richtext.ts
24. Redaction options and marks in the file · pdf/panels.ts Redact section
25. Selecting and editing text already on the page · tools/content.ts
26. Make searchable (OCR) · tools/ocr.ts
27. Scan · pdf/scan.ts, pdf/workbench.ts startScan, ui/home.ts

## 1. Opening files by path · _v0.1.0 (app.ts openPaths, pdf/workbench.ts WorkbenchOptions.path)

The desktop shell passes files it was asked to open as repeated `?open=` parameters on the first load, and later through `window.__formpdfOpen(paths)`. PDFs go through `/api/pdf/open-path` into the workbench. The query is cleared with replaceState so a reload does not open the file again.

## 2. PDF Edit tab, comment threads and find to redact · _v0.1.0 (pdf/panels.ts syncAnnots, syncCrop, header and footer preview; pdf/annotate.ts crop tool)

Header and footer preview is a fixed-size miniature page whose six slots are patched as the fields change; tokens are inserted at the caret. The crop box is one overlay rectangle shared by typed margins and the drawn tool, kept in sync both ways by `syncCrop(source)`. Comment threads are keyed rows patched in place: replies and a status picked before Apply stay pending in the panel and are written with the comment. Find to redact lists matches with their context; Mark ticked adds the ticked matches to the marked areas, and Redact all matches sends every match and marked area to the engine at once.

## 3. Zero shift on Home and in the workbench · _v0.1.0 (ui/home.ts, styles/shell.css, pdf/panels.ts, styles/pdf.css)

The Recent PDFs row holds one skeleton card (same 4 by 3 preview as a real card) until the list arrives, and an empty card replaces it when there are none; cards get their name and meta when created because patchList only calls update on existing nodes. The workbench document name and status count have reserved boxes, the Document properties list keeps all fifteen rows and patches values, and the Edited badge toggles visibility so the centred title never moves.

## 4. PDF page layouts, reading mode, forms, stamps and compare · _v0.1.0 (pdf/viewer.ts setLayout, reading.ts, form.ts, stamps.ts, compare.ts, create.ts)

Paged layouts hide other pages with `.is-off` instead of removing nodes, so page virtualisation and canvas eviction keep working; two-up layouts are a CSS grid justified towards the gutter. Reading mode reserves each page section at the average height of the first chunk and compensates scrollTop for sections filled above the viewport. Read aloud speaks one sentence per utterance (Chrome cuts long ones) and highlights through the text-layer ranges Find uses. Stamps keep their aspect on resize; the window SVG and the engine's appearance stream share their geometry constants. Form drafts are applied by `flush`, so Save writes them; Compare is read-only and never flushes staged comments.

## 5. Window tools and consent · _v0.1.0 (live/agent.ts AgentBridge, Consent)

The engine asks the window over /api/live with `{t: "tool", name, args}` and waits for `toolResult`. Tools: consent (the Allow agents dialog, one question at a time however many agents ask), state, open, commit, undo-turn and saved. Allow turns agents on for good (Preferences and Agents can turn it off); Not now answers the agent at once.

## 6. What moved out of formsld and what was dropped · _v0.1.0 (src/)

Moved: `pdf/*` with the workbench and every tab, the ui toolkit (dom, icons, toast, dialogs, menu, commands, themes, dropdown), the styles the workbench and Home use (tokens, shell, panels, dialogs, app-dialogs, pdf, light-mode, scrollbars, fonts) and the pre-paint theme boot in index.html. Dropped: the deck engine, renderer, editor, presenter, automation and their styles, the deck dialogs, and every @fontsource family except Inter, JetBrains Mono and Caveat (typed signatures). `pdf/intent.ts` keeps only the CreateKind type; Home passes the create intent in the open options instead of a module flag.

## 7. Home is the front door; the workbench opens over it · _v0.1.0 (app.ts startApp, ui/home.ts Home, pdf/workbench.ts AppHooks)

formsld's Home led to decks and the workbench was a side door. In formpdf Home (same layout, tokens and nav as formsld's) opens PDFs by picker, drop or path, lists recents with forget, and starts Create from pictures or Merge; the workbench is created once at start (hidden) so agents can open a PDF into it at any time, opens over Home, and returns to Home on Close or the mark. Cancelling Create with no PDF open also returns to Home rather than leaving an empty workbench.

## 8. A menu bar in the workbench title · _v0.1.0 (pdf/workbench.ts constructor menus, key)

The workbench was the one formsld surface without menus. Its title now carries File, Edit, View, Tools and Help built from its own `Commands`, so every command shows its shortcut and Keyboard shortcuts can list them. The existing key switch still handles the common combinations first; F1, Mod+/, Mod+, , Alt+Mod+H and Alt+Mod+Z go through the command registry. Menus opened over the workbench take `--z-context` (they mount after it in #overlay-root).

## 9. Agent turns in the workbench history · _v0.1.0 (pdf/workbench.ts State.turn, agentCommit, agentTarget, undoAgent, state, report)

History states carry an optional turn id and agent name. `agentCommit` refuses when the window's current id is not the one the agent changed (the person edited meanwhile), otherwise commits like any operation, so plain Undo and Redo walk agent steps too. Undo agent turn (Edit menu, Alt+Mod+Z, the Undo turn button in the agent chip, or the MCP undo tool) travels to the state before the first state of the newest turn, and refuses when the newest state is the person's. `state()` is reported to the engine from syncChrome, deduplicated, so get_context always knows the open document.

## 10. Thumbnails in fixed slots and other shift fixes · _v0.1.0 (pdf/viewer.ts THUMB_W, THUMB_H, Thumbs.sync; styles/pdf.css; pdf/panels.ts syncDoc, syncMatches; pdf/workbench.ts show)

Measured with a PerformanceObserver under 4x CPU and 1.5 Mbps while exercising every tab and the agent flow. Thumbnails sized by aspect moved the whole list after a crop, rotation or merge; they now sit in 176 px slots with the page box (fitted into 120 by 156) at the top and the number at the bottom. Other fixes: minimum heights on the crop, header and footer, compress and redact notes; the Remove password section is always shown and disabled when the PDF is not protected; redaction matches turn stale (disabled, "in an earlier version") instead of collapsing when the PDF changes; the match count truncates and Select all has a fixed width; compare marks clear when page geometry changes; the status bar busy label and agent chip have fixed widths. The one shift left is a crop resizing its own pages.

## 11. Export to PowerPoint replaces PDF to deck · _v0.1.0 (pdf/panels.ts Convert pane, click pptx; pdf/api.ts pptxUrl)

The Convert tab's PDF to deck section (pages as slides or rebuild into a template) needed formsld's deck model and template catalog. It is now Export to PowerPoint (.pptx) with a page range and an Editable text boxes switch, delivered like Word export. The Extract tab's Add to deck button went with it.

## 12. The formpdf mark · _v0.1.0 (ui/brand.ts MARK; assets/formpdf_mark.svg)

Same family construction as the formsld mark (dark tile, red bloom, light paper with the cool to warm gradient, the stepped paint stroke with three trailing pixels, two text bars), with the paper drawn as a page with a folded corner and a text line in place of the easel. Favicon, apple-touch icon, splash and the Tauri icon set are rendered from it.

## 13. Command palette and the tool registry · _v0.2.0 (ui/palette.ts Palette, scoreCommand; pdf/tools.ts registerTool, mountTools, syncTools, TAB_WORDS; app.ts homeCmds; pdf/workbench.ts pdf-palette, host)

Acrobat hides tools behind an All tools page; the palette (Mod+K on Home and in the workbench, Help > Find a command or tool) searches every command by label and by synonyms, so "bates", "black out" or "powerpoint" find the tab that does it, and the matched synonym shows beside the result. Disabled commands stay listed, dimmed, with a reason from the command's optional `why` (Undo says Nothing to undo yet) or a fallback that knows whether a PDF is open. Ranking: enabled first, then match strength (exact, prefix, word start, substring, synonym, subsequence), then the twelve most recently run ids from localStorage (wrapped in try/catch; the palette works without it). It is a Dialog subclass so `anyDialogOpen` keeps global keys quiet while it is open; the head is hidden by CSS, the list has a fixed 336 px height so typing never resizes the box, rows are patched by command id, and focus moves by class only. On Home it lists Home's own commands plus the workbench commands that make sense without the workbench; in the workbench it lists the workbench's.

`pdf/tools.ts` is the seam the parity phases build on: a tool registers its tab, an optional pane section (HTML plus mount and sync callbacks) and its commands with synonyms. The workbench mounts every registered tool once after its panes exist, appends the section to that tab's pane, adds the commands to its command set (so menus, shortcuts and the palette see them), and calls each tool's sync from `syncChrome`. Existing panes in panels.ts stay where they are; new tools never edit them. No tool is registered in 0.2.0, so the mount and sync paths first run in 0.3.0.

## 14. Batch on Home · _v0.2.0 (ui/batch.ts Batch, fieldHtml; ui/home.ts View batch; app.ts home-batch; styles/batch.css)

Batch is a Home page (nav item and the palette's "Batch: run an action on many PDFs"), not a dialog, because a run takes a while and the person may want to watch it or leave. Files are uploaded as they are added (browser) or added by path, listed in a fixed-height list whose rows are patched by key with their state and, when done, the output file name. The action list comes from GET /api/pdf/actions filtered to batchable actions; every action's field group is rendered once when the catalogue arrives, while the page is still hidden, and switching action only toggles `hidden` on groups, so nothing is rebuilt and the box keeps its reserved minimum height. The action select is enhanced once: `enhanceAllSelects` at startup already reaches it, so Batch only enhances it if that has not happened (it rendered twice before the guard). Run posts the job, then polls every 500 ms, patching rows, the progress line and the output folder in their fixed slots; Download all fetches the zip through `deliver`. Drops on the Batch page stop propagation so Home's own drop (open or create) does not also fire. New rows are filled in `create` as well as `update`, because `patchList` only calls `update` for rows it already had (the palette had the same gap).

## 15. Resume on Home and the network list · _v0.2.0 (ui/resume.ts offerResume; app.ts start; pdf/workbench.ts WorkbenchOptions.restore, openRecent; ui/app-dialogs.ts PreferencesDialog Network; styles/shell.css .fs-home-sub.is-line, .fs-home-resume)

At start, Home asks GET /api/session. When the last window closed with unsaved changes it says "formpdf closed with unsaved changes in [name]. Reopen them · Discard"; otherwise "Pick up where you left off: [name]. Reopen · Dismiss". The line replaces the start page subtitle's content in place, so nothing moves: the subtitle is now one line with an ellipsis (`is-line`) and the two choices are text-styled buttons with the line's own height. Reopen opens that working copy with `restore`: the workbench switches to the saved tab, goes to the saved page, and, for a recovery, clears `savedId` so the Edited badge and the save-before-close guard apply again. Comments, field values and organize steps that were staged but never applied live only in memory and are not recovered.

Preferences gained a Network section listing every connection from /api/capabilities with its state and a sentence; its list has a reserved minimum height so the rows arriving after the dialog opens do not move the Done button.

## 16. Page tools and safe links · _v0.3.0 (pdf/annotate.ts PageTool, Annotator.custom; pdf/tools.ts ToolHost, pageTools; tools/overlay.ts PageLayers; pdf/workbench.ts host, openLink; pdf/viewer.ts ViewerHooks.link; pdf/api.ts act, actFile)

Registered tools that draw on pages (links, measuring, attachment pins) need pointer input on the page, which the Annotator owns. Rather than give each tool its own listeners, the Annotator gained one `custom` tool slot: while `tool` is `custom`, pointer down, move and up are handed to the active `PageTool` with page coordinates (points from the top left of the unrotated page), and switching tool cancels it. The workbench passes keys to it first (Enter, Backspace) and Esc still returns to Select. `ToolHost` gives tools `useTool`, the inline bar, the tab switch and the Ctx; `page` on a registered tool runs whenever a page view mounts so `PageLayers` can keep one overlay per page inside the page space (positioned with `calc(var(--k) * Npx)` like every other layer, so zoom and rotation need no code). Section and layer elements use `data-section` and `data-layer`, because `data-tool` already holds the workbench's tool mode. `pdfApi.act` and `actFile` call the engine's route for registered actions.

Following a web link used to call `window.open` with whatever the PDF said. Links now go through `openLink`: only http, https and mailto (without an attach parameter) are offered, in the inline bar with Open, Copy address and Cancel, and hosts with punycode labels (`xn--`) are named as look-alike letters. Page links still jump directly.

## 17. The Links tool · _v0.3.0 (tools/links.ts; tools/index.ts; styles/tools.css)

Edit > Links: Draw a link puts the page into a drag-a-box page tool (the box shows as a dashed overlay on the page while drawn and while pending), Goes to takes a web address, an email address or a page number (Enter adds), Link web addresses links every address in the text, and the list shows the links in the PDF with remove and click-to-show (scroll and pulse). Every change is one engine call that becomes a version, so Undo works. Two layout rules learned here: the note under the form has a reserved three-line height and both of its texts fit in it (a longer default text grew it by a line after Add and moved everything below), and the list keeps the order its rows already had and appends new links at the end, instead of re-sorting by page and pushing existing rows down. Both shifts arrived after the engine answered, more than 500 ms after the click, so they counted.

## 18. The Attached files tool · _v0.3.0 (tools/attachments.ts)

Edit > Attached files: Attach files picks any files and sends them as data URLs in one engine call (one version, one Undo step); Pin a file to the page picks one file, then a one-click page tool places its pin centred on the click and clamped to the page. The list shows document files and pins together, keeps its existing order when the PDF changes (the Links rule), and offers Save a copy (downloaded through `deliver`, so the desktop app asks for a path) and Remove. Clicking a pin row scrolls to it and pulses it.

## 19. Toasts and the comment list never move anything · _v0.3.0 (ui/toast.ts toast, expire; styles/shell.css #toast-root; pdf/panels.ts Comments section; styles/pdf.css .fs-pdfwb-annots-area)

Measuring several things in a row showed two shifts that were not the tool's own. Toasts: the stack was a bottom-anchored column, so a second toast pushed the first one up, and the container itself grew upward, which Chrome also reports. The stack is now `column-reverse` inside a fixed 220 px box: a new toast appears above the others, nothing that is showing moves, and an expired toast turns invisible but keeps its slot until every toast above it has gone too. Comments: measurements, pins and links-turned-comments appear in the PDF's comment list, and the list swapping its "No comments yet" block for rows moved every section below it. The list, its In this PDF heading and the empty block now share one fixed 260 px scrolling area.

## 20. The Measure tool · _v0.3.0 (tools/measure.ts; styles/tools.css .fs-pdf-measure, .fs-tool-listbox)

Comment > Measure: Distance (click, click, or drag), Perimeter and Area (click corners; double-click or Enter finishes, Backspace drops the last corner), Shift for 45 degree steps, Esc to stop. Pointer events carry no click count on pointerdown (`detail` is 0), so a double-click is two presses within 450 ms and 6 screen pixels. The drawing shows in an SVG overlay per page in page points (the overlay scales with zoom like every other layer) with the live value on a label. Snapping fetches `snap_points` for a page the first time the pointer moves over it and snaps within 9 screen pixels; Shift turns snapping off while it constrains angles. Each finished measurement is one engine call and one version, so Undo removes it; there is no staged state to lose on close. The scale is units per point: true size per unit by default, or calibrated by drawing over a known length and typing its real length; changing the unit converts the scale, and the scale is remembered per document key in memory and localStorage. Export CSV writes the PDF's measurements with a leading quote on cells that start with = + - @, tab or carriage return so a spreadsheet does not run them. The mode buttons blur when a mode starts, because a focused button turns Enter into a click that ended the mode instead of finishing the shape.

All tool lists (Links, Attached files, Measure) now sit with their empty note in one fixed 176 px box that scrolls; rows keep their height (`flex: none`) and the note sits in the same cell. Growing lists and a hiding note had moved the buttons under them.

## 21. Web page, rich text and Excel · _v0.3.0 (tools/exports.ts; ui/icons.ts fileCode, fileSheet)

A registered Convert section: one Pages box, a pictures switch for HTML and RTF, a tables-only switch for Excel, and three buttons that post the registered action through `pdfApi.actFile` and hand the file to `ctx.deliver`, so the desktop app saves through its dialog and the browser downloads. The file is named from the PDF's own name rather than the response header. The palette gets Save as HTML, Save as RTF and Save as Excel. Nothing in the section changes size while a conversion runs; busy state is the shared run indicator.

## 22. Check spelling · _v0.3.0 (tools/spell.ts; pdf/fill.ts current, setValue, carry; pdf/workbench.ts show; ui/app-dialogs.ts Spelling, langName, applyLang; app.ts; styles/tools.css .fs-spell-*)

Comment > Check spelling (F7 from anywhere) sends the comments and text boxes not applied yet and every editable text field's current value (typed or saved) as texts, and asks the engine to check the PDF's own comments too. Issues list in the fixed tool list box; picking one scrolls to it (the comment is selected, a field or PDF comment pulses). Change and Change all work where the text lives: a pending comment through `annot.update` (one undo step per comment), a field through `fields.setValue`, which patches the input in place, and PDF comments through one `spell_fix` call and one commit. Offsets of the remaining issues in the same text move by the length difference, so later fixes still land. Ignore drops one; Ignore all drops every case variant and keeps the word out of later checks in this session; Add to dictionary appends to the settings list.

Committing a version reset the form fields, which threw away typed but unapplied field values on every engine change, not only here. `fields.reset` now takes the pending values when the new version is the same document, `load` puts them back onto the fields that still differ, and `show` reloads fields straight away while values are pending, so a field fix survives a comment fix.

The detail card has fixed geometry: the word and its context are two one-line rows; six suggestion slots sit in a 3 by 2 grid of fixed cells and unused ones turn invisible (not hidden, which let the grid reflow); the no-suggestions note is absolutely placed over the grid. The first version moved the card 28 px when suggestions appeared, and chips of changing width nudged their neighbours. Preferences > Spelling has the language (from `capabilities.spellLanguages`, named with Intl.DisplayNames) and Your words (one per line); the language also sets the page's `lang`, so the browser's own underline in comment editing follows it.

## 23. Text and pictures on the page · _v0.4.0 (tools/content.ts, tools/richtext.ts, tools/formalign.ts, pdf/align.ts; pdf/tools.ts rendered, ToolHost.forms; pdf/annotate.ts custom tool skip; pdf/form.ts group, chosen; pdf/workbench.ts; styles/tools.css .fs-cx-*, .fs-rt-*, FkSans/FkSerif/FkMono)

Edit > Text and pictures has three modes on one page tool: Select, Add text and Add picture. Select draws a thin outline round every added item and existing picture on the visible pages (loaded per page from `items` only while a mode is on, because listing existing pictures interprets the page) and a solid frame with handles round the selection. Frames are rotated boxes (`transform: rotate`), so hit-testing turns the pointer into the item's own frame first. Handles are real elements with `pointer-events: auto` inside the non-interactive layer, so the pointerdown still reaches the page tool and the handle is read from the event target. Move, resize (corners keep the picture's shape unless Shift), the width of text, rotation (Shift for 15 degrees) and the crop handles change only a preview geometry while dragging; the frames move, the page does not. On release one `edit_items` call commits the change; the new geometry is written into the local list straight away (and an existing picture that became an item is added under its new id), so the frame stays put while the items are reloaded. Every change that re-renders a page waits for that page's `rendered` hook (a new Tool hook) before it ends, registered after the engine answers and before the commit, so whatever overlay was showing the change is removed only once the page shows it.

Text is edited in a contenteditable box laid over the page in page units (`calc(var(--k) * ...)`), in the engine's own fonts served from `/api/fonts` (font-display block, loaded with `document.fonts.load` before the editor appears), with kerning and ligatures off and the same line height, list indents and super and subscript offsets as `items.py layout`, so the page wraps where the editor did. While an existing item is edited, a picture of the page without that item (`items/under`) covers it, so the old text is not seen under the new; the cover and the editor are added in the same frame after both the picture and the fonts are ready. Run styles use execCommand with styleWithCSS off (b, i, u, strike, sup, sub, font color); paragraphs are the editor's div children with text-align and data-list and data-level, and `readParas` turns them into runs by walking tags and inline styles rather than computed styles (text-decoration is not inherited in computed style). Toolbar buttons prevent default on pointerdown so the selection stays in the editor; the selects and inputs restore the saved range after they change. The custom page tool ignores pointerdowns inside the editor (one guard in Annotator) so the caret and selection work normally.

Arrange works on items through the engine and on comments not applied yet by reordering the Annotator's list. Align and distribute use one function (`pdf/align.ts`) over axis-aligned bounding boxes: in Edit for items, pictures and comments, and in Prepare form for new fields, where Shift-click now adds fields to a group (`FormBuilder.group`, `chosen()`) and the form builder's select hook syncs the registered tools so the Align fields buttons enable. Make page text replaces a comment text box with page text at the same place and size.

## 24. Redaction options and marks in the file · _v0.5.0 (pdf/panels.ts Redact section, redactLook, loadMarks, syncAreas; pdf/api.ts redact)

The Redact section gained a fill colour, optional text on each box and a "Scanned pages" switch that sends `mode: "raster"`; both apply buttons (marked areas, and Redact all matches in Find text to redact) send the same look. Redaction marks already saved in the file (from another app or from `mark_redactions`) are counted when the Protect tab shows a document, with one comments request per document id (`marksFor`), and enable Apply on their own; the engine applies them with the drawn areas. The note line only changes text, so the section does not move. The warning now says what goes (text, pictures, shapes, comments and fields under each box) and that the rest of the page stays text.

## 25. Selecting and editing text already on the page · _v0.6.0 (tools/content.ts Txt, objects, ref, adopt, remap, convKey, editText, finishEdit, textFormat, pictureEdit replace, readPicture, sync; styles/tools.css .fs-cx-note)

In Select mode the engine's `paragraphs` load with the items and pictures of each visible page and become objects of kind `ptext` keyed `t:page:key`. They are hit after added items and before pictures already on the page, have only width handles like added text, and show a frame only when selected, so a page full of text is not covered in boxes. Everything that works on added text works on them: double-click or Enter opens the editor over a render of the page without that paragraph (`items/under?paragraph=`), the format controls send updates by `{page, paragraph}`, and drag, nudge, align, arrange and Delete send the same reference. Opening the editor makes no version; only finishing with a change sends one update that converts and edits together. `converted` maps the paragraph to the new item id (`convKey` builds "page:tkey"), and `adopt` and `remap` move it to the items list and the selection.

A commit reloads the page's objects while the call is still waiting for the page to be redrawn; the reload used to drop selected `p:` and `t:` keys that no longer exist before `remap` could turn them into item ids, so the selection vanished after a move. `pending` counts calls in flight and the reload leaves the selection alone while it is above zero.

The note names the font that edits will use: the document's own font when the engine can reuse it, with the bundled family for missing letters, or the bundled family when it cannot. The note keeps a fixed minimum height of four lines (`.fs-cx-note`) so a longer message never moves the controls below. A line spacing read from the page (1.455, say) is added to the Line spacing list as its own option instead of leaving the list blank. Replace… in the Picture row swaps the selected picture, added or already on the page, for a file, keeping its frame.

## 26. Make searchable (OCR) · _v0.7.0 (tools/ocr.ts; pdf/panels.ts find and text hints)

Convert > Make searchable (OCR) reads `capabilities.ocr` once and keeps the button disabled with the engine's sentence in the note when recognition is not installed, so the person learns what to do instead of meeting an error. Resolution, pages, skip pages with text, straighten and recognise again map to the action's fields; the call runs through `ctx.run` with a busy label that gives the page count and a rough time, and the result lands as a version with Undo like any other change. The note keeps the last result (pages, words, straightened, skipped) and has the fixed minimum height of tool notes, so its changing text never moves the controls. Find and Extract text now point to this section when a page has no text.

## 27. Scan · _v0.7.0 (pdf/scan.ts ScanDialog, askScan, setOptions; pdf/workbench.ts startScan, pdf-scan command, hero and menus; ui/home.ts scan; app.ts home-scan; ui/icons.ts scanner; styles/pdf.css .fs-scan-*)

Scan is reached from Home, the workbench's hero, File and the Open menu, and the palette. The dialog looks for scanners as it opens and lets the person type a network address instead; choosing either asks the scanner what it can do and fills Paper from and Resolution with what it offers. Every step that waits (looking, asking, a failure) writes one note line with a fixed minimum height, and option lists are replaced inside their own select, so the dialog never changes size. A sequence number drops answers that arrive after the person moved on. Make the scan searchable is ticked by default and disabled, unticked, when OCR is not installed; Add the pages to the end of the open PDF is enabled only with a PDF open. A new scan opens like a PDF created from pictures (unsaved until Save); scanning into the open PDF commits a version labelled Add scanned pages, so Undo removes them.

## 28. Certificate signing and signing requests · _v0.8.0 (tools/certsign.ts certsign and sigrequest tools; pdf/api.ts identity, trust, signedVersionUrl, joinCopy, SigReport; pdf/fill.ts signed fields; ui/app-dialogs.ts Signing preferences; styles/tools.css .fs-sig-*)

Fill & Sign gains Sign with a digital ID beside the drawn and typed signature. The panel lists IDs in a select, with New ID (name, email, organisation, password twice) and Import (a .p12 or .pfx and its password) in dialogs whose error line has a fixed height. The person picks an empty signature field from a list or draws a box on the page with a page tool on the shared page layer; the draft outline is one absolutely positioned node moved by style, never rebuilt. Appearance offers text only or a picture from a file, Certify offers forms, comments or none, and Lock fields and Add a timestamp are checkboxes whose labels never change (with no server set, the timestamp box is disabled and its tooltip points to Preferences). Signing commits a version, so Undo removes the signature.

The Signatures list reads the engine's report and patches rows in place: an icon for valid, unknown or invalid, the signer and the sentences, then Trust this certificate for unknown signers and Save the signed version, which downloads the bytes that signature covers. When a PDF that carries signatures opens, a toast says so once and points to the list.

Request signatures is its own tool: signer rows (name and email) added and removed in place, a message, and Prepare request, which assigns the PDF's empty signature fields to the signers in order and records the request (with too few fields it says how many to add in Prepare form). Its status list names each signer as signed, next or waiting, with an email link for the next one, and Bring in a signed copy reads a file and asks the engine to join it as a new version. Preferences gains a Signing section with the timestamp server address. The form overlay hides Sign here on signature fields the engine reports as signed.
