# formpdf manual

formpdf reads, edits and converts PDFs. It runs in the browser or as a desktop app, with an engine on your computer that holds every PDF as working copies, so the window, outside agents and the command line all work on the same documents. Help > formpdf Help (F1) has the short version; Help > Keyboard shortcuts (Mod+/) lists every key.

In this manual **Mod** is Cmd on macOS and Ctrl on Windows and Linux, and **Alt** is Option on macOS.

## Install and run

```
./formpdf install      # backend venv and frontend packages
./formpdf              # engine on 127.0.0.1:8198, app on http://localhost:5198
```

On Windows use `formpdf.bat install` and `formpdf.bat`. The one-click installers `formpdf_oc_install` and `formpdf_oc_install.bat` do both steps. You need Python 3.12 or later and Node 20.19+ or 22.12+; `./formpdf doctor` checks the toolchain, the venv, the Python packages and whether ports 5198 and 8198 are free.

| Command | What it does |
| --- | --- |
| `./formpdf backend`, `./formpdf frontend` | boot one half only |
| `./formpdf build`, `./formpdf serve` | build the frontend into `frontend/dist`, then serve it from the engine on 127.0.0.1:8198 |
| `./formpdf install-desktop`, `./formpdf desktop dev`, `./formpdf desktop build` | the Tauri desktop app (checks Rust and PyInstaller, runs it, bundles it) |
| `./formpdf freeze` | freeze the engine into the desktop sidecar |
| `./formpdf mcp` | the MCP server over stdio, for Claude Desktop and other stdio clients |
| `./formpdf agents install`, `./formpdf agents sync` | set up Claude Code, Codex and Cursor; refresh the skills |
| `./formpdf run ...` | a PDF job without the window (see The headless CLI) |
| `./formpdf clean [--all]` | remove build output (`--all` also the venv and node_modules) |

`FORMPDF_PORT` moves the engine off 8198 and `FORMPDF_DATA_DIR` moves the data off `~/Formpdf`.

## Home

Home opens when no PDF is open, and from the formpdf mark in the workbench title bar, File > Home (Alt+Mod+H) or Close.

- **Start** greets you with **Open a PDF**: drop a PDF on the window, or choose Open PDF (Mod+O). Dropping pictures, or several PDFs, starts Create PDF instead. **Open by path** takes a full path such as `~/Documents/report.pdf`. **Create from pictures** and **Merge PDFs** open the Create PDF dialog. **Scan** looks for scanners on your network (any scanner that supports AirScan or eSCL, which most made in the last ten years do) and connected ones (through SANE on Linux and WIA on Windows); you can also type a network scanner's address. Choose Glass, Document feeder or Feeder, both sides, a resolution and colour, tick Make the scan searchable to run OCR on it, and, with a PDF open, Add the pages to the end of the open PDF (Undo removes them). File > Scan… does the same inside the workbench. **Use your agent** opens the Agents dialog.
- **Recent PDFs** lists the PDFs you opened, newest first, with a page preview. Click one to open the version you last had; the x on a card forgets it (the file itself is not touched).
- **Batch** runs one action on many PDFs: add PDFs (or paths), choose the action (page numbers, header and footer with Bates numbers, watermark, crop, redact, protect, metadata, compress, remove hidden information, link web and email addresses, split, Word, PowerPoint, HTML, RTF, Excel), set its options and choose **Run on all files**. With Add Bates numbers on, numbering continues from one file to the next in list order, each row shows its range and `Bates numbers.csv` records them. Your PDFs are not changed; each result goes into a new folder `Exports/Batch [date time] [action]`, the list shows each file's result, and **Download all** gives them as a zip.
- **Reviews** lists every recent PDF that has comments: its comment and reply counts, who commented (hover for each person's counts and last date), how many threads are still open, how many are resolved (Accepted, Rejected, Completed or Cancelled) and the last activity, newest first. Click a row to open that PDF on the Comment tab. Refresh reads them again.
- **Picking up again:** when formpdf closed while a PDF was open, the line under the greeting offers it back. After a crash or a reload with unsaved changes it reads "formpdf closed with unsaved changes in [name]. Reopen them": the changes you had applied come back with the Edited badge on, so you can still save them. Comments, field values and page moves you had not applied yet are not recovered. Discard or Dismiss clears the offer; the working copies stay in the data folder.
- **Create PDF from pictures** and **Merge PDFs** in the side bar do the same as the buttons. **Claude Code, Codex, Cursor** opens the Agents dialog; **Local only** is a reminder that PDFs stay on this computer; **Help** and **Preferences** open those dialogs.

## The workbench

The workbench opens over Home when you open or create a PDF. It has a title bar (the formpdf mark, the menus File, Edit, View, Tools and Help, the document name with an Edited badge, then Undo, Redo, Open, Print, Agents, Save and Close), a tool row with the tabs and the current tab's tools, a page and bookmark side bar, the pages, a panel for the current tab, and a status bar with the page size and file size, progress, a hint, the agent's last change, the page number, page display, zoom, Fit width, Fit page and Rotate view.

Password-protected PDFs ask for their password and open as an unlocked working copy. Changes build up as versions of that working copy: Undo and Redo step through them, and Save writes the PDF (the browser downloads it; the desktop app asks for a path, by default the Exports folder). Opening another PDF or closing offers to save first.

| Tab | What it does |
| --- | --- |
| View | Read the PDF; Select and Hand tools, Find in document, the document's properties (pages, page size, file size, PDF version, title, author, dates, form fields, security). Page display: Single page, Single page continuous, Two-page, Two-page continuous and Show cover page (also from the page button in the status bar and View menu); in the paged layouts Page Up and Page Down move a page or spread. Reading turns the PDF into one readable column, page after page with headings and tables, and the text size buttons (or Mod with plus or minus) resize it; Esc goes back to the same page. Read aloud reads this page or to the end, highlights the sentence, and pauses, resumes and stops, with a voice and speed. Compare checks this PDF against an older or newer one (optionally pictures too): insertions show in green, changes in amber, deletions as red marks and picture changes in purple, the panel lists every difference, and nothing in either file changes |
| Comment | Highlight, underline and strike through text; sticky notes, text boxes, freehand ink, rectangles, ellipses, lines and arrows in any colour and line width. Select a comment to reply to it or set its status (Accepted, Rejected, Completed); comments already in the PDF are listed with their replies. Apply to PDF writes them as real PDF annotations with their replies and status, or flattened into the page when Flatten into the page is on. Measure: Distance (click, click or drag), Perimeter and Area (click the corners, double-click or Enter to finish, Backspace takes back a corner), snapping to line ends, corners and crossings, Shift for 45 degree steps, units mm, cm, m, in, ft or pt at true size or calibrated by drawing over a known length; each measurement is saved as a measurement comment other readers show, listed with remove and Export CSV. Check spelling (F7) checks comments, text boxes and form field text, applied or not, and offers suggestions with Change, Change all, Ignore, Ignore all and Add to dictionary. Share comments: Export comments saves them with replies and status as an XFDF file that Acrobat and other readers import; Import comments adds the comments from an XFDF file that this PDF does not have yet (importing the same file twice adds nothing), as one change you can undo; Export text changes saves struck-out, replaced and inserted text and notes as a JSON change list, which the InDesign script in docs/indesign applies to the layout (see its README) |
| Fill Forms and Sign | Fill the PDF's form fields and Apply to form (optionally flattened); add text; draw or type a signature in blue or black ink and place it. Sign with a digital ID: make an ID on this computer (your name, optional email and organisation, a password that protects it) or import a .p12 or .pfx file, then sign into an empty signature field or draw a box; choose a text or picture appearance, a reason and location, Certify (allow form filling, comments, or no changes), Lock fields and Add a timestamp. The Signatures list says for each signature whether it is valid, from a certificate you have not trusted yet, or invalid, and in plain sentences what changed after it; Trust this certificate and Save the signed version are beside each one. Comments and form filling save as an incremental update, so signatures stay valid. Request signatures: add signers in order with their email and a message, Prepare request assigns the PDF's empty signature fields to them, the list shows who is next with an email link, and Bring in a signed copy adds the signatures from a copy someone sent back. Stamps (also on the Comment toolbar): twelve business stamps (Approved, Not Approved, Draft, Final, Confidential and the rest), dynamic stamps that carry your name and the date and time, sign-here tags, check and cross marks, date and text, and a stamp from a picture; click a stamp, click the page, drag to move or resize; they stay as stamp comments unless flattened |
| Prepare form | Draw text, multi-line, check box, radio (consecutive radios join one group), dropdown, list box, date and signature fields by dragging a box or clicking; select a field to move or resize it and set its name, tooltip, default, options, date format, font size, alignment, required and read-only. Fields already in the PDF are listed to rename or delete. Shift-click new fields to select several, then Align fields lines them up or spaces them evenly. Apply to PDF (or Save) writes real form fields |
| Edit | Header and footer: left, centre and right text for each, with Page, Pages, Date, File and Bates tokens, a live preview, font, size, colour, margins, a page range, odd or even pages and a starting number; Bates numbering with a prefix, start and digits. Crop pages by typed margins, a box drawn on the page, or Remove white margins, for this page, all pages or a range. Page numbers (position, format, start) and a text watermark (opacity, angle, size, colour). Links: draw a box and link it to a web address, an email address or a page, or link every web and email address in the text; links are listed with remove, and following a link in any PDF asks first and opens only web and email links. Attached files: attach any file to the PDF or pin one to a spot on a page (a paperclip), save a copy or remove it. Text and pictures: Add text (click, or drag across to set the width, then type; Inter, Noto Serif or JetBrains Mono, size, colour, bold, italic, underline, strike, super and subscript, left, centre, right or justified paragraphs, bulleted and numbered lists with Tab and Shift+Tab for levels, line spacing; click outside or Esc to finish), Add picture (choose a file, click where it goes), and Select: click or Shift-click any text on the page (text the PDF already had is picked up a paragraph at a time; the note says whether edits keep the document's own font), pictures (also pictures that were already on the page) and comments, drag to move, use the handles to resize and the round handle to rotate (Shift for 15 degree steps), double-click text to edit it or a picture to crop it (Enter keeps the crop), rotate by 90 degrees, flip, reset the crop, Replace… a picture with a file, arrow keys to nudge (Shift for 10 points), Delete to remove; Bring to front, Bring forward, Send backward and Send to back; align edges and centres or distribute across or down; Make page text turns a comment text box into page text. The text and pictures you add are page content: they print, extract and search like the rest of the page, and stay editable in formpdf |
| Organize | Rotate, delete and reorder pages by dragging, insert a blank page or pages from another PDF (or drop a PDF on the grid), extract the selected pages; Apply changes. Split into files by ranges such as `1-3, 4-6, 7-`; Merge PDFs appends whole PDFs |
| Extract | From this page, all pages or a range: text (copy, .txt or .md), pictures (download) and tables (copy as CSV, CSV per table, or all as .xlsx) |
| Protect | Add a password with an optional owner password and permissions (AES-256); remove a password (available when the PDF is protected); Find text to redact (words or a phrase, email addresses, phone numbers, card numbers, dates or a regular expression, with Match case and Whole words), tick the matches and mark or redact them; mark areas, choose the fill colour and optional text on each box, and Apply redactions (the text, pictures, shapes, comments and form fields under each box are removed for good while the rest of the page stays selectable text; redaction marks already in the file are applied too; tick Scanned pages to turn the marked pages into pictures instead); edit or remove the title, author, subject and keywords. Remove hidden information: Find hidden information counts metadata, JavaScript and actions, attachments, comments, form fields, hidden layers, links, bookmarks, thumbnails, private application data and hidden text; untick what to keep and Remove ticked |
| Convert | Make searchable (OCR): recognises the words on scanned pages on this computer and adds them as invisible text, so Find, copy, redaction and the exports work (choose 200, 300 or 400 dpi and the pages; Skip pages that already have text, Straighten tilted scans, which also straightens the scanned picture itself when the page is only a scan, and Recognise again; about ten seconds a page; when recognition is not installed the section says how to add it); Export to PowerPoint (see below); Save as Word (.docx) for a page range, with paragraphs, headings, lists, pictures and tables as editable Word content, two- and three-column pages as Word columns, and running headers and footers in the Word header and footer with a live page number; Save as HTML (one file, pictures inside), RTF or Excel (one sheet per page, table numbers as real numbers, or tables only), with running headers and footers left out; Compress at a chosen quality; export pages as PNG pictures at 72, 144, 216 or 300 dpi |
| Accessibility | Accessibility check: Run check tests the PDF against 32 PDF/UA and WCAG rules in seven groups; each rule says passed, failed, check by hand or skipped and why (hover a rule for the pages), Fix repairs a rule that can be repaired (tags, title, language, tab order, untagged comments and fields, field descriptions, table summaries, bookmarks from headings), Fix what can be fixed does all of them, and Report saves an HTML report. Tags: Tag the PDF works out headings, paragraphs, lists, tables, figures, links and form fields in reading order and marks running headers and footers as background; set the language and title first if you like; tagging again replaces the tags. Reading order: numbered outlines show the tagged regions on the pages; pick a page, select a region to see it, change what it is tagged as (Background takes it out of what screen readers read) or move it Earlier or Later. Alternate text: step through the figures, type what each shows, or mark it Decorative, then Save |
| Print | Print (Mod+P or the Print button opens this tab; Enter on Print… prints): Pages, Booklet or Poster; pages per sheet (1 to 16) in four orders with an optional border; booklet binding on the left or right edge (print on both sides, flipping on the short edge, then fold); poster tile scale, overlap, cut marks and tile labels; size (fit, shrink oversized, actual, custom percent), paper (the pages' own size, Letter, Legal, Tabloid, A3, A4, A5), orientation, margin, which comments and fields print, and Grayscale, converted in the file rather than by the printer. The preview shows every sheet as it will print. Save print PDF keeps the laid-out file. PDF/A and PDF/X: check against PDF/A-2b, 2u or 3b with each problem's clause and whether converting fixes it, convert (fonts the file lacks are embedded from Liberation, which matches Helvetica, Times and Courier in width), or convert to PDF/X-4 with your printer's ICC profile. Preflight: commercial print, office printer or screen and email; checks fonts, picture resolution at the printed size, colour, transparency, hairlines, trim boxes and scripts, with fixups (embed fonts, thicken hairlines, trim boxes, remove scripts, downsample) and a report |
| Assistant | Uses the AI provider you choose in Preferences > AI (off until you do). Ask this PDF: type a question and Ask (Mod+Enter), or Summarise at a length; the answer cites the pages it comes from as small page buttons that jump there, and quotations formpdf could not find on the cited page are underlined so you know to check them. With your agent as provider, ask here, then tell Claude Code, Codex or Cursor "answer my formpdf question"; the answer appears here. Generate a presentation: drafts an outline from this PDF and any files you add by path (PDFs, Word, PowerPoint, Excel, text), which you edit (titles, one point per line, remove slides) before Create presentation saves it as PowerPoint with the source pages in each slide's notes. Generate a picture: describe it, choose square, wide or tall, and it is placed on the current page as a picture you can move, resize and crop with Edit > Select (needs OpenAI or a picture server on your computer) |

**Create PDF**: Create from pictures or Combine files (from Home, the Open menu or the empty workbench): add or drop pictures, PDFs and Office files (Word, PowerPoint, Excel, OpenDocument, RTF, text and CSV; dropping one on Home or the workbench opens Combine files), set the order by dragging or with the arrows, choose Fit to picture, A4 or Letter, margins and orientation, and Create PDF. The new PDF opens in the workbench; save it to keep it. Office files are converted by LibreOffice, which formpdf uses but does not include: install it from libreoffice.org and formpdf finds it (the dialog says when it is missing). It runs on this computer with macros off and linked content not updated, so converting never runs a document's code or fetches anything.

## Export to PowerPoint

Convert > PowerPoint writes a .pptx with one slide per page. The slides take the size of the first page (other page sizes are fitted and centred). Words become real text boxes where formpdf's layout analysis finds paragraphs and headings, with their size, bold, italic, colour and alignment; words spread across a line, such as chart labels, get a box each; turned text becomes a turned text box; detected tables become PowerPoint tables. Lines, rectangles and other drawn shapes become PowerPoint shapes you can recolour and move, and pictures become pictures. What cannot be rebuilt (shadings, soft masks, shapes cut by a clipping path, skewed pictures, and anything drawn before them) stays in a picture behind the slide, so the slide still looks like the page. Untick Editable text, shapes and pictures for pictures only. The text is placed where it was; fonts PowerPoint does not have are substituted, so a line can run slightly longer or shorter. Scanned pages have no text, so they stay pictures.

## Find a command or tool

Mod+K, on Home or in the workbench (also Help > Find a command or tool), opens one search over every command and tool. Type what you want to do in your own words: "bates", "black out", "powerpoint", "bulk" or "rotate" find the tab or command that does it, and the word that matched shows beside it. Commands that cannot run right now stay in the list, dimmed, with the reason (Open a PDF first, Nothing to undo yet). Up and Down move, Enter runs, Esc closes; the commands you use most rise to the top.

## Action lists and plug-ins

Tools > Action lists runs a sequence of actions on the open PDF as one change you can undo. Five lists come with formpdf: Prepare for distribution (removes metadata, scripts, attached files, private data and thumbnails, then compresses), Optimise scans (makes scanned pages searchable, straightens them, compresses), Mark confidential (watermark and a confidential footer with page numbers), Make accessible (tags the PDF and applies every accessibility fix that needs no person) and Archive as PDF/A. To make your own, choose Tools > Record an action list, make the changes you want in any tab, then Stop and save in the bar at the top and give the list a name; Cancel throws the recording away. Saved lists can be deleted; they also run from Home > Batch (Run an action list) over many files, from agents and from the CLI (`./formpdf run run_list report.pdf --set list="Mark confidential"`).

Plug-ins add actions and tool sections. A plug-in is a folder in `~/Formpdf/plugins` with a `plugin.json`, an engine file in Python and a window file in JavaScript; `docs/plugins/word-count` is a sample to copy there. Nothing in a plug-in runs until you turn it on in Preferences > Plug-ins, and a plug-in turns itself off again if any of its files change. A plug-in runs with the same access to your files as formpdf, so turn on only plug-ins you trust. Its actions appear in the Mod+K search, in Batch, in action lists and for agents.

Forms with calculations, number, percent, date and phone formats, keystroke limits and range checks written with the standard AcroForm functions work as you fill them: totals update as you type, formatted values show when you leave a field, and a value out of range is marked with the reason. formpdf never runs a form's own JavaScript; a form with custom scripts says how many it skipped. Preferences > Forms turns calculations off.

## Keyboard shortcuts

| Group | Command | Keys |
| --- | --- | --- |
| File | Home | Alt+Mod+H |
| | Open a PDF | Mod+O |
| | Save | Mod+S |
| | Print | Mod+P |
| Edit | Undo | Mod+Z |
| | Redo | Shift+Mod+Z or Mod+Y |
| | Undo agent turn | Alt+Mod+Z |
| | Find | Mod+F |
| View | Zoom in, Zoom out | Mod+=, Mod+- (in reading mode: text size) |
| | Fit width | Mod+0 |
| Page | Next, previous page | Page Down, Page Up |
| | First, last page | Home, End |
| | Delete the selected comment, field or pages | Delete or Backspace |
| | Cancel the tool, close search or the bar | Esc |
| Comment | Select, highlight, underline, strike through, note, text box, draw, rectangle, ellipse, line, arrow | V, H, U, K, N, T, P, R, E, L, A |
| Organize | Select all pages | Mod+A |
| Text and pictures | Bring to front, Bring forward | Shift+Mod+], Mod+] |
| | Send backward, Send to back | Mod+[, Shift+Mod+[ |
| | Nudge the selection | Arrow keys (Shift for 10 points) |
| Help | Find a command or tool | Mod+K |
| | formpdf Help | F1 |
| | Check spelling | F7 |
| | Keyboard shortcuts | Mod+/ |
| | Preferences | Mod+, |

## Agents

Claude Code, Codex, Cursor and Claude Desktop can work on PDFs through formpdf's MCP server. They see the PDF you have open, and their changes land in the window live.

### Setup

Start formpdf first (`./formpdf`). Then pick one:

- **All at once**: `./formpdf agents install` writes `.mcp.json` (Claude Code), `.codex/config.toml` (Codex) and `.cursor/mcp.json` (Cursor) in the formpdf folder and in the folder you ran it from, and installs the formpdf skills into `~/.claude/skills` and `~/.agents/skills`. `--dry-run` shows what it would do.
- **Claude Code**: `claude mcp add --transport http formpdf http://127.0.0.1:8198/mcp`.
- **Codex**: add `[mcp_servers.formpdf]` with `url = "http://127.0.0.1:8198/mcp"` to `~/.codex/config.toml`.
- **Cursor**: add `{"mcpServers": {"formpdf": {"url": "http://127.0.0.1:8198/mcp"}}}` to `~/.cursor/mcp.json` or a project's `.cursor/mcp.json`.
- **Claude Desktop**: in `claude_desktop_config.json` add `{"mcpServers": {"formpdf": {"command": "/path/to/formpdf/formpdf", "args": ["mcp"]}}}`. The stdio bridge finds the engine through `~/Formpdf/engine.json` and starts it when it is not running.

The Agents dialog (the Agents button in the title bar, Help > Agents and MCP, or Home) shows the same snippets with Copy buttons, the MCP address, the engine's port and data folder, and Copy a starter prompt.

### The tools

| Tool | What it does |
| --- | --- |
| get_context | the open PDF, PDFs the agent opened, recent PDFs, whether agents may edit |
| open_pdf | opens a file in the window |
| pdf | 60 actions: info, text, images, tables, find, comments, fields, hidden, compare, links, attachments, measurements, snap_points, spell, items, signatures, accessibility, structure, print_layout, pdfa_check, preflight; header_footer, page_numbers, watermark, crop, redact, mark_redactions, organize, protect, unlock, metadata, compress, sanitize, fill, annotate, form, merge, edit_links, edit_attachments, measure, spell_fix, edit_items, ocr, sign, request_signatures, autotag, fix_accessibility, edit_structure, pdfa, pdfx, preflight_fix; split, to_docx, to_pptx, to_html, to_rtf, to_xlsx, accessibility_report, print_pdf, preflight_report |
| render_pages | a contact sheet picture of up to 12 pages |
| extract | text, tables or pictures |
| save | writes the open PDF to a file |
| undo | takes back the agent's last turn |

Without a path, a changing action works on the PDF open in the window: the window switches to the result at once, and the change is labelled as the agent's in the history and the status bar. With a path, the file is left alone and a new file is written beside it.

### Consent

Agents can read without asking, but the first time one tries to change a PDF or write a file formpdf asks in the window: **Allow agents to edit?** with Allow and Not now. The switch lives in Preferences > Agents and the Agents dialog; turning it off stops agent changes. The server listens on 127.0.0.1 only.

### Undoing an agent

Edit > Undo agent turn (Alt+Mod+Z), or **Undo turn** next to the agent's last change in the status bar, takes back the agent's whole last turn (every change it made within 90 seconds of the one before) in one step. Plain Undo steps back one change at a time, the agent's included. Nothing an agent does is written to disk until you or the agent saves.

### The skills

`./formpdf agents install` (and `./formpdf agents sync` after an update) installs **formpdf-harness**, for doing PDF work (the loop, every action with its arguments, verification by rendering, handoff), and **formpdf-skillset**, for developing formpdf itself. The MCP resource `formpdf://guide` is the short guide agents read first, and the server offers a `pdf-job` prompt.

## The headless CLI

`./formpdf run` does one PDF action on files without the window, through the same code the MCP tools use. Changing actions write `[name]-[action].pdf` beside the input unless `--out` is given; the input never changes.

```
./formpdf run actions
./formpdf run info report.pdf
./formpdf run page_numbers report.pdf --format "Page {n} of {total}" --position bottom-right
./formpdf run header_footer exhibits.pdf --json '{"footer": {"right": "<<bates>>"}, "bates": {"prefix": "ACME-", "digits": 6}}'
./formpdf run redact contract.pdf --preset email
./formpdf run merge a.pdf b.pdf --out both.pdf
./formpdf run merge report.docx
./formpdf run export_xfdf reviewed.pdf --out review.xfdf
./formpdf run import_xfdf mine.pdf --set xfdf=review.xfdf
./formpdf run to_pptx slides.pdf
./formpdf run render report.pdf --pages 1-4 --out sheet.png
```

| Option | Meaning |
| --- | --- |
| `action` | a pdf action, `render` (contact sheet), `actions` or `guide` |
| `files` | the PDF; merge takes two or more |
| `--out`, `--pages` | output file or folder; page range |
| `--query`, `--preset`, `--regex`, `--case-sensitive`, `--whole-word` | find and redact |
| `--text`, `--opacity`, `--angle`, `--size`, `--color` | watermark and numbers |
| `--format`, `--position`, `--start` | page numbers |
| `--password`, `--owner` | protect and unlock |
| `--title`, `--author`, `--subject`, `--keywords`, `--strip` | metadata |
| `--quality`, `--rotate`, `--flatten`, `--auto`, `--other`, `--highlight` | compress, organize, fill, crop, compare, annotate |
| `--set KEY=VALUE`, `--json '{...}'` | any other argument, as the MCP pdf tool takes it |

## Preferences

Help > Preferences (Mod+,): Appearance (theme and accent colour, the same fourteen themes as the form family, light and dark), Comments and stamps (the author name written on comments you apply, units), Spelling (the dictionary language and Your words, one per line, which Check spelling accepts; more languages are Hunspell .dic and .aff pairs placed in `~/Formpdf/dictionaries/<code>/`), Signing (a timestamp server address, used only when you tick Add a timestamp while signing), Forms (run standard form calculations, formats and checks), Plug-ins (each plug-in in the plugins folder with its state and any error, and a switch to turn it on or off), AI (the provider for the Assistant tab: Off, Your agent, Anthropic or OpenAI with your API key, or a model on this computer through Ollama, LM Studio or another OpenAI-compatible server; the model, the server address, the key, which is kept in the data folder and never shown again, a picture server for local pictures, and Test the connection), Agents (let Claude Code, Codex and Cursor read and edit PDFs), and Network (every connection formpdf could make and whether it does: today the engine and the window talk only on this computer, and the desktop update check is off).

## Languages

The window speaks 26 languages; English is the default. Change it in Help > Preferences > Language > Interface; the choice is kept in the data folder, so every window and the desktop app start in it. The languages are English, Español, Español (México), Português (Brasil), Français, Français (Canada), Deutsch, Italiano, Nederlands, Dansk, Suomi, Norsk bokmål, Svenska, Русский, Polski, Čeština, Magyar, Українська, Türkçe, 简体中文, 繁體中文, 日本語, 한국어, Bahasa Indonesia, ไทย and Tiếng Việt. Español (México) and Français (Canada) hold only the words that differ and fall back to Español and Français for the rest.

What is translated: every label, menu, tooltip and dialog, and the messages the engine sends the window (errors, preflight, PDF/X and accessibility findings, with their counts and page lists). What stays English: the PDF's own text, what agents and the command line read, and HTML reports.

Each language is one table in `frontend/src/ui/i18n/<code>.ts`, keyed by the English text. A key with `{0}`, `{1}` holes is a pattern: the window matches a message against it and translates each hole's value on its own. A translation can choose a word by a count with `{0|one:Seite|other:Seiten}`, using the language's plural rules (the categories are zero, one, two, few, many and other; other is required). To correct a translation, edit its line and run `python3 setup/i18n.py parity`, which lists for each table the keys that are missing, no longer used, or whose holes or count-aware words do not fit the key.

## The data folder

Everything lives in `~/Formpdf` (or `FORMPDF_DATA_DIR`):

```
Pdf/pdf_xxxxxxxxxx.pdf   every opened, created or changed version, with a .json beside it
Pdf/recent.json          the recent PDFs list
Media/                   pictures extracted from PDFs
Exports/                 files written by Save and by agents and exports without a path
Exports/Batch [date] [action]/   results of a batch run
Batch/                   copies of PDFs added to Batch in a browser, removed after a day
settings.json            preferences, including your spelling words
dictionaries/            extra Hunspell dictionaries, one folder per language (de_DE/de_DE.dic and .aff)
actions/                 your saved action lists, one .json each
plugins/                 plug-ins, one folder each with its plugin.json
office-profile/          the LibreOffice settings formpdf uses to convert Office files
ai-keys.json             AI provider keys, readable only by you
session.json             the PDF open in the window, for picking up again after a restart or crash
engine.json              the running engine's port and process, removed when it stops
```

## When something goes wrong

- **"The formpdf engine is not answering yet"**: the engine is not running or is starting. Run `./formpdf` (or `./formpdf backend`) and reload. `./formpdf doctor` shows what is missing and whether the ports are taken.
- **Port in use**: another formpdf or app is on 8198 or 5198. Stop it, or set `FORMPDF_PORT`.
- **A PDF will not open**: if it is password protected, enter the password when asked; otherwise it may be damaged.
- **Text search or extraction finds nothing**: the page is probably a scan; formpdf has no OCR yet.
- **An agent cannot connect**: check that formpdf is running, that the address in the Agents dialog matches your agent's config, and that Let agents read and edit PDFs is on. Claude Desktop needs the stdio entry (`./formpdf mcp`), not the URL.
- **An agent's change went wrong**: Edit > Undo agent turn, or Undo turn in the status bar. Your file on disk is not touched until you save.
- **Fonts look different in PowerPoint**: the export uses the PDF's font names; PowerPoint substitutes fonts it does not have.
