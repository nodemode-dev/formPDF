# formpdf

A PDF editor in the form family: an open alternative to Adobe Acrobat that runs on your computer, built so that Claude Code, Codex or Cursor can do PDF work in the open window while you watch, with every agent turn undoable at once.

Version 0.10.0 · Apache-2.0 · macOS, Windows, Linux (browser or Tauri desktop)

## What it does

| Area | In this version |
| --- | --- |
| Home | Open a PDF by picker, drop or path; recent PDFs with forget; create a PDF from pictures; merge PDFs; scan from network and connected scanners; Batch (one action on many PDFs, results in a new folder); pick up where you left off, including unsaved changes after a crash |
| Everywhere | Mod+K finds any command or tool in your own words and says why one cannot run yet; Preferences lists every network connection (none leave this computer) |
| View | Single, continuous, two-page and cover layouts; reading mode; read aloud; find; compare two PDFs; document properties |
| Comment | Highlight, underline, strike through, notes, text boxes, ink, shapes, lines and arrows; replies and status; stamps; measure distance, perimeter and area; check spelling with your own words |
| Fill & Sign | Fill form fields; draw or type a signature; sign with a digital ID (certify, lock fields, timestamp) and check every signature in plain sentences; request signatures in order; dates, text and business or dynamic stamps |
| Prepare form | Text, multi-line, check box, radio, dropdown, list box, date and signature fields |
| Edit | Edit the text a PDF already has in place, in its own font where possible; page text and pictures that stay editable (fonts, styles, alignment, lists; crop, rotate, flip, replace), pictures already on the page moved, cropped and replaced, arrange and align; headers and footers with Bates numbers (across a set of files from Batch), crop, page numbers, watermark, links, attached files |
| Organize | Rotate, delete, reorder, insert pages; split; merge |
| Extract | Text (.txt, .md), pictures, tables (CSV, .xlsx) |
| Protect | Passwords and permissions, remove a password, find and redact (the content under each box is removed, the rest stays text; marks from other apps applied too), metadata, remove hidden information |
| Convert | Make scanned pages searchable with OCR that runs on this computer; export to PowerPoint (one slide per page, words as real text boxes), Word (columns, lists, headers and footers kept), Excel, HTML, RTF, compress, pages to pictures |
| Accessibility | Check against Acrobat's 32 rules with a fix for each repairable one and an HTML report; tag the PDF from its layout; edit the reading order on the page; alternate text figure by figure |
| Print | Pages per sheet, booklets and posters with a live sheet preview; real grayscale; PDF/A-2b, 2u and 3b check and convert; PDF/X-4 with your printer's profile; preflight with fixups and a report |
| Agents | MCP server over HTTP at /mcp or stdio: get_context, open_pdf, pdf (60 actions), render_pages, extract, save, undo |

## Install and run

```
./formpdf install      # backend venv and frontend packages
./formpdf              # engine on 127.0.0.1:8198, app on http://localhost:5198
```

Windows: `formpdf.bat install` then `formpdf.bat`. One-click installers: `formpdf_oc_install` and `formpdf_oc_install.bat`. You need Python 3.12+ and Node 20.19+ or 22.12+; `./formpdf doctor` checks them. `./formpdf build` then `./formpdf serve` serves the built app from the engine alone.

## Desktop

```
./formpdf install-desktop   # PyInstaller and the Rust and Tauri toolchain check
./formpdf desktop dev
./formpdf desktop build     # freezes the engine sidecar, bundles .app/.dmg, .msi/.exe, .deb/.AppImage
```

The desktop app opens .pdf files (Open With formpdf, or a double-click once associated). CI builds all three platforms in `.github/workflows/desktop.yml`.

## Agents

```
./formpdf agents install   # writes .mcp.json, .codex/config.toml, .cursor/mcp.json and installs the skills
```

Claude Code alone: `claude mcp add --transport http formpdf http://127.0.0.1:8198/mcp`. Claude Desktop and other stdio clients: `./formpdf mcp`. Then ask, for example: "Use formpdf: add Bates numbers ACME-000001 to the PDF I have open and redact every email address." Changes land live in the window; Edit > Undo agent turn takes back the whole turn. The skills `formpdf-harness` (doing PDF work) and `formpdf-skillset` (developing formpdf) live in `.claude/skills`.

Without the window: `./formpdf run page_numbers report.pdf --format "Page {n} of {total}"`; `./formpdf run actions` lists every action.

## Data

Everything stays in `~/Formpdf` (override with `FORMPDF_DATA_DIR`): `Pdf/` working copies and the recent list, `Media/` extracted pictures, `Exports/` files written by Save and agents, `settings.json`, and `engine.json` while the engine runs. `FORMPDF_PORT` moves the engine off 8198.

## Layout

```
backend/    FastAPI engine: PDF services, /api/pdf, live channel, MCP server
frontend/   Vanilla TypeScript and Vite app: Home, the PDF workbench, ui toolkit, styles
setup/      install, boot, build, serve, freeze, desktop, doctor, clean, run, mcp_stdio, agents (with .bat twins)
src-tauri/  desktop shell and the engine sidecar
docs/       MANUAL.md
```

## Known gaps

- Against Acrobat, formpdf scores 63.5 of 72 (88%); docs/PARITY.md has every row. The largest gaps are Office to PDF, automation and plug-ins, and AI tools.
- Print production has no CMYK conversion or transparency flattening; PDF/X-4 needs your printer's ICC profile and is not checked by an outside validator.
- Tagging works out structure from the layout; check the reading order and add alternate text afterwards. Editing page content after tagging leaves the new content untagged until you tag again.
- OCR adds about 150 MB to an install (set `FORMPDF_NO_OCR=1` before `./formpdf install` to leave it out). On macOS, USB scanners are reached only when they also speak eSCL (AirScan); network scanners work everywhere.
- Signature validation trusts only certificates you trusted in formpdf (your own IDs are trusted automatically) and never checks revocation online; signing requests are sent by your own email.
- Editing text already in a PDF re-sets the paragraph: kerning the PDF wrote by hand is replaced by the font's own spacing, and text inside form XObjects, Type 3 fonts and fonts without a character map cannot be edited.
- No tagged PDF or accessibility checker; no shared review or signature requests.

## Licence

Apache-2.0 (see LICENSE). formpdf was extracted from formsld 0.5.1; third-party notices are in NOTICE.md.
