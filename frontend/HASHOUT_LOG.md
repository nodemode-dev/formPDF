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
