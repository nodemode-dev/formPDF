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
row(a, "Edit PDF text and pictures in place", 1, N, "nothing found: no tool edits text already on the page (`annotate.ts Tool` has markup and drawing tools only), and placed pictures are new annotations, not the page's own images")
row(a, "Add new text to PDF pages", 1, P, "Fill & Sign > Add text and the Comment text box (`annotate.ts` freetext, `annot.py draw`) flattened into the page; size and colour only, one font, not editable as text after Apply")
row(a, "Edit PDF text formatting: font, size, colour, style", 1, P, "only for text formpdf adds (`annotate.ts` freetext size select and colour palette, `annot.py font_for`); no font choice, bold, italic or underline, and no tool edits text already on the page (`annotate.ts Tool` has markup and drawing tools only)")
row(a, "Bulleted and numbered lists in PDF text", 1, N, "nothing found")
row(a, "Align PDF paragraphs: left, centre, right, justify", 1, N, "nothing found: added text boxes are left-aligned (`annot.py _text_block`); only new form fields have an alignment (`pdf/form.ts` Align)")
row(a, "Add links to PDF pages", 1, F, "Edit > Links (`frontend/src/tools/links.ts`): draw a box and link it to a web address, an email address or a page, link every web and email address in the text, list and remove links; `services/pdf/links.py change, read` (actions edit_links and links in MCP, the CLI and Batch); following a link offers http, https and mailto only, behind a prompt (`workbench.ts openLink`)")
row(a, "Spell check edited text and comments", 1, P, "browser spell check on comment and text-box editing (`annotate.ts` textarea spellcheck) and multi-line form fields (`fill.ts`); no dictionaries or language settings")
row(a, "Add pictures to PDF pages", 1, P, "Stamps > From a picture (`panels.ts` stamp-image) places a PNG, JPEG, WebP, GIF or BMP and `annot.py draw` image writes it (flattened or as a stamp comment); re-encoded to PNG at most 1600 px, and not editable as a page image afterwards")
row(a, "Crop pictures on PDF pages", 1, N, "nothing found: placed pictures resize only (`annotate.ts`); no crop for any image")
row(a, "Generate pictures with AI (Adobe Express)", 1, N, "nothing found")
row(a, "Arrange objects: bring forward, send backward", 1, N, "nothing found: annotations and placed pictures have no z-order commands (`annotate.ts`)")
row(a, "Align and distribute objects on a page", 1, N, "nothing found for page objects or form fields")
row(a, "Rotate and flip pictures on PDF pages", 1, N, "nothing found: placed pictures follow the page rotation only; no rotate or flip")
row(a, "Attach files to a PDF", 1, F, "Edit > Attached files (`frontend/src/tools/attachments.ts`): attach files of any type to the document, pin a file to a spot on a page (a FileAttachment comment with a paperclip), list, save a copy and remove; `services/pdf/attach.py change, read, get_file` (actions edit_attachments and attachments), GET /api/pdf/{id}/attachment; Remove hidden information still strips them")

a = "PDF forms and signing"
row(a, "Fill form fields", 1, F, "`frontend/src/pdf/fill.ts`, `services/pdf/edit.py read_fields, fill_fields`")
row(a, "Flatten a filled form", 1, F, "`edit.py fill_fields(flatten)`")
row(a, "Place a drawn or typed signature", 1, F, "`panels.ts` signature pad (Draw, Type), `placeSignature`")
row(a, "Certificate-based digital signatures", 1, N, "nothing found: no certificate or PKCS#7 code in `services/pdf`; the Signature field type in `pdf/form.ts FormBuilder` only creates an empty /Sig field")
row(a, "Request signatures from others", 1, N, "nothing found: no sending or signer workflow")
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
row(a, "Redact marked areas", 1, P, "`edit.py redact` removes the content by re-rendering each redacted page as a picture, so the rest of that page loses its text")
row(a, "Find and redact text or patterns", 1, F, "Protect > Find text to redact: words, regex, email, phone, card and date presets (`search.py find`), redacted through `edit.py redact`; MCP `pdf redact`")
row(a, "Remove metadata and hidden information", 1, F, "Protect > Remove hidden information (`sanitize.py scan, sanitize`: metadata, JavaScript, attachments, comments, flattened fields, hidden layers, links, bookmarks, thumbnails, private data, hidden text)")

a = "PDF convert"
row(a, "Export to PowerPoint (.pptx)", 1, P, "Convert > Export to PowerPoint and the to_pptx action (`services/pdf/slides.py to_pptx`): one slide per page, the page drawn as a picture with its text removed, words placed as real text boxes and detected tables as PowerPoint tables; rotated words and text in form XObjects stay in the picture, and shapes and pictures are not rebuilt as objects")
row(a, "Extract text as .txt or .md", 1, F, "`core.py extract_text`, `panels.ts` text-txt, text-md")
row(a, "Export to HTML or RTF", 1, F, "Convert > Web page, rich text and Excel (`tools/exports.ts`), MCP `pdf to_html` and `to_rtf` (`exports.py`): one self-contained HTML file with pictures inline, or RTF with lists, tables and pictures; headings, lists and tables in reading order with running headers and footers left out")
row(a, "Extract pictures", 1, F, "`core.py extract_images`")
row(a, "Tables to Excel", 1, F, "Convert > Save as Excel and MCP `pdf to_xlsx` (`exports.py`): one sheet per page in reading order, table numbers, money and percentages stored as real numbers with their formats, a tables-only option; Extract > Tables (`core.py tables_xlsx`) still exports detected tables")
row(a, "Pages to pictures", 1, F, "`services/pdf/core.py pages_zip`, `render_png`, Convert > pages as PNG at 72, 144, 216 or 300 dpi; PNG only")
row(a, "Compress", 1, F, "`edit.py compress`")
row(a, "PDF to Word", 1, F, "Convert > Word (`word.py to_docx`: headings, styled paragraphs, Word bullet and numbered lists, pictures, tables, column sections, running headers and footers in the Word header and footer with a PAGE field), MCP `pdf to_docx`")
row(a, "OCR for scanned pages", 1, N, "nothing found: no OCR engine in requirements or `services/pdf`; `panels.ts` tells the person scanned pages need OCR first")
row(a, "Create a PDF from pictures", 1, F, "`create.py from_files` (one page per picture, fit, A4 or Letter, margins, orientation; PDFs combined in order), `pdf/create.ts` from Home and the Open menu")
row(a, "Scan paper documents to PDF", 1, N, "nothing found: no scanner acquisition")

a = "Review and comments"
row(a, "Compare two versions of a PDF", 1, F, "`pdf/compare.ts Comparer`, `services/pdf/compare.py compare`: View > Compare against an older or newer PDF, word-level insertions, changes and deletions marked on the page with optional picture changes, every difference listed with before and after text; no summary report file")
row(a, "Track a review: who commented, when, and with what status", 1, P, "comments are read with author, date, replies and status (`annot.py comments`, `panels.ts syncAnnots`); no review tracker across files or reviewers")

a = "Collaboration and sharing"
row(a, "Share PDF links with permissions", 1, N, "nothing found: no hosted service")
row(a, "Works offline on local files", 1, F, "local engine; working copies under the data folder (`services/pdf/docs.py root`) and Save writes the PDF back to disk (`routers/pdf.py /pdf/{doc_id}/save`)")

a = "Accessibility"
row(a, "Accessibility checker for PDFs", 1, N, "nothing found: formsld's `services/lint.py` checks decks, not PDFs")
row(a, "Reading Order tool for tagged PDFs", 1, N, "nothing found: reading order is only inferred for Reading view (`layout.py xycut`), never written to tags")
row(a, "Screen reader support in the app", 1, P, "ARIA roles and labels on workbench buttons, panels and dialogs (`workbench.ts`, `panels.ts`, `form.ts` aria-label); page content is pdf.js canvas plus text layer; not audited")
row(a, "Alternate text for figures", 1, N, "nothing found: no structure-tree editing in `services/pdf`")
row(a, "Tag a PDF for accessibility (autotag)", 1, N, "nothing found: no PDF is tagged; edits through pypdf keep but never add /StructTreeRoot")

a = "Import and export"
row(a, "Create PDFs from Office files (Word, PowerPoint, Excel)", 1, N, "nothing found: `services/pdf/create.py from_files` takes pictures and PDFs only")

a = "Print"
row(a, "Print PDFs, including several pages per sheet", 1, P, "Print renders every page with pdf.js and hands it to the system print dialog (`workbench.ts print`, Tauri print_window or window.print); pages per sheet, booklet and scaling only where the system dialog offers them")
row(a, "Print settings: paper size, grayscale, scaling", 1, P, "no print settings of its own: paper, colour and scaling come from the system print dialog (`workbench.ts print`)")
row(a, "Preflight and PDF/A, PDF/X standards", 1, N, "nothing found: no preflight, output intents or PDF/A conversion in `services/pdf`")

a = "Automation and agents"
row(a, "Generate a presentation from PDFs and files with AI (PDF Spaces)", 1, N, "nothing found: formpdf has no deck editor and no built-in model; Export to PowerPoint converts pages, it does not draft a presentation")
row(a, "JavaScript and guided actions", 1, P, "no JavaScript (`sanitize.py` only removes it) and no in-app action sequences; repeatable steps only from outside, through the MCP pdf actions or the CLI")
row(a, "Plug-ins and add-ons", 1, N, "nothing found")
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
