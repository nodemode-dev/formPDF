import json
import sys

F, P, N = "full", "partial", "none"
V = {F: 1.0, P: 0.5, N: 0.0}

AREAS = [
    "PDF viewing", "PDF annotation", "Content editing", "PDF forms and signing", "PDF organize",
    "PDF protect and redact", "PDF convert", "Review and comments", "Collaboration and sharing", "Accessibility",
    "Import and export", "Print", "Automation and agents", "Platform",
]

R = []


def row(area, cap, acro, st, ev):
    R.append({"area": area, "cap": cap, "acro": acro, "st": st, "ev": ev})


a = "PDF viewing"
row(a, "View with thumbnails, zoom, fit width or page, rotate view", 1, F, "`frontend/src/pdf/viewer.ts Viewer` (pdf.js), `workbench.ts`")
row(a, "Search text", 1, F, "`frontend/src/pdf/find.ts`")
row(a, "Bookmarks and links", 1, F, "`workbench.ts` Bookmarks side panel, `viewer.ts` link layer")
row(a, "Open password-protected PDFs", 1, F, "`workbench.ts askPassword`, `services/pdf/core.py reader(passwords)`")
row(a, "Read aloud, reflow, two-page layout", 1, F, "`viewer.ts setLayout` (single, continuous, two-page, two-page continuous, cover), `reading.ts Reflow` over `layout.py reflow`, `reading.ts Speaker` (speechSynthesis with sentence and word highlight)")
row(a, "Summarize or ask questions of a PDF (AI Assistant)", 1, P, "no built-in model; an outside agent reads the PDF through the MCP pdf actions text and tables (`mcp.py t_pdf`, `services/pdf/core.py extract_text, extract_tables`) and answers in its own chat")

a = "PDF annotation"
row(a, "Highlight, underline, strike through text", 1, F, "`frontend/src/pdf/annotate.ts`, `backend/app/services/pdf/annot.py annotate`")
row(a, "Sticky notes and text boxes", 1, F, "`annotate.ts` note and freetext tools")
row(a, "Drawing: ink, rectangle, ellipse, line, arrow", 1, F, "`annotate.ts` tools, `annot.py draw`")
row(a, "Stamps", 1, F, "`pdf/stamps.ts STAMPS` (standard, dynamic with name and date, sign-here, marks, picture stamps), `annot.py _stamp` Stamp annotations with appearance streams")
row(a, "Comment list with replies and status", 1, F, "Comment panel threads with replies and status (`panels.ts syncAnnots`), written as /IRT reply and /State annotations (`annot.py _thread`), read by `GET /pdf/{id}/comments`")
row(a, "Flatten annotations into the page", 1, F, "`panels.ts` Flatten into the page, `annot.py annotate(flatten)`")
row(a, "Measure distance, perimeter and area", 1, F, "Comment > Measure (`frontend/src/tools/measure.ts`): distance, perimeter and area with a live value, units, calibration from a known length, snapping to path ends, midpoints and crossings, 45 degree steps, a list with remove and CSV export; saved as Line, PolyLine and Polygon measurement annotations with a Measure dictionary and their own appearance (`services/pdf/measure.py change, read, snap`; actions measure, measurements, snap_points)")

a = "Content editing"
row(a, "Edit PDF text and pictures in place", 1, F, "Edit > Text and pictures > Select: any paragraph already on the page (`textedit.py detect`: lines, table walls, duplicate and invisible layers, alignment, bullets) is retyped in place, rewraps to its box and keeps its own font where the font has the letters (`items.py` orig fonts), or moves, widens, rotates and restyles; pictures already on the page move, resize, rotate, flip, crop, are replaced or deleted without re-encoding; MCP and CLI `edit_items {page, paragraph}`")
row(a, "Add new text to PDF pages", 1, F, "Edit > Text and pictures > Add text (`tools/content.ts`, `tools/richtext.ts`): type on the page in a live editor, saved as page content that stays editable (`services/pdf/items.py`, actions items and edit_items in MCP and the CLI); double-click to edit again, move, resize the width, rotate; Make page text turns a comment text box into page text")
row(a, "Edit PDF text formatting: font, size, colour, style", 1, F, "for added text and text already on the page: the document's font or Inter, Noto Serif or JetBrains Mono, size, colour, bold, italic, underline, strike, super and subscript per run, alignment, lists, line spacing (`tools/content.ts`, `items.py layout`, `textedit.py`); the pane names the font edits will use")
row(a, "Bulleted and numbered lists in PDF text", 1, F, "in added page text: bulleted and numbered lists with hanging indents and four levels (Tab and Shift+Tab), numbering restarting after other paragraphs (`richtext.ts setList, indent`, `items.py layout`)")
row(a, "Align PDF paragraphs: left, centre, right, justify", 1, F, "in added page text, per paragraph: left, centre, right and justify with the last line left (`richtext.ts`, `items.py layout`)")
row(a, "Add links to PDF pages", 1, F, "Edit > Links (`frontend/src/tools/links.ts`): draw a box and link it to a web address, an email address or a page, link every web and email address in the text, list and remove links; `services/pdf/links.py change, read` (actions edit_links and links in MCP, the CLI and Batch); following a link offers http, https and mailto only, behind a prompt (`workbench.ts openLink`)")
row(a, "Spell check edited text and comments", 1, F, "Comment > Check spelling (`tools/spell.ts`, F7) over PDF comments, text boxes, form field text and comments not applied yet, with suggestions, Change, Change all, Ignore, Ignore all and Add to dictionary; engine `spell.py` reads Hunspell dictionaries (SCOWL en_US bundled, more in Formpdf/dictionaries), MCP `pdf spell` and `spell_fix`; Preferences > Spelling sets the language and your words")
row(a, "Add pictures to PDF pages", 1, F, "Edit > Text and pictures > Add picture (`tools/content.ts`): PNG, JPEG, GIF, WebP, BMP or TIFF placed as page content at full resolution, JPEG kept as JPEG, EXIF orientation honoured, editable afterwards (`items.py image_object`)")
row(a, "Crop pictures on PDF pages", 1, F, "Select a picture added by formpdf or already on the page, Crop and drag the handles (Enter keeps it), Reset crop; a clip in the picture's form, never a re-encode (`items.py _picture_form`, `Page.convert`)")
row(a, "Generate pictures with AI (Adobe Express)", 1, N, "nothing found")
row(a, "Arrange objects: bring forward, send backward", 1, F, "Bring to front, Bring forward, Send backward, Send to back (Mod+], Mod+[ with Shift for front and back) for page text, pictures (added or already on the page) and comments (`tools/content.ts arrange`; `items.py Page.arrange`, edit_items comments for comments already in the PDF)")
row(a, "Align and distribute objects on a page", 1, F, "align left, centre, right, top, middle, bottom and distribute across or down for selected page text, pictures and comments (Edit > Text and pictures) and for new form fields (Prepare form > Align fields, Shift-click to select several) (`pdf/align.ts`, `tools/formalign.ts`)")
row(a, "Rotate and flip pictures on PDF pages", 1, F, "rotate by any angle with the rotate handle (Shift for 15 degree steps) or by 90 degrees, flip horizontally or vertically, for pictures added by formpdf and pictures already on the page, by transform only (`items.py placement`)")
row(a, "Attach files to a PDF", 1, F, "Edit > Attached files (`frontend/src/tools/attachments.ts`): attach files of any type to the document, pin a file to a spot on a page (a FileAttachment comment with a paperclip), list, save a copy and remove; `services/pdf/attach.py change, read, get_file` (actions edit_attachments and attachments), GET /api/pdf/{id}/attachment; Remove hidden information still strips them")

a = "PDF forms and signing"
row(a, "Fill form fields", 1, F, "`frontend/src/pdf/fill.ts`, `services/pdf/edit.py read_fields, fill_fields`")
row(a, "Flatten a filled form", 1, F, "`edit.py fill_fields(flatten)`")
row(a, "Place a drawn or typed signature", 1, F, "`panels.ts` signature pad (Draw, Type), `placeSignature`")
row(a, "Certificate-based digital signatures", 1, F, "Fill & Sign > Sign with a digital ID (`tools/certsign.ts`) and the sign and signatures actions (`services/pdf/sign.py`, pyHanko): digital IDs made here or imported from .p12 and .pfx, PAdES signatures into a field or a drawn box with a text or picture appearance, certification with forms, comments or no changes allowed, field locking, RFC 3161 timestamps from a server the person sets; validation against certificates trusted on this computer with plain-sentence verdicts and formpdf's own change analysis, signed versions saved out; comments and form filling save incrementally so signatures stay valid")
row(a, "Request signatures from others", 1, P, "Fill & Sign > Request signatures and the request_signatures action (`services/pdf/sign.py`): ordered signers assigned to signature fields, status with who is next, an email link, and signed copies joined back as versions; partial because Acrobat sends, reminds and collects through its cloud service and formpdf leaves sending to the person's own email")
row(a, "Create form fields", 1, F, "Prepare form tab (`pdf/form.ts FormBuilder`: text, multi-line, check box, radio groups, dropdown, list box, date, signature; rename, delete), `forms.py prepare` writes AcroForm fields with appearance streams")

a = "PDF organize"
row(a, "Reorder, rotate, delete, insert blank and insert pages from a PDF", 1, F, "`frontend/src/pdf/organize.ts Organizer`, `services/pdf/edit.py organize`")
row(a, "Extract pages", 1, F, "`panels.ts` Extract selected")
row(a, "Split by ranges", 1, F, "`services/pdf/core.py split`")
row(a, "Merge PDFs", 1, F, "`core.py merge`, `routers/pdf.py /pdf/merge`")
row(a, "Crop pages", 1, F, "Edit > Crop pages by margins, a drawn box or white-margin detection (`edit.py crop`, `annotate.ts` crop tool, `POST /pdf/{id}/crop`)")
row(a, "Page numbers, headers and footers, watermark", 1, F, "Edit > Header and footer with tokens and Bates numbering (`edit.py header_footer`), page numbers and watermark")
row(a, "Bates numbering", 1, F, "`services/pdf/edit.py header_footer(bates)` with a <<bates>> token, prefix, suffix, start and digits from Edit > Header and footer and MCP `pdf header_footer`; across a set of legal documents from Home > Batch (`routers/batch.py _bates, _numbered`): numbers continue from file to file in the order listed, each row shows its range, and Bates numbers.csv records file, numbered copy, first and last")

a = "PDF protect and redact"
row(a, "Password protection with permissions", 1, F, "`edit.py protect`, `panels.ts` Password and permissions")
row(a, "Remove protection", 1, F, "`edit.py unlock`")
row(a, "Redact marked areas", 1, F, "`redact.py apply`: text, covered pixels, shapes, comments, fields and item text under each box removed, the rest stays text; marks in the file applied with their own fill and overlay text; re-read and render checks before writing; `mark_redactions`; Protect > Redact (fill, text on box, Scanned pages for `edit.py redact` raster)")
row(a, "Find and redact text or patterns", 1, F, "Protect > Find text to redact: words, regex, email, phone, card and date presets (`search.py find`), redacted through `edit.py redact`; MCP `pdf redact`")
row(a, "Remove metadata and hidden information", 1, F, "Protect > Remove hidden information (`sanitize.py scan, sanitize`: metadata, JavaScript, attachments, comments, flattened fields, hidden layers, links, bookmarks, thumbnails, private data, hidden text)")

a = "PDF convert"
row(a, "Export to PowerPoint (.pptx)", 1, F, "Convert > Export to PowerPoint and the to_pptx action (`services/pdf/slides.py to_pptx`, `objects.py split`): one slide per page; words as real text boxes (turned words as turned boxes, text in form XObjects included), detected tables as PowerPoint tables, lines, rectangles and other paths as PowerPoint shapes and pictures as pictures, over a slide picture that keeps only what cannot be rebuilt (shadings, soft masks, clipped or skewed objects and what is drawn before them)")
row(a, "Extract text as .txt or .md", 1, F, "`core.py extract_text`, `panels.ts` text-txt, text-md")
row(a, "Export to HTML or RTF", 1, F, "Convert > Web page, rich text and Excel (`tools/exports.ts`), MCP `pdf to_html` and `to_rtf` (`exports.py`): one self-contained HTML file with pictures inline, or RTF with lists, tables and pictures; headings, lists and tables in reading order with running headers and footers left out")
row(a, "Extract pictures", 1, F, "`core.py extract_images`")
row(a, "Tables to Excel", 1, F, "Convert > Save as Excel and MCP `pdf to_xlsx` (`exports.py`): one sheet per page in reading order, table numbers, money and percentages stored as real numbers with their formats, a tables-only option; Extract > Tables (`core.py tables_xlsx`) still exports detected tables")
row(a, "Pages to pictures", 1, F, "`services/pdf/core.py pages_zip`, `render_png`, Convert > pages as PNG at 72, 144, 216 or 300 dpi; PNG only")
row(a, "Compress", 1, F, "`edit.py compress`")
row(a, "PDF to Word", 1, F, "Convert > Word (`word.py to_docx`: headings, styled paragraphs, Word bullet and numbered lists, pictures, tables, column sections, running headers and footers in the Word header and footer with a PAGE field), MCP `pdf to_docx`")
row(a, "OCR for scanned pages", 1, F, "Convert > Make searchable (OCR) and the ocr action (`services/pdf/ocr.py`): RapidOCR with PaddleOCR's Apache-2.0 models on onnxruntime, on this computer; skips pages with text, caps the render at the scan's resolution, straightens tilted scans, writes an invisible per-word text layer in an embedded Unicode font that find, redaction and exports use, rotated pages included; Batch, MCP and CLI")
row(a, "Create a PDF from pictures", 1, F, "`create.py from_files` (one page per picture, fit, A4 or Letter, margins, orientation; PDFs combined in order), `pdf/create.ts` from Home and the Open menu")
row(a, "Scan paper documents to PDF", 1, F, "Home and File > Scan (`pdf/scan.ts`, `services/scan.py`): network scanners found over mDNS and driven with eSCL (glass, feeder, both sides, resolution, colour), USB scanners through SANE on Linux and WIA on Windows; into a new PDF or added to the open one, made searchable on the way")

a = "Review and comments"
row(a, "Compare two versions of a PDF", 1, F, "`pdf/compare.ts Comparer`, `services/pdf/compare.py compare`: View > Compare against an older or newer PDF, word-level insertions, changes and deletions marked on the page with optional picture changes, every difference listed with before and after text; no summary report file")
row(a, "Track a review: who commented, when, and with what status", 1, F, "Home > Reviews (`ui/reviews.ts`, `services/reviews.py`): every recent PDF with comments, its reviewers with their counts and last dates, open and resolved threads and last activity, opening on the Comment tab; reviews pass between copies as XFDF (`xfdf.py export_xfdf, import_xfdf`, Comment > Share comments) with replies, status, authors and dates, matched by name so nothing is duplicated")

a = "Collaboration and sharing"
row(a, "Share PDF links with permissions", 1, N, "nothing found: no hosted service")
row(a, "Works offline on local files", 1, F, "local engine; working copies under the data folder (`services/pdf/docs.py root`) and Save writes the PDF back to disk (`routers/pdf.py /pdf/{doc_id}/save`)")

a = "Accessibility"
row(a, "Accessibility checker for PDFs", 1, F, "Accessibility > Accessibility check and the accessibility action (`services/pdf/access.py check`): Acrobat's 32 rules in its seven groups with passed, failed, manual and skipped, page findings, a fix per repairable rule (`fix_accessibility`: tags, title, language, tab order, untagged comments and fields, field descriptions, table summaries, bookmarks) and an HTML report (`accessibility_report`)")
row(a, "Reading Order tool for tagged PDFs", 1, F, "Accessibility > Reading order (`tools/access.ts`): numbered tagged regions on the pages, retag, move earlier or later, mark as background; `structure` and `edit_structure` for agents")
row(a, "Screen reader support in the app", 1, P, "labelled region, tabs pattern with arrow keys and labelled tab panels (`workbench.ts`), status region for long jobs, dialogs labelled with focus kept inside (`ui/dialogs.ts`), ARIA labels on buttons and fields; page content is pdf.js canvas plus text layer; partial because it has not been tried with VoiceOver or NVDA")
row(a, "Alternate text for figures", 1, F, "Accessibility > Alternate text (`tools/access.ts`): figure by figure with a crop of the page, alternate text or decorative; `edit_structure {alt, decorative}`")
row(a, "Tag a PDF for accessibility (autotag)", 1, F, "Accessibility > Tags and the autotag action (`services/pdf/access.py tag`): headings, paragraphs, lists, tables with header cells, figures with boxes, links, fields and comments in reading order from `layout.page_blocks`, running headers and footers as artifacts, marked content written stream by stream; renders unchanged and Poppler reads the tree")

a = "Import and export"
row(a, "Create PDFs from Office files (Word, PowerPoint, Excel)", 1, F, "Combine files, drops on Home and the workbench, open_pdf, merge and the CLI convert Word, PowerPoint, Excel, OpenDocument, RTF, text and CSV through the LibreOffice the person installs (`services/office.py`, `create.py from_files`), headless with macros and link updates off; the window says when LibreOffice is missing, as Acrobat needs Office for some of its own conversions")

a = "Print"
row(a, "Print PDFs, including several pages per sheet", 1, F, "Print tab (`tools/print.ts`, `pdf/printjob.ts`) over `services/pdf/printing.py`: pages per sheet (1 to 16) in four orders with borders, booklets with binding side, posters with overlap, cut marks and labels, comments and fields choice, a live preview of every sheet, printed through a print PDF sized with @page on every platform or saved")
row(a, "Print settings: paper size, grayscale, scaling", 1, F, "fit, shrink, actual and custom scale, named or page-sized paper, orientation and margins (`printing.py options`); grayscale converted in the file by rewriting colours and pictures (`colour.py`), not left to the driver")
row(a, "Preflight and PDF/A, PDF/X standards", 1, P, "PDF/A-2b, 2u and 3b check and convert with ISO 19005 clauses, font embedding from Liberation and an sRGB output intent (`pdfa.py`; converted files pass veraPDF where formpdf says they conform); PDF/X-4 with a supplied printer profile; preflight profiles with fixups and a report (`preflight.py`); partial because there is no CMYK conversion, transparency flattening or PDF/X validation")

a = "Automation and agents"
row(a, "Generate a presentation from PDFs and files with AI (PDF Spaces)", 1, N, "nothing found: formpdf has no deck editor and no built-in model; Export to PowerPoint converts pages, it does not draft a presentation")
row(a, "JavaScript and guided actions", 1, P, "action lists: five built in, recorded from the window's own changes, saved, run on the open PDF as one undoable version, in Batch, by agents and from the CLI (`lists.py run_list`, `tools/lists.ts`, `pdf/recorder.ts`); form calculations, formats, keystrokes and range checks written with Acrobat's standard functions run as the person fills (`pdf/formcalc.ts`); partial because no PDF JavaScript is executed, so custom form scripts, document scripts and a console are not available")
row(a, "Plug-ins and add-ons", 1, F, "plug-in folders with an engine file and a window file, off until the person allows them and off again when they change (`plugins.py`); a plug-in registers ordinary actions that reach the MCP tool, the palette, Batch, action lists and the CLI, and adds tool sections to any tab (`pdf/plugins.ts`, `pdf/tools.ts registerTool`); sample in `docs/plugins/word-count`")
row(a, "MCP server for outside agents (HTTP and stdio)", 0, F, "`backend/app/routers/mcp.py` HTTP server on 127.0.0.1:8198/mcp and `setup/mcp_stdio.py` stdio bridge (engine found through ~/Formpdf/engine.json); tools get_context, open_pdf, pdf, render_pages, extract, save, undo")
row(a, "Agent edits land live in the open window and undo per turn", 0, F, "a change from `mcp.py t_pdf` without an out path replaces the PDF open in the window live (`live/agent.ts`, `pdf/workbench.ts`), labelled Agent: in its history; Undo turn in the status bar, Edit > Undo agent turn (Alt+Mod+Z) and the MCP `undo` tool return the version before the turn; the agent's change is refused if the person edited meanwhile")
row(a, "Agent sees its pages", 0, F, "`render_pages` returns a contact sheet of chosen pages (`services/pdf/slides.py`, pdfium) and `extract` returns text, tables and pictures (`core.py extract_text, extract_tables, extract_images`)")
row(a, "Agent consent and on/off switch", 0, F, "`mcp.py _mutating` sends open_pdf, save, undo and every change or export action of the pdf tool through `_consent` (Allow agents to edit? in the window); reads never ask; Preferences > Agents turns agents off")
row(a, "Skills shipped for Claude Code, Codex and Cursor", 0, F, "`.claude/skills/formpdf-harness` and `formpdf-skillset`, mirrored by `./formpdf agents sync` to .agents/skills; `.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json` point at the formpdf MCP server")
row(a, "Headless processing from the command line", 0, F, "`./formpdf run` (`setup/cli.py`): any pdf action on files with --out, --pages, --preset and the rest, plus render and merge, headless")

a = "Platform"
row(a, "Desktop app", 1, P, "Tauri shell in `src-tauri/`, bundles from `.github/workflows/desktop.yml`; signing optional")
row(a, "Runs in a browser", 1, P, "Vite app against a local engine; no hosted service")
row(a, "Phone and tablet", 1, N, "nothing found")
row(a, "macOS, Windows and Linux builds", 0, F, "`.github/workflows/desktop.yml` builds the Tauri app on macos-latest, ubuntu-22.04 and windows-latest (`src-tauri/tauri.conf.json` bundle targets all)")


def scored(rows):
    return [r for r in rows if r["area"] != "Platform" and r["acro"]]


def summary():
    out = {"total_rows": len(R), "scored_rows": len(scored(R)), "areas": []}
    for a in AREAS:
        rows = [r for r in scored(R) if r["area"] == a]
        if rows:
            out["areas"].append({"area": a, "rows": len(rows), "points": sum(V[r["st"]] for r in rows)})
    s = scored(R)
    out["overall"] = [sum(V[r["st"]] for r in s), len(s)]
    out["counts"] = {k: sum(1 for r in s if r["st"] == k) for k in (F, P, N)}
    out["leads"] = [r["cap"] for r in R if not r["acro"] and r["area"] != "Platform" and r["st"] != N]
    return out


def pct(p, n):
    return f"{round(100 * p / n)}%" if n else "n/a"


if __name__ == "__main__":
    out = summary()
    if "--md" in sys.argv:
        word = {F: "Full", P: "Partial", N: "None"}
        print("| Area | vs Acrobat |")
        print("| --- | --- |")
        for e in out["areas"]:
            print(f"| {e['area']} | {e['points']:g} of {e['rows']} · {pct(e['points'], e['rows'])} |")
        p, n = out["overall"]
        print(f"| **Overall** | **{p:g} of {n} · {pct(p, n)}** |")
        for a in AREAS:
            rows = [r for r in R if r["area"] == a]
            if not rows:
                continue
            print(f"\n### {a}\n")
            print("| Capability | Acrobat | formpdf | Evidence |")
            print("| --- | --- | --- | --- |")
            for r in rows:
                print(f"| {r['cap']} | {'yes' if r['acro'] else 'no'} | {word[r['st']]} | {r['ev']} |")
    else:
        print(json.dumps(out, indent=1))
