<p align="center">
  <img src="assets/app-icon/formpdf-256.png" width="128" height="128" alt="FormPDF icon">
</p>

<h1 align="center">FormPDF</h1>

<p align="center">
  <b>PDF editing; the PDF editor of the Form family.</b><br>
  In-place text editing, redaction, OCR, signing and forms, with an agent dock,<br>
  in one window on your computer. Your files never leave it. No account.
</p>

<p align="center">
  <img alt="version 0.58.2" src="https://img.shields.io/badge/version-0.58.2-eef0f4?style=flat-square">
  <img alt="Python" src="https://img.shields.io/badge/python-3.12%2B-3776ab?style=flat-square&logo=python&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-vite-3178c6?style=flat-square">
  <img alt="macOS, Windows, Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-native-2f7bf5?style=flat-square">
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-3a3a3a?style=flat-square">
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-d69e2e?style=flat-square">
</p>

<p align="center">
  <a href="https://formpdf.formai.studio/"><b>Download FormPDF on formai.studio</b></a> ·
  <a href="#run-it-from-source">Run it from source</a>
</p>

<br>

<p align="center">
  <img src="docs/images/formpdf-hero.jpg" alt="FormPDF on the Organize tab with an eight page travel guide: page thumbnails in a grid, the pages rail and the Pages, Split and Merge panel" width="100%">
  <br>
  <sub>Organize an 8-page PDF: reorder, rotate, delete, insert, split and merge pages in one grid.</sub>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#everything-in-the-box">In the box</a> · <a href="#built-for-agents">Agents</a> · <a href="#under-the-hood">Under the hood</a> · <a href="#download">Download</a> · <a href="#run-it-from-source">Run from source</a>
</p>

<table>
  <tr>
    <td width="25%" valign="top"><h3>Edit in place</h3>Change the text a PDF already has, in its own font where possible, and move, crop or replace its pictures.</td>
    <td width="25%" valign="top"><h3>Redact for real</h3>Find text or patterns and the content under each box is removed, not just covered. The rest stays selectable text.</td>
    <td width="25%" valign="top"><h3>Local only</h3>Files, OCR and signing stay on this computer, and Preferences lists every network connection. None leave it.</td>
    <td width="25%" valign="top"><h3>Agent-ready</h3>The same engine from the window, the command line and an MCP server, with the whole agent turn undoable at once.</td>
  </tr>
</table>

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/formpdf-edit.png" alt="The Edit tab with a paragraph selected on a visitor report, showing font, size, alignment and line spacing controls" width="100%"><br><sub>Edit: a paragraph of a visitor report selected for editing.</sub>
      <h3>Edit text and pictures</h3>Click any text to retype it with font, size, style, alignment and lists. Pictures can be moved, cropped, flipped and replaced.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/formpdf-redact.png" alt="The Protect tab listing four email address matches to redact across two pages" width="100%"><br><sub>Protect: four email addresses found on two pages, all ticked.</sub>
      <h3>Find and redact</h3>Search for words, phrases or email addresses and tick the matches. Apply removes the content under each box.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/formpdf-sign.png" alt="A typed signature placed on the signature line of a report page, with the Signature panel open" width="100%"><br><sub>Fill Forms and Sign: a typed signature on the approval line.</sub>
      <h3>Fill and sign</h3>Draw or type a signature and stamp it on the page. Or sign with a digital ID and check every signature in plain sentences.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/formpdf-dock.webp" alt="A quarterly report open in FormPDF with the agent dock at the bottom holding a Claude Code terminal" width="100%"><br><sub>Agent dock: a Claude Code terminal under the open PDF.</sub>
      <h3>Agents in the window</h3>Ctrl+J opens real terminals already connected to FormPDF's tools, plus a Chat tab that answers about the open PDF.
    </td>
  </tr>
</table>

## Everything in the box

<table>
  <tr>
    <td width="33%" valign="top"><h4>Work on the page</h4>View · Comment · Fill Forms and Sign · Prepare form · Edit · Organize · Extract · Protect · Convert · Accessibility · Print · Assistant</td>
    <td width="33%" valign="top"><h4>Protect and convert</h4>Passwords and permissions · Find and redact · Metadata · OCR on this computer · Word · PowerPoint · Excel · HTML · RTF · Compress · PDF/A · PDF/X-4</td>
    <td width="33%" valign="top"><h4>Formats</h4>Opens: PDF, PNG, JPG, GIF, WEBP, TIFF, DOCX, PPTX, XLSX (Office files through your LibreOffice) · Saves: PDF, plus text, tables, pictures and the exports above</td>
  </tr>
</table>

## Built for agents

83 PDF actions sit in one registry; the window, the command line and the MCP server call the same ones.

```sh
./formpdf run actions                                          # list every action
./formpdf run page_numbers report.pdf --format "Page {n} of {total}"   # a job without the window
./formpdf cli list                                             # every window command
./formpdf mcp                                                  # MCP server on stdio for Claude Code, Codex and Cursor
```

`.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json` are already wired in this repo. With the engine running, Claude Code can also use `claude mcp add --transport http formpdf http://127.0.0.1:8198/mcp`. Ctrl+J (Cmd+J on a Mac) opens an agent dock with real terminals. See [`AGENTS.md`](AGENTS.md).

## Under the hood

- **Engine:** a FastAPI service in `backend/` does the PDF work, so the window, CLI and agents share one code path.
- **Window:** a vanilla TypeScript and Vite app in `frontend/`, with every menu item and shortcut a single command in one catalogue.
- **Desktop:** a Tauri shell in `src-tauri/` wraps the frozen engine as a sidecar.
- **Local data:** everything stays in `~/Formpdf`; override it with `FORMPDF_DATA_DIR`.
- **Tested:** 61 backend tests in `backend/tests`, run in CI.

## Download

| Platform | Download | Release |
|---|---|---|
| macOS | [Download FormPDF for macOS](https://formai.studio/get/formpdf/macos) | [FormPDF releases on FormCompiler](https://github.com/nodemode-dev/formcompiler/releases?q=formpdf-v&expanded=true) |
| Windows | [Download FormPDF for Windows](https://formai.studio/get/formpdf/windows) | [FormPDF releases on FormCompiler](https://github.com/nodemode-dev/formcompiler/releases?q=formpdf-v&expanded=true) |
| Linux | [Download FormPDF for Linux](https://formai.studio/get/formpdf/linux) | [FormPDF releases on FormCompiler](https://github.com/nodemode-dev/formcompiler/releases?q=formpdf-v&expanded=true) |

All FormPDF builds are compiled and released from [FormCompiler](https://github.com/nodemode-dev/formcompiler); this repo holds the source.

## Demo

Open [`demo/index.html`](demo/index.html) in a browser, by double-click or from any static server, to try the viewer and page tools offline on your own PDF or on the illustrated edition and NASA report excerpts it opens with (sources in [`demo/CREDITS.md`](demo/CREDITS.md)): find, rotate, reorder, delete, extract, merge, page numbers and watermark. Nothing is uploaded. See [`demo/README.md`](demo/README.md).

Three demos, each a page you open by double-click:

- [`demo/index.html`](demo/index.html): pages and search, on the illustrated edition and the NASA excerpts.
- [`demos/sign/index.html`](demos/sign/index.html): annotate, fill and sign a fillable loan agreement, add stamps and comments, flatten and save.
- [`demos/protect/index.html`](demos/protect/index.html): find and redact, remove hidden information, compare two versions, extract, convert and password-protect.

## Run it from source

Prefer it in your browser, or want to contribute? Run the web UI straight from this repo.

**Requires:** Python 3.12+ and Node 20.19+ or 22.12+ (`./formpdf doctor` checks them).

```sh
git clone git@github.com:nodemode-dev/formpdf.git
cd formpdf
./formpdf install   # backend venv and frontend packages
./formpdf           # web UI at http://localhost:5198
```

`./formpdf desktop dev` opens the desktop window instead. On Windows use `formpdf.bat install` then `formpdf.bat`. The engine listens on http://127.0.0.1:8198 (`FORMPDF_PORT` moves it).

| Variable | Purpose |
|---|---|
| `FORMPDF_DATA_DIR` | Where working copies, exports and settings live (default `~/Formpdf`) |
| `FORMPDF_NO_OCR` | Set to `1` before `./formpdf install` to leave out OCR (about 150 MB) |

> [!IMPORTANT]
> **Status:** pre-release. Gaps include hosted sharing, form JavaScript beyond the standard AcroForm functions and print production (CMYK, flattening). See [`docs/PARITY.md`](docs/PARITY.md).

**Contributing:** branch from `main`, keep changes to source here, and leave packaging and releases to FormCompiler. See [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).

## Repository

| Path | What it is |
|---|---|
| `backend/` | FastAPI engine: PDF services, `/api/pdf`, live channel, MCP server |
| `frontend/` | Vanilla TypeScript and Vite app: Home, the PDF workbench, styles |
| `setup/` | Install, boot, build, freeze, doctor, run, MCP stdio and agent scripts |
| `src-tauri/` | Desktop shell and the engine sidecar |
| `docs/` | [`MANUAL.md`](docs/MANUAL.md), [`PARITY.md`](docs/PARITY.md), plug-in examples |

<br>

---

## Maintainers

| Maintainer | Role |
|---|---|
| [@nodemode-ai](https://github.com/nodemode-ai) | Owner |
| [@gbarnai](https://github.com/gbarnai) | Co-owner |

Code owners are set in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## License

FormPDF is licensed under the Apache License 2.0 ([`LICENSE`](LICENSE), SPDX `Apache-2.0`). Copyright 2026 NodeAgentc, Inc. Third-party notices: [`NOTICE.md`](NOTICE.md).

<sub>Screenshot content: CC0 photos from Poly Haven. Hero: a sample travel guide made for the Form family.</sub>

<sub>Adobe, Acrobat, Microsoft, Word and PowerPoint are trademarks of their respective owners. FormPDF is an independent project and is not affiliated with or endorsed by them.</sub>
